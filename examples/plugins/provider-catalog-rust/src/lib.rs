#![no_std]

extern crate alloc;

use alloc::{
    alloc::{alloc, dealloc, realloc, Layout},
    format,
    string::String,
};

#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

// `std` normally supplies this canonical-ABI export for wasm32-wasip2. This
// guest intentionally has no `std`/WASI CLI imports, so it provides the same
// allocator bridge explicitly.
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
    path: "../../../wit/yaqmc-provider",
    world: "provider",
});

struct ExampleCatalog;

impl Guest for ExampleCatalog {
    fn invoke(
        capability: String,
        operation: String,
        _payload_json: String,
    ) -> Result<String, String> {
        if capability != "provider.catalog" {
            return Err(error(
                "unsupported-operation",
                "the example only implements provider.catalog",
            ));
        }

        match operation.as_str() {
            "catalog.search" => Ok(search()),
            "catalog.song" => Ok(String::from(SONG)),
            "catalog.album" => Ok(album()),
            "catalog.artist" => Ok(artist()),
            _ => Err(error(
                "unsupported-operation",
                "the example does not implement this catalog operation",
            )),
        }
    }
}

fn error(code: &str, message: &str) -> String {
    format!(r#"{{"code":"{code}","message":"{message}","retryable":false}}"#)
}

const SONG: &str = r##"{"id":"component-song-1","title":"Component Model","artists":[{"id":"component-artist-1","name":"YAQMC Example"}],"album":{"id":"component-album-1","title":"Provider SDK"},"artwork":{"src":"","alt":"YAQMC Component Model fixture","dominantColor":"#334155"},"durationMs":180000,"trackNumber":1,"isFavorite":false,"quality":"standard","availability":{"status":"available"},"provider":{"providerId":"dev.yaqmc.example.catalog","trackId":"component-song-1"}}"##;

fn search() -> String {
    [
        r#"{"kind":"song","query":"component","page":1,"hasMore":false,"items":["#,
        SONG,
        "]}",
    ]
    .concat()
}

fn album() -> String {
    [
        r##"{"id":"component-album-1","title":"Provider SDK","artist":{"id":"component-artist-1","name":"YAQMC Example"},"artwork":{"src":"","alt":"YAQMC Component Model fixture","dominantColor":"#334155"},"releaseYear":2026,"genre":"Example","description":"A deterministic catalog fixture.","tracks":["##,
        SONG,
        "]}",
    ]
    .concat()
}

fn artist() -> String {
    [
        r##"{"id":"component-artist-1","name":"YAQMC Example","artwork":{"src":"","alt":"YAQMC Component Model fixture","dominantColor":"#334155"},"description":"A read-only Provider Component example.","topSongs":["##,
        SONG,
        r#"],"albums":[]}"#,
    ]
    .concat()
}

export!(ExampleCatalog);

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}
