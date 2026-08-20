# Windows acceptance

> [简体中文](zh-CN/windows-acceptance.md) | **English**

> Historical pre-migration evidence only. It does not validate the current Electron host.

## Local lyrics checkpoint C

Checkpoint C passed for the raw `tauri-no-bundle` Windows binary. This is a local visual and interaction
checkpoint only: `releasePass` is `false`, `releaseArtifact` is `null`, and the final NSIS/install checkpoint K
remains open until the authenticated beta stabilizes.

Evidence is stored in the ignored directory
`output/visual-acceptance/lyrics-focus-fullscreen/windows/`. The verifier accepted the complete directory, and all
ten native client screenshots were visually reviewed for nonblank YAQMC content, expected presentation and
appearance, correct crop bounds, and absence of desktop contamination.

### Build identity

| Field                  | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| Captured               | `2026-08-11T06:27:33.9230588Z`                                     |
| Git commit             | `e2854d316f3273b46eef7a5eef19df56a6e25975`                         |
| Git tree               | `c543c5cef94d2446cab762e282a569958e10bc33`                         |
| App version            | `0.1.0`                                                            |
| Build kind             | `tauri-no-bundle`                                                  |
| Raw executable SHA-256 | `bdddecd60c3c9d31e196872c724252bd834c941b3d891fd5bf85bf9e0aa002f2` |
| Manifest SHA-256       | `722c4dc2b25329154d3dba0babe056f7863510b9b5bfa5da42327fecaa74a8e1` |
| State ledger SHA-256   | `1608a76655bb772e68c4718fda15285164c98fa5c7ec8f8ecafa012e4c7ce8c3` |
| Windows                | `Microsoft Windows NT 10.0.26200.0`                                |
| WebView2               | `151.0.4129.72`                                                    |
| Monitor / DPR          | `\\.\DISPLAY1` / `1.5`                                             |
| Provider / fixture     | `fake` / `quiet-light`                                             |

### Visual matrix

| ID  | Source    | Presentation      | Theme | Locale | Background | Entry                | Exit              | Reduced motion | Result |
| --- | --------- | ----------------- | ----- | ------ | ---------- | -------------------- | ----------------- | -------------- | ------ |
| W01 | 1280×800  | Normal            | light | en-US  | default    | PlayerBar Lyrics     | close button      | no             | pass   |
| W02 | 1280×800  | Focus             | dark  | zh-CN  | artwork    | Focus button         | Focus button      | no             | pass   |
| W03 | 1280×800  | native fullscreen | dark  | en-US  | image      | header fullscreen    | header fullscreen | no             | pass   |
| W04 | 1000×700  | Normal            | light | zh-CN  | color      | PlayerBar Lyrics     | Escape            | yes            | pass   |
| W05 | 1000×700  | Focus             | dark  | en-US  | image      | Focus button         | Escape            | no             | pass   |
| W06 | 1000×700  | native fullscreen | dark  | zh-CN  | artwork    | PlayerBar fullscreen | Escape            | yes            | pass   |
| W07 | 1000×1000 | Normal            | dark  | en-US  | artwork    | PlayerBar Lyrics     | close button      | no             | pass   |
| W08 | 1000×1000 | Focus             | light | zh-CN  | default    | Focus button         | Focus button      | yes            | pass   |
| W09 | 1000×1000 | native fullscreen | light | en-US  | color      | F11                  | F11               | no             | pass   |
| S01 | 1000×680  | Normal smoke      | dark  | en-US  | default    | PlayerBar Lyrics     | Escape            | no             | pass   |

The three fullscreen cases captured the 2560×1600 physical monitor client area and restored both logical and
physical source geometry exactly. W04, W06, and W08 recorded numeric zero for maximum transition duration,
maximum animation duration, and rAF-contained active-word progress writes.

### Real interaction ledger

The same S01-sized run used CDP pointer, wheel, text, and keyboard input against visible controls. The 15 ordered
states prove:

- manual lyric scrolling exposes Follow, and Follow restores automatic tracking;
- clicking lyric line index 4 seeks into its 74–89 second interval;
- PlayerBar pause and resume converge;
- Focus expands Lyrics and PlayerBar to the full viewport width;
- fullscreen transport hides after 2400 ms, reveals on pointer movement, and remains visible while focused;
- fullscreen Next changes `quiet-light` to `night-geometry`, and Previous restores it while playing;
- Escape exits native fullscreen first, Focus second, and Lyrics third;
- the `paper-sun` fixture renders both translation and romanization after their visible Settings controls are set
  to Show.

An independent `external-native-api` probe verified the `main` window label, native `true -> false` transition,
fulfilled `set_fullscreen(false)`, presentation-store reconciliation, and exact geometry restoration without
writing frontend presentation state directly.

## Reproduce

```powershell
npm run check
npm run stage-core
npm run build -w @yaqmc/desktop
npm run test:e2e:electron
npm run perf:windows-gpu
```

The retired host-specific collector is no longer a supported evidence path. Record Electron screenshots,
window-state evidence, and the exact tested commit separately; local unpacked output is not a release artifact.
