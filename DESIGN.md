# Design System

## Theme

Dark, tool-grade interface. Deep prussian-blue backgrounds — not pure black, not navy-corporate — give the app a distinct identity separate from generic dark-mode SaaS. The three-level surface stack (bg → surface → surface-2) creates spatial depth without needing drop shadows. Cerulean accent (`#19b9e6`) carries all interactive affordances; the blue-violet primary (`#3357cc`) anchors structural selections.

**Strategy**: Restrained committed — the prussian-blue hue runs across all surfaces and structural elements, with cerulean as the sole interactive accent. Color serves navigation and state, not decoration.

---

## Color Tokens

```css
:root {
  /* Surfaces */
  --bg:        #070c1d;   /* page bg — prussian-950 */
  --surface:   #0a1129;   /* panel bg — prussian-900 */
  --surface-2: #142352;   /* elevated, table headers — prussian-800 */

  /* Borders */
  --border:    #1f347a;   /* structural borders — prussian-700 */

  /* Brand */
  --primary:   #3357cc;   /* primary buttons, selection bg — prussian-500 */
  --primary-h: #2945a3;   /* primary hover — prussian-600 */
  --accent:    #19b9e6;   /* interactive: active tabs, focus rings, column highlight — cerulean-500 */
  --highlight: #0684f9;   /* chart accent / type badges — yale-500 */
  --cerulean:  #47c7eb;   /* accent hover, chart lines — cerulean-400 */

  /* Text */
  --text:      #ebeefa;   /* primary text — prussian-50 */
  --muted:     #adbceb;   /* secondary text, form labels, column names — prussian-200 */
  --faint:     #5c78d6;   /* tertiary — prussian-400. ⚠ min use on body text; verify 4.5:1 per context */

  /* Semantic */
  --ok:        #22c55e;   /* quality dot: clean column */
  --warn:      #f59e0b;   /* quality dot / outlier cells: caution */
  --danger:    #ef4444;   /* quality dot: critical missing / error */
}
```

**Contrast notes (WCAG 2.1 AA target)**
- `--text` (`#ebeefa`) on `--bg` (`#070c1d`): ~14:1 ✓
- `--muted` (`#adbceb`) on `--bg` (`#070c1d`): ~6.8:1 ✓
- `--muted` on `--surface-2` (`#142352`): ~5.1:1 ✓
- `--faint` (`#5c78d6`) on `--bg`: ~3.1:1 ✗ at 11px — avoid for body text; use only for decorative numbering (log-num) or 14px+ with weight ≥600
- `--accent` (`#19b9e6`) on `--bg`: ~5.8:1 ✓ for interactive labels

---

## Typography

```
Display:  Oxanium 500/600/700  — logo, section headers, summary cards
Body:     Inter 400/500/600    — all prose, labels, UI copy
Mono:     JetBrains Mono 300/400/500 — data values, column names, code, log entries
```

**Scale (functional, not decorative)**

| Role | Size | Weight | Font | Token |
|---|---|---|---|---|
| App title / logo | 14px | 600 | Oxanium | `font-display font-semibold` |
| Boot heading | 30px | 700 | Oxanium | `text-3xl font-bold font-display` |
| Section header | 12px | 700 | Inter | uppercase + tracking |
| Body / labels | 12px | 400–500 | Inter | default |
| Small / meta | 11px | 400 | Inter | `text-xs` |
| Tiny / badge | 9–10px | 600–700 | Inter | uppercase, tracking, pill |
| Table headers | 10px | 600 | Inter | uppercase, letter-spacing 0.05em |
| Table data | 11px | 400 | JetBrains Mono | data cells |
| Log / badge values | 10px | 400 | JetBrains Mono | log-num, shape badge |

**Letter-spacing**: Only uppercase labels use tracking (`0.05–0.06em`). Display headings are set at browser default (0). Never negative on sans-serif body text.

---

## Spacing & Layout

**App shell**: Full-viewport, overflow-hidden. Header 44px → tab bar 36px → three-column body (fills remaining height). No page scroll; each panel scrolls internally.

**Three-column body**:
- Left (column browser): `w-52` (208px), fixed
- Main: `flex-1`, min-width 0
- Right (ops panel, when present): `w-64` (256px), fixed

**Internal spacing rhythm**:
- Panel padding: `px-3 py-2` (12px × 8px) for sidebar rows; `p-4` (16px) for content areas
- Table cell padding: `4px 12px`
- Card padding: `14px 16px`
- Gap between items in a form: `space-y-3` (12px)

**Z-index scale** (defined inline, not named):
- Boot overlay: 200
- Toast container: 100
- Table sticky header: 10
- Top bar: 50

---

## Components

### Buttons

