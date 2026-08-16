# Test baseline

Captured for `bc55b7ddd2a57cde8987c96c7c20f0b7d4a2e742` before runtime migration work.

| Command | Result |
|---|---|
| `npm run check` | Passed: public-docs check (42 docs), 60 test files / 485 tests, and production build. |
| `npm run ci:test-scripts` | Passed: 9 / 9 script tests. |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` | Passed with Rust 1.88: 346 passed; 9 ignored. |

Observed non-failing warnings:

- Node `24.14.1` is below `jsdom` 30's declared `>=24.15.0` engine requirement during `npm ci`.
- The current main JavaScript bundle is 578.48 kB and triggers Vite's existing `>500 kB` chunk-size warning.

This is a documentation-only checkpoint. No baseline test, runtime source, package manifest, permission artifact, or existing test is changed here.
