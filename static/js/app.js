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
async function handleUpload(file) {
  if (!file?.name.toLowerCase().endsWith('.csv')) {
    showUploadError('Please upload a .csv file.');
    return;
  }
  showUploadError('');
  document.getElementById('upload-progress').classList.remove('hidden');

  try {
    const text = await file.text();
    S.pyodide.globals.set('_csv_raw', text);
    const raw = await py('load_csv(_csv_raw)');
    applyState(JSON.parse(raw));
    enterWorkspace(file.name);
  } catch (err) {
    showUploadError(err.message);
  } finally {
    document.getElementById('upload-progress').classList.add('hidden');
  }
}

function showUploadError(msg) {
  const el = document.getElementById('upload-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

/* ── Apply server (Python) state ────────────────────────────────────────── */
function applyState(data) {
  if (data.preview) {
    S.columns     = data.preview.columns     ?? S.columns;
    S.dtypes      = data.preview.dtypes      ?? S.dtypes;
    S.totalRows   = data.preview.total_rows  ?? S.totalRows;
    S.currentPage = data.preview.page        ?? 0;
    renderTable(data.preview);
  }
  if (data.stats)   { S.stats   = data.stats; }
  if (data.quality) { S.quality = data.quality; }
  if (data.op_log)  { S.opLog   = data.op_log; }

  renderColumnList();
  updateShapeBadge();
  updateQualityBadge();
  updateLogBadge();
  populateOpColumnSelect();
}

/* ── Workspace transition ───────────────────────────────────────────────── */
function enterWorkspace(filename) {
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

    let dot = 'dot-ok';
    if (qr.missing?.[col] || qr.type_issues?.[col] || qr.outliers?.[col] ||
        qr.inconsistent_formats?.[col] || qr.typo_candidates?.[col]) dot = 'dot-warn';
    if ((qr.missing?.[col]?.pct ?? 0) > 30) dot = 'dot-error';

    const sel = col === S.selectedCol ? 'selected' : '';
    return `<div class="col-item ${sel}" role="listitem button" tabindex="0" onclick="selectCol('${esc(col)}')" onkeydown="if(event.key==='Enter'||event.key===' ')selectCol('${esc(col)}')" aria-pressed="${col === S.selectedCol}" title="${esc(col)}">
      <span class="col-type-badge ${tcls}" aria-label="${tlbl} column">${tlbl}</span>
      <span class="flex-1 truncate">${esc(col)}</span>
      <span class="col-quality-dot ${dot}" aria-hidden="true"></span>
    </div>`;
  }).join('');
}

function selectCol(col) {
  S.selectedCol = col;
  renderColumnList();
  highlightTableCol(col);
  // Pre-fill the wrangle tab's column selector
  const sel = document.getElementById('op-column');
  if (sel) sel.value = col;
}

/* ── Data table ─────────────────────────────────────────────────────────── */
function renderTable(preview) {
  const { columns, data, total_rows, page, page_size } = preview;
  const start = page * page_size;
  const end   = Math.min(start + page_size, total_rows);

  document.getElementById('preview-range').textContent =
    `Rows ${start + 1}–${end} of ${total_rows.toLocaleString()}`;
  document.getElementById('page-info').textContent =
    `Page ${page + 1} / ${Math.ceil(total_rows / page_size)}`;

  const outlierCols = new Set(Object.keys(S.quality.outliers ?? {}));

  document.getElementById('table-head').innerHTML =
    `<tr>${columns.map(c =>
      `<th class="${c === S.selectedCol ? 'col-selected' : ''}" onclick="selectCol('${esc(c)}')">${esc(c)}</th>`
    ).join('')}</tr>`;

  document.getElementById('table-body').innerHTML = data.map(row =>
    `<tr>${columns.map(c => {
      const val    = row[c];
      const isNull = val === null || val === undefined;
      const isOut  = !isNull && outlierCols.has(c);
      const colSel = c === S.selectedCol ? 'col-selected' : '';
      const cls    = [colSel, isNull ? 'null-cell' : isOut ? 'outlier-cell' : ''].filter(Boolean).join(' ');
      return `<td class="${cls}" title="${esc(String(val ?? ''))}">${esc(isNull ? 'null' : String(val).slice(0, 60))}</td>`;
    }).join('')}</tr>`
  ).join('');
}

function highlightTableCol(col) {
  document.querySelectorAll('.data-table th, .data-table td').forEach(el => el.classList.remove('col-selected'));
  const idx = S.columns.indexOf(col);
  if (idx < 0) return;
  document.querySelectorAll('#table-head th')[idx]?.classList.add('col-selected');
  document.querySelectorAll(`#table-body tr td:nth-child(${idx + 1})`).forEach(td => td.classList.add('col-selected'));
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
  if (name === 'log')       renderLog();
  if (name === 'visualize') { populateVizSelects(); updateVizControls(); }
}

