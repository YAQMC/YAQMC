# Plugin host fixtures

Frozen runtime inputs extracted from YAQMC 5d5f86fb93ecd7398789d1db5d8bc8349de0e751. Editable examples, their SDK mirror, API documentation, source builds and distributable packages are maintained in [YAQMC/yaqmc-plugins](https://github.com/YAQMC/yaqmc-plugins). These snapshots keep host regression tests reproducible and offline; they are not a second plugin catalog.

`dev.yaqmc.example.local-files-1.0.0.yaqmc-plugin` is built from the companion repository's
`plugins/provider-local-files-rust` with `npm run provider:local-files` (Rust 1.88+, wasm32-wasip2).
It exercises the real `local-files` WIT imports, Host metadata parsing and opaque local playback.
Copy only the generated package here when updating that example; editable sources remain in the companion repository.
