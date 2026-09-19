# GameCoach brand assets

First-pass identity in "The Study" palette. Original work for this project, GPL-3.0-only like the repo.

## Provenance
- The SVGs were hand-authored by Codex (no image-generation model was used). Codex hit its usage limit before it could rasterise anything or write this file.
- The PNGs were rendered from those SVGs by the orchestrator with headless Chrome and `sips`, using the self-hosted fonts in `packages/ui-study/fonts` so the text matches the app.

## Files
| File | Use |
| --- | --- |
| `logo-mark.svg` | The mark: a pawn with one small dot, the coach's quiet nudge. Square, two flat colours. |
| `logo-wordmark.svg`, `logo-wordmark-dark.svg` | Mark plus "GameCoach". Live text with the stack `'Playfair Display', Georgia, serif`; convert to outlines before using anywhere the font is not loaded. |
| `favicon.svg` | Mark tuned for small sizes; switches to parchment and gold under `prefers-color-scheme: dark`. |
| `favicon-32.png` | 32x32, transparent. |
| `apple-touch-icon.png` | 180x180, parchment background, padded. |
| `icon-192.png`, `icon-512.png` | Web app manifest icons, maskable: the ink sits inside the central 80% safe zone. |
| `og-image.svg`, `og-image.png` | 1200x630 social card. |

## Colours
Slate `#1e293b` (ink), baize `#2D5A3D` (the dot), walnut `#5C3D2E` (board), parchment `#FAF8F2` and `#F5F0E8` (grounds), gold `#C9A84C` (dot on dark). All from `packages/ui-study/styles/tokens.css`.

## Re-rendering the PNGs
Wrap the SVG in an HTML page that declares `@font-face` rules pointing at `packages/ui-study/fonts/*.woff2`, then:

```
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --hide-scrollbars --allow-file-access-from-files \
  --default-background-color=00000000 --window-size=1200,630 \
  --screenshot=og-image.png file:///path/to/og.html
sips -z 180 180 touch-512.png --out apple-touch-icon.png
```

Icons are rendered at 512x512 and downscaled with `sips -z`. For the icon pages the mark's ink box (x 13-53, y 8-56 of the 64 unit viewBox) is centred on the canvas at scale 9.0 (favicon), 6.4 (touch icon) and 5.2 (maskable).

## Known weaknesses
- At 16 px the dot is about one pixel and nearly disappears.
- The wordmark is live text, not outlines.
