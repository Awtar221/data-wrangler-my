"""
Visualisation module — runs inside Pyodide alongside cleaner.py.
Accesses _df from cleaner.py's globals (same Pyodide namespace).
Returns base64-encoded PNG strings consumed by app.js.
"""
import base64
import json
from io import BytesIO

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

# Colour tokens matching the CSS palette
BG      = '#070c1d'
SURFACE = '#0a1129'
CARD    = '#142352'
BORDER  = '#1f347a'
TEXT    = '#ebeefa'
MUTED   = '#adbceb'

# Categorical series slots — validated against the CARD surface
# (lightness band, chroma floor, CVD separation, >=3:1 contrast).
# Fixed order; never cycle or reorder — the order is the CVD-safety mechanism.
PALETTE = ['#3987e5', '#199e70', '#c98500', '#008300',
           '#9085e9', '#e66767', '#d55181', '#d95926']
SERIES  = PALETTE[0]   # single-series mark colour (blue)
EMPH    = PALETTE[2]   # reference/annotation lines: mean, trend (yellow)


def _ax(fig, ax):
    fig.patch.set_facecolor(SURFACE)
    ax.set_facecolor(CARD)
    ax.tick_params(colors=MUTED, labelsize=9)
    ax.xaxis.label.set_color(MUTED)
    ax.yaxis.label.set_color(MUTED)
    ax.title.set_color(TEXT)
    for sp in ax.spines.values():
        sp.set_edgecolor(BORDER)
    ax.grid(True, color=BORDER, alpha=0.45, linewidth=0.5)
    ax.set_axisbelow(True)


def _b64(fig):
    buf = BytesIO()
    fig.savefig(buf, format='png', bbox_inches='tight', facecolor=fig.get_facecolor(), dpi=110)
    buf.seek(0)
    enc = base64.b64encode(buf.read()).decode()
    plt.close(fig)
    return enc


def generate(config_json):
    cfg  = json.loads(config_json)
    kind = cfg.get('type', 'auto')
    col  = cfg.get('column')
    col2 = cfg.get('column2')
    charts = []

    # Convention: col = X axis, col2 = Y axis (UI states this per chart type)
    if   kind == 'histogram' and col:  charts.append(_histogram(col))
    elif kind == 'bar'       and col:  charts.append(_bar(col, col2))
    elif kind == 'scatter'   and col and col2: charts.append(_scatter(col, col2))
    elif kind == 'box'       and col2: charts.append(_box(col2, col))   # y = col2, group x = col
    elif kind == 'line'      and col2: charts.append(_line(col2, col)) # y = col2, x = col
    elif kind == 'heatmap':            charts.append(_heatmap())
    elif kind == 'pie'       and col:  charts.append(_pie(col, col2))
    elif kind == 'auto':               charts = _auto()

    return json.dumps([c for c in charts if c])


