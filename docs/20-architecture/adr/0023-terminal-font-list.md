# ADR-0023 Terminal font: offer only the monospace fonts installed on the device

Status: Accepted (2026-09-13). **Superseded by [ADR-0030](0030-no-settings.md)**: there is no font picker; the terminal always uses the system monospace stack (`--font-mono`). Before that, [ADR-0028](0028-settings-without-notes.md) had already withdrawn the requirement to explain missing ligatures in the settings panel; the fact itself is documented in [layout.md](../../40-frontend/layout.md).

## Context

Font size was adjustable (AC-5.3) but the font was not. xterm got a hard-coded fallback list:

```
ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas,
"Liberation Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace
```

On a Mac, `ui-monospace` resolves to SF Mono, so an installed JetBrains Mono never gets used. On a Linux box with only DejaVu there is nothing to choose from. People look at the terminal all day; the font deserves the same control as the size.

## Decision

Ship a hard-coded list of preferred monospace fonts, detect which ones are installed when settings opens, and offer only those. The list lives in [layout.md](../../40-frontend/layout.md); the implementation is `web/src/ui/fonts.ts`.

1. **Every entry is a full stack that ends in a CJK monospace font and `monospace`**, e.g. `"JetBrains Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace`. Almost no programming font has CJK glyphs. Without that tail, CJK text falls back to a proportional font and mixed-width columns misalign.
2. **One value, not one per breakpoint.** Font size depends on how big the screen is; the font depends on what the device has installed, which doesn't change when the window is resized. The key is `webterm.font.family`, and it stores an **id, not the stack**, so old settings still resolve if a stack is edited later.
3. **Changing the font changes the cell size, so call `fit()` and then send a `resize`.** The container hasn't changed size, so `ResizeObserver` won't fire. Without the explicit `resize`, client and PTY disagree on cols/rows and full-screen programs render misaligned. Font-size changes had the same bug; it was fixed at the same time.

### Detection: compare canvas `measureText` against three baselines

```ts
const BASES = ['monospace', 'serif', 'sans-serif']
const w = (family: string) => ctx.measureText(PROBE).width   // ctx.font = `72px ${family}`
const installed = (name: string) => BASES.some((b) => w(`"${name}", ${b}`) !== w(b))
```

- A font name that isn't installed is ignored, so `"X", serif` measures exactly like `serif`. If all three baselines match, the font is missing.
- **Comparing against `monospace` alone is not enough.** Menlo or Consolas may *be* the browser's default monospace font, measure the same, and be reported as missing. Any one baseline differing counts as installed.
- **Not `document.fonts.check()`.** Chrome returns `true` for names that aren't installed: it answers "have the web fonts in this list loaded", not "does this font exist locally". Used as a detector it would list everything.
- **Not `queryLocalFonts()`.** It shows a permission prompt and only exists in Chromium. Not worth it for a font picker.
- Cache the result for the life of the page. It can't change mid-session, and the settings panel may be opened many times.
- If no 2D canvas context is available, detection returns nothing and only "System default" remains. The feature disappears without an error.

### Rejected alternatives

- **Bundle a webfont via `go:embed`.** Doesn't break the single binary ([ADR-0002](0002-self-contained-binary.md)), but one weight is hundreds of KB, and what actually aligns mixed CJK/Latin text (Sarasa Mono SC) is around 10 MB. Size is unbounded and we'd have to handle a flash of unstyled text. System fonts have neither problem.
- **Let users type a font name.** A typo silently falls back and users can't tell why. A proportional font (Arial) wrecks column alignment. The curated list rules out both.
- **Guess the list by platform** (`navigator.platform`). Measuring is more accurate than guessing.

## Consequences

- The list is maintained by hand. Adding a new font is one line.
- **Ligatures don't render.** Fira Code / JetBrains Mono ligatures need xterm's `addon-ligatures`, which only works with the DOM renderer, and we use WebGL (AC-5.5). The list therefore prefers ligature-free variants (Cascadia Mono over Cascadia Code). Fonts with ligatures can still be picked; they just show plain glyphs. (This originally had to be stated in the settings panel; ADR-0028 withdrew that.)
- The UI chrome font (`--font-ui`) is not part of this setting. The terminal font is content; the chrome font is the shell around it. Mixing them would make "font" ambiguous in settings.
