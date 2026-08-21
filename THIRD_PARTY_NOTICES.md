# Third-party notices

YAQMC independently adapts QMC/mflac cipher behavior from the MIT-licensed project below. Upstream files
were not vendored. Protocol-only research references, including GPL/LGPL and unlicensed repositories, are
recorded in [docs/qqmusic-provider.md](docs/qqmusic-provider.md) and are not reproduced here.

`mzj3920/qqmusic-decrypt`, AynaLivePlayer/miaosic, and official QQ Music Electron ASAR contents are **not**
in-tree YAQMC sources. The `mzj3920` and ASAR claims were removed from the current private `qm-api-rs` pin;
miaosic was protocol corroboration only.

## QMCDecode

Source: <https://github.com/gongjiehong/QMCDecode>
Revision: `aea76301a08678100ec677cb61a8458bc75662ec`

| Upstream file / range                                           | YAQMC target                                                                                      | Transformation                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `QMCDecode/QMCipher.swift` `QMMapCipher.getMask` / `rotate`     | `crates/yaqmc-provider-qqmusic/src/qmc.rs` `MapCipher.decrypt`                                    | Independent Rust rewrite of the non-circular `(key << rot) \| (key >> rot)` mask. YAQMC indexes with `key.len()` rather than `& 0xFF`. |
| `QMCDecode/QMCipher.swift` `QMRC4Cipher`                        | `crates/yaqmc-provider-qqmusic/src/qmc.rs` `Rc4Cipher`                                            | Independent Rust rewrite of the 128-byte first segment and 5,120-byte segmented RC4 stream.                                            |
| `QMCDecode/QMCKeyDecoder.swift` and `QMCDecode/TeaCipher.swift` | `crates/yaqmc-provider-qqmusic/src/qmc.rs` `derive_key`, `simple_make_key`, `decrypt_tencent_tea` | Independent Rust rewrite of ekey TEA unwrapping after any EncV2 outer wrap is removed.                                                 |

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
