#![no_std]

extern crate alloc;

use alloc::{
    alloc::{alloc, dealloc, realloc, Layout},
    format,
    string::{String, ToString},
};

#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[unsafe(export_name = "cabi_realloc")]
unsafe extern "C" fn canonical_realloc(
    old_ptr: *mut u8,
    old_len: usize,
    align: usize,
    new_len: usize,
) -> *mut u8 {
    if old_len == 0 {
        if new_len == 0 {
            return align as *mut u8;
        }
        let layout = Layout::from_size_align_unchecked(new_len, align);
        let ptr = alloc(layout);
        if ptr.is_null() {
            core::arch::wasm32::unreachable();
        }
        return ptr;
    }
    let layout = Layout::from_size_align_unchecked(old_len, align);
    if new_len == 0 {
        dealloc(old_ptr, layout);
        return align as *mut u8;
    }
    let ptr = realloc(old_ptr, layout, new_len);
    if ptr.is_null() {
        core::arch::wasm32::unreachable();
    }
    ptr
}

wit_bindgen::generate!({
    path: "../../../../../wit/yaqmc-provider",
    world: "provider-account",
});

struct HostProbe;

impl Guest for HostProbe {
    fn invoke(
        _capability: String,
        operation: String,
        payload_json: String,
    ) -> Result<String, String> {
        match operation.as_str() {
            "test.storage" => {
                yaqmc::provider::storage::kv_set("probe", &payload_json)?;
                Ok(yaqmc::provider::storage::kv_get("probe")?.unwrap_or_default())
            }
            "test.cache" => {
                yaqmc::provider::storage::cache_put("probe", payload_json.as_bytes())?;
                let value = yaqmc::provider::storage::cache_get("probe")?.unwrap_or_default();
                String::from_utf8(value).map_err(|_| "cache response is not UTF-8".to_string())
            }
            "test.utilities" => {
                yaqmc::provider::utilities::log("info", "component host probe");
                let bytes = yaqmc::provider::utilities::random_bytes(16)?;
                Ok(format!(
                    "{{\"randomBytes\":{},\"monotonicMillis\":{}}}",
                    bytes.len(),
                    yaqmc::provider::utilities::monotonic_millis()
                ))
            }
            "test.credential" => {
                let handle =
                    yaqmc::provider::credentials::create("https://api.example.com", &payload_json)?;
                let deleted = yaqmc::provider::credentials::delete(&handle)?;
                Ok(format!(
                    "{{\"handleBytes\":{},\"deleted\":{deleted}}}",
                    handle.len()
                ))
            }
            "test.network" => yaqmc::provider::network::request(&payload_json),
            _ => Err("unknown host probe operation".to_string()),
        }
    }
}

export!(HostProbe);

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}
