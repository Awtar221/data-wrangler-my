# DataWrangler — Report Brief (for report writer)

Compact facts sheet. Everything below is true of the implementation; expand into report sections (Introduction, Objective, Method, Process/Design, Conclusion), Times New Roman 12, 1.5 spacing, IEEE references.

## What it is
Browser-only CSV cleaning + visualisation tool. Python (pandas, NumPy, Matplotlib, Seaborn) runs **inside the browser** via Pyodide (WebAssembly). No backend, no install, no data leaves the machine. Run: `python serve.py` → http://localhost:5000 (server only serves static files).

## Problem
Messy CSVs (missing values, duplicates, wrong types, outliers, inconsistent formats, typos) distort analysis. Existing fixes need coding skill (pandas/R) or installed software (Tableau Prep/Power BI) and often upload data to third parties. DataWrangler removes all three barriers: no code, no install, no data upload.

## Objectives (mirror the CLOs)
1. Ensure data quality/reliability: detect 6 anomaly types, fix with 14 manual operations, all logged + undoable.
2. Effective visualisation via design principles: 8 chart types, colour-blind-validated palette, WCAG contrast.
3. Apply processing/visualisation tools practically: point-and-click pandas + Matplotlib for non-programmers.

## Method / pipeline (7 steps)
1. **Boot**: browser downloads Pyodide runtime (~30–60 MB, cached after first load).
2. **Load**: CSV upload, or live fetch from data.gov.my open data API (Data Catalogue / OpenDOSM / Weather endpoints; JSON records → json_normalize → DataFrame, nested fields auto-flattened); original copy kept.
3. **Detect** (automatic quality report): missing = null %, duplicates = exact match, type issues = ≥70% parseable as numeric/datetime, outliers = IQR (Q1−1.5×IQR, Q3+1.5×IQR), format issues = date-pattern + casing analysis, typos = difflib fuzzy match (cutoff 0.85). Findings ranked by severity; "Fix" buttons pre-fill operations but never auto-apply.
4. **Wrangle**: 14 explicit ops — fill missing (mean/median/mode/ffill/bfill/zero/custom), drop missing rows, remove duplicates, convert type, handle outliers (cap/remove/nullify/z-score), standardise case, standardise dates, trim whitespace, fix typos, find & replace, filter rows, drop column, rename column.
5. **Audit**: operation log; any single op undoable (replays the rest from original data).
6. **Visualise**: histogram, bar, scatter (+trend line, r), box (+group-by), line, correlation heatmap, pie, auto-overview. Matplotlib renders PNG in-browser.
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