def _histogram(col):
    fig, ax = plt.subplots(figsize=(8, 4.5))
    _ax(fig, ax)
    data = _df[col].dropna()
    bins = min(50, max(10, len(data) // 20))
    ax.hist(data, bins=bins, color=SERIES, edgecolor=SURFACE, alpha=0.95, linewidth=0.6)
    mean = data.mean()
    ax.axvline(mean, color=EMPH, linestyle='--', linewidth=1.5, label=f'Mean: {mean:.2f}')
    ax.legend(facecolor=CARD, edgecolor=BORDER, labelcolor=TEXT, fontsize=8)
    ax.set_title(f'Distribution  {col}', fontsize=12, pad=10)
    ax.set_xlabel(col); ax.set_ylabel('Frequency')
    plt.tight_layout()
    return {'type': 'histogram', 'title': f'Distribution  {col}', 'data': _b64(fig)}


def _bar(col, val_col=None):
    # optional second (numeric) column: bars become mean of val_col per category
    if val_col and val_col in _df.columns and val_col != col:
        vals = pd.to_numeric(_df[val_col], errors='coerce')
        agg = vals.groupby(_df[col]).mean().dropna().sort_values(ascending=False).head(15)
        if not len(agg):
            return {'type': 'message', 'title': f'{val_col} by {col}',
                    'message': f'"{val_col}" has no numeric values to aggregate. '
                               'Pick a numeric second column, or convert it in Wrangle first.'}
        counts, ylabel = agg, f'Mean {val_col}'
        title = f'Mean {val_col} by {col}'
    else:
        counts, ylabel = _df[col].value_counts().head(15), 'Count'
        title = f'Value Counts  {col}'

    n = len(counts)
    fig, ax = plt.subplots(figsize=(max(7, n * 0.6), 4.5))
    _ax(fig, ax)
    # one nominal series -> one hue; bar length already encodes the value,
    # rainbow-per-bar would spend the identity channel on nothing
    ax.bar(range(n), counts.values, color=SERIES, edgecolor=SURFACE, linewidth=1)
    ax.xaxis.grid(False)
    ax.set_xticks(range(n))
    ax.set_xticklabels([str(v)[:20] for v in counts.index], rotation=35, ha='right', fontsize=8)
    ax.set_title(title, fontsize=12, pad=10)
    ax.set_ylabel(ylabel)
    plt.tight_layout()
    return {'type': 'bar', 'title': title, 'data': _b64(fig)}


def _scatter(col1, col2):
    x = _df[col1].pipe(lambda s: s if np.issubdtype(s.dtype, np.number) else pd.to_numeric(s, errors='coerce'))
    y = _df[col2].pipe(lambda s: s if np.issubdtype(s.dtype, np.number) else pd.to_numeric(s, errors='coerce'))
    mask = x.notna() & y.notna()
    fig, ax = plt.subplots(figsize=(8, 4.5))
    _ax(fig, ax)
    ax.scatter(x[mask], y[mask], color=SERIES, alpha=0.55, s=20, edgecolors='none')
    if mask.sum() >= 2:
        m = np.polyfit(x[mask], y[mask], 1)
        xr = np.linspace(x[mask].min(), x[mask].max(), 100)
        ax.plot(xr, np.polyval(m, xr), color=EMPH, linewidth=1.5, linestyle='--', alpha=0.9)
        corr = x[mask].corr(y[mask])
        ax.text(0.03, 0.95, f'r = {corr:.3f}', transform=ax.transAxes,
                color=TEXT, fontsize=9, va='top')
    ax.set_title(f'{col1} vs {col2}', fontsize=12, pad=10)
    ax.set_xlabel(col1); ax.set_ylabel(col2)
    plt.tight_layout()
    return {'type': 'scatter', 'title': f'{col1} vs {col2}', 'data': _b64(fig)}


def _box(col, group_col=None):
    fig, ax = plt.subplots(figsize=(8, 4.5))
    _ax(fig, ax)
    ax.xaxis.grid(False)
    bp_kw = dict(patch_artist=True, boxprops=dict(facecolor=BORDER, color=SERIES, linewidth=1.2),
                 medianprops=dict(color=EMPH, linewidth=2),
                 whiskerprops=dict(color=MUTED), capprops=dict(color=MUTED),
                 flierprops=dict(marker='o', markerfacecolor=PALETTE[5], markeredgecolor='none',
                                 markersize=3.5, alpha=0.85))
    if group_col and group_col in _df.columns:
        grouped = [(str(k)[:15], g[col].dropna().values) for k, g in _df.groupby(group_col)][:10]
        labels  = [k for k, _ in grouped]
        ax.boxplot([v for _, v in grouped], **bp_kw)
        ax.set_xticks(range(1, len(grouped) + 1))
        ax.set_xticklabels(labels, rotation=30, ha='right', fontsize=8)
        title = f'{col} by {group_col}'
    else:
        ax.boxplot(_df[col].dropna(), **bp_kw)
        title = f'Box Plot  {col}'
    ax.set_title(title, fontsize=12, pad=10)
    ax.set_ylabel(col)
    plt.tight_layout()
    return {'type': 'box', 'title': title, 'data': _b64(fig)}


def _heatmap():
    num_cols = _df.select_dtypes(include=np.number).columns.tolist()
    if len(num_cols) < 2:
        return {'type': 'message', 'title': 'Correlation Heatmap',
                'message': f'A correlation heatmap needs at least 2 numeric columns — this dataset currently has {len(num_cols)}. '
                           'If your numbers are stored as text, use Wrangle → Convert Column Type → Numeric first.'}
    cols = num_cols[:12]
    corr = _df[cols].corr()
    size = max(6, len(cols))
    fig, ax = plt.subplots(figsize=(size, size - 1))
    _ax(fig, ax)
    # center='dark': zero correlation recedes into the dark surface,
    # strong +/- pop as blue/red — a light midpoint would glare on dark theme
    sns.heatmap(corr, ax=ax, cmap=sns.diverging_palette(220, 20, s=80, center='dark', as_cmap=True),
                annot=True, fmt='.2f', linewidths=0.5, linecolor=SURFACE,
                annot_kws={'color': TEXT, 'size': 8}, vmin=-1, vmax=1,
                cbar_kws={'shrink': 0.75})
    ax.set_title('Correlation Matrix', fontsize=12, pad=10)
    ax.tick_params(colors=MUTED, labelsize=8)
    plt.tight_layout()
    return {'type': 'heatmap', 'title': 'Correlation Matrix', 'data': _b64(fig)}


def _line(col, x_col=None):
    fig, ax = plt.subplots(figsize=(10, 4.5))
    _ax(fig, ax)
    y = pd.to_numeric(_df[col], errors='coerce')
    if x_col and x_col in _df.columns:
        ax.plot(_df[x_col], y, color=SERIES, linewidth=1.8)
        ax.set_xlabel(x_col)
    else:
        ax.plot(y.values, color=SERIES, linewidth=1.8)
        ax.set_xlabel('Index')
    ax.set_title(f'Line Chart  {col}', fontsize=12, pad=10)
    ax.set_ylabel(col)
    plt.tight_layout()
    return {'type': 'line', 'title': f'Line Chart  {col}', 'data': _b64(fig)}


def _pie(col, val_col=None):
    # optional second (numeric) column: slices become sum of val_col per category
    if val_col and val_col in _df.columns and val_col != col:
        vals = pd.to_numeric(_df[val_col], errors='coerce')
        counts = vals.groupby(_df[col]).sum().sort_values(ascending=False).head(8)
        counts = counts[counts > 0]  # pie needs positive slices
        if not len(counts):
            return {'type': 'message', 'title': f'{val_col} by {col}',
                    'message': f'"{val_col}" has no positive numeric values to aggregate. '
                               'Pick a numeric second column, or convert it in Wrangle first.'}
        title = f'Composition  Total {val_col} by {col}'
    else:
        counts = _df[col].value_counts().head(8)
        title = f'Composition  {col}'
    if not len(counts):
        return None
    fig, ax = plt.subplots(figsize=(7, 5))
    fig.patch.set_facecolor(SURFACE)
    wedges, texts, autotexts = ax.pie(
        counts.values,
        labels=[str(v)[:15] for v in counts.index],
        autopct='%1.1f%%',
        colors=PALETTE[:len(counts)],
        startangle=140,
        wedgeprops=dict(edgecolor=SURFACE, linewidth=2),
        pctdistance=0.82,
    )
    for t in texts: t.set_color(MUTED); t.set_fontsize(9)
    for at in autotexts: at.set_color(TEXT); at.set_fontsize(8)
    ax.set_title(title, fontsize=12, color=TEXT)
    plt.tight_layout()
    return {'type': 'pie', 'title': title, 'data': _b64(fig)}


def _auto():
    charts = []
    num_cols = _df.select_dtypes(include=np.number).columns.tolist()
    cat_cols = _df.select_dtypes(include='object').columns.tolist()
    for c in num_cols[:3]:  charts.append(_histogram(c))
    for c in cat_cols[:2]:
        if _df[c].nunique() <= 30: charts.append(_bar(c))
    if len(num_cols) >= 2:
        h = _heatmap()
        if h: charts.append(h)
    return charts