/* ── Quality Report ─────────────────────────────────────────────────────── */
function updateQualityBadge() {
  const qr = S.quality;
  const n  = Object.keys(qr.missing ?? {}).length
    + ((qr.duplicates ?? 0) > 0 ? 1 : 0)
    + Object.keys(qr.type_issues ?? {}).length
    + Object.keys(qr.outliers ?? {}).length
    + Object.keys(qr.inconsistent_formats ?? {}).length
    + Object.keys(qr.typo_candidates ?? {}).length;
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
  if (Object.keys(qr.missing ?? {}).length) {
    html += aSection('Missing Values', '#f59e0b', iconInfo(),
      Object.entries(qr.missing).map(([col, i]) =>
        `<div class="anomaly-row">
          ${pill(i.pct > 30 ? 'HIGH' : i.pct > 10 ? 'MED' : 'LOW', i.pct > 30 ? 'sev-high' : i.pct > 10 ? 'sev-medium' : 'sev-low')}
          <span class="log-col flex-1">${esc(col)}</span>
          <span class="text-prussian-300 text-[11px]">${i.count.toLocaleString()} null (${i.pct}%)</span>
          <button class="op-btn ml-2" onclick="prefillWrangle('fill_missing','${esc(col)}')">Fix</button>
        </div>`).join(''));
  }

  /* Duplicates */
  if ((qr.duplicates ?? 0) > 0) {
    html += aSection('Duplicate Rows', '#ef4444', iconCopy(),
      `<div class="anomaly-row">
        ${pill('MED','sev-medium')}
        <span class="text-prussian-200 flex-1">${qr.duplicates.toLocaleString()} exact duplicate rows</span>
        <button class="op-btn" onclick="prefillWrangle('remove_duplicates',null)">Fix</button>
      </div>`);
  }

  /* Type issues */
  if (Object.keys(qr.type_issues ?? {}).length) {
    html += aSection('Incorrect Data Types', '#0684f9', iconCode(),
      Object.entries(qr.type_issues).map(([col, i]) =>
        `<div class="anomaly-row">
          ${pill('TYPE','sev-medium')}
          <span class="log-col flex-1">${esc(col)}</span>
          <span class="text-prussian-300 text-[11px]">${i.current} → ${i.suggested} (${i.convertible_pct}% convertible)</span>
          <button class="op-btn ml-2" onclick="prefillWrangle('convert_type','${esc(col)}')">Fix</button>
        </div>`).join(''));
  }

  /* Outliers */
  if (Object.keys(qr.outliers ?? {}).length) {
    html += aSection('Outliers', '#f59e0b', iconWarn(),
      Object.entries(qr.outliers).map(([col, i]) =>
        `<div class="anomaly-row">
          ${pill(i.pct > 5 ? 'HIGH' : 'MED', i.pct > 5 ? 'sev-high' : 'sev-medium')}
          <span class="log-col flex-1">${esc(col)}</span>
          <span class="text-prussian-300 text-[11px]">${i.count} outliers (${i.pct}%) IQR [${i.lower_bound}, ${i.upper_bound}]</span>
          <button class="op-btn ml-2" onclick="prefillWrangle('handle_outliers','${esc(col)}')">Fix</button>
        </div>`).join(''));
  }

  /* Inconsistent formats */
  if (Object.keys(qr.inconsistent_formats ?? {}).length) {
    html += aSection('Inconsistent Formats', '#adbceb', iconEdit(),
      Object.entries(qr.inconsistent_formats).map(([col, i]) => {
        const detail = i.type === 'date_format'
          ? Object.entries(i.formats).map(([f, c]) => `${f}:${c}`).join(' | ')
          : `lower:${i.lower} upper:${i.upper} title:${i.title} mixed:${i.mixed}`;
        const op = i.type === 'date_format' ? 'standardize_date' : 'standardize_case';
        return `<div class="anomaly-row">
          ${pill(i.type === 'date_format' ? 'DATE' : 'CASE','sev-low')}
          <span class="log-col flex-1">${esc(col)}</span>
          <span class="text-prussian-300 text-[10px]">${esc(detail)}</span>
          <button class="op-btn ml-2" onclick="prefillWrangle('${op}','${esc(col)}')">Fix</button>
        </div>`;
      }).join(''));
  }

  /* Typos */
  if (Object.keys(qr.typo_candidates ?? {}).length) {
    html += aSection('Spelling / Typo Candidates', '#adbceb', iconEdit(),
      Object.entries(qr.typo_candidates).map(([col, mapping]) =>
        `<div class="anomaly-row flex-col items-start gap-2">
          <div class="flex items-center gap-2 w-full">
            ${pill('TYPO','sev-low')}
            <span class="log-col">${esc(col)}</span>
            <button class="op-btn ml-auto" onclick="prefillWrangle('fix_typos','${esc(col)}')">Fix</button>
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
      <p class="text-green-400 font-medium mb-1">No anomalies detected</p>
      <p class="text-prussian-400 text-xs">Dataset looks clean.</p>
    </div>`;
  }

  document.getElementById('quality-content').innerHTML = html;
}

/* Shortcut: jump to Wrangle tab with operation pre-filled */
function prefillWrangle(opType, col) {
  switchTab('wrangle');
  document.getElementById('op-type').value = opType;
  if (col) document.getElementById('op-column').value = col;
  renderOpParams();
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
    case 'fix_typos': {
      const col = document.getElementById('op-column')?.value;
      return { mapping: S.quality.typo_candidates?.[col] ?? {} };
    }
    default: return {};
  }
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

  const spinner = document.getElementById('op-spinner');
  const btn     = document.getElementById('btn-apply-op');
  spinner.classList.remove('hidden');
  btn.disabled = true;
  resultEl.textContent = '';

  try {
    S.pyodide.globals.set('_op_type', opType);
    S.pyodide.globals.set('_op_col',  col ?? '');
    S.pyodide.globals.set('_op_params', JSON.stringify(params));
    const raw  = await py('apply_operation(_op_type, _op_col or None, _op_params)');
    const data = JSON.parse(raw);

    if (data.ok) {
      applyState(data);
      const label = opType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      resultEl.textContent = `Applied: ${label}`;
      resultEl.className = 'text-xs text-green-400';
      toast(`${label}${col ? ' on ' + col : ''} applied`, 'success');
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

/* ── Op Log ─────────────────────────────────────────────────────────────── */
function updateLogBadge() {
  const b = document.getElementById('log-badge');
  b.textContent = S.opLog.length;
  b.classList.toggle('hidden', S.opLog.length === 0);
}

function renderLog() {
  const el = document.getElementById('log-content');
  if (!S.opLog.length) {
    el.innerHTML = `<p class="text-prussian-500 text-sm text-center mt-12">No operations applied yet.</p>`;
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

async function undoOperation(i) {
  try {
    const raw  = await py(`undo_operation(${i})`);
    const data = JSON.parse(raw);
    if (!data.ok) { toast(data.error, 'error'); return; }

    applyState(data);
    renderLog();
    if (data.failed?.length) {
      const names = data.failed.map(f => f.type.replace(/_/g, ' ')).join(', ');
      toast(`Undone — but ${data.failed.length} later operation(s) no longer applied and were removed: ${names}`, 'error', 6000);
    } else {
      toast('Operation undone', 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ── Visualisation ──────────────────────────────────────────────────────── */
function populateVizSelects() {
  const opts = S.columns.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  document.getElementById('viz-col').innerHTML  = `<option value="">Select column</option>` + opts;
  document.getElementById('viz-col2').innerHTML = `<option value="">Second column (optional)</option>` + opts;
}

function updateVizControls() {
  const type      = document.getElementById('viz-type').value;
  const needsCol  = ['histogram','bar','scatter','box','line','pie'].includes(type);
  const needsCol2 = ['scatter','box','line'].includes(type); // box: group-by, line: x-axis
  document.getElementById('viz-col').classList.toggle('hidden', !needsCol);
  document.getElementById('viz-col2').classList.toggle('hidden', !needsCol2);
}

async function generateChart() {
  const type = document.getElementById('viz-type').value;
  const col  = document.getElementById('viz-col').value  || undefined;
  const col2 = document.getElementById('viz-col2').value || undefined;

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
  gallery.innerHTML = charts.map((c, i) =>
    `<div class="chart-card" style="--i:${Math.min(i, 8)}">
      <h4>${esc(c.title ?? c.type)}</h4>
      <img src="data:image/png;base64,${c.data}" alt="${esc(c.title ?? '')}" loading="lazy" />
    </div>`
  ).join('');
}

/* ── Reset ──────────────────────────────────────────────────────────────── */
async function resetDataset() {
  try {
    const raw  = await py('reset()');
    const data = JSON.parse(raw);
    applyState(data);
    S.selectedCol = null;
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

/* ── Init ───────────────────────────────────────────────────────────────── */
function initUI() {
  const dz = document.getElementById('drop-zone');
  document.getElementById('file-input').addEventListener('change', e => handleUpload(e.target.files[0]));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drop-zone-active'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drop-zone-active'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drop-zone-active'); handleUpload(e.dataTransfer.files[0]); });

  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  document.getElementById('btn-reset').addEventListener('click', resetDataset);
  document.getElementById('btn-download').addEventListener('click', exportCSV);
  document.getElementById('prev-page').addEventListener('click', () => { if (S.currentPage > 0) loadPage(S.currentPage - 1); });
  document.getElementById('next-page').addEventListener('click', () => { if ((S.currentPage + 1) * S.pageSize < S.totalRows) loadPage(S.currentPage + 1); });

  document.getElementById('op-type').addEventListener('change', renderOpParams);
  document.getElementById('op-column').addEventListener('change', renderOpParams);
  document.getElementById('btn-apply-op').addEventListener('click', applyOperation);
  document.getElementById('viz-type').addEventListener('change', () => { updateVizControls(); populateVizSelects(); });
  document.getElementById('btn-generate').addEventListener('click', generateChart);

  renderOpParams();
}

boot();
