/* ── State ──────────────────────────────────────────────────────────────── */
const S = {
  pyodide:     null,
  columns:     [],
  dtypes:      {},
  stats:       {},
  quality:     {},
  opLog:       [],
  selectedCol: null,
  currentPage: 0,
  totalRows:   0,
  pageSize:    100,
  ignored:     new Set(),   // quality findings the user chose to ignore ("section:col")
  sortCol:     null,        // column currently sorted by (backend-persisted, not a view-only sort)
  sortDir:     null,        // 'asc' | 'desc' | null
};

/* ── Boot: load Pyodide + packages + Python modules ────────────────────── */
async function boot() {
  const bar    = document.getElementById('boot-bar');
  const status = document.getElementById('boot-status');

  const progress = document.getElementById('boot-progress');
  const step = (pct, msg) => {
    bar.style.width = pct + '%';
    status.textContent = msg;
    progress?.setAttribute('aria-valuenow', pct);
  };

  try {
    step(5, 'Loading Pyodide runtime…');
    S.pyodide = await loadPyodide();

    step(30, 'Installing pandas + numpy…');
    await S.pyodide.loadPackage(['pandas', 'numpy', 'matplotlib', 'Pillow', 'micropip']);

    step(65, 'Installing seaborn…');
    await S.pyodide.runPythonAsync(`
      import micropip
      await micropip.install('seaborn')
    `);

    step(80, 'Loading data modules…');
    // cache-buster: never run a stale cached copy of the Python modules
    const v = Date.now();
    const [cleanerSrc, vizSrc] = await Promise.all([
      fetch(`static/py/cleaner.py?v=${v}`).then(r => r.text()),
      fetch(`static/py/visualizer.py?v=${v}`).then(r => r.text()),
    ]);
    await S.pyodide.runPythonAsync(cleanerSrc);
    await S.pyodide.runPythonAsync(vizSrc);

    step(100, 'Ready');
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('boot-overlay').remove();

    initUI();
  } catch (err) {
    status.textContent = 'Boot failed: ' + err.message;
    status.style.color = '#f87171';
    console.error(err);
  }
}

/* ── Python bridge ──────────────────────────────────────────────────────── */
async function py(code) {
  return S.pyodide.runPythonAsync(code);
}

/* ── Toast ──────────────────────────────────────────────────────────────── */
function toast(msg, type = 'info', ms = 3500) {
  const el = Object.assign(document.createElement('div'), { className: `toast ${type}`, textContent: msg });
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ── Upload ─────────────────────────────────────────────────────────────── */
const FORMAT_MAP = {
  csv:  { kind: 'text',     loader: 'load_csv'     },
  json: { kind: 'text',     loader: 'load_records' },
  xlsx: { kind: 'workbook', pkg: 'openpyxl', label: 'Excel (.xlsx)' },
  xls:  { kind: 'workbook', pkg: 'xlrd',     label: 'Excel (.xls)'  },
};

async function finishLoad(pyCall, filename) {
  const raw = await py(pyCall);
  applyState(JSON.parse(raw));
  enterWorkspace(filename);
}

async function pySetBytes(name, file) {
  S.pyodide.globals.set(name, new Uint8Array(await file.arrayBuffer()));
}

/* Lazily micropip-install a format's parser package on first use, so
   CSV/JSON-only users never pay the extra boot cost for Excel support. */
const S_installedPkgs = new Set();
async function ensurePackage(pkgName, label) {
  if (S_installedPkgs.has(pkgName)) return;
  const label_ = document.querySelector('#upload-progress span');
  const prevText = label_?.textContent;
  if (label_) label_.textContent = `Installing ${label} support…`;
  try {
    S.pyodide.globals.set('_pkg_name', pkgName);
    await py(`
import micropip
await micropip.install(_pkg_name)
    `);
    S_installedPkgs.add(pkgName);
  } finally {
    if (label_ && prevText) label_.textContent = prevText;
  }
}

/* Generic "pick one item, then load" panel — used by the Excel sheet picker. */
function promptItemChoice({ file, title, items, loaderFn }) {
  return new Promise((resolve) => {
    const panel     = document.getElementById('item-picker');
    const select    = document.getElementById('item-picker-select');
    const loadBtn   = document.getElementById('item-picker-load');
    const cancelBtn = document.getElementById('item-picker-cancel');

    document.getElementById('item-picker-title').textContent = title;
    document.getElementById('item-picker-filename').textContent = file.name;
    select.innerHTML = items.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    panel.classList.remove('hidden');
    document.getElementById('upload-progress').classList.add('hidden');

    const cleanup = () => { panel.classList.add('hidden'); loadBtn.onclick = null; cancelBtn.onclick = null; };
    loadBtn.onclick = async () => {
      cleanup();
      document.getElementById('upload-progress').classList.remove('hidden');
      try {
        await finishLoad(loaderFn(select.value), file.name);
      } catch (err) {
        showUploadError(err.message);
      } finally {
        document.getElementById('upload-progress').classList.add('hidden');
        resolve();
      }
    };
    cancelBtn.onclick = () => { cleanup(); resolve(); };
  });
}

async function handleUpload(file) {
  const ext = file ? file.name.toLowerCase().split('.').pop() : '';
  const fmt = FORMAT_MAP[ext];
  if (!file || !fmt) {
    showUploadError(`Unsupported file type. Supported: ${Object.keys(FORMAT_MAP).map(e => '.' + e).join(', ')}.`);
    return;
  }
  showUploadError('');
  document.getElementById('upload-progress').classList.remove('hidden');

  try {
    if (fmt.kind === 'text') {
      const text = await file.text();
      S.pyodide.globals.set('_text_raw', text);
      await finishLoad(`${fmt.loader}(_text_raw)`, file.name);
    } else if (fmt.kind === 'workbook') {
      await ensurePackage(fmt.pkg, fmt.label);
      await pySetBytes('_bin_raw', file);
      const sheets = JSON.parse(await py('list_excel_sheets(_bin_raw)'));
      if (!sheets.length) throw new Error('No worksheets found in this file.');
      if (sheets.length > 1) {
        await promptItemChoice({ file, title: 'Choose a sheet', items: sheets,
          loaderFn: (v) => `load_excel(_bin_raw, ${JSON.stringify(v)})` });
      } else {
        await finishLoad(`load_excel(_bin_raw, ${JSON.stringify(sheets[0])})`, file.name);
      }
    }
  } catch (err) {
    showUploadError(err.message);
  } finally {
    document.getElementById('upload-progress').classList.add('hidden');
  }
}

/* ── data.gov.my API ────────────────────────────────────────────────────── */
const API_BASE = 'https://api.data.gov.my/';

function apiNeedsId() {
  return !document.getElementById('api-source').value.startsWith('weather');
}

function updateApiControls() {
  document.getElementById('api-id').classList.toggle('hidden', !apiNeedsId());
}

async function loadFromApi() {
  const source = document.getElementById('api-source').value;
  const id     = document.getElementById('api-id').value.trim();
  const status = document.getElementById('api-status');
  const btn    = document.getElementById('btn-api-load');

  if (apiNeedsId() && !id) { toast('Enter a dataset ID (see the data.gov.my Data Catalogue page).', 'error'); return; }

  const url = new URL(API_BASE + source);
  if (apiNeedsId()) url.searchParams.set('id', id);

  btn.disabled = true;
  status.classList.remove('hidden');
  status.textContent = 'Fetching from data.gov.my…';

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`data.gov.my responded ${r.status} — check the dataset ID.`);
    const data = await r.json();
    const records = Array.isArray(data) ? data : (data.data ?? []);
    if (!records.length) throw new Error('The API returned no rows for this query.');

    status.textContent = `Parsing ${records.length.toLocaleString()} rows…`;
    S.pyodide.globals.set('_api_json', JSON.stringify(records));
    const raw = await py('load_records(_api_json)');
    applyState(JSON.parse(raw));
    enterWorkspace(`data.gov.my — ${apiNeedsId() ? id : source}`);
    toast(`Loaded ${records.length.toLocaleString()} rows from data.gov.my`, 'success');
    status.classList.add('hidden');
  } catch (err) {
    status.textContent = err.message;
    status.className = 'text-red-400 text-xs mt-2';
  } finally {
    btn.disabled = false;
  }
}

