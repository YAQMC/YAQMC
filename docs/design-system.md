# Design system

The visual system is intentionally small. `src/styles/tokens.css` defines color, type, spacing, radius,
shadow, and motion primitives. `src/application/theme-tokens.ts` overlays the resolved color mode, user accent
pair, safe surface alpha, and material preference. Shared controls, artwork, media cards, track rows, and context
panels consume those tokens; pages do not introduce separate design languages or embed user colors directly.

The chrome uses restrained neutral surfaces so local album artwork carries most of the color. A single
contained color wash may support hierarchy in a hero, but translucency and gradients are not general-purpose
panel decoration. Focus rings, semantic buttons, keyboard playback/search shortcuts, and reduced-motion
handling are part of the component contract.

## Settings controls

Settings sections use a predictable title/description/control row, separators, and spacing instead of nested
cards. Toggle, slider, color, text, number, button, and preview controls share the same surface, radius, focus, and
disabled-state hierarchy. Color never communicates critical state alone.

`src/components/ui/Select.tsx` replaces primary browser-native selects. Its portal menu is positioned against the
trigger and constrained above or below the viewport. It provides listbox/combobox semantics, selected and active
states, visible focus, disabled options, click-outside dismissal, and keyboard handling for Enter, Space, arrows,
Home, End, and Escape. Menus use the same tokenized borders, shadow, radius, and reduced-motion behavior as the
rest of the application.

Application appearance and lyric-surface appearance are separate domains. Main-window transparency does not
implicitly modify lyric text colors or lyric-window opacity. Compact previews explain theme, background, Desktop
Lyrics, and Lyrics Island settings without becoming decorative hero content.

The desktop target has a 1000×680 minimum Tauri window. Layouts also tighten at 1120px and reduced-height
windows. Windows and Linux should share information hierarchy and interaction behavior even when later
native integrations differ.

See [appearance](appearance.md), [internationalization](i18n.md), and
[lyrics surfaces](lyrics-surfaces.md) for the corresponding component contracts.
