"""
Data cleaning module — runs inside Pyodide (Python in browser).
All functions are called from app.js via pyodide.runPythonAsync().
State is held in module-level globals so the DataFrame persists
between operations without serialisation overhead.
"""
import io
import json
import math
import warnings
import pandas as pd
import numpy as np
from difflib import get_close_matches

_df = None
_original_df = None
_op_log = []
_changed = {}     # col -> set of row index labels changed by the last operation


def _diff_changed(before, after):
    """Cell-level diff between two frames, over surviving rows/columns."""
    changed = {}
    common_idx = after.index.intersection(before.index)
    common_cols = [c for c in after.columns if c in before.columns]
    a, b = after.loc[common_idx], before.loc[common_idx]
    for c in common_cols:
        av, bv = a[c], b[c]
        try:
            m = av.ne(bv) & ~(av.isna() & bv.isna())
        except Exception:
            m = av.astype(str) != bv.astype(str)
        labels = av.index[m]
        if len(labels):
            changed[str(c)] = set(labels)
    return changed


def _clean(o):
    """Make a structure strictly JSON-safe: NaN/inf/NaT -> null, Timestamps -> str."""
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean(v) for v in o]
    if isinstance(o, float) and not math.isfinite(o):
        return None
    if o is pd.NaT:
        return None
    return o


def _dump(obj):
    return json.dumps(_clean(obj), default=str)


# ── Load ──────────────────────────────────────────────────────────────────────

def load_csv(csv_text):
    global _df, _original_df, _op_log, _changed
    _df = pd.read_csv(io.StringIO(csv_text))
    _original_df = _df.copy()
    _op_log = []
    _changed = {}
    return _dump(_build_state())


def load_records(json_text):
    """Load a list of JSON records (e.g. from the data.gov.my API).
    Nested objects are flattened to dotted column names via json_normalize."""
    global _df, _original_df, _op_log, _changed
    records = json.loads(json_text)
    if isinstance(records, dict):
        records = records.get('data', [records])
    _df = pd.json_normalize(records)
    _original_df = _df.copy()
    _op_log = []
    _changed = {}
    return _dump(_build_state())


# ── State snapshot ────────────────────────────────────────────────────────────

def get_state():
    return _dump(_build_state())


def _build_state():
    return {
        'preview': _preview(),
        'stats': _stats(),
        'quality': _quality_report(),
        'op_log': _op_log,
    }


def _preview(page=0, page_size=100):
    start = page * page_size
    chunk = _df.iloc[start:start + page_size].copy()
    # Timestamps are not JSON-serialisable — render as strings for the UI
    for c in chunk.columns:
        if pd.api.types.is_datetime64_any_dtype(chunk[c]):
            chunk[c] = chunk[c].dt.strftime('%Y-%m-%d %H:%M:%S')
    # astype(object) first — .where(..., None) on numeric columns silently
    # reinserts NaN, which json.dumps emits as invalid bare NaN
    safe = chunk.astype(object).where(pd.notnull(chunk), None)
    # positions (within this page) of cells changed by the last operation
    changed_cells = {}
    if _changed:
        for c, labels in _changed.items():
            if c in chunk.columns:
                pos = [i for i, lbl in enumerate(chunk.index) if lbl in labels]
                if pos:
                    changed_cells[c] = pos
    return {
        'changed_cells': changed_cells,
        'columns': list(_df.columns),
        'dtypes': {c: str(_df[c].dtype) for c in _df.columns},
        'data': safe.to_dict(orient='records'),
        'total_rows': len(_df),
        'total_cols': len(_df.columns),
        'page': page,
        'page_size': page_size,
    }


def get_page(page):
    return _dump({'preview': _preview(page=int(page))})


# ── Stats ─────────────────────────────────────────────────────────────────────

def _stats():
    out = {}
    for col in _df.columns:
        null_n = int(_df[col].isnull().sum())
        entry = {
            'dtype': str(_df[col].dtype),
            'null_count': null_n,
            'null_pct': round(null_n / len(_df) * 100, 2) if len(_df) > 0 else 0,
            'unique_count': int(_df[col].nunique()),
        }
        if pd.api.types.is_numeric_dtype(_df[col]):
            nonnull = _df[col].dropna()
            if len(nonnull):
                entry.update({
                    'mean':   round(float(nonnull.mean()), 4),
                    'std':    round(float(nonnull.std()),  4),
                    'min':    round(float(nonnull.min()),  4),
                    'max':    round(float(nonnull.max()),  4),
                    'q25':    round(float(nonnull.quantile(.25)), 4),
                    'median': round(float(nonnull.median()), 4),
                    'q75':    round(float(nonnull.quantile(.75)), 4),
                })
        else:
            top = _df[col].value_counts().head(5)
            entry['top_values'] = {str(k): int(v) for k, v in top.items()}
        out[col] = entry
    return out


