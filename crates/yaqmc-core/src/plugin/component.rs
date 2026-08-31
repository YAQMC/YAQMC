use std::{
    collections::{BTreeSet, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use thiserror::Error;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use wasmtime::{
    component::{Component, Linker, ResourceTable},
    Config, Engine, Store, StoreLimits, StoreLimitsBuilder,
};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

use crate::plugin::{
    component_host::ComponentHostContext,
    manifest::{ProviderCapability, ProviderWorld},
    network::{component_request_origin, proxy_component_request, ComponentCredentialHeader},
};

#[allow(dead_code)]
mod wit_contract {
    wasmtime::component::bindgen!({
        path: "../../wit/yaqmc-provider",
        world: "provider",
    });
}

pub const COMPONENT_MEMORY_LIMIT: usize = 64 * 1024 * 1024;
pub const COMPONENT_MAX_CONCURRENCY: usize = 4;
pub const COMPONENT_MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub const COMPONENT_OPERATION_DEADLINE: Duration = Duration::from_secs(15);
pub const COMPONENT_OPERATION_FUEL: u64 = 10_000_000;
pub const COMPONENT_FAULT_THRESHOLD: u8 = 3;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ComponentRuntimeError {
    #[error("the provider component could not be compiled")]
    InvalidComponent,
    #[error("the provider component capability was not granted")]
    CapabilityDenied,
    #[error("the provider component is disabled")]
    Disabled,
    #[error("the provider component circuit breaker is open")]
    CircuitOpen,
    #[error("the provider component operation was cancelled")]
    Cancelled,
    #[error("the provider component host services are unavailable")]
    HostUnavailable,
    #[error("the provider component operation exceeded its deadline")]
    Deadline,
    #[error("the provider component returned an oversized response")]
    OversizedResponse,
    #[error("the provider component reported an operation error: {0}")]
    Guest(String),
    #[error("the provider component sandbox trapped")]
    SandboxFault,
}

struct ComponentStore {
    table: ResourceTable,
    wasi: WasiCtx,
    limits: StoreLimits,
    cancellation: CancellationToken,
}

impl WasiView for ComponentStore {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

struct ComponentInner {
    engine: Engine,
    component: Component,
    capabilities: BTreeSet<ProviderCapability>,
    world: ProviderWorld,
    host: Option<ComponentHostContext>,
    permits: Arc<Semaphore>,
    enabled: AtomicBool,
    faults: AtomicU8,
    circuit_open: AtomicBool,
    cancellation: Mutex<CancellationToken>,
}

/// One isolated provider component instance. The engine is intentionally not
/// shared across plugins so an epoch interruption cannot affect another plugin.
#[derive(Clone)]
pub struct ProviderComponent {
    inner: Arc<ComponentInner>,
}

impl ProviderComponent {
    pub fn load(
        bytes: &[u8],
        capabilities: impl IntoIterator<Item = ProviderCapability>,
    ) -> Result<Self, ComponentRuntimeError> {
        Self::load_with_host(bytes, capabilities, ProviderWorld::Isolated, None)
    }

    pub fn load_with_host(
        bytes: &[u8],
        capabilities: impl IntoIterator<Item = ProviderCapability>,
        world: ProviderWorld,
        host: Option<ComponentHostContext>,
    ) -> Result<Self, ComponentRuntimeError> {
        if world != ProviderWorld::Isolated && host.is_none() {
            return Err(ComponentRuntimeError::HostUnavailable);
        }
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.consume_fuel(true);
        config.epoch_interruption(true);
        let engine = Engine::new(&config).map_err(|_| ComponentRuntimeError::InvalidComponent)?;
        let component =
            Component::new(&engine, bytes).map_err(|_| ComponentRuntimeError::InvalidComponent)?;
        Ok(Self {
            inner: Arc::new(ComponentInner {
                engine,
                component,
                capabilities: capabilities.into_iter().collect(),
                world,
                host,
                permits: Arc::new(Semaphore::new(COMPONENT_MAX_CONCURRENCY)),
                enabled: AtomicBool::new(true),
                faults: AtomicU8::new(0),
                circuit_open: AtomicBool::new(false),
                cancellation: Mutex::new(CancellationToken::new()),
            }),
        })
    }

    pub fn enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::Acquire)
    }

    pub fn circuit_open(&self) -> bool {
        self.inner.circuit_open.load(Ordering::Acquire)
    }

    pub fn consecutive_faults(&self) -> u8 {
        self.inner.faults.load(Ordering::Acquire)
    }

    pub fn disable(&self) {
        self.inner.enabled.store(false, Ordering::Release);
        if let Some(host) = &self.inner.host {
            host.revoke();
        }
        self.current_cancellation().cancel();
        self.inner.engine.increment_epoch();
    }

    /// Re-enabling is the only operation that resets a session circuit breaker.
    pub fn enable(&self) {
        let mut cancellation = self
            .inner
            .cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *cancellation = CancellationToken::new();
        self.inner.faults.store(0, Ordering::Release);
        self.inner.circuit_open.store(false, Ordering::Release);
        self.inner.enabled.store(true, Ordering::Release);
    }

    pub async fn invoke(
        &self,
        capability: ProviderCapability,
        operation: &str,
        payload_json: &str,
    ) -> Result<String, ComponentRuntimeError> {
        if !self.enabled() {
            return Err(ComponentRuntimeError::Disabled);
        }
        if self.circuit_open() {
            return Err(ComponentRuntimeError::CircuitOpen);
        }
        if !self.inner.capabilities.contains(&capability) {
            return Err(ComponentRuntimeError::CapabilityDenied);
        }
        if payload_json.len() > COMPONENT_MAX_RESPONSE_BYTES {
            return Err(ComponentRuntimeError::OversizedResponse);
        }

        let cancellation = self.current_cancellation();
        let permit = tokio::select! {
            permit = self.inner.permits.clone().acquire_owned() => {
                permit.map_err(|_| ComponentRuntimeError::Disabled)?
            }
            _ = cancellation.cancelled() => return Err(ComponentRuntimeError::Cancelled),
        };
        if !self.enabled() {
            return Err(ComponentRuntimeError::Disabled);
        }

        let inner = Arc::clone(&self.inner);
        let operation = operation.to_owned();
        let payload_json = payload_json.to_owned();
        let capability = capability.as_str().to_owned();
        let store_cancellation = cancellation.clone();
        let mut task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            invoke_sync(
                &inner,
                &capability,
                &operation,
                &payload_json,
                store_cancellation,
            )
        });

        let outcome = tokio::select! {
            joined = &mut task => joined.unwrap_or(Err(ComponentRuntimeError::SandboxFault)),
            _ = cancellation.cancelled() => {
                self.inner.engine.increment_epoch();
                let _ = task.await;
                return Err(ComponentRuntimeError::Cancelled);
            }
            _ = tokio::time::sleep(COMPONENT_OPERATION_DEADLINE) => {
                self.inner.engine.increment_epoch();
                let _ = task.await;
                Err(ComponentRuntimeError::Deadline)
            }
        };

        match outcome {
            Ok(value) => {
                self.inner.faults.store(0, Ordering::Release);
                Ok(value)
            }
            Err(error @ ComponentRuntimeError::Guest(_))
            | Err(error @ ComponentRuntimeError::CapabilityDenied)
            | Err(error @ ComponentRuntimeError::OversizedResponse) => Err(error),
            Err(error) => {
                self.record_sandbox_fault();
                Err(error)
            }
        }
    }

    fn current_cancellation(&self) -> CancellationToken {
        self.inner
            .cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn record_sandbox_fault(&self) {
        let faults = self
            .inner
            .faults
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        if faults >= COMPONENT_FAULT_THRESHOLD {
            self.inner.circuit_open.store(true, Ordering::Release);
        }
    }
}

