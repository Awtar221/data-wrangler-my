# MyDataWrangler.my

**BAI21124 Data Processing and Visualisation — Project**

A serverless, browser-based data processing and visualisation tool. Upload a CSV, JSON, or Excel file, detect six categories of data quality anomaly, apply cleaning operations one explicit step at a time, and generate publication-styled charts — entirely in the browser, with no installation and no data ever leaving your machine.

---

## 1. Problem Statement

Real-world datasets are rarely analysis-ready. Missing values, duplicate records, wrong data types, outliers, inconsistent formats, and spelling errors silently distort statistics and produce misleading visualisations. Cleaning this data normally requires either programming skill (pandas, R) or expensive desktop software (Power BI, Tableau Prep) — and both typically require installing software and uploading data to third-party services, which is a barrier for students and a privacy risk for sensitive datasets.

**MyDataWrangler.my solves this problem**: it gives anyone with a web browser a complete data cleaning and visualisation workflow — no installation, no account, no server, no code. A full scientific Python stack (pandas, NumPy, Matplotlib, Seaborn) runs *inside the browser* via WebAssembly, so the dataset never leaves the user's machine.

## 2. Objectives

1. **Ensure data quality and reliability** — automatically detect six categories of anomaly (missing values, duplicates, type mismatches, outliers, inconsistent formats, spelling errors), recommend statistically appropriate fixes with visual evidence (distribution sparklines, box plots), and provide 17 manual cleaning operations plus direct in-place editing in Data Preview, with every step logged, undoable, and reversible.
2. **Create effective visualisations by applying design principles** — eight chart types rendered with a colour-blind-validated categorical palette, WCAG-checked contrast against the dark theme, recessive gridlines, and single-hue encoding for nominal series.
3. **Apply data processing and visualisation tools in a practical scenario** — deliver pandas/NumPy processing and Matplotlib/Seaborn charting through an approachable point-and-click interface usable by non-programmers.
4. **Guarantee transparency and trust** — nothing is applied automatically; every operation is user-initiated, recorded in an operation log, individually undoable, and the original dataset is always recoverable via Reset.

## 3. Technology Stack

| Layer | Technology | Role |
|---|---|---|
| Runtime | **Pyodide 0.27 (WebAssembly)** | Full CPython 3.12 interpreter running in the browser |
| Data processing | **pandas + NumPy** | DataFrame operations, cleaning, anomaly detection |
| Visualisation | **Matplotlib + Seaborn** (Agg backend) | Charts rendered to PNG in-browser |
| Fuzzy matching | **difflib** | Spelling / typo candidate detection |
| File formats | **openpyxl, xlrd** (lazy-loaded via micropip) | Excel `.xlsx` / `.xls` upload, installed on first use only |
| Frontend | **Vanilla JavaScript + Tailwind CSS** | Single-page UI, tabs, tables, operation forms |
| Dev server | **Python `http.server`** | Serves static files only — zero application logic |

There is no backend. The "server" is a static file host and can be replaced by GitHub Pages, Netlify, or any web server.

## 4. How MyDataWrangler.my Works

```
┌────────────────────────── Browser ──────────────────────────┐
│  UI (app.js)  ⇄  Pyodide bridge  ⇄  Python (WebAssembly)    │
│                                     ├─ cleaner.py           │
│                                     │   pandas DataFrame     │
│                                     │   quality report       │
│                                     │   17 wrangling ops     │
│                                     │   op log + undo        │
│                                     └─ visualizer.py         │
│                                         matplotlib → PNG     │
└──────────────────────────────────────────────────────────────┘
```

