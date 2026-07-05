# MyDataWrangler.my — Report Brief (for report writer)

Compact facts sheet. Everything below is true of the implementation; expand into report sections (Introduction, Objective, Method, Process/Design, Conclusion), Times New Roman 12, 1.5 spacing, IEEE references.

## What it is
Browser-only CSV cleaning + visualisation tool. Python (pandas, NumPy, Matplotlib, Seaborn) runs **inside the browser** via Pyodide (WebAssembly). No backend, no install, no data leaves the machine. Run: `python serve.py` → http://localhost:5000 (server only serves static files).

## Problem
Messy CSVs (missing values, duplicates, wrong types, outliers, inconsistent formats, typos) distort analysis. Existing fixes need coding skill (pandas/R) or installed software (Tableau Prep/Power BI) and often upload data to third parties. MyDataWrangler.my removes all three barriers: no code, no install, no data upload.

## Objectives (mirror the CLOs)
1. Ensure data quality/reliability: detect 6 anomaly types, fix with 15 manual operations, all logged + undoable.
2. Effective visualisation via design principles: 8 chart types, colour-blind-validated palette, WCAG contrast.
3. Apply processing/visualisation tools practically: point-and-click pandas + Matplotlib for non-programmers.

## Method / pipeline (7 steps)
1. **Boot**: browser downloads Pyodide runtime (~30–60 MB, cached after first load).
2. **Load**: primary path = live fetch from data.gov.my open data API (Data Catalogue / OpenDOSM / Weather endpoints; JSON records → json_normalize → DataFrame, nested fields auto-flattened); secondary = CSV upload. Original copy kept.
3. **Detect** (automatic quality report): missing = null %, duplicates = exact match, type issues = ≥70% parseable as numeric/datetime, outliers = IQR (Q1−1.5×IQR, Q3+1.5×IQR), format issues = date-pattern + casing analysis, typos = difflib fuzzy match (cutoff 0.85). Findings ranked by severity; "Fix" buttons pre-fill operations but never auto-apply. Missing/outlier findings additionally show inline mini charts (distribution histogram with mean+median markers; box plot with outlier dots) and a rule-based recommendation with stated reasoning: |skew| ≤ 0.5 → mean fill, skewed → median, categorical → mode; outliers >5% or heavy skew → cap (Winsorize), else remove.
4. **Wrangle**: 15 explicit ops — fill missing (mean/median/mode/ffill/bfill/zero/custom), drop missing rows, remove duplicates, convert type, split date into parts (year/quarter/month/month name/day/weekday/hour → new columns), handle outliers (cap/remove/nullify/z-score), standardise case, standardise dates, trim whitespace, fix typos, find & replace, filter rows, drop column, rename column. Date parsing tolerates mixed formats per column (pandas format='mixed'). After each Apply, Data Preview highlights exactly which cells changed (cell-level before/after diff) and reports rows-removed/cells-changed counts; colour legends explain all cell/dot cues.
5. **Audit**: operation log (embedded in Wrangle tab); any single op undoable (replays the rest from original data). Quality findings can be ignored/restored without touching data.
6. **Visualise**: consistent convention first selector = X, second = Y, and pickers only list type-suitable columns (categories incl. ≤20-unique numerics for bar/pie/box-group X). Histogram, bar (optional numeric Y → mean per category), scatter (+trend line, r), box (+group-by, red outlier dots), line, correlation heatmap, pie (optional numeric Y → share of its total per category, e.g. % of arrests by sex), auto-overview. Matplotlib renders PNG in-browser; every chart downloadable as JPG; undrawable charts explain why (e.g. heatmap needs ≥2 numeric columns).
7. **Export**: cleaned CSV downloads directly from browser.

## Design decisions worth citing
- **Transparency**: nothing auto-applies; one click = one logged, undoable change.
- **Chart palette**: 8 categorical hues validated for colour-vision-deficiency separation, lightness band, chroma floor, ≥3:1 contrast on the dark chart surface. Single nominal series = single hue (no rainbow bars).
- **Accessibility**: WCAG AA contrast, keyboard navigation, ARIA labels, reduced-motion support.
- Dark "tool-grade" UI (prussian blue palette), density-first layout.

## Originality angle (10-mark rubric row)
Full scientific Python stack in WebAssembly = no server, zero deployment cost, complete data privacy. Unusual architecture vs typical Flask/Streamlit student projects.

## Findings / limitations (for Conclusion)
- Interactive speed on classroom-scale CSVs (hundreds of thousands of cells) after boot.
- Trade-offs: 30–60 s first-load boot; memory bounded by browser tab.

## Stack (one line)
Pyodide 0.27 (CPython 3.12/WASM) · pandas · NumPy · Matplotlib · Seaborn · difflib · vanilla JS + Tailwind CSS · Python http.server (static only).
