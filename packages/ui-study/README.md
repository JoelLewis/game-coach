# @game-coach/ui-study

"The Study" design system: CSS tokens, typography, and board themes for GameCoach.

## Usage

Import in this order to ensure proper cascading:

```typescript
import "@game-coach/ui-study/styles/base.css";
import "@game-coach/ui-study/styles/tokens.css";
import "@game-coach/ui-study/styles/fonts.css";
import "@game-coach/ui-study/styles/board-themes.css";
import "@game-coach/ui-study/styles/study-surfaces.css";
import "@game-coach/ui-study/styles/grid-surface.css";
```

## Themes

Two themes control the visual appearance via the `[data-theme]` attribute on the root element:

- **`data-theme="study"`** (default): Warm palette with wooden board aesthetic
- **`data-theme="grid"`**: Dark neon cyberpunk aesthetic

## Font Families

All fonts are self-hosted:

- **"Source Serif 4"** (weight 400) — body text
- **"Playfair Display"** (weight 400) — headings
- **"JetBrains Mono"** (weight 400) — monospace (Study theme)
- **"Orbitron"** (weight 400) — headings (Grid theme)
- **"IBM Plex Sans"** (weight 400) — body text (Grid theme)
- **"IBM Plex Mono"** (weight 400) — monospace (Grid theme)

## Severity Colors

Token names for status indicators:

- `--cm-status-success` — success/positive states
- `--cm-status-error` — error/negative states
- `--cm-status-warning` — warning states
- `--cm-status-info` — informational states

## Fonts and Licenses

- PlayfairDisplay-Regular.woff2 — No license file found
- SourceSerif4-Regular.woff2 — No license file found
- JetBrainsMono-Regular.woff2 — No license file found
- Orbitron-Regular.woff2 — No license file found
- IBMPlexSans-Regular.woff2 — No license file found
- IBMPlexMono-Regular.woff2 — No license file found

**Origin:** `/Users/joellewis/code/teach-chess`
