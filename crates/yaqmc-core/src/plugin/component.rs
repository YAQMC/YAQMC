use std::{
    collections::BTreeSet,
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

use crate::plugin::manifest::ProviderCapability;

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
        let mut task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            invoke_sync(&inner, &capability, &operation, &payload_json)
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
                    (realloc $realloc))))"#,
        length = length
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