# ── Quality report ────────────────────────────────────────────────────────────

def _col_dist(nonnull):
    """24-bin histogram + markers, drawn as an inline sparkline in the UI."""
    counts, edges = np.histogram(nonnull, bins=24)
    return {
        'bins':   [int(c) for c in counts],
        'min':    round(float(edges[0]), 4),
        'max':    round(float(edges[-1]), 4),
        'mean':   round(float(nonnull.mean()), 4),
        'median': round(float(nonnull.median()), 4),
    }


def _col_box(nonnull, lo, hi):
    """Five-number summary + sampled outlier points for the mini box plot."""
    inside = nonnull[(nonnull >= lo) & (nonnull <= hi)]
    outs = nonnull[(nonnull < lo) | (nonnull > hi)]
    if len(outs) > 40:
        outs = outs.sample(40, random_state=0)
    q1, q3 = float(nonnull.quantile(.25)), float(nonnull.quantile(.75))
    return {
        'min':      round(float(nonnull.min()), 4),
        'max':      round(float(nonnull.max()), 4),
        'q1':       round(q1, 4),
        'median':   round(float(nonnull.median()), 4),
        'q3':       round(q3, 4),
        # whiskers: furthest data points still inside the IQR fences
        'whisk_lo': round(float(inside.min()) if len(inside) else q1, 4),
        'whisk_hi': round(float(inside.max()) if len(inside) else q3, 4),
        'points':   [round(float(v), 4) for v in outs],
    }


def _skew(nonnull):
    if len(nonnull) < 3 or nonnull.std() == 0:
        return 0.0
    s = float(nonnull.skew())
    return 0.0 if not math.isfinite(s) else round(s, 2)


def _recommend_fill(col):
    """Suggest a fill method from the column's distribution shape."""
    if not pd.api.types.is_numeric_dtype(_df[col]):
        return {'method': 'mode',
                'label': 'Mode',
                'reason': 'Categorical column — fill with the most frequent value.'}
    nonnull = _df[col].dropna()
    if not len(nonnull):
        return {'method': 'zero', 'label': 'Zero',
                'reason': 'Column is entirely empty — no distribution to estimate from.'}
    sk = _skew(nonnull)
    if abs(sk) <= 0.5:
        return {'method': 'mean', 'label': 'Mean',
                'reason': f'Distribution is roughly symmetric (skew {sk:+.2f}) — the mean is a fair centre.'}
    side = 'right' if sk > 0 else 'left'
    return {'method': 'median', 'label': 'Median',
            'reason': f'Distribution is {side}-skewed (skew {sk:+.2f}) — the mean is pulled toward the tail; the median resists it.'}


def _recommend_outlier(col, pct):
    nonnull = _df[col].dropna()
    sk = _skew(nonnull)
    if pct > 5:
        return {'method': 'cap', 'label': 'Cap (Winsorize)',
                'reason': f'{pct}% of rows are outliers — removing that many would distort the dataset; capping keeps every row.'}
    if abs(sk) > 1:
        side = 'right' if sk > 0 else 'left'
        return {'method': 'cap', 'label': 'Cap (Winsorize)',
                'reason': f'Distribution is heavily {side}-skewed (skew {sk:+.2f}) — extreme values may be a legitimate tail, so cap rather than delete.'}
    return {'method': 'remove', 'label': 'Remove rows',
            'reason': f'Few outliers ({pct}%) in a roughly symmetric distribution (skew {sk:+.2f}) — safe to remove.'}