function showUploadError(msg) {
  const el = document.getElementById('upload-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

/* ── Apply server (Python) state ────────────────────────────────────────── */
function applyState(data) {
  if (data.stats)   { S.stats   = data.stats; }
  if (data.quality) { S.quality = data.quality; }
  if (data.preview) {
    S.columns     = data.preview.columns     ?? S.columns;
    S.dtypes      = data.preview.dtypes      ?? S.dtypes;
    S.totalRows   = data.preview.total_rows  ?? S.totalRows;
    S.currentPage = data.preview.page        ?? 0;
    renderTable(data.preview);
  }
  if (data.op_log)  { S.opLog   = data.op_log; renderLog(); }

  renderColumnList();
  updateShapeBadge();
  updateQualityBadge();
  updateLogBadge();
  populateOpColumnSelect();
}

/* ── Workspace transition ───────────────────────────────────────────────── */
function enterWorkspace(filename) {
  S.ignored = new Set();
  document.getElementById('upload-screen').style.display = 'none';
  document.getElementById('workspace').style.display = 'flex';
  document.getElementById('top-actions').style.display = 'flex';
  document.getElementById('file-label').textContent = filename;
  switchTab('preview');
}

/* ── Shape badge ────────────────────────────────────────────────────────── */
function updateShapeBadge() {
  document.getElementById('shape-badge').textContent =
    `${S.totalRows.toLocaleString()} rows  ×  ${S.columns.length} cols`;
}

/* ── Column browser ─────────────────────────────────────────────────────── */
function renderColumnList() {
  const qr   = S.quality;
  const list = document.getElementById('column-list');
  list.innerHTML = S.columns.map(col => {
    const dtype = S.dtypes[col] ?? '';
    const isNum = dtype.startsWith('int') || dtype.startsWith('float');
    const isDt  = dtype.startsWith('datetime');
    const tcls  = isNum ? 'col-type-num' : isDt ? 'col-type-dt' : 'col-type-obj';
    const tlbl  = isNum ? 'num' : isDt ? 'dt' : 'str';

    // ignored findings read as resolved for this dot, same as an actual fix
    const has = (section) => qr[section]?.[col] && !S.ignored.has(`${section}:${col}`);
    let dot = 'dot-ok';
    if (has('missing') || has('type_issues') || has('outliers') ||
        has('inconsistent_formats') || has('typo_candidates')) dot = 'dot-warn';
    if (has('missing') && (qr.missing[col]?.pct ?? 0) > 30) dot = 'dot-error';

    const sel = col === S.selectedCol ? 'selected' : '';
    return `<div class="col-item ${sel}" role="listitem button" tabindex="0" onclick="gotoColumn('${esc(col)}')" onkeydown="if(event.key==='Enter'||event.key===' ')gotoColumn('${esc(col)}')" aria-pressed="${col === S.selectedCol}" title="View ${esc(col)} in Data Preview">
      <span class="col-type-badge ${tcls}" aria-label="${tlbl} column">${tlbl}</span>
      <span class="flex-1 truncate">${esc(col)}</span>
      <span class="col-quality-dot ${dot}" aria-hidden="true"></span>
    </div>`;
  }).join('');
}

function selectCol(col, { toggle = true } = {}) {
  if (toggle && S.selectedCol === col) col = null;   // clicking the selected column deselects it
  S.selectedCol = col;
  renderColumnList();
  highlightTableCol(col);
  // Pre-fill the wrangle tab's column selector
  const sel = document.getElementById('op-column');
  if (sel) sel.value = col ?? '';
}

/* Select a column AND navigate to it in the Data Preview table.
   Toggles off (stays put) if the sidebar row clicked is already selected. */
function gotoColumn(col) {
  const deselecting = S.selectedCol === col;
  selectCol(col);
  if (deselecting) return;                 // toggled off — stay put, no navigation
  navigateToColumn(col);
}

/* Always select + navigate, never toggles off — used by quality report and
   log links, where clicking a reference to the selected column should still jump there */
function viewColumn(col) {
  selectCol(col, { toggle: false });
  navigateToColumn(col);
}

function navigateToColumn(col) {
  switchTab('preview');
  requestAnimationFrame(() => {
    const idx = S.columns.indexOf(col);
    if (idx < 0) return;
    document.querySelectorAll('#table-head th')[idx + 1]   // +1: leading row-number column
      ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });
}

/* Clickable column name used across the quality report */
function colLink(col, extra = '') {
  return `<button class="col-link log-col text-left ${extra}" onclick="viewColumn('${esc(col)}')" title="View this column in Data Preview">${esc(col)}</button>`;
}

/* ── Data table ─────────────────────────────────────────────────────────── */
function renderTable(preview) {
  const { columns, data, total_rows, page, page_size, row_index } = preview;
  const start = page * page_size;
  const end   = Math.min(start + page_size, total_rows);

  document.getElementById('preview-range').textContent =
    `Rows ${start + 1}–${end} of ${total_rows.toLocaleString()}`;
  document.getElementById('page-info').textContent =
    `Page ${page + 1} / ${Math.ceil(total_rows / page_size)}`;

  const changedByCol = {};
  for (const [c, positions] of Object.entries(preview.changed_cells ?? {})) {
    changedByCol[c] = new Set(positions);
  }

  document.getElementById('table-head').innerHTML =
    `<tr><th class="row-num-header" title="Row number — use this to target Drop Row / Promote Row to Header">#</th>${columns.map(c => headerCell(c)).join('')}</tr>`;

  document.getElementById('table-body').innerHTML = data.map((row, ri) => {
    const idx = row_index?.[ri];
    return `<tr><td class="row-num-cell">
      <span class="row-num">${idx ?? ''}</span>
      <button class="row-delete-btn" onclick="dropRowDirect(${idx})" title="Remove row ${idx}" aria-label="Remove row ${idx}">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </td>${columns.map(c => {
      const val     = row[c];
      const isNull  = val === null || val === undefined;
      const changed = changedByCol[c]?.has(ri);
      const colSel  = c === S.selectedCol ? 'col-selected' : '';
      const cls     = [colSel, changed ? 'changed-cell' : '', isNull ? 'null-cell' : ''].filter(Boolean).join(' ');
      const tip     = changed ? 'Changed by the last operation' : (isNull ? 'null — double-click to edit' : esc(String(val)));
      return `<td class="${cls}" title="${tip}" data-row="${idx}" data-col="${esc(c)}" data-value="${isNull ? '' : esc(String(val))}" ${isNull ? 'data-null="1"' : ''} ondblclick="editCell(this)">${esc(isNull ? 'null' : String(val).slice(0, 60))}</td>`;
    }).join('')}</tr>`;
  }).join('');
}

/* Data Wrangler-style header: name, missing/distinct counts, mini histogram, min/max */
function headerCell(c) {
  const st = S.stats[c] ?? {};
  const missingPct  = st.null_pct ?? 0;
  const distinctPct = S.totalRows ? Math.round((st.unique_count ?? 0) / S.totalRows * 100) : 0;
  const sel = c === S.selectedCol ? 'col-selected' : '';
  const sortDir  = S.sortCol === c ? S.sortDir : null;
  const sortNext = sortDir === 'asc' ? 'descending' : sortDir === 'desc' ? 'default order' : 'ascending';
  const sortIcon = sortDir === 'asc' ? '&#9650;' : sortDir === 'desc' ? '&#9660;' : '&#8645;';
  return `<th class="${sel}" onclick="selectCol('${esc(c)}')">
    <button class="col-sort-btn ${sortDir ? 'active' : ''}" onclick="event.stopPropagation(); sortColumnDirect('${esc(c)}')" title="Sort by ${esc(c)} (click for ${sortNext})" aria-label="Sort by ${esc(c)}, currently ${sortDir ?? 'unsorted'}">
      ${sortIcon}
    </button>
    <button class="col-delete-btn" onclick="event.stopPropagation(); dropColumnDirect('${esc(c)}')" title="Remove column ${esc(c)}" aria-label="Remove column ${esc(c)}">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <div class="col-header-name" title="${esc(c)}">${esc(c)}</div>
    <div class="col-header-stats">
      <span>Missing: ${(st.null_count ?? 0).toLocaleString()} (${missingPct}%)</span>
      <span>Distinct: ${(st.unique_count ?? 0).toLocaleString()} (${distinctPct}%)</span>
    </div>
    ${st.dist ? `${headerSpark(st.dist)}
    <div class="col-header-range">
      <span class="truncate" title="${st.dist.min}">Min ${st.dist.min}</span>
      <span class="truncate" title="${st.dist.max}">Max ${st.dist.max}</span>
    </div>` : ''}
  </th>`;
}

function headerSpark(d, W = 168, H = 40) {
  // trim leading/trailing empty bins so sparse-edge data (e.g. a 0/1 flag
  // column) packs its bars together instead of spanning the full bin range
  let lo = d.bins.findIndex(c => c > 0);
  let hi = d.bins.length - 1 - [...d.bins].reverse().findIndex(c => c > 0);
  if (lo < 0) { lo = 0; hi = d.bins.length - 1; }
  const bins = d.bins.slice(lo, hi + 1);
  const n = bins.length, max = Math.max(...bins, 1), bw = W / n;
  const bars = bins.map((c, i) => {
    const h = Math.max(c / max * (H - 2), c > 0 ? 1 : 0);
    return `<rect x="${(i * bw + 0.3).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(bw - 0.6, 0.5).toFixed(1)}" height="${h.toFixed(1)}" fill="var(--accent)" opacity="0.85"/>`;
  }).join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="col-sparkline" role="img" aria-label="Value distribution histogram, min ${d.min}, max ${d.max}">${bars}</svg>`;
}

function highlightTableCol(col) {
  document.querySelectorAll('.data-table th, .data-table td').forEach(el => el.classList.remove('col-selected'));
  const idx = S.columns.indexOf(col);
  if (idx < 0) return;
  document.querySelectorAll('#table-head th')[idx + 1]?.classList.add('col-selected');   // +1: leading row-number column
  document.querySelectorAll(`#table-body tr td:nth-child(${idx + 2})`).forEach(td => td.classList.add('col-selected'));
}

async function loadPage(page) {
  try {
    const raw  = await py(`get_page(${page})`);
    const data = JSON.parse(raw);
    S.currentPage = page;
    renderTable(data.preview);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    const visible = c.id === `tab-${name}`;
    const wasHidden = c.classList.contains('hidden');
    c.classList.toggle('hidden', !visible);
    c.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (visible && wasHidden) {
      c.classList.remove('tab-entering');
      void c.offsetWidth; // reflow to restart animation
      c.classList.add('tab-entering');
      c.addEventListener('animationend', () => c.classList.remove('tab-entering'), { once: true });
    }
  });
  if (name === 'quality')   renderQualityReport();
  if (name === 'wrangle')   renderLog();
  if (name === 'visualize') populateVizSelects();
}

/* ── Quality Report ─────────────────────────────────────────────────────── */
function notIgnored(section) {
  return ([col]) => !S.ignored.has(`${section}:${col}`);
}

function ignoreFinding(section, col) {
  S.ignored.add(`${section}:${col}`);
  renderQualityReport();
  updateQualityBadge();
  renderColumnList();
}

function restoreFinding(key) {
  S.ignored.delete(key);
  renderQualityReport();
  updateQualityBadge();
  renderColumnList();
}

function restoreAllIgnored() {
  S.ignored.clear();
  renderQualityReport();
  updateQualityBadge();
  renderColumnList();
}

function ignoreBtn(section, col) {
  return `<button class="op-btn ml-1" onclick="ignoreFinding('${section}','${esc(col)}')" title="Hide this finding from the report">Ignore</button>`;
}

function updateQualityBadge() {
  const qr = S.quality;
  const n  = Object.entries(qr.missing ?? {}).filter(notIgnored('missing')).length
    + ((qr.duplicates ?? 0) > 0 && !S.ignored.has('duplicates:*') ? 1 : 0)
    + Object.entries(qr.type_issues ?? {}).filter(notIgnored('type_issues')).length
    + Object.entries(qr.outliers ?? {}).filter(notIgnored('outliers')).length
    + Object.entries(qr.inconsistent_formats ?? {}).filter(notIgnored('inconsistent_formats')).length
    + Object.entries(qr.typo_candidates ?? {}).filter(notIgnored('typo_candidates')).length;
  const b = document.getElementById('quality-badge');
  b.textContent = n;
  b.classList.toggle('hidden', n === 0);
}

function renderQualityReport() {
  const qr   = S.quality;
  const summ = qr.summary ?? {};
  let html = `<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
    ${sCard('Total Rows',    summ.total_rows?.toLocaleString() ?? 0, '#0684f9')}
    ${sCard('Columns',       summ.total_cols ?? 0,                    '#19b9e6')}
    ${sCard('Missing Cells', summ.total_missing ?? 0,                 '#f59e0b')}
    ${sCard('Duplicate Rows',summ.duplicates ?? 0,                    '#ef4444')}
  </div>`;

  /* Missing */
  const missingRows = Object.entries(qr.missing ?? {}).filter(notIgnored('missing'));
  if (missingRows.length) {
    html += aSection('Missing Values', '#f59e0b', iconInfo(),
      missingRows.map(([col, i]) =>
        `<div class="anomaly-row flex-col items-stretch gap-1.5">
          <div class="flex items-center gap-2 w-full">
            ${pill(i.pct > 30 ? 'HIGH' : i.pct > 10 ? 'MED' : 'LOW', i.pct > 30 ? 'sev-high' : i.pct > 10 ? 'sev-medium' : 'sev-low')}
            ${colLink(col, 'flex-1')}
            <span class="text-prussian-300 text-[11px]">${i.count.toLocaleString()} null (${i.pct}%)</span>
            <button class="op-btn ml-2" onclick="prefillWrangle('fill_missing','${esc(col)}','${i.recommend?.method ?? ''}')">
              Fix${i.recommend ? ' with ' + esc(i.recommend.label) : ''}</button>
            ${ignoreBtn('missing', col)}
          </div>
          ${recommendRow(i)}
        </div>`).join(''));
  }

  /* Duplicates */
  if ((qr.duplicates ?? 0) > 0 && !S.ignored.has('duplicates:*')) {
    html += aSection('Duplicate Rows', '#ef4444', iconCopy(),
      `<div class="anomaly-row">
        ${pill('MED','sev-medium')}
        <span class="text-prussian-200 flex-1">${qr.duplicates.toLocaleString()} exact duplicate rows</span>
        <button class="op-btn" onclick="prefillWrangle('remove_duplicates',null)">Fix</button>
        ${ignoreBtn('duplicates', '*')}
      </div>`);
  }

  /* Type issues */
  const typeRows = Object.entries(qr.type_issues ?? {}).filter(notIgnored('type_issues'));
  if (typeRows.length) {
    html += aSection('Incorrect Data Types', '#0684f9', iconCode(),
      typeRows.map(([col, i]) =>
        `<div class="anomaly-row">
          ${pill('TYPE','sev-medium')}
          ${colLink(col, 'flex-1')}
          <span class="text-prussian-300 text-[11px]">${i.current} → ${i.suggested} (${i.convertible_pct}% convertible)</span>
          <button class="op-btn ml-2" onclick="prefillWrangle('convert_type','${esc(col)}')">Fix</button>
          ${ignoreBtn('type_issues', col)}
        </div>`).join(''));
  }

  /* Outliers */
  const outlierRows = Object.entries(qr.outliers ?? {}).filter(notIgnored('outliers'));
  if (outlierRows.length) {
    html += aSection('Outliers', '#f59e0b', iconWarn(),
      outlierRows.map(([col, i]) =>
        `<div class="anomaly-row flex-col items-stretch gap-1.5">
          <div class="flex items-center gap-2 w-full">
            ${pill(i.pct > 5 ? 'HIGH' : 'MED', i.pct > 5 ? 'sev-high' : 'sev-medium')}
            ${colLink(col, 'flex-1')}
            <span class="text-prussian-300 text-[11px]">${i.count} outliers (${i.pct}%) IQR [${i.lower_bound}, ${i.upper_bound}]</span>
            <button class="op-btn ml-2" onclick="prefillWrangle('handle_outliers','${esc(col)}','${i.recommend?.method ?? ''}')">
              Fix with ${esc(i.recommend?.label ?? '')}</button>
            ${ignoreBtn('outliers', col)}
          </div>
          ${recommendRow(i, i.lower_bound, i.upper_bound)}
        </div>`).join(''));
  }

  /* Inconsistent formats */
  const fmtRows = Object.entries(qr.inconsistent_formats ?? {}).filter(notIgnored('inconsistent_formats'));
  if (fmtRows.length) {
    html += aSection('Inconsistent Formats', '#adbceb', iconEdit(),
      fmtRows.map(([col, i]) => {
        const detail = i.type === 'date_format'
          ? Object.entries(i.formats).map(([f, c]) => `${f}:${c}`).join(' | ')
          : `lower:${i.lower} upper:${i.upper} title:${i.title} mixed:${i.mixed}`;
        const op = i.type === 'date_format' ? 'standardize_date' : 'standardize_case';
        return `<div class="anomaly-row">
          ${pill(i.type === 'date_format' ? 'DATE' : 'CASE','sev-low')}
          ${colLink(col, 'flex-1')}
          <span class="text-prussian-300 text-[10px]">${esc(detail)}</span>
          <button class="op-btn ml-2" onclick="prefillWrangle('${op}','${esc(col)}')">Fix</button>
          ${ignoreBtn('inconsistent_formats', col)}
        </div>`;
      }).join(''));
  }

  /* Typos */
  const typoRows = Object.entries(qr.typo_candidates ?? {}).filter(notIgnored('typo_candidates'));
  if (typoRows.length) {
    html += aSection('Spelling / Typo Candidates', '#adbceb', iconEdit(),
      typoRows.map(([col, mapping]) =>
        `<div class="anomaly-row flex-col items-start gap-2">
          <div class="flex items-center gap-2 w-full">
            ${pill('TYPO','sev-low')}
            ${colLink(col)}
            <button class="op-btn ml-auto" onclick="prefillWrangle('fix_typos','${esc(col)}')">Fix</button>
            ${ignoreBtn('typo_candidates', col)}
          </div>
          <div class="text-[10px] text-prussian-400 pl-10 space-y-0.5">
            ${Object.entries(mapping).slice(0, 5).map(([k, v]) =>
              `<div><span class="text-red-400">${esc(k)}</span> → <span class="text-green-400">${esc(v)}</span></div>`
            ).join('')}
          </div>
        </div>`).join(''));
  }

  if (!html.includes('anomaly-row')) {
    html += `<div class="quality-card text-center py-8">
      <p class="text-green-400 font-medium mb-1">No anomalies ${S.ignored.size ? 'shown' : 'detected'}</p>
      <p class="text-prussian-400 text-xs">${S.ignored.size ? 'All remaining findings are ignored (see below).' : 'Dataset looks clean.'}</p>
    </div>`;
  }

  /* Ignored findings */
  if (S.ignored.size) {
    const names = { missing: 'Missing values', duplicates: 'Duplicate rows', type_issues: 'Data type',
                    outliers: 'Outliers', inconsistent_formats: 'Format', typo_candidates: 'Typos' };
    html += `<div class="quality-card">
      <h3 class="text-prussian-400">Ignored findings (${S.ignored.size})</h3>
      <div class="space-y-0.5">
        ${[...S.ignored].map(key => {
          const [section, col] = key.split(/:(.*)/s);
          return `<div class="anomaly-row">
            <span class="text-prussian-400 text-[11px] flex-1">${names[section] ?? section}${col !== '*' ? ' — ' : ''}${col !== '*' ? `<span class="log-col">${esc(col)}</span>` : ''}</span>
            <button class="op-btn" onclick="restoreFinding('${esc(key)}')">Restore</button>
          </div>`;
        }).join('')}
      </div>
      <button class="op-btn mt-2" onclick="restoreAllIgnored()">Restore all</button>
    </div>`;
  }

  document.getElementById('quality-content').innerHTML = html;
}

/* Recommendation row: sparkline histogram + reason text.
   lo/hi (IQR bounds) tint out-of-range bins red on outlier rows. */
function recommendRow(i, lo = null, hi = null) {
  if (!i.recommend) return '';
  const spark = i.box ? sparkBox(i.box) : i.dist ? sparkHist(i.dist, lo, hi) : '';
  const legend = i.box
    ? `<span class="text-[9px] text-prussian-400 whitespace-nowrap">
         <span style="color:#3987e5">▬ IQR box</span>&ensp;<span style="color:#47c7eb">┊ median</span>&ensp;<span style="color:#e66767">• outliers</span>
       </span>`
    : i.dist
    ? `<span class="text-[9px] text-prussian-400 whitespace-nowrap">
         <span style="color:#c98500">┊ mean</span>&ensp;<span style="color:#47c7eb">┊ median</span>
       </span>`
    : '';
  return `<div class="flex items-center gap-3 pl-10">
    ${spark}${legend}
    <span class="text-prussian-300 text-[10px] leading-snug flex-1">
      <span class="text-cerulean-400 font-medium">Suggested: ${esc(i.recommend.label)}.</span>
      ${esc(i.recommend.reason)}
    </span>
  </div>`;
}

function sparkHist(d, lo = null, hi = null) {
  const W = 280, H = 60, n = d.bins.length;
  const max = Math.max(...d.bins, 1);
  const bw = W / n;
  const span = (d.max - d.min) || 1;
  const x = v => Math.min(W, Math.max(0, (v - d.min) / span * W));
  const bars = d.bins.map((c, i) => {
    const h = Math.max(c / max * (H - 3), c > 0 ? 1.5 : 0);
    const binLo = d.min + span * i / n, binHi = d.min + span * (i + 1) / n;
    const out = (lo != null && binHi <= lo) || (hi != null && binLo >= hi);
    return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${out ? '#e66767' : '#3987e5'}" opacity="0.9"/>`;
  }).join('');
  const mark = (v, color) => v == null ? '' :
    `<line x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="0" y2="${H}" stroke="${color}" stroke-width="1.2" stroke-dasharray="2 2"/>`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="shrink-0" role="img" aria-label="Distribution histogram with mean and median markers">
    ${bars}${mark(d.mean, '#c98500')}${mark(d.median, '#47c7eb')}</svg>`;
}

function sparkBox(b) {
  const W = 280, H = 60, cy = H / 2;
  const span = (b.max - b.min) || 1;
  const x = v => ((v - b.min) / span) * (W - 10) + 5;
  const bx1 = x(b.q1), bx2 = x(b.q3), wl = x(b.whisk_lo), wh = x(b.whisk_hi);
  const boxH = 28, boxY = cy - boxH / 2;
  // whisker stems + caps, IQR box, median line
  let svg = `
    <line x1="${wl.toFixed(1)}" x2="${bx1.toFixed(1)}" y1="${cy}" y2="${cy}" stroke="#adbceb" stroke-width="1"/>
    <line x1="${bx2.toFixed(1)}" x2="${wh.toFixed(1)}" y1="${cy}" y2="${cy}" stroke="#adbceb" stroke-width="1"/>
    <line x1="${wl.toFixed(1)}" x2="${wl.toFixed(1)}" y1="${cy - 8}" y2="${cy + 8}" stroke="#adbceb" stroke-width="1"/>
    <line x1="${wh.toFixed(1)}" x2="${wh.toFixed(1)}" y1="${cy - 8}" y2="${cy + 8}" stroke="#adbceb" stroke-width="1"/>
    <rect x="${bx1.toFixed(1)}" y="${boxY}" width="${Math.max(bx2 - bx1, 1.5).toFixed(1)}" height="${boxH}" fill="#3987e5" fill-opacity="0.35" stroke="#3987e5" stroke-width="1" rx="1.5"/>
    <line x1="${x(b.median).toFixed(1)}" x2="${x(b.median).toFixed(1)}" y1="${boxY}" y2="${boxY + boxH}" stroke="#47c7eb" stroke-width="1.6"/>`;
  // outlier points, tiny vertical jitter so stacked values stay visible
  svg += (b.points ?? []).map((v, i) =>
    `<circle cx="${x(v).toFixed(1)}" cy="${(cy + ((i % 3) - 1) * 8).toFixed(1)}" r="2.5" fill="#e66767" fill-opacity="0.85"/>`
  ).join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="shrink-0" role="img" aria-label="Box plot with outlier points">${svg}</svg>`;
}

/* Shortcut: jump to Wrangle tab with operation pre-filled (+ suggested method) */
function prefillWrangle(opType, col, suggest = '') {
  switchTab('wrangle');
  document.getElementById('op-type').value = opType;
  if (col) document.getElementById('op-column').value = col;
  renderOpParams();
  if (suggest) {
    if (opType === 'fill_missing') {
      const sel = document.getElementById('p-fill-method');
      if (sel) { sel.value = suggest; toggleCustomFill(); }
    } else if (opType === 'handle_outliers') {
      const sel = document.getElementById('p-outlier-method');
      if (sel) sel.value = suggest;
    }
  }
}

/* ── Wrangle tab ────────────────────────────────────────────────────────── */
function populateOpColumnSelect() {
  const sel = document.getElementById('op-column');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">All columns</option>` +
    S.columns.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (S.columns.includes(cur)) sel.value = cur;
}

const OP_META = {
  fill_missing: {
    needsCol: true,
    desc: 'Replace null / NaN values in a column with a computed or custom value. Choose "All columns" to fill across the entire dataset.',
    params: () => `
      <div>
        <label class="field-label">Fill Method</label>
        <select id="p-fill-method" class="select-field w-full" onchange="toggleCustomFill()">
          <option value="mean">Mean (numeric columns)</option>
          <option value="median">Median (numeric columns)</option>
          <option value="mode">Mode (most frequent value)</option>
          <option value="ffill">Forward Fill</option>
          <option value="bfill">Backward Fill</option>
          <option value="zero">Zero (numeric columns)</option>
          <option value="empty_string">Empty String</option>
          <option value="custom">Custom Value</option>
        </select>
      </div>
      <div id="custom-fill-row" class="hidden">
        <label class="field-label">Custom Value</label>
        <input id="p-fill-custom" type="text" class="input-field w-full" placeholder="Enter value…" />
      </div>`,
  },
  drop_missing_rows: {
    needsCol: true,
    desc: 'Remove entire rows where the selected column contains a null value. Choose "All columns" to drop any row with at least one null.',
    params: () => '',
  },
  remove_duplicates: {
    needsCol: false,
    desc: 'Remove rows that are exact duplicates of another row (all column values identical). Keeps the first occurrence.',
    params: () => '',
  },
  convert_type: {
    needsCol: true,
    desc: 'Change the data type of a column. Values that cannot be converted become null.',
    params: () => `
      <div>
        <label class="field-label">Target Type</label>
        <select id="p-conv-type" class="select-field w-full">
          <option value="numeric">Numeric (int / float)</option>
          <option value="datetime">DateTime</option>
          <option value="string">String (text)</option>
        </select>
      </div>`,
  },
  split_datetime: {
    needsCol: true,
    desc: 'Parse a date/time column and add separate columns for the chosen parts (e.g. date_year, date_month). The original column is kept unchanged. Values that cannot be parsed as dates become null in the new columns.',
    params: () => {
      const parts = [
        ['year', 'Year', true], ['quarter', 'Quarter', false], ['month', 'Month (number)', true],
        ['month_name', 'Month (name)', false], ['day', 'Day of month', false],
        ['weekday', 'Weekday name', false], ['hour', 'Hour', false],
      ];
      return `<div>
        <label class="field-label">Parts to Extract</label>
        <div class="grid grid-cols-2 gap-1.5">
          ${parts.map(([v, label, on]) =>
            `<label class="flex items-center gap-2 text-xs text-prussian-200 cursor-pointer">
              <input type="checkbox" value="${v}" class="p-dtpart accent-cerulean-500" ${on ? 'checked' : ''} /> ${label}
            </label>`).join('')}
        </div>
      </div>`;
    },
  },
  handle_outliers: {
    needsCol: true,
    desc: 'Detect outliers using the IQR method (values outside Q1 − 1.5×IQR or Q3 + 1.5×IQR) and apply a chosen remedy.',
    params: () => `
      <div>
        <label class="field-label">Method</label>
        <select id="p-outlier-method" class="select-field w-full">
          <option value="cap">Cap to IQR bounds (Winsorize)</option>
          <option value="remove">Remove outlier rows</option>
          <option value="nullify">Set outliers to null</option>
          <option value="zscore">Remove by Z-score ( |z| > 3 )</option>
        </select>
      </div>`,
  },
  standardize_case: {
    needsCol: true,
    desc: 'Normalise text casing in a string column to eliminate inconsistencies like "new york" vs "New York" vs "NEW YORK".',
    params: () => `
      <div>
        <label class="field-label">Case</label>
        <select id="p-case" class="select-field w-full">
          <option value="lower">lowercase</option>
          <option value="upper">UPPERCASE</option>
          <option value="title">Title Case</option>
          <option value="strip">Strip Whitespace Only</option>
        </select>
      </div>`,
  },
  standardize_date: {
    needsCol: true,
    desc: 'Parse mixed date formats and output a single consistent format (default: ISO 8601 YYYY-MM-DD). Unparseable values become null.',
    params: () => `
      <div>
        <label class="field-label">Output Format (strftime)</label>
        <select id="p-date-fmt" class="select-field w-full">
          <option value="%Y-%m-%d">YYYY-MM-DD (ISO 8601)</option>
          <option value="%d/%m/%Y">DD/MM/YYYY</option>
          <option value="%m/%d/%Y">MM/DD/YYYY</option>
          <option value="%d-%m-%Y">DD-MM-YYYY</option>
          <option value="%B %d, %Y">Month DD, YYYY</option>
        </select>
      </div>`,
  },
  trim_whitespace: {
    needsCol: true,
    desc: 'Strip leading and trailing whitespace from all values in a string column.',
    params: () => '',
  },
  fix_typos: {
    needsCol: true,
    desc: 'Use fuzzy string matching to find values that are likely typos of more common values, then replace them automatically.',
    params: () => {
      const col = document.getElementById('op-column')?.value;
      const mapping = S.quality.typo_candidates?.[col];
      if (!mapping || !Object.keys(mapping).length)
        return `<p class="text-prussian-400 text-xs">No typo candidates detected for this column. Select a column with typo candidates.</p>`;
      const rows = Object.entries(mapping).map(([k, v]) =>
        `<div class="flex gap-3 text-xs py-1 border-b border-prussian-800">
          <span class="text-red-400 font-mono flex-1">${esc(k)}</span>
          <span class="text-prussian-500">→</span>
          <span class="text-green-400 font-mono flex-1">${esc(v)}</span>
        </div>`).join('');
      return `<div>
        <label class="field-label">Proposed Corrections</label>
        <div class="bg-prussian-900 rounded-lg p-2 border border-prussian-800 max-h-48 overflow-y-auto custom-scroll">
          <div class="flex gap-3 text-[10px] pb-1 border-b border-prussian-700 text-prussian-500 uppercase tracking-wider">
            <span class="flex-1">Original</span><span class="flex-1">Replace With</span>
          </div>
          ${rows}
        </div>
        <p class="text-prussian-500 text-[10px] mt-1">All corrections will be applied when you click Apply.</p>
      </div>`;
    },
  },
  replace_value: {
    needsCol: true,
    desc: 'Find a specific value in a column and replace it with another value (exact match).',
    params: () => `
      <div>
        <label class="field-label">Find Value</label>
        <input id="p-replace-old" type="text" class="input-field w-full" placeholder="Value to find…" />
      </div>
      <div>
        <label class="field-label">Replace With</label>
        <input id="p-replace-new" type="text" class="input-field w-full" placeholder="Replacement value…" />
      </div>`,
  },
  filter_rows: {
    needsCol: true,
    desc: 'Keep only rows matching a condition. Rows that do not match are permanently removed from the dataset.',
    params: () => `
      <div>
        <label class="field-label">Condition</label>
        <select id="p-filter-cond" class="select-field w-full">
          <option value="not_null">Is not null</option>
          <option value="equals">Equals</option>
          <option value="not_equals">Not equals</option>
          <option value="contains">Contains (text)</option>
          <option value="greater_than">Greater than (numeric)</option>
          <option value="less_than">Less than (numeric)</option>
        </select>
      </div>
      <div>
        <label class="field-label">Value</label>
        <input id="p-filter-val" type="text" class="input-field w-full" placeholder="Comparison value…" />
      </div>`,
  },
  drop_column: {
    needsCol: true,
    desc: 'Permanently remove a column from the dataset. This cannot be undone without resetting to the original upload.',
    params: () => `<p class="text-amber-400 text-xs bg-amber-900/20 border border-amber-800 rounded p-2">
      This will permanently remove the selected column. Use Reset to undo.</p>`,
  },
  rename_column: {
    needsCol: true,
    desc: 'Give a column a new name. All data is preserved.',
    params: () => `
      <div>
        <label class="field-label">New Column Name</label>
        <input id="p-rename" type="text" class="input-field w-full" placeholder="New name…" />
      </div>`,
  },
  drop_row: {
    needsCol: false,
    desc: 'Permanently remove one row, identified by the row number shown in the leftmost column of Data Preview.',
    params: () => `
      <div>
        <label class="field-label">Row Number</label>
        <input id="p-row" type="number" min="0" class="input-field w-full" placeholder="Row # from Data Preview…" />
      </div>`,
  },
  set_header_row: {
    needsCol: false,
    desc: 'Use one row\'s values as the new column names, identified by the row number shown in the leftmost column of Data Preview. That row is then removed.',
    params: () => `
      <div>
        <label class="field-label">Row Number</label>
        <input id="p-row" type="number" min="0" class="input-field w-full" placeholder="Row # from Data Preview…" />
      </div>`,
  },
  sort_values: {
    needsCol: true,
    desc: 'Reorder every row by the selected column\'s values, or restore the original load order. Nulls sort last. This changes the dataset itself, not just the view — same as any other operation, undo from the Operation Log.',
    params: () => `
      <div>
        <label class="field-label">Direction</label>
        <select id="p-sort-dir" class="select-field w-full">
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
          <option value="default">Default (original order)</option>
        </select>
      </div>`,
  },
};

function renderOpParams() {
  const opType = document.getElementById('op-type').value;
  const meta   = OP_META[opType];
  if (!meta) return;

  document.getElementById('field-column').classList.toggle('hidden', !meta.needsCol);
  document.getElementById('op-params').innerHTML    = meta.params();
  document.getElementById('op-description').innerHTML =
    `<p class="text-prussian-300">${meta.desc}</p>`;
}

function toggleCustomFill() {
  const method = document.getElementById('p-fill-method')?.value;
  document.getElementById('custom-fill-row')?.classList.toggle('hidden', method !== 'custom');
}

function buildParams(opType) {
  switch (opType) {
    case 'fill_missing': {
      const method = document.getElementById('p-fill-method')?.value ?? 'mean';
      const custom = document.getElementById('p-fill-custom')?.value ?? '';
      return method === 'custom' ? { method, value: custom } : { method };
    }
    case 'convert_type':    return { target: document.getElementById('p-conv-type')?.value };
    case 'split_datetime':  return { components: [...document.querySelectorAll('.p-dtpart:checked')].map(i => i.value) };
    case 'handle_outliers': return { method: document.getElementById('p-outlier-method')?.value };
    case 'standardize_case':return { case: document.getElementById('p-case')?.value };
    case 'standardize_date':return { format: document.getElementById('p-date-fmt')?.value };
    case 'replace_value':   return {
      old: document.getElementById('p-replace-old')?.value,
      new: document.getElementById('p-replace-new')?.value,
    };
    case 'filter_rows': return {
      condition: document.getElementById('p-filter-cond')?.value,
      value:     document.getElementById('p-filter-val')?.value,
    };
    case 'rename_column': return { new_name: document.getElementById('p-rename')?.value?.trim() };
    case 'drop_row':
    case 'set_header_row': return { row: document.getElementById('p-row')?.value };
    case 'sort_values':    return { direction: document.getElementById('p-sort-dir')?.value ?? 'asc' };
    case 'fix_typos': {
      const col = document.getElementById('op-column')?.value;
      return { mapping: S.quality.typo_candidates?.[col] ?? {} };
    }
    default: return {};
  }
}

async function runOperation(opType, col, params) {
  S.pyodide.globals.set('_op_type', opType);
  S.pyodide.globals.set('_op_col',  col ?? '');
  S.pyodide.globals.set('_op_params', JSON.stringify(params));
  const raw = await py('apply_operation(_op_type, _op_col or None, _op_params)');
  return JSON.parse(raw);
}

async function applyOperation() {
  const opType  = document.getElementById('op-type').value;
  const col     = document.getElementById('op-column').value || null;
  const params  = buildParams(opType);
  const resultEl = document.getElementById('op-result');

  if (opType === 'rename_column' && !params.new_name) {
    toast('Enter a new column name.', 'error'); return;
  }
  if (opType === 'replace_value' && (params.old == null || params.old === '')) {
    toast('Enter a value to find.', 'error'); return;
  }
  if (opType === 'split_datetime' && !params.components.length) {
    toast('Tick at least one part to extract.', 'error'); return;
  }
  if (opType === 'split_datetime' && !col) {
    toast('Pick the date column to split.', 'error'); return;
  }
  if ((opType === 'drop_row' || opType === 'set_header_row') && params.row === '') {
    toast('Enter a row number.', 'error'); return;
  }
  if (opType === 'sort_values' && params.direction !== 'default' && !col) {
    toast('Pick a column to sort by.', 'error'); return;
  }

  const spinner = document.getElementById('op-spinner');
  const btn     = document.getElementById('btn-apply-op');
  spinner.classList.remove('hidden');
  btn.disabled = true;
  resultEl.textContent = '';

  try {
    const data = await runOperation(opType, col, params);

    if (data.ok) {
      if (opType === 'sort_values') {
        const isDefault = params.direction === 'default';
        S.sortCol = isDefault ? null : col;
        S.sortDir = isDefault ? null : params.direction;
      }
      applyState(data);
      const label = opType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const detail = [];
      if (data.rows_removed > 0)  detail.push(`${data.rows_removed.toLocaleString()} rows removed`);
      if (data.cells_changed > 0) detail.push(`${data.cells_changed.toLocaleString()} cells changed`);
      resultEl.textContent = '';
      toast(`${label}${col ? ' on ' + col : ''} applied${detail.length ? ' — ' + detail.join(', ') : ''}`, 'success');
      updateLogBadge();
    } else {
      resultEl.textContent = 'Error: ' + data.error;
      resultEl.className = 'text-xs text-red-400';
      toast(data.error, 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    spinner.classList.add('hidden');
    btn.disabled = false;
  }
}

/* Delete a row straight from Data Preview, without opening the Wrangle tab.
   Routes through the same apply_operation path, so it's logged and undoable. */
async function dropRowDirect(idx) {
  try {
    const data = await runOperation('drop_row', null, { row: idx });
    if (data.ok) {
      applyState(data);
      toast(`Row ${idx} removed — undo from the Operation Log`, 'success');
      updateLogBadge();
    } else {
      toast(data.error, 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* Delete a column straight from Data Preview, without opening the Wrangle tab.
   Routes through the same apply_operation path, so it's logged and undoable. */
async function dropColumnDirect(col) {
  try {
    const data = await runOperation('drop_column', col, {});
    if (data.ok) {
      if (S.selectedCol === col) S.selectedCol = null;
      applyState(data);
      toast(`Column "${col}" removed — undo from the Operation Log`, 'success');
      updateLogBadge();
    } else {
      toast(data.error, 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* Sort by a column straight from Data Preview, without opening the Wrangle tab.
   Cycles ascending → descending → default (original order) on repeat clicks of
   the same column. This is a live toggle, not a trail of operations: each click
   first undoes this column's currently-active sort_values entry (if any), then
   applies the new direction — so the log gains at most one entry for the whole
   cycle, and going back to "default" undoes it rather than adding a new op. */
async function sortColumnDirect(col) {
  const current = S.sortCol === col ? S.sortDir : null;
  const direction = current === 'asc' ? 'desc' : current === 'desc' ? 'default' : 'asc';

  const activeIdx = S.opLog.map((op, i) => ({ op, i })).reverse()
    .find(({ op }) => op.type === 'sort_values' && op.column === col && op.params?.direction !== 'default')?.i;

  try {
    // clear before the undo's own applyState() re-render, so that render
    // reads the cleared sort state instead of the stale descending one
    if (direction === 'default') { S.sortCol = null; S.sortDir = null; }

    if (activeIdx != null && !(await undoOperationCore(activeIdx))) return;

    if (direction === 'default') {
      toast('Restored original row order', 'success');
      return;
    }

    const data = await runOperation('sort_values', col, { direction });
    if (data.ok) {
      S.sortCol = col;
      S.sortDir = direction;
      applyState(data);
      toast(`Sorted by "${col}" (${direction === 'asc' ? 'ascending' : 'descending'})`, 'success');
    } else {
      toast(data.error, 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* Edit a single cell's value directly from Data Preview.
   Routes through the same apply_operation path, so it's logged and undoable. */
function editCell(td) {
  if (td.querySelector('.cell-edit-input')) return;   // already editing this cell

  const { row, col } = td.dataset;
  const startVal = td.dataset.null === '1' ? '' : (td.dataset.value ?? '');
  const originalHTML = td.innerHTML;

  td.classList.add('editing');
  td.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cell-edit-input';
  input.value = startVal;
  td.appendChild(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    td.classList.remove('editing');
    if (!commit || input.value === startVal) {
      td.innerHTML = originalHTML;
      return;
    }
    try {
      const data = await runOperation('edit_cell', col, { row, value: input.value });
      if (data.ok) {
        applyState(data);
        updateLogBadge();
      } else {
        toast(data.error, 'error');
        td.innerHTML = originalHTML;
      }
    } catch (err) {
      toast(err.message, 'error');
      td.innerHTML = originalHTML;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/* ── Op Log ─────────────────────────────────────────────────────────────── */
function updateLogBadge() {
  const b = document.getElementById('log-badge');
  b.textContent = S.opLog.length;
  b.classList.toggle('hidden', S.opLog.length === 0);
}

function renderLog() {
  const el = document.getElementById('log-content');
  if (!S.opLog.length) {
    el.innerHTML = `<p class="text-prussian-400 text-xs text-center py-3">No operations applied yet — applied steps appear here and can be undone individually.</p>`;
    return;
  }
  el.innerHTML = S.opLog.map((op, i) =>
    `<div class="log-entry">
      <span class="log-num">${i + 1}.</span>
      <div class="log-text flex-1">
        <span class="text-prussian-200 font-medium">${op.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
        ${op.column ? ` on <span class="log-col">${esc(op.column)}</span>` : ''}
        ${Object.keys(op.params ?? {}).length ? `<span class="text-prussian-500 text-[10px] ml-2">${esc(JSON.stringify(op.params))}</span>` : ''}
      </div>
      <button class="op-btn ml-2" onclick="undoOperation(${i})" aria-label="Undo operation ${i + 1}" title="Undo this operation (later operations are re-applied)">Undo</button>
    </div>`
  ).join('');
}

/* Shared core: undo op at index i, apply the resulting state, report failures.
   Returns true on success so callers (e.g. sortColumnDirect) can chain their
   own follow-up toast instead of the generic "Operation undone" one. */
async function undoOperationCore(i) {
  const raw  = await py(`undo_operation(${i})`);
  const data = JSON.parse(raw);
  if (!data.ok) { toast(data.error, 'error'); return false; }

  applyState(data);
  renderLog();
  if (data.failed?.length) {
    const names = data.failed.map(f => f.type.replace(/_/g, ' ')).join(', ');
    toast(`Undone — but ${data.failed.length} later operation(s) no longer applied and were removed: ${names}`, 'error', 6000);
  }
  return true;
}

async function undoOperation(i) {
  try {
    if (await undoOperationCore(i)) toast('Operation undone', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ── Visualisation ──────────────────────────────────────────────────────── */
/* Convention: first selector = X axis, second = Y axis. Placeholder text
   states the role (and whether it's required) per chart type. */
const VIZ_COLS = {
  auto:      { x: null,                                    y: null },
  histogram: { x: 'X — numeric column',                    y: null,  xFilter: 'num' },
  bar:       { x: 'X — category column',                   y: 'Y — numeric to average (optional: blank = counts)', yOptional: true, xFilter: 'cat', yFilter: 'num' },
  scatter:   { x: 'X — numeric column',                    y: 'Y — numeric column', xFilter: 'num', yFilter: 'num' },
  box:       { x: 'X — group by (optional)',               y: 'Y — numeric column', xOptional: true, xFilter: 'cat', yFilter: 'num' },
  line:      { x: 'X — column (optional: blank = row order)', y: 'Y — numeric column', xOptional: true, yFilter: 'num' },
  heatmap:   { x: null,                                    y: null },
  pie:       { x: 'Slices — category column',              y: 'Slice size — numeric to total (optional: blank = counts)', yOptional: true, xFilter: 'cat', yFilter: 'num' },
};

function isNumericCol(c) {
  const d = S.dtypes[c] ?? '';
  return d.startsWith('int') || d.startsWith('float');
}

/* Only offer columns whose dtype suits the slot: 'num', 'cat', or undefined = all.
   Low-cardinality numeric columns (<=20 uniques, e.g. year, rating) count as
   categories too — they group meaningfully even though the dtype is numeric. */
function suitsCategory(c) {
  return !isNumericCol(c) || (S.stats[c]?.unique_count ?? Infinity) <= 20;
}

function fillVizSelect(sel, filter) {
  const cur  = sel.value;
  const cols = S.columns.filter(c =>
    !filter ? true : filter === 'num' ? isNumericCol(c) : suitsCategory(c));
  sel.innerHTML = `<option value=""></option>` +
    cols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (cols.includes(cur)) sel.value = cur;
  return cols.length;
}

function populateVizSelects() {
  const meta = VIZ_COLS[document.getElementById('viz-type').value] ?? VIZ_COLS.auto;
  const nx = fillVizSelect(document.getElementById('viz-col'),  meta.xFilter);
  const ny = fillVizSelect(document.getElementById('viz-col2'), meta.yFilter);
  updateVizControls(nx, ny);   // set the placeholder text for the current chart type
}

function updateVizControls(nx = null, ny = null) {
  const meta = VIZ_COLS[document.getElementById('viz-type').value] ?? VIZ_COLS.auto;
  const colX = document.getElementById('viz-col');
  const colY = document.getElementById('viz-col2');
  colX.classList.toggle('hidden', !meta.x);
  colY.classList.toggle('hidden', !meta.y);
  const noneMsg = f => f === 'num' ? 'no numeric columns — convert in Wrangle' : 'no category columns';
  if (meta.x && colX.options.length) {
    const label = nx === 0 ? `${meta.x.split(' — ')[0]} — ${noneMsg(meta.xFilter)}` : meta.x;
    colX.options[0].text = label; colX.setAttribute('aria-label', label);
  }
  if (meta.y && colY.options.length) {
    const label = ny === 0 ? `${meta.y.split(' — ')[0]} — ${noneMsg(meta.yFilter)}` : meta.y;
    colY.options[0].text = label; colY.setAttribute('aria-label', label);
  }
}

async function generateChart() {
  const type = document.getElementById('viz-type').value;
  const col  = document.getElementById('viz-col').value  || undefined;
  const col2 = document.getElementById('viz-col2').value || undefined;

  const meta = VIZ_COLS[type] ?? {};
  if (meta.x && !meta.xOptional && !col)  { toast(`Select the ${meta.x.split(' (')[0]}.`, 'error'); return; }
  if (meta.y && !meta.yOptional && !col2) { toast(`Select the ${meta.y.split(' (')[0]}.`, 'error'); return; }

  const spinner = document.getElementById('viz-spinner');
  const btn     = document.getElementById('btn-generate');
  spinner.classList.remove('hidden');
  btn.disabled = true;

  try {
    S.pyodide.globals.set('_viz_config', JSON.stringify({ type, column: col, column2: col2 }));
    const raw    = await py('generate(_viz_config)');
    const charts = JSON.parse(raw);
    renderCharts(charts);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    spinner.classList.add('hidden');
    btn.disabled = false;
  }
}

function renderCharts(charts) {
  const gallery = document.getElementById('chart-gallery');
  if (!charts?.length) {
    gallery.innerHTML = `<div class="col-span-2 text-center text-prussian-500 py-16 text-sm">No charts generated — select a column and chart type, then click Generate.</div>`;
    return;
  }
  S.lastCharts = charts;
  gallery.innerHTML = charts.map((c, i) =>
    `<div class="chart-card ${charts.length === 1 ? 'chart-card-wide' : ''}" style="--i:${Math.min(i, 8)}">
      <h4>
        <span class="truncate">${esc(c.title ?? c.type)}</span>
        ${c.data ? `<button class="op-btn chart-dl" onclick="downloadChart(${i})" title="Download this chart as a JPG image" aria-label="Download ${esc(c.title ?? 'chart')} as JPG">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          JPG</button>` : ''}
      </h4>
      ${c.message
        ? `<p class="p-4 text-xs text-prussian-300 leading-relaxed">${esc(c.message)}</p>`
        : `<img src="data:image/png;base64,${c.data}" alt="${esc(c.title ?? '')}" loading="lazy" />`}
    </div>`
  ).join('');
}

function downloadChart(i) {
  const c = S.lastCharts?.[i];
  if (!c?.data) return;
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a1129';           // JPG has no alpha — paint the chart surface first
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const a = Object.assign(document.createElement('a'), {
      href: canvas.toDataURL('image/jpeg', 0.95),
      download: `${(c.title ?? 'chart').trim().replace(/[^\w-]+/g, '_')}.jpg`,
    });
    a.click();
  };
  img.src = 'data:image/png;base64,' + c.data;
}

/* ── Close dataset: back to upload screen ───────────────────────────────── */
function closeDataset() {
  if (S.opLog.length) {
    const dlg = document.getElementById('close-dialog');
    const n = S.opLog.length;
    document.getElementById('close-dialog-msg').textContent =
      `${n} applied operation${n > 1 ? 's' : ''} will be discarded. Export the cleaned CSV first if you want to keep your work.`;
    dlg.showModal();
    return;
  }
  doCloseDataset();
}

function doCloseDataset() {
  document.getElementById('workspace').style.display   = 'none';
  document.getElementById('top-actions').style.display = 'none';
  document.getElementById('upload-screen').style.display = '';
  document.getElementById('file-label').textContent = 'No file loaded';
  document.getElementById('file-input').value = '';   // allow re-uploading the same file

  Object.assign(S, {
    columns: [], dtypes: {}, stats: {}, quality: {}, opLog: [],
    selectedCol: null, currentPage: 0, totalRows: 0,
    sortCol: null, sortDir: null,
  });
  document.getElementById('column-list').innerHTML = '';
  document.getElementById('chart-gallery').innerHTML = '';
  document.getElementById('item-picker').classList.add('hidden');
  showUploadError('');
  const apiStatus = document.getElementById('api-status');
  apiStatus.classList.add('hidden');
  apiStatus.className = 'text-prussian-400 text-xs mt-2 hidden';
}

/* ── Reset ──────────────────────────────────────────────────────────────── */
async function resetDataset() {
  try {
    const raw  = await py('reset()');
    const data = JSON.parse(raw);
    applyState(data);
    S.selectedCol = null;
    S.sortCol = null;
    S.sortDir = null;
    renderColumnList();
    toast('Dataset reset to original upload', 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ── Export CSV ─────────────────────────────────────────────────────────── */
async function exportCSV() {
  try {
    const csvText = await py('export_csv()');
    const blob = new Blob([csvText], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'processed_data.csv' });
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ── Utility ────────────────────────────────────────────────────────────── */
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function sCard(label, val, color) {
  return `<div class="quality-card text-center"><div class="text-2xl font-bold font-mono" style="color:${color}">${val}</div><div class="text-prussian-400 text-xs mt-1">${label}</div></div>`;
}
function aSection(title, color, icon, body) {
  return `<div class="quality-card"><h3 style="color:${color}">${icon}${title}</h3><div class="space-y-0.5">${body}</div></div>`;
}
function pill(label, cls) {
  return `<span class="severity-pill ${cls}">${label}</span>`;
}
function iconInfo() { return `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`; }
function iconCopy() { return `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`; }
function iconCode() { return `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>`; }
function iconWarn() { return `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`; }
function iconEdit() { return `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`; }

/* ── Font scale ─────────────────────────────────────────────────────────── */
const BASE_ZOOM = 1.2;   // rendered zoom at the "100%" slider position

function applyFontScale(v) {
  v = Math.min(125, Math.max(100, v));   // displayed %; 100% floor (= 1.2 actual zoom)
  const zoom = (v / 100) * BASE_ZOOM;
  document.body.style.zoom = zoom;
  // vh-based heights render zoom× too large; --app-zoom divides them back so
  // the app shell always fits the real viewport (fixes clipped bottom/legend)
  document.documentElement.style.setProperty('--app-zoom', zoom);
  document.querySelectorAll('.font-slider').forEach(s => {
    s.value = v;
    s.setAttribute('aria-valuetext', `${v}%`);
    s.title = `Text size: ${v}%`;
  });
  try { localStorage.setItem('mdw-font-scale2', v); } catch {}
}

/* ── Init ───────────────────────────────────────────────────────────────── */
function initUI() {
  const savedScale = parseInt(localStorage.getItem('mdw-font-scale2'), 10);
  applyFontScale(Number.isFinite(savedScale) ? savedScale : 100);   // 100% shown = 1.2 zoom
  document.querySelectorAll('.font-slider').forEach(s =>
    s.addEventListener('input', e => applyFontScale(+e.target.value)));
  const dz = document.getElementById('drop-zone');
  document.getElementById('file-input').addEventListener('change', e => handleUpload(e.target.files[0]));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drop-zone-active'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drop-zone-active'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drop-zone-active'); handleUpload(e.dataTransfer.files[0]); });

  document.getElementById('btn-api-load').addEventListener('click', loadFromApi);
  document.getElementById('api-source').addEventListener('change', updateApiControls);
  document.getElementById('api-id').addEventListener('keydown', e => { if (e.key === 'Enter') loadFromApi(); });

  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  document.getElementById('btn-close').addEventListener('click', closeDataset);
  const closeDlg = document.getElementById('close-dialog');
  document.getElementById('close-cancel').addEventListener('click', () => closeDlg.close());
  document.getElementById('close-discard').addEventListener('click', () => { closeDlg.close(); doCloseDataset(); });
  document.getElementById('close-export').addEventListener('click', async () => {
    closeDlg.close();
    await exportCSV();
    doCloseDataset();
  });
  document.getElementById('btn-reset').addEventListener('click', resetDataset);
  document.getElementById('btn-download').addEventListener('click', exportCSV);
  document.getElementById('prev-page').addEventListener('click', () => { if (S.currentPage > 0) loadPage(S.currentPage - 1); });
  document.getElementById('next-page').addEventListener('click', () => { if ((S.currentPage + 1) * S.pageSize < S.totalRows) loadPage(S.currentPage + 1); });

  document.getElementById('op-type').addEventListener('change', renderOpParams);
  document.getElementById('op-column').addEventListener('change', renderOpParams);
  document.getElementById('btn-apply-op').addEventListener('click', applyOperation);
  document.getElementById('viz-type').addEventListener('change', populateVizSelects);
  document.getElementById('btn-generate').addEventListener('click', generateChart);

  renderOpParams();
}

boot();