fn invoke_sync(
    inner: &ComponentInner,
    capability: &str,
    operation: &str,
    payload_json: &str,
    cancellation: CancellationToken,
) -> Result<String, ComponentRuntimeError> {
    let limits = StoreLimitsBuilder::new()
        .memory_size(COMPONENT_MEMORY_LIMIT)
        .instances(32)
        .tables(32)
        .memories(32)
        .build();
    let mut store = Store::new(
        &inner.engine,
        ComponentStore {
            table: ResourceTable::new(),
            wasi: WasiCtx::builder().build(),
            limits,
            cancellation,
        },
    );
    store.limiter(|state| &mut state.limits);
    store
        .set_fuel(COMPONENT_OPERATION_FUEL)
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    store.set_epoch_deadline(1);
    store.epoch_deadline_trap();

    let mut linker = Linker::new(&inner.engine);
    // This exposes only WASI 0.2 clocks/random/closed stdio. It deliberately
    // omits filesystem, environment, sockets, and process interfaces.
    wasmtime_wasi::p2::add_to_linker_proxy_interfaces_sync(&mut linker)
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    add_component_host_imports(&mut linker, inner.world, inner.host.clone())?;
    let instance = linker
        .instantiate(&mut store, &inner.component)
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let invoke = instance
        .get_typed_func::<(&str, &str, &str), (Result<String, String>,)>(&mut store, "invoke")
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let result = invoke
        .call(&mut store, (capability, operation, payload_json))
        .map_err(|_| ComponentRuntimeError::SandboxFault)?
        .0;
    invoke
        .post_return(&mut store)
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    match result {
        Ok(response) if response.len() <= COMPONENT_MAX_RESPONSE_BYTES => Ok(response),
        Ok(_) => Err(ComponentRuntimeError::OversizedResponse),
        Err(error) if error.len() <= COMPONENT_MAX_RESPONSE_BYTES => {
            Err(ComponentRuntimeError::Guest(error))
        }
        Err(_) => Err(ComponentRuntimeError::OversizedResponse),
    }
}