Three variants — all `border-radius: 6px`, `display: inline-flex`, `align-items: center`:

| Variant | Class | Use |
|---|---|---|
| Primary | `.btn-primary` | Export CSV, secondary confirms |
| Accent | `.btn-accent` | Apply Operation (primary CTA) |
| Ghost | `.btn-ghost` | Reset, pagination, cancel |
| Micro | `.op-btn` | Quick-fix buttons inside quality cards, per-op shortcuts |

All have `transform: scale(0.97)` on `:active`. No `:focus-visible` ring yet — **a11y gap to fix**.

### Tabs

Bottom-border indicator (`border-bottom: 2px solid var(--accent)` when active). Active tab: `--text`; inactive: `--faint` (see contrast note above — acceptable at this size because it's non-body, icon-adjacent). Hover: `--muted`.

### Column Browser

`.col-item` rows: `border-left: 2px solid var(--accent)` on `.selected` state. This is a VS Code-style selection pattern (intentional, fits the tool register). The impeccable side-stripe rule targets decorative cards/callouts, not interactive list selection indicators. Distinct from the ban.

Type badges: 9px mono, colored by type (num = blue, str = cerulean, dt = purple). Quality dots: 5px circles right-aligned (green/amber/red).

### Data Table

Sticky headers (`--surface-2` bg). Monospace data cells. Special cell states: `.null-cell` (desaturated, italic), `.outlier-cell` (amber), `.col-selected` (subtle cerulean tint).

### Cards (`.quality-card`)

Single use: quality report sections and the wrangle operation config area. Not nested. `border-radius: 8px`, `border: 1px solid var(--border)`, `background: var(--surface)`.

### Severity Pills (`.severity-pill`)

9px uppercase mono badges: HIGH (red tint), MED (amber tint), LOW / TYPE / DATE / CASE / TYPO (primary tint). Used only inside quality report anomaly rows.

### Form Controls (`.select-field`, `.input-field`)

`--surface-2` background, `--border` border, focus border → `--accent`. No box-shadow on focus — **a11y gap**: add `outline: 2px solid var(--accent); outline-offset: 1px` on `:focus-visible` to meet WCAG 2.4.7.

### Toasts

Bottom-right stack. Slide-in from below (`translateY(8px) → 0`). Semantic border + background tint (no side stripe). `box-shadow: 0 4px 20px rgba(0,0,0,0.5)`.

### Spinner

16px circular CSS spinner, `border-top-color: var(--accent)`, 0.7s linear infinite. Used inline with buttons and viz generate.

---

## Motion

**Current state**: Restrained and state-driven — tab content fade (0.15s), toast slide-in (0.2s), boot progress bar (0.5s), button active scale (0.1s), chart cards fade+rise on generate (0.3s, 50ms stagger per card capped at 8, `--ease-out-quart`), chart card hover (border + shadow, 0.15s). Global `prefers-reduced-motion` guard in `style.css` collapses all animation/transition durations.

**Intent**: Motion should signal state change, not decorate. The tool register demands restraint — no entrance animations on data tables, no scroll reveals. The chart-gallery stagger is generate-feedback on a real list (legitimate list rhythm), not page choreography.

---

## Chart Palette (matplotlib, `static/py/visualizer.py`)

Categorical series slots, validated (OKLCH lightness band, chroma floor, CVD
adjacent-pair separation, ≥3:1 contrast) against the chart surface `#142352`:

```
1 blue    #3987e5   (SERIES — single-series marks: histogram, bar, scatter, line)
2 aqua    #199e70
3 yellow  #c98500   (EMPH — reference/annotation lines: mean, trend)
4 green   #008300
5 violet  #9085e9
6 red     #e66767
7 magenta #d55181
8 orange  #d95926
```

Rules: fixed slot order (CVD-safety mechanism — never reorder or cycle); one
nominal series = one hue (no rainbow bars); pie wedges use slots 1..N with a 2px
surface-coloured spacer edge; correlation heatmap uses a blue↔red diverging map
with a dark midpoint so zero recedes; gridlines are `--border` at 45% alpha
behind the data; annotation text wears text tokens (`--text`/`--muted`), never
the series colour.

---

## Known Gaps (for follow-up)

1. **No `:focus-visible` rings** on buttons or form controls — WCAG 2.4.7 failure.
2. **`--faint` on small text** — 3.1:1 contrast; avoid for informational body text.
3. ~~No `prefers-reduced-motion` guard~~ — fixed: global guard in `style.css`.
4. **No ARIA labels** on icon-only SVG controls (tab icons, column type badges).
5. **`null-cell` colour** (`#3d4e7a`) on `--surface` — approximately 1.5:1; decorative-only, but should be bumped to at least `--faint` if it conveys meaning (which it does — null state).
