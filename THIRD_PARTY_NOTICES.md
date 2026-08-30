# Third-party notices

YAQMC's production QMC/mflac decryptor delegates to the pinned `qm-api-rs`
revision `2ef9182732e02db23788175dbe5b7d9d937e328f`, which independently
adapts cipher behavior from the MIT-licensed project below. Upstream files were
not vendored. Protocol-only research references, including GPL/LGPL and
unlicensed repositories, are recorded in
[docs/qqmusic-provider.md](docs/qqmusic-provider.md) and are not reproduced
here.

## Apple Music-like Lyrics

Source: <https://github.com/amll-dev/applemusic-like-lyrics>

Packages: `@applemusic-like-lyrics/core` `0.5.2` and `@applemusic-like-lyrics/react` `0.5.2`

License: GNU Affero General Public License version 3 only (`AGPL-3.0-only`). These official packages are used by
the desktop lyric renderer without vendoring or local modification. The package license text and corresponding
source are available from the upstream project; distributors of YAQMC must satisfy the GPLv3/AGPLv3 obligations
described in [docs/lyrics.md](docs/lyrics.md#amll-decision).

`mzj3920/qqmusic-decrypt`, AynaLivePlayer/miaosic, and official QQ Music Electron ASAR contents are **not**
in-tree YAQMC sources. The `mzj3920` and ASAR claims were removed from the current pinned `qm-api-rs` revision;
miaosic was protocol corroboration only.

## QMCDecode

Source: <https://github.com/gongjiehong/QMCDecode>
Revision: `aea76301a08678100ec677cb61a8458bc75662ec`

| Upstream file / range                                           | Pinned `qm-api-rs` target                                           | Transformation                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `QMCDecode/QMCipher.swift` `QMMapCipher.getMask` / `rotate`     | `src/qmc.rs` `Qmc2Map::decrypt_in_place`                            | Independent Rust rewrite of the non-circular `(key << rot) \| (key >> rot)` mask. The key is indexed with `key.len()` rather than `& 0xFF`. |
| `QMCDecode/QMCipher.swift` `QMRC4Cipher`                        | `src/qmc.rs` `Qmc2Rc4` / `decrypt_in_place`                         | Independent Rust rewrite of the 128-byte first segment and 5,120-byte segmented RC4 stream.                                                 |
| `QMCDecode/QMCKeyDecoder.swift` and `QMCDecode/TeaCipher.swift` | `src/qmc.rs` `derive_key`, `simple_make_key`, `decrypt_tencent_tea` | Independent Rust rewrite of ekey TEA unwrapping after any EncV2 outer wrapper is removed.                                                   |

The YAQMC file `crates/yaqmc-provider-qqmusic/src/qmc.rs` now only validates
and redacts the media key before selecting
`crates/yaqmc-provider-qqmusic/src/qmapi/qmc.rs`'s `QmapiQmcDecryptor`. That
adapter delegates Map, segmented-RC4, and ekey processing to the pinned symbols
above; the former duplicate in-tree cipher and TEA implementation was retired
when the production provider cut over to the pinned dependency.

MIT License

Copyright (c) 2019 程序猿老龚 gjh.me

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
