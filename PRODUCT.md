# Product

## Register

product

## Users

Anyone who works with CSV datasets and needs to detect data quality issues, apply cleaning operations, and generate visualisations — without writing code. Context ranges from students and analysts doing one-off data investigations to developers who want a fast in-browser wrangling environment. The tool must feel capable enough for technical users and approachable enough for non-programmers.

## Product Purpose

MyDataWrangler.my is a serverless, browser-based data processing and visualisation tool. Users upload a CSV, inspect it for six categories of anomaly (missing values, duplicates, type mismatches, outliers, format inconsistencies, spelling errors), apply wrangling operations manually one at a time, and generate charts — all without a backend server. Python runs in-browser via Pyodide (WebAssembly). Success means a user can go from a messy CSV to a clean, exported dataset and a set of insight charts in a single session, with no installation and no data leaving their machine.

## Brand Personality

Confident, capable, precise.

The tool is quietly powerful — like Linear or Notion for data work. It does not shout; it delivers. The interface is dense enough for technical users without being intimidating. Every interaction is purposeful: nothing auto-applies, everything is one explicit click.

## Anti-references

- **Overly playful / consumer apps**: bright palette, oversized rounded corners, emoji-heavy UI, animations that feel like a social app. MyDataWrangler.my is a tool, not a toy.
- **Generic Bootstrap / Excel clones**: blue header bars, striped table rows, default browser form controls, spreadsheet-software aesthetics from 2012.
- **Generic dark SaaS (Vercel clone)**: pure-black bg, white text, purple accent — the oversaturated 2024 dark-mode default. The prussian-blue palette distinguishes MyDataWrangler.my from this lane.

## Design Principles

1. **One click, one change.** No operation is applied automatically. Every wrangling step is user-initiated and visible in the log. Trust through transparency.
2. **Data first.** The table, the report, the chart — these are the interface. Chrome, controls, and panels exist to serve the data, not to decorate it.
3. **Density without clutter.** Capable users tolerate dense layouts; overwhelmed users quit. Pack information tightly but leave breathing room at structural seams (between panels, between sections).
4. **Anomaly as signal, not alarm.** Quality issues are surfaced calmly with severity — not red banners and exclamation points. The tone is analytical, not panicked.
5. **Progressive disclosure.** Detection runs on load; remediation waits for a click; explanation is one hover away. Never show everything at once.

## Accessibility & Inclusion

WCAG 2.1 AA. Body text ≥4.5:1 against background. Interactive elements keyboard-navigable. Focus indicators visible. Reduced-motion respected for any transitions. ARIA labels on icon-only controls.