fn add_component_host_imports(
    linker: &mut Linker<ComponentStore>,
    world: ProviderWorld,
    host: Option<ComponentHostContext>,
) -> Result<(), ComponentRuntimeError> {
    if world == ProviderWorld::Isolated {
        return Ok(());
    }
    let host = host.ok_or(ComponentRuntimeError::HostUnavailable)?;
    add_utilities_imports(linker, host.clone())?;
    if world.has_storage() {
        add_storage_imports(linker, host.clone())?;
    }
    if world.has_network() {
        add_network_imports(linker, host.clone(), world.has_credentials())?;
    }
    if world.has_credentials() {
        add_credential_imports(linker, host)?;
    }
    Ok(())
}

fn add_utilities_imports(
    linker: &mut Linker<ComponentStore>,
    host: ComponentHostContext,
) -> Result<(), ComponentRuntimeError> {
    let mut instance = linker
        .instance("yaqmc:provider/utilities@0.1.0")
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let logging = host.clone();
    instance
        .func_wrap("log", move |_store, (level, message): (String, String)| {
            logging.log(&level, &message);
            Ok(())
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let clock = host.clone();
    instance
        .func_wrap("monotonic-millis", move |_store, (): ()| {
            Ok((clock.monotonic_millis(),))
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    instance
        .func_wrap("random-bytes", move |_store, (length,): (u32,)| {
            Ok((host.random_bytes(length),))
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    Ok(())
}

fn add_storage_imports(
    linker: &mut Linker<ComponentStore>,
    host: ComponentHostContext,
) -> Result<(), ComponentRuntimeError> {
    let mut instance = linker
        .instance("yaqmc:provider/storage@0.1.0")
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let kv_get = host.clone();
    instance
        .func_wrap("kv-get", move |_store, (key,): (String,)| {
            Ok((kv_get.kv_get(&key),))
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let kv_set = host.clone();
    instance
        .func_wrap("kv-set", move |_store, (key, value): (String, String)| {
            Ok((kv_set.kv_set(&key, &value),))
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let kv_delete = host.clone();
    instance
        .func_wrap("kv-delete", move |_store, (key,): (String,)| {
            Ok((kv_delete.kv_delete(&key),))
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let cache_get = host.clone();
    instance
        .func_wrap("cache-get", move |_store, (key,): (String,)| {
            Ok((cache_get.cache_get(&key),))
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let cache_put = host.clone();
    instance
        .func_wrap(
            "cache-put",
            move |_store, (key, value): (String, Vec<u8>)| Ok((cache_put.cache_put(&key, &value),)),
        )
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    instance
        .func_wrap("cache-delete", move |_store, (key,): (String,)| {
            Ok((host.cache_delete(&key),))
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    Ok(())
}

fn add_network_imports(
    linker: &mut Linker<ComponentStore>,
    host: ComponentHostContext,
    allow_credentials: bool,
) -> Result<(), ComponentRuntimeError> {
    let mut instance = linker
        .instance("yaqmc:provider/network@0.1.0")
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    instance
        .func_wrap("request", move |store, (request_json,): (String,)| {
            let cancellation = store.data().cancellation.clone();
            let result =
                component_network_request(&host, allow_credentials, &request_json, cancellation);
            Ok((result,))
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    Ok(())
}

fn add_credential_imports(
    linker: &mut Linker<ComponentStore>,
    host: ComponentHostContext,
) -> Result<(), ComponentRuntimeError> {
    let mut instance = linker
        .instance("yaqmc:provider/credentials@0.1.0")
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    let create = host.clone();
    instance
        .func_wrap(
            "create",
            move |_store, (origin, secret): (String, String)| {
                Ok((create.credential_create(&origin, &secret),))
            },
        )
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    instance
        .func_wrap("delete", move |_store, (handle,): (String,)| {
            Ok((host.credential_delete(&handle),))
        })
        .map_err(|_| ComponentRuntimeError::SandboxFault)?;
    Ok(())
}

fn component_network_request(
    host: &ComponentHostContext,
    allow_credentials: bool,
    request_json: &str,
    cancellation: CancellationToken,
) -> Result<String, String> {
    host.ensure_active()?;
    if request_json.len() > COMPONENT_MAX_RESPONSE_BYTES {
        return Err("component network request is too large".to_owned());
    }
    let payload: serde_json::Value = serde_json::from_str(request_json)
        .map_err(|_| "component network request is invalid".to_owned())?;
    let credential_headers = component_credential_headers(host, allow_credentials, &payload)?;
    let result = host.runtime().block_on(async {
        tokio::select! {
            result = proxy_component_request(host.allowed_origins(), &payload, &credential_headers) => result,
            _ = cancellation.cancelled() => Err("component network request was cancelled".to_owned()),
        }
    })?;
    host.ensure_active()?;
    serde_json::to_string(&result)
        .map_err(|_| "component network response could not be encoded".to_owned())
}

pub(crate) fn component_credential_headers(
    host: &ComponentHostContext,
    allow_credentials: bool,
    payload: &serde_json::Value,
) -> Result<Vec<ComponentCredentialHeader>, String> {
    let Some(bindings) = payload.get("credentialHeaders") else {
        return Ok(Vec::new());
    };
    let bindings = bindings
        .as_array()
        .ok_or_else(|| "component credential headers must be an array".to_owned())?;
    if bindings.is_empty() {
        return Ok(Vec::new());
    }
    if !allow_credentials {
        return Err("component credentials were not granted".to_owned());
    }
    if bindings.len() > 4 {
        return Err("component credential header limit exceeded".to_owned());
    }
    let origin = component_request_origin(payload)?;
    let mut names = HashSet::new();
    let mut headers = Vec::with_capacity(bindings.len());
    for binding in bindings {
        let handle = binding
            .get("handle")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "component credential handle is required".to_owned())?;
        let name = binding
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("authorization")
            .to_ascii_lowercase();
        if !["authorization", "cookie", "x-api-key", "x-auth-token"].contains(&name.as_str())
            || !names.insert(name.clone())
        {
            return Err("component credential header is not allowed".to_owned());
        }
        let prefix = binding
            .get("prefix")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if prefix.len() > 32 || prefix.chars().any(char::is_control) {
            return Err("component credential prefix is invalid".to_owned());
        }
        let secret = host.credential_resolve(handle, &origin)?;
        let value = format!("{prefix}{secret}");
        if value.len() > 8_192 || value.chars().any(char::is_control) {
            return Err("component credential value is invalid".to_owned());
        }
        headers.push(ComponentCredentialHeader {
            origin: origin.clone(),
            name,
            value,
        });
    }
    Ok(headers)
}

#[cfg(test)]
pub(crate) fn static_test_component(response: &str) -> String {
    let length = response.len();
    let response = response.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        r#"(component
            (core module $module
                (memory (export "memory") 1)
                (global $heap (mut i32) (i32.const 4096))
                (data (i32.const 1024) "{response}")
                (func (export "realloc")
                    (param i32 i32 i32 i32) (result i32)
                    (local $result i32)
                    global.get $heap
                    local.tee $result
                    local.get 3
                    i32.add
                    global.set $heap
                    local.get $result)
                (func (export "invoke")
                    (param i32 i32 i32 i32 i32 i32) (result i32)
                    i32.const 0
                    i32.const 0
                    i32.store
                    i32.const 0
                    i32.const 1024
                    i32.store offset=4
                    i32.const 0
                    i32.const {length}
                    i32.store offset=8
                    i32.const 0))
            (core instance $instance (instantiate $module))
            (core func $invoke (alias core export $instance "invoke"))
            (core func $realloc (alias core export $instance "realloc"))
            (alias core export $instance "memory" (core memory $memory))
            (type $invoke-type
                (func
                    (param "capability" string)
                    (param "operation" string)
                    (param "payload-json" string)
                    (result (result string (error string)))))
            (func (export "invoke") (type $invoke-type)
                (canon lift (core func $invoke)
                    (memory $memory)
                    (realloc $realloc))))"#
    )
}

#[cfg(test)]
fn hostile_test_component(invoke_body: &str) -> String {
    format!(
        r#"(component
            (core module $module
                (memory (export "memory") 1)
                (global $heap (mut i32) (i32.const 4096))
                (func (export "realloc")
                    (param i32 i32 i32 i32) (result i32)
                    (local $result i32)
                    global.get $heap
                    local.tee $result
                    local.get 3
                    i32.add
                    global.set $heap
                    local.get $result)
                (func (export "invoke")
                    (param i32 i32 i32 i32 i32 i32) (result i32)
                    {invoke_body}))
            (core instance $instance (instantiate $module))
            (core func $invoke (alias core export $instance "invoke"))
            (core func $realloc (alias core export $instance "realloc"))
            (alias core export $instance "memory" (core memory $memory))
            (type $invoke-type
                (func
                    (param "capability" string)
                    (param "operation" string)
                    (param "payload-json" string)
                    (result (result string (error string)))))
            (func (export "invoke") (type $invoke-type)
                (canon lift (core func $invoke)
                    (memory $memory)
                    (realloc $realloc))))"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        credentials::MemoryCredentialStore, plugin::component_host::ComponentHostServices,
    };

    fn host_fixture() -> &'static [u8] {
        include_bytes!("../../tests/fixtures/component-host-guest.wasm")
    }

    fn host_context(root: &tempfile::TempDir) -> ComponentHostContext {
        ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("host services")
        .for_plugin(
            "dev.example.host-probe",
            "provider.host-probe",
            HashSet::from(["https://api.example.com".to_owned()]),
        )
    }

    #[test]
    fn invalid_components_are_rejected_before_activation() {
        assert!(matches!(
            ProviderComponent::load(b"not wasm", [ProviderCapability::Catalog]),
            Err(ComponentRuntimeError::InvalidComponent)
        ));
    }

    #[tokio::test]
    async fn invokes_the_frozen_wit_envelope() {
        let source = static_test_component(r#"{"ok":true}"#);
        let mut config = Config::new();
        config.wasm_component_model(true);
        let engine = Engine::new(&config).expect("test engine");
        if let Err(error) = Component::new(&engine, source.as_bytes()) {
            panic!("static component must parse: {error:#}");
        }
        let component = ProviderComponent::load(source.as_bytes(), [ProviderCapability::Catalog])
            .expect("static component compiles");
        assert_eq!(
            component
                .invoke(ProviderCapability::Catalog, "search", "{}")
                .await,
            Ok(r#"{"ok":true}"#.to_owned())
        );
        assert_eq!(component.consecutive_faults(), 0);
    }

    #[tokio::test]
    async fn capability_checks_and_fault_breaker_are_deterministic() {
        let component = ProviderComponent::load(br#"(component)"#, [ProviderCapability::Catalog])
            .expect("empty component compiles");
        assert_eq!(
            component
                .invoke(ProviderCapability::Playback, "resolve", "{}")
                .await,
            Err(ComponentRuntimeError::CapabilityDenied)
        );
        for expected in 1..=COMPONENT_FAULT_THRESHOLD {
            assert_eq!(
                component
                    .invoke(ProviderCapability::Catalog, "search", "{}")
                    .await,
                Err(ComponentRuntimeError::SandboxFault)
            );
            assert_eq!(component.consecutive_faults(), expected);
        }
        assert!(component.circuit_open());
        assert_eq!(
            component
                .invoke(ProviderCapability::Catalog, "search", "{}")
                .await,
            Err(ComponentRuntimeError::CircuitOpen)
        );
        component.enable();
        assert!(!component.circuit_open());
        assert_eq!(component.consecutive_faults(), 0);
    }

    #[tokio::test]
    async fn cpu_fuel_and_memory_limits_isolate_resource_exhaustion() {
        let spinning = ProviderComponent::load(
            hostile_test_component("(loop $spin (br $spin)) unreachable").as_bytes(),
            [ProviderCapability::Catalog],
        )
        .expect("spinning component compiles");
        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            spinning.invoke(ProviderCapability::Catalog, "spin", "{}"),
        )
        .await
        .expect("fuel must stop the component");
        assert_eq!(outcome, Err(ComponentRuntimeError::SandboxFault));

        let growing = ProviderComponent::load(
            hostile_test_component(
                "i32.const 2048 memory.grow i32.const -1 i32.eq if unreachable end i32.const 0",
            )
            .as_bytes(),
            [ProviderCapability::Catalog],
        )
        .expect("memory component compiles");
        assert_eq!(
            growing
                .invoke(ProviderCapability::Catalog, "grow", "{}")
                .await,
            Err(ComponentRuntimeError::SandboxFault)
        );
    }

    #[tokio::test]
    async fn disable_cancels_future_calls_until_explicit_reenable() {
        let component = ProviderComponent::load(br#"(component)"#, [ProviderCapability::Catalog])
            .expect("empty component compiles");
        component.disable();
        assert_eq!(
            component
                .invoke(ProviderCapability::Catalog, "search", "{}")
                .await,
            Err(ComponentRuntimeError::Disabled)
        );
        component.enable();
        assert!(component.enabled());
    }

    #[tokio::test]
    async fn account_world_imports_are_bounded_and_operational() {
        let root = tempfile::tempdir().expect("root");
        let component = ProviderComponent::load_with_host(
            host_fixture(),
            [ProviderCapability::Catalog, ProviderCapability::Account],
            ProviderWorld::Account,
            Some(host_context(&root)),
        )
        .expect("component loads");

        assert_eq!(
            component
                .invoke(ProviderCapability::Catalog, "test.storage", "stored")
                .await,
            Ok("stored".to_owned())
        );
        assert_eq!(
            component
                .invoke(ProviderCapability::Catalog, "test.cache", "cached")
                .await,
            Ok("cached".to_owned())
        );
        let utilities = component
            .invoke(ProviderCapability::Catalog, "test.utilities", "")
            .await
            .expect("utilities");
        let utilities: serde_json::Value =
            serde_json::from_str(&utilities).expect("utilities json");
        assert_eq!(utilities["randomBytes"], 16);
        assert!(utilities["monotonicMillis"].is_u64());

        let credential = component
            .invoke(
                ProviderCapability::Account,
                "test.credential",
                "synthetic-secret",
            )
            .await
            .expect("credential create/delete");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&credential).expect("credential json")
                ["deleted"],
            true
        );
        assert!(!credential.contains("synthetic-secret"));
        assert_eq!(component.consecutive_faults(), 0);
    }

    #[tokio::test]
    async fn network_denials_are_guest_errors_and_do_not_trip_the_circuit() {
        let root = tempfile::tempdir().expect("root");
        let component = ProviderComponent::load_with_host(
            host_fixture(),
            [ProviderCapability::Catalog, ProviderCapability::Account],
            ProviderWorld::Account,
            Some(host_context(&root)),
        )
        .expect("component loads");
        let error = component
            .invoke(
                ProviderCapability::Catalog,
                "test.network",
                r#"{"url":"https://localhost/private"}"#,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ComponentRuntimeError::Guest(message) if message.contains("not allowed")
        ));
        assert_eq!(component.consecutive_faults(), 0);
    }

    #[tokio::test]
    async fn manifest_world_cannot_import_ungranted_host_interfaces() {
        let root = tempfile::tempdir().expect("root");
        let component = ProviderComponent::load_with_host(
            host_fixture(),
            [ProviderCapability::Catalog],
            ProviderWorld::Network,
            Some(host_context(&root)),
        )
        .expect("component compiles before linking");
        assert_eq!(
            component
                .invoke(ProviderCapability::Catalog, "test.storage", "blocked")
                .await,
            Err(ComponentRuntimeError::SandboxFault)
        );
    }

    #[test]
    fn non_isolated_world_requires_host_services() {
        assert!(matches!(
            ProviderComponent::load_with_host(
                host_fixture(),
                [ProviderCapability::Catalog],
                ProviderWorld::Network,
                None,
            ),
            Err(ComponentRuntimeError::HostUnavailable)
        ));
    }
}