1. **Boot** — the page downloads the Pyodide runtime and Python packages (~30–60 MB, cached by the browser afterwards), then loads the app's two Python modules.
2. **Load data** — the primary path fetches a dataset directly from **data.gov.my** (Malaysia's official open data portal) via its Data Catalogue, OpenDOSM, or Weather APIs: enter a dataset ID (e.g. `fuelprice`) and the records load straight into a pandas DataFrame (nested fields auto-flattened). Alternatively, drop your own file — **CSV, JSON, or Excel** (`.xlsx`/`.xls`; multi-sheet workbooks prompt a sheet picker before loading). Excel support installs `openpyxl`/`xlrd` lazily on first use, so CSV/JSON-only sessions never pay that boot cost. A copy of the original is kept for Reset/Undo.
3. **Detect** — a quality report runs automatically over the whole dataset:

   | Anomaly | Detection method |
   |---|---|
   | Missing values | Null count + percentage per column |
   | Duplicate rows | Exact row matching |
   | Incorrect data types | Numeric / datetime parseability ratio (≥70%) |
   | Outliers | IQR method (Q1 − 1.5×IQR, Q3 + 1.5×IQR) |
   | Inconsistent formats | Date-pattern matching + casing distribution |
   | Spelling / typos | Fuzzy string matching (difflib, cutoff 0.85) |

   Each finding shows severity, and for missing values and outliers the report goes further:
   - an inline **mini chart** — a fixed-24-bin distribution histogram with mean/median markers for missing values (a dedicated skew-analysis histogram, separate from the compact one in Data Preview's column headers — see below), and a box plot with the actual outlier points drawn as red dots for outliers — so the user can *see* the shape of the data before deciding;
   - a **rule-based recommendation** with its reasoning, derived from the column's skewness and outlier share (e.g. right-skewed → fill with median, not mean; >5% outliers → cap rather than delete);
   - a **Fix with …** button that jumps to Wrangle with the column, operation, *and recommended method* pre-selected — but never applies anything automatically.

   Column names throughout the report are clickable and navigate to that column in the Data Preview table, and any finding can be **ignored** (and later restored) to keep the report focused on what matters.
4. **Wrangle** — the user picks one of 17 explicit operations (fill/drop missing, remove duplicates, convert types, split a date column into parts such as year/month/weekday, cap/remove/nullify outliers, standardise case and dates, fix typos, find & replace, filter rows, drop/rename columns, drop a row by number, promote a row to column headers, sort by a column), configures it, and clicks Apply. Date parsing is tolerant of mixed formats within one column. After each Apply, the Data Preview **highlights exactly which cells changed**, and the toast reports the cell/row counts; legends in the preview and column browser explain every colour cue.

   **Data Preview doubles as a direct-edit surface** — column headers show a Data Wrangler-style mini histogram, missing/distinct counts, and min/max, plus small icon controls: delete this column, or cycle a column's sort (ascending → descending → back to original order, which *undoes* the sort rather than stacking a new operation). Each row has a delete icon in its row-number gutter (row numbers are the DataFrame's real index labels, not page position, so they stay correct after earlier rows are removed). Double-clicking any cell edits its value in place. All of these route through the exact same logged/undoable pipeline as the Wrangle tab — no separate "view-only" mode to keep track of.
5. **Audit** — every applied operation appears in the Operation Log (shown directly inside the Wrangle tab) with its parameters. Any single operation can be undone: the app replays the remaining operations from the original data, so history stays consistent.
6. **Visualise** — eight chart types (histogram, bar, scatter with trend line and correlation coefficient, box plot with group-by, line, correlation heatmap, pie, and an automatic overview). Column pickers follow one convention — **first selector = X axis, second = Y axis** — and only offer columns whose type suits the slot (e.g. bar's X lists categories, including low-cardinality numerics like year). Bar and pie accept an optional numeric Y to aggregate (mean per category / share of total — e.g. % of drug arrests by sex); charts that cannot be drawn explain why instead of failing silently. Charts render via Matplotlib in-browser with a validated dark-theme palette, and each can be **downloaded as a JPG** from its card.
7. **Export** — the cleaned dataset downloads as CSV directly from the browser; no server round-trip. **Close** returns to the upload screen; if unexported operations would be discarded, a confirmation dialog offers **Export CSV & Close** in one step.

## 5. How to Run

Requires only Python 3 (for the local static file server) and a modern browser.

```bash
# from the project folder
python serve.py

# then open
http://localhost:5000
```

No `pip install` is needed to run the app — all data processing packages load inside the browser via the Pyodide CDN. The first load takes 30–60 seconds while the runtime downloads (a progress bar tracks it); subsequent loads use the browser cache.

Alternatively, the `templates/` + `static/` files can be hosted on any static web host — the application is fully client-side.

> `requirements.txt` lists optional packages for running the Python modules locally during development/testing only.

## 6. Design Principles Applied

- **Trust through transparency** — no operation auto-applies; everything is one explicit click, logged and undoable.
- **Colour-blind-safe charting** — the eight-slot categorical palette was validated for CVD (colour-vision-deficiency) separation, lightness band, chroma floor, and ≥3:1 contrast against the chart surface.
- **One nominal series, one hue** — bar charts do not rainbow-colour a single series; bar length carries the value.
- **Anomaly as signal, not alarm** — quality issues are ranked by severity and presented analytically, not as red-alert banners.
- **Accessibility** — WCAG AA contrast targets, keyboard-navigable controls, ARIA labelling, `prefers-reduced-motion` support, and a **text-size slider** (in the tab bar and on the upload page) that scales the whole interface up to 125% while keeping every panel scrollable.

## 7. Findings & Conclusion

Running a full scientific Python stack in WebAssembly is a practical architecture for data tools: after a one-time runtime download, cleaning and charting a several-hundred-thousand-cell CSV is interactive-speed, and the zero-server design eliminates both deployment cost and data privacy risk. The main trade-offs observed are the initial ~30–60 s boot and memory limits inherited from the browser tab — acceptable for the classroom- and analyst-scale datasets this tool targets. Detailed methodology, screenshots, and evaluation are presented in the accompanying project report.