def _quality_report():
    qr = {
        'summary': {
            'total_rows':    len(_df),
            'total_cols':    len(_df.columns),
            'total_missing': int(_df.isnull().sum().sum()),
            'duplicates':    int(_df.duplicated().sum()),
        },
        'missing':             {},
        'duplicates':          int(_df.duplicated().sum()),
        'type_issues':         {},
        'outliers':            {},
        'inconsistent_formats':{},
        'typo_candidates':     {},
    }

    # 1. Missing values (+ fill recommendation and mini distribution)
    for col in _df.columns:
        n = int(_df[col].isnull().sum())
        if n:
            entry = {'count': n, 'pct': round(n / len(_df) * 100, 2),
                     'recommend': _recommend_fill(col)}
            if pd.api.types.is_numeric_dtype(_df[col]):
                nonnull = _df[col].dropna()
                if len(nonnull) >= 3:
                    entry['dist'] = _col_dist(nonnull)
            qr['missing'][col] = entry

    # 2. Type issues (object columns that are mostly numeric / datetime)
    for col in _df.select_dtypes(include='object').columns:
        nonnull = _df[col].dropna()
        if not len(nonnull):
            continue
        numeric_ratio = pd.to_numeric(nonnull, errors='coerce').notna().sum() / len(nonnull)
        if numeric_ratio >= 0.7:
            qr['type_issues'][col] = {
                'current': 'object', 'suggested': 'numeric',
                'convertible_pct': round(numeric_ratio * 100, 2),
            }
        else:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                dt_ratio = pd.to_datetime(nonnull, errors='coerce').notna().sum() / len(nonnull)
            if dt_ratio >= 0.7:
                qr['type_issues'][col] = {
                    'current': 'object', 'suggested': 'datetime',
                    'convertible_pct': round(dt_ratio * 100, 2),
                }

    # 3. Outliers (IQR)
    for col in _df.select_dtypes(include=np.number).columns:
        nonnull = _df[col].dropna()
        if len(nonnull) < 4:
            continue
        q1, q3 = float(nonnull.quantile(.25)), float(nonnull.quantile(.75))
        iqr = q3 - q1
        lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
        n_out = int(((nonnull < lo) | (nonnull > hi)).sum())
        if n_out:
            pct = round(n_out / len(_df) * 100, 2)
            qr['outliers'][col] = {
                'count': n_out,
                'pct': pct,
                'lower_bound': round(lo, 4),
                'upper_bound': round(hi, 4),
                'recommend': _recommend_outlier(col, pct),
                'box': _col_box(nonnull, lo, hi),
            }

    # 4. Inconsistent formats
    for col in _df.select_dtypes(include='object').columns:
        nonnull = _df[col].dropna()
        if not len(nonnull):
            continue
        date_pats = {
            'YYYY-MM-DD': r'^\d{4}-\d{2}-\d{2}$',
            'DD/MM/YYYY': r'^\d{2}/\d{2}/\d{4}$',
            'DD-MM-YYYY': r'^\d{2}-\d{2}-\d{4}$',
        }
        found = {f: int(nonnull.str.match(p, na=False).sum()) for f, p in date_pats.items() if nonnull.str.match(p, na=False).sum()}
        if len(found) > 1:
            qr['inconsistent_formats'][col] = {'type': 'date_format', 'formats': found}
            continue
        if len(nonnull) > 5:
            s = nonnull.astype(str)
            lo_c, up_c, ti_c = int(s.str.islower().sum()), int(s.str.isupper().sum()), int(s.str.istitle().sum())
            dominant = max(lo_c, up_c, ti_c)
            if dominant < len(s) * 0.8 and len(s) > 10:
                qr['inconsistent_formats'][col] = {
                    'type': 'casing', 'lower': lo_c, 'upper': up_c,
                    'title': ti_c, 'mixed': len(s) - lo_c - up_c - ti_c,
                }

    # 5. Typo / spelling candidates
    for col in _df.select_dtypes(include='object').columns:
        nonnull = _df[col].dropna()
        uniq = nonnull.unique()
        if len(uniq) < 3 or len(uniq) > 200:
            continue
        vc = nonnull.value_counts()
        canonical = list(vc.index[:30])
        mapping = {}
        for val in uniq:
            vs = str(val)
            matches = get_close_matches(vs, [str(c) for c in canonical if c != val], n=1, cutoff=0.85)
            if matches and vc.get(val, 0) < vc.get(matches[0], 0):
                mapping[vs] = matches[0]
        if mapping:
            qr['typo_candidates'][col] = mapping

    return qr


# ── Apply single operation ────────────────────────────────────────────────────

def apply_operation(op_type, column, params_json):
    global _df, _changed
    params = json.loads(params_json) if params_json else {}
    col = column if column else None

    before = _df.copy()
    try:
        _apply(op_type, col, params)
        _op_log.append({'type': op_type, 'column': col, 'params': params})
        _changed = _diff_changed(before, _df)
        return _dump({'ok': True,
                      'rows_removed': len(before) - len(_df),
                      'cells_changed': sum(len(v) for v in _changed.values()),
                      **_build_state()})
    except Exception as e:
        return _dump({'ok': False, 'error': str(e), **_build_state()})


def _apply(op_type, col, params):
    global _df

    if op_type == 'remove_duplicates':
        _df = _df.drop_duplicates()

    elif op_type == 'drop_column':
        _df = _df.drop(columns=[col])

    elif op_type == 'rename_column':
        _df = _df.rename(columns={col: params['new_name']})

    elif op_type == 'fill_missing':
        _fill(col, params.get('method', 'mean'), params.get('value'))

    elif op_type == 'drop_missing_rows':
        _df = _df.dropna(subset=[col]) if col else _df.dropna()

    elif op_type == 'convert_type':
        t = params.get('target', 'numeric')
        if t == 'numeric':
            # .mask: keep original nulls null — NaT would otherwise become
            # the int64 sentinel -9223372036854775808
            _df[col] = pd.to_numeric(_df[col], errors='coerce').mask(_df[col].isna())
        elif t == 'datetime':
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                _df[col] = pd.to_datetime(_df[col], errors='coerce')
        elif t == 'string':
            # keep original nulls as NaN instead of the strings 'nan'/'NaT'
            _df[col] = _df[col].astype(str).where(_df[col].notna())

    elif op_type == 'handle_outliers':
        _outliers(col, params.get('method', 'cap'))

    elif op_type == 'standardize_case':
        case = params.get('case', 'lower')
        s = _df[col].astype(str)
        _df[col] = {'lower': s.str.lower, 'upper': s.str.upper,
                    'title': s.str.title, 'strip': s.str.strip}[case]()

    elif op_type == 'standardize_date':
        fmt = params.get('format', '%Y-%m-%d')
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            _df[col] = pd.to_datetime(_df[col], errors='coerce').dt.strftime(fmt)

    elif op_type == 'fix_typos':
        _df[col] = _df[col].replace(params.get('mapping', {}))

    elif op_type == 'filter_rows':
        cond, val = params.get('condition'), params.get('value')
        if cond == 'not_null':
            _df = _df[_df[col].notnull()]
        elif cond == 'equals':
            _df = _df[_df[col].astype(str) == str(val)]
        elif cond == 'not_equals':
            _df = _df[_df[col].astype(str) != str(val)]
        elif cond == 'contains':
            _df = _df[_df[col].astype(str).str.contains(str(val), case=False, na=False)]
        elif cond == 'greater_than':
            _df = _df[pd.to_numeric(_df[col], errors='coerce') > float(val)]
        elif cond == 'less_than':
            _df = _df[pd.to_numeric(_df[col], errors='coerce') < float(val)]

    elif op_type == 'trim_whitespace':
        _df[col] = _df[col].str.strip()

    elif op_type == 'replace_value':
        _df[col] = _df[col].replace(params.get('old'), params.get('new'))


def _fill(col, method, custom=None):
    cols = [col] if col else list(_df.columns)
    for c in cols:
        if _df[c].isnull().sum() == 0:
            continue
        is_num = pd.api.types.is_numeric_dtype(_df[c])
        if   method == 'mean'   and is_num: _df[c] = _df[c].fillna(_df[c].mean())
        elif method == 'median' and is_num: _df[c] = _df[c].fillna(_df[c].median())
        elif method == 'zero'   and is_num: _df[c] = _df[c].fillna(0)
        elif method == 'mode':
            m = _df[c].mode()
            if len(m): _df[c] = _df[c].fillna(m[0])
        elif method == 'ffill': _df[c] = _df[c].ffill()
        elif method == 'bfill': _df[c] = _df[c].bfill()
        elif method == 'empty_string': _df[c] = _df[c].fillna('')
        elif method == 'custom' and custom is not None:
            v = float(custom) if is_num else custom
            _df[c] = _df[c].fillna(v)


def _outliers(col, method):
    global _df
    q1, q3 = _df[col].quantile(.25), _df[col].quantile(.75)
    iqr = q3 - q1
    lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    if   method == 'cap':    _df[col] = _df[col].clip(lower=lo, upper=hi)
    elif method == 'remove': _df = _df[(_df[col] >= lo) & (_df[col] <= hi) | _df[col].isnull()]
    elif method == 'nullify':
        _df.loc[(_df[col] < lo) | (_df[col] > hi), col] = np.nan
    elif method == 'zscore':
        mean, std = _df[col].mean(), _df[col].std()
        if std > 0:
            _df = _df[abs((_df[col] - mean) / std) <= 3]


def undo_operation(index):
    """Undo one logged operation by replaying the rest from the original data.
    Later ops that fail after removal (e.g. depend on an undone rename) are
    dropped from the log and reported in 'failed'."""
    global _df, _op_log, _changed
    idx = int(index)
    if idx < 0 or idx >= len(_op_log):
        return _dump({'ok': False, 'error': 'Invalid operation index', **_build_state()})

    remaining = [op for i, op in enumerate(_op_log) if i != idx]
    _df = _original_df.copy()
    _op_log = []
    _changed = {}
    failed = []
    for op in remaining:
        try:
            _apply(op['type'], op['column'], op['params'])
            _op_log.append(op)
        except Exception as e:
            failed.append({'type': op['type'], 'column': op['column'], 'error': str(e)})
    return _dump({'ok': True, 'failed': failed, **_build_state()})


def reset():
    global _df, _op_log, _changed
    _df = _original_df.copy()
    _op_log = []
    _changed = {}
    return _dump(_build_state())


def export_csv():
    return _df.to_csv(index=False)
