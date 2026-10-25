'use strict';

// grid: a spreadsheet view over one local file. The Go server owns the file;
// this page keeps a copy of the cell model, applies edits optimistically and
// sends each edit to the server as an op. Only visible cells are in the DOM.
//
// Coordinates: selection, rendering and the editor work in *view* rows. With
// no filter, view row = data row. With a filter, view rows map to the data
// rows that pass it (see dr). Ops sent to the server always use data rows.

const TOKEN = location.hash.slice(1);
const ROW_H = 22;
const DEF_W = 100;
const MIN_ROWS = 200;
const MIN_COLS = 26;
const MAX_ROWS = 1048576;
const MAX_COLS = 16384;
const MAX_HITS = 20000;
const MAX_LIST = 300;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const SHIFT = IS_MAC ? '⇧' : 'Shift+';
const ALT = IS_MAC ? '⌥' : 'Alt+';
const CHEVRON_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FUNNEL_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1.5 2h9L7 6.3V10L5 9V6.3z" fill="currentColor"/></svg>';

const $ = (id) => document.getElementById(id);
const vp = $('viewport'), cellsEl = $('cells'), sizer = $('sizer');
const colhead = $('colhead-inner'), rowhead = $('rowhead-inner');
const selbox = $('selbox'), activeEl = $('active'), clipbox = $('clipbox');
const editor = $('editor'), fx = $('fx'), addr = $('addr');
const menu = $('menu'), colMenu = $('colmenu'), findBox = $('find'), findq = $('findq');

let doc;             // {name, path, format, sheets: [{name, values, edit}]}
let si = 0;          // active sheet index
let sheet;           // doc.sheets[si]
const sheetState = []; // per sheet: {widths, header, filters: Map(col -> {q, excluded}), sort}
let ss;              // sheetState[si]
let colW = [];
let colX = [0];      // colX[c] = left edge of column c
let nRows = MIN_ROWS, nCols = MIN_COLS;
let dataCols = 1;    // columns that hold any data; only these get a sort & filter button
let colTypes = [];   // colTypes[c] = {label, title} or null, filled in as headers are drawn
let view = null;     // with a filter: {rows: [data rows shown], tail: data row count when filtered}
let sel = { ar: 0, ac: 0, fr: 0, fc: 0 }; // anchor (the active cell) and focus, in view rows
let ed = null;       // {r, c, mode: 'enter' | 'edit', via: 'cell' | 'fx'}
let clip = null;     // what we last copied, so pastes inside the grid keep formulas
let hits = null, hitList = [], hitIdx = -1;
const undoStack = [], redoStack = [];
let queue = Promise.resolve();
let dirty = false, toldAboutSave = false, quitting = false;

// ---------- server ----------

async function api(path, body) {
  const res = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Grid-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

// send queues ops so the server sees them in the order they were made.
function send(ops) {
  queue = queue
    .then(() => api('ops', { ops }))
    .then(applyResult)
    .catch((err) => toast('Edit failed: ' + err.message));
  return queue;
}

function applyResult(res) {
  if (res.sheets) {
    doc.sheets = res.sheets.map(normalize);
    sheet = doc.sheets[si];
    if (view) refilter();
  }
  for (const u of res.updates || []) {
    const s = doc.sheets[u.sheet];
    putValue(s, u.r, u.c, u.v);
    const k = u.r + ',' + u.c;
    if (u.e) s.edit[k] = u.e; else delete s.edit[k];
  }
  setDirty(res.dirty);
  growToData();
  render();
  showSelection();
}

function normalize(s) {
  s.values = (s.values || []).map((row) => row || []);
  s.edit = s.edit || {};
  return s;
}

// The server keeps an event stream open and sends "quit" when you press
// Ctrl+C in the terminal, so the tab can close itself.
function listenForQuit() {
  const es = new EventSource('/api/events?t=' + encodeURIComponent(TOKEN));
  const stopped = (clean) => {
    es.close();
    if (quitting) return;
    quitting = true;
    const lost = dirty;
    dirty = false; // don't let the "leave site?" prompt block the close
    if (clean) window.close();
    // Browsers only let a page close its own tab in some cases; if this one
    // is still here, say so instead.
    setTimeout(() => {
      $('closedmsg').textContent = (lost ? 'Unsaved changes in this tab were not saved. ' : '') + 'You can close this tab.';
      $('closed').hidden = false;
    }, 150);
  };
  es.addEventListener('quit', () => stopped(true));
  es.addEventListener('error', () => stopped(false));
}

// ---------- cell model (data rows) ----------

const val = (s, r, c) => (s.values[r] && s.values[r][c]) || '';
const editText = (s, r, c) => s.edit[r + ',' + c] ?? val(s, r, c);
const dataRows = (s) => s.values.length;

function putValue(s, r, c, v) {
  if (v === '' && val(s, r, c) === '') return;
  while (s.values.length <= r) s.values.push([]);
  const row = s.values[r];
  while (row.length <= c) row.push('');
  row[c] = v;
}

// ---------- view rows ----------

// dr maps a view row to a data row. Past the filtered rows come the rows
// after the data, so you can still type below it.
const dr = (r) => (!view ? r : r < view.rows.length ? view.rows[r] : view.tail + r - view.rows.length);
const vval = (r, c) => val(sheet, dr(r), c);
const vedit = (r, c) => editText(sheet, dr(r), c);
const viewRows = () => (!view ? dataRows(sheet) : view.rows.length + Math.max(0, dataRows(sheet) - view.tail));

// vrOf maps a data row to its view row, or -1 if a filter hides it.
function vrOf(d) {
  if (!view) return d;
  if (d >= view.tail) return view.rows.length + d - view.tail;
  return view.rows.indexOf(d);
}

// ---------- ops ----------

// applyLocal mirrors the server's handling of an op on our copy of the model.
function applyLocal(op) {
  const s = doc.sheets[op.sheet];
  const n = Math.max(op.n || 1, 1);
  switch (op.op) {
    case 'set':
      if (doc.format === 'xlsx' && op.text.startsWith('=')) {
        s.edit[op.r + ',' + op.c] = op.text; // the server sends back the computed value
      } else {
        putValue(s, op.r, op.c, op.text);
        delete s.edit[op.r + ',' + op.c];
      }
      break;
    case 'insertRows':
      if (op.r <= s.values.length) s.values.splice(op.r, 0, ...Array.from({ length: n }, () => []));
      shiftEdits(s, 'r', op.r, n);
      break;
    case 'deleteRows':
      if (op.r < s.values.length) s.values.splice(op.r, n);
      shiftEdits(s, 'r', op.r, -n);
      break;
    case 'insertCols':
      for (const row of s.values) if (op.c <= row.length) row.splice(op.c, 0, ...Array(n).fill(''));
      shiftEdits(s, 'c', op.c, n);
      if (op.sheet === si) { colW.splice(op.c, 0, ...Array(n).fill(DEF_W)); layout(); }
      break;
    case 'deleteCols':
      for (const row of s.values) if (op.c < row.length) row.splice(op.c, n);
      shiftEdits(s, 'c', op.c, -n);
      if (op.sheet === si) { colW.splice(op.c, n); layout(); }
      break;
    case 'reorder': {
      const moved = op.order.map((i) => s.values[i]);
      moved.forEach((row, j) => { s.values[op.r + j] = row; });
      const to = new Map(op.order.map((old, j) => [old, op.r + j]));
      const out = {};
      for (const [k, v] of Object.entries(s.edit)) {
        const [r, c] = k.split(',').map(Number);
        out[(to.get(r) ?? r) + ',' + c] = v;
      }
      s.edit = out;
      break;
    }
  }
}

function shiftEdits(s, axis, at, delta) {
  const out = {};
  for (const [k, v] of Object.entries(s.edit)) {
    let [r, c] = k.split(',').map(Number);
    let p = axis === 'r' ? r : c;
    if (delta < 0 && p >= at && p < at - delta) continue;
    if (p >= at) p += delta;
    if (axis === 'r') r = p; else c = p;
    out[r + ',' + c] = v;
  }
  s.edit = out;
}

// inverse returns the ops that undo op, given the model before op runs.
function inverse(op) {
  const s = doc.sheets[op.sheet];
  const n = Math.max(op.n || 1, 1);
  const base = { sheet: op.sheet, r: op.r, c: op.c, n };
  const restore = (r0, r1, c0, c1) => {
    const out = [];
    for (let r = r0; r <= Math.min(r1, dataRows(s) - 1); r++) {
      for (let c = c0; c <= Math.min(c1, s.values[r].length - 1); c++) {
        const t = editText(s, r, c);
        if (t !== '') out.push({ op: 'set', sheet: op.sheet, r, c, text: t });
      }
    }
    return out;
  };
  switch (op.op) {
    case 'set': return [{ op: 'set', sheet: op.sheet, r: op.r, c: op.c, text: editText(s, op.r, op.c) }];
    case 'insertRows': return [{ ...base, op: 'deleteRows' }];
    case 'insertCols': return [{ ...base, op: 'deleteCols' }];
    case 'deleteRows': return [{ ...base, op: 'insertRows' }, ...restore(op.r, op.r + n - 1, 0, MAX_COLS)];
    case 'deleteCols': return [{ ...base, op: 'insertCols' }, ...restore(0, MAX_ROWS, op.c, op.c + n - 1)];
    case 'reorder': {
      const back = new Array(op.order.length);
      op.order.forEach((old, j) => { back[old - op.r] = op.r + j; });
      return [{ op: 'reorder', sheet: op.sheet, r: op.r, order: back }];
    }
  }
  return [];
}

// commit applies a batch of ops as one undoable step.
function commit(ops) {
  if (!ops.length) return;
  let inv = [];
  for (const op of ops) {
    inv = inverse(op).concat(inv);
    applyLocal(op);
  }
  undoStack.push({ fwd: ops, inv, si, sel: { ...sel } });
  redoStack.length = 0;
  afterEdit(ops);
}

function undo(redo = false) {
  const entry = (redo ? redoStack : undoStack).pop();
  if (!entry) return;
  (redo ? undoStack : redoStack).push(entry);
  if (entry.si !== si) switchSheet(entry.si);
  const ops = redo ? entry.fwd : entry.inv;
  ops.forEach(applyLocal);
  afterEdit(ops);
  select(entry.sel.ar, entry.sel.ac, entry.sel.fr, entry.sel.fc);
}

function afterEdit(ops) {
  setDirty(true);
  // Rows moved, so the filtered rows need recomputing. Plain edits don't
  // refilter, so a row you just edited doesn't vanish from under you.
  if (view && ops.some((op) => op.op !== 'set')) refilter();
  growToData();
  render();
  showSelection();
  send(ops);
}

// ---------- layout & rendering ----------

function colName(c) {
  let s = '';
  for (c++; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}
function colNum(name) {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
const cellName = (r, c) => colName(c) + (r + 1);

function layout() {
  while (colW.length < nCols) colW.push(DEF_W);
  colX = new Array(nCols + 1);
  colX[0] = 0;
  for (let c = 0; c < nCols; c++) colX[c + 1] = colX[c] + colW[c];
  sizer.style.width = colX[nCols] + 'px';
  sizer.style.height = nRows * ROW_H + 'px';
  const w = Math.max(40, String(Math.max(nRows, dataRows(sheet))).length * 8 + 18);
  $('grid').style.setProperty('--rowhead-w', w + 'px');
}

function colAt(x) {
  let lo = 0, hi = nCols - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (colX[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function growToData() {
  dataCols = maxCols();
  colTypes = []; // the data changed, so the types might have too
  const r = Math.min(MAX_ROWS, Math.max(nRows, viewRows() + 100));
  const c = Math.min(MAX_COLS, Math.max(nCols, dataCols + 10));
  if (r !== nRows || c !== nCols) { nRows = r; nCols = c; layout(); }
}

function maxCols() {
  let n = 1;
  for (const row of sheet.values) if (row.length > n) n = row.length;
  return n;
}

const NUM_RE = /^[-+]?[$€£¥]?[-+]?\(?[\d,]*\.?\d+\)?(e[-+]?\d+)?%?$/i;

function render() {
  const st = vp.scrollTop, sl = vp.scrollLeft, h = vp.clientHeight, w = vp.clientWidth;
  const r0 = Math.max(0, Math.floor(st / ROW_H) - 2);
  const r1 = Math.min(nRows - 1, Math.ceil((st + h) / ROW_H) + 2);
  const c0 = Math.max(0, colAt(sl) - 1);
  const c1 = Math.min(nCols - 1, colAt(sl + w) + 1);
  const rect = selRect();

  const frag = document.createDocumentFragment();
  for (let r = r0; r <= r1; r++) {
    const d = dr(r);
    const row = sheet.values[d];
    const hdr = ss.header && d === 0 ? ' hdr' : '';
    for (let c = c0; c <= c1; c++) {
      const el = document.createElement('div');
      const v = (row && row[c]) || '';
      el.className = 'c' + hdr + (v && NUM_RE.test(v) ? ' n' : '') + (hits && hits.has(d + ',' + c) ? ' hit' : '');
      el.style.cssText = `left:${colX[c]}px;top:${r * ROW_H}px;width:${colW[c]}px;height:${ROW_H}px`;
      el.textContent = v;
      frag.appendChild(el);
    }
  }
  cellsEl.replaceChildren(frag);

  const ch = document.createDocumentFragment();
  for (let c = c0; c <= c1; c++) {
    const el = document.createElement('div');
    const filtered = isFiltering(ss.filters.get(c));
    el.className = 'ch' + (c >= rect.c0 && c <= rect.c1 ? ' on' : '') + (filtered ? ' filt' : '');
    el.style.cssText = `left:${colX[c]}px;width:${colW[c]}px`;
    el.dataset.c = c;
    el.append(colName(c));
    // The column's data type: a small muted tag pinned to the left edge, clear
    // of the centered letter and the menu button. Narrow columns drop the tag
    // and keep the type on hover and in the sort & filter menu.
    const type = c < dataCols ? colType(c) : null;
    if (type) el.title = type.title;
    // The centered letter (and sort arrow) must clear the tag on the left and
    // the button on the right.
    const mid = colName(c).length * 7 + (ss.sort && ss.sort.c === c ? 18 : 0);
    if (type && colW[c] >= Math.max(2 * (10 + type.label.length * 6) + mid, mid + 44)) {
      const tag = document.createElement('span');
      tag.className = 'type';
      tag.textContent = type.label;
      el.append(tag);
    }
    if (ss.sort && ss.sort.c === c) {
      const arrow = document.createElement('span');
      arrow.className = 'sort';
      arrow.textContent = ss.sort.desc ? '↓' : '↑';
      el.append(arrow);
    }
    if (c < dataCols || filtered) {
      const dd = document.createElement('div');
      dd.className = 'dd';
      dd.dataset.c = c;
      dd.title = `Sort & filter (${ALT}↓)`;
      dd.innerHTML = filtered ? FUNNEL_SVG : CHEVRON_SVG;
      el.append(dd);
    }
    const rz = document.createElement('div');
    rz.className = 'resizer';
    rz.dataset.c = c;
    el.append(rz);
    ch.appendChild(el);
  }
  colhead.replaceChildren(ch);
  colhead.style.transform = `translateX(${-sl}px)`;

  const rh = document.createDocumentFragment();
  for (let r = r0; r <= r1; r++) {
    const el = document.createElement('div');
    el.className = 'rh' + (r >= rect.r0 && r <= rect.r1 ? ' on' : '') + (view && r < view.rows.length ? ' fr' : '');
    el.style.cssText = `top:${r * ROW_H}px;height:${ROW_H}px`;
    el.textContent = dr(r) + 1;
    el.dataset.r = r;
    rh.appendChild(el);
  }
  rowhead.replaceChildren(rh);
  rowhead.style.transform = `translateY(${-st}px)`;
}

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

vp.addEventListener('scroll', () => {
  // Like an endless sheet: add rows and columns as you scroll toward the edge.
  if (vp.scrollTop + vp.clientHeight > nRows * ROW_H - 10 * ROW_H && nRows < MAX_ROWS) {
    nRows = Math.min(MAX_ROWS, nRows + 500); layout();
  }
  if (vp.scrollLeft + vp.clientWidth > colX[nCols] - 3 * DEF_W && nCols < MAX_COLS) {
    nCols = Math.min(MAX_COLS, nCols + 20); layout();
  }
  scheduleRender();
});
window.addEventListener('resize', scheduleRender);

function measurer() {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '600 13px ' + getComputedStyle(document.body).fontFamily;
  return ctx;
}

function autoWidths(s) {
  const ctx = measurer();
  const out = [];
  const rows = Math.min(dataRows(s), 500);
  for (let r = 0; r < rows; r++) {
    const row = s.values[r];
    for (let c = 0; c < Math.min(row.length, 500); c++) {
      if (!row[c]) continue;
      // Room for the sort/filter button on the header row.
      out[c] = Math.max(out[c] || 0, ctx.measureText(row[c]).width + (r === 0 ? 34 : 16));
    }
  }
  return Array.from(out, (w) => (w ? Math.round(Math.min(360, Math.max(60, w))) : DEF_W));
}

function autofit(c) {
  const ctx = measurer();
  let w = 40;
  for (let r = 0; r < Math.min(dataRows(sheet), 5000); r++) {
    const v = val(sheet, r, c);
    if (v) w = Math.max(w, ctx.measureText(v).width + 16);
  }
  colW[c] = Math.round(Math.min(600, w));
  layout(); render(); showSelection();
}

// ---------- selection ----------

function selRect() {
  return {
    r0: Math.min(sel.ar, sel.fr), r1: Math.max(sel.ar, sel.fr),
    c0: Math.min(sel.ac, sel.fc), c1: Math.max(sel.ac, sel.fc),
  };
}

// dataRect clips a selection to the rows that can hold data, so selecting a
// whole column doesn't mean walking a million empty rows.
function dataRect() {
  const r = selRect();
  return { ...r, r1: Math.min(r.r1, viewRows() - 1) };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function select(ar, ac, fr = ar, fc = ac, scroll = true) {
  sel = {
    ar: clamp(ar, 0, MAX_ROWS - 1), ac: clamp(ac, 0, MAX_COLS - 1),
    fr: clamp(fr, 0, MAX_ROWS - 1), fc: clamp(fc, 0, MAX_COLS - 1),
  };
  if (scroll) {
    if (sel.fr >= nRows - 5) { nRows = Math.min(MAX_ROWS, sel.fr + 200); layout(); }
    if (sel.fc >= nCols - 2) { nCols = Math.min(MAX_COLS, sel.fc + 20); layout(); }
    ensureVisible(sel.fr, sel.fc);
  }
  showSelection();
  render();
}

function showSelection() {
  const { r0, r1, c0, c1 } = selRect();
  const multi = r0 !== r1 || c0 !== c1;
  const rc = Math.min(c1, nCols - 1), rr = Math.min(r1, nRows - 1);
  place(selbox, colX[c0], r0 * ROW_H, colX[rc + 1] - colX[c0], (rr - r0 + 1) * ROW_H, multi);
  place(activeEl, colX[sel.ac] - 1, sel.ar * ROW_H - 1, colW[sel.ac] + 1, ROW_H + 1, true);
  if (clip && clip.si === si) {
    const cc = Math.min(clip.c1, nCols - 1);
    place(clipbox, colX[clip.c0], clip.r0 * ROW_H, colX[cc + 1] - colX[clip.c0], (clip.r1 - clip.r0 + 1) * ROW_H, true);
  } else {
    clipbox.style.display = 'none';
  }
  if (!ed) {
    fx.value = vedit(sel.ar, sel.ac);
    const lastR = r1 >= MAX_ROWS - 1 ? MAX_ROWS - 1 : dr(r1);
    addr.value = multi ? cellName(dr(r0), c0) + ':' + cellName(lastR, c1) : cellName(dr(sel.ar), sel.ac);
    fitAddr();
  }
  scheduleStats();
}

function place(el, x, y, w, h, show) {
  el.style.display = show ? 'block' : 'none';
  el.style.cssText += `;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
}

function ensureVisible(r, c) {
  const top = r * ROW_H, bottom = top + ROW_H;
  if (top < vp.scrollTop) vp.scrollTop = top;
  else if (bottom > vp.scrollTop + vp.clientHeight) vp.scrollTop = bottom - vp.clientHeight;
  const left = colX[c], right = colX[c + 1];
  if (left < vp.scrollLeft) vp.scrollLeft = left;
  else if (right > vp.scrollLeft + vp.clientWidth) vp.scrollLeft = right - vp.clientWidth;
}

function move(dr_, dc, extend) {
  if (extend) select(sel.ar, sel.ac, sel.fr + dr_, sel.fc + dc);
  else select(sel.ar + dr_, sel.ac + dc);
}

// jump is Ctrl/Cmd+arrow: to the edge of the current block of data, or to
// the next filled cell if you're next to a gap.
function jump(dy, dx, extend) {
  const filled = (r, c) => vval(r, c) !== '';
  const r0 = extend ? sel.fr : sel.ar, c0 = extend ? sel.fc : sel.ac;
  // Past the last filled cell there's nothing to find, so stop at the data's edge.
  const hiR = Math.max(viewRows() - 1, r0), hiC = Math.max(maxCols() - 1, c0);
  const inside = (r, c) => r >= 0 && c >= 0 && r <= hiR && c <= hiC;
  let r = r0, c = c0;
  if (filled(r, c) && inside(r + dy, c + dx) && filled(r + dy, c + dx)) {
    while (inside(r + dy, c + dx) && filled(r + dy, c + dx)) { r += dy; c += dx; }
  } else {
    do { r += dy; c += dx; } while (inside(r, c) && !filled(r, c));
    if (!inside(r, c)) {
      if (dy) r = dy > 0 ? hiR : 0;
      if (dx) c = dx > 0 ? hiC : 0;
    }
  }
  if (extend) select(sel.ar, sel.ac, r, c); else select(r, c);
}

// ---------- editing ----------

function startEdit(mode, initial) {
  if (ed) return;
  ed = { r: sel.ar, c: sel.ac, mode, via: 'cell' };
  ensureVisible(ed.r, ed.c);
  editor.hidden = false;
  editor.value = initial ?? vedit(ed.r, ed.c);
  editor.style.left = colX[ed.c] - 1 + 'px';
  editor.style.top = ed.r * ROW_H - 1 + 'px';
  sizeEditor();
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  fx.value = editor.value;
}

function sizeEditor() {
  const cellW = colW[ed.c] + 2;
  editor.style.width = cellW + 'px';
  editor.style.height = '0px';
  editor.style.width = Math.max(cellW, editor.scrollWidth + 12) + 'px';
  editor.style.height = Math.max(ROW_H + 2, editor.scrollHeight + 4) + 'px';
}

function commitEdit() {
  if (!ed) return;
  const { r, c, via } = ed;
  const text = via === 'fx' ? fx.value : editor.value;
  endEdit();
  if (text !== vedit(r, c)) commit([{ op: 'set', sheet: si, r: dr(r), c, text }]);
}

function cancelEdit() {
  if (!ed) return;
  endEdit();
  showSelection();
}

function endEdit() {
  ed = null;
  editor.hidden = true;
  editor.value = '';
  vp.focus({ preventScroll: true });
}

editor.addEventListener('input', () => { fx.value = editor.value; sizeEditor(); });
editor.addEventListener('blur', () => { if (ed && ed.via === 'cell') commitEdit(); });
editor.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'Enter' && (e.altKey || e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    editor.setRangeText('\n', editor.selectionStart, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input'));
  } else if (k === 'Enter' || k === 'Tab') {
    e.preventDefault();
    commitEdit();
    if (k === 'Enter') move(e.shiftKey ? -1 : 1, 0); else move(0, e.shiftKey ? -1 : 1);
  } else if (k === 'Escape') {
    e.preventDefault();
    cancelEdit();
  } else if (k === 'F2') {
    e.preventDefault();
    ed.mode = ed.mode === 'enter' ? 'edit' : 'enter';
  } else if (ed.mode === 'enter' && k.startsWith('Arrow')) {
    e.preventDefault();
    commitEdit();
    move(...ARROWS[k], false);
  }
});

fx.addEventListener('focus', () => {
  if (ed && ed.via === 'cell') commitEdit();
  ed = { r: sel.ar, c: sel.ac, mode: 'edit', via: 'fx' };
});
fx.addEventListener('blur', () => { if (ed && ed.via === 'fx') commitEdit(); });
fx.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    commitEdit();
    if (e.key === 'Enter') move(e.shiftKey ? -1 : 1, 0); else move(0, e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
  }
});

addr.title = `Go to a cell, row, column or header (${MOD}G)`;
addr.addEventListener('input', fitAddr);
addr.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { showSelection(); vp.focus(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  vp.focus();
  goTo(addr.value.trim());
});

function fitAddr() {
  addr.style.width = Math.max(84, addr.value.length * 8 + 20) + 'px';
}

function openGoTo() {
  if (ed) commitEdit();
  closeColMenu();
  addr.focus();
  addr.select();
}

// goTo jumps to what was typed in the address box: a cell (B12), a range
// (A1:D20), a row (12), a column (AA) or a column by its header (email).
function goTo(q) {
  if (!q) { showSelection(); return; }
  if (/^\d+$/.test(q)) {
    if (+q < 1 || +q > MAX_ROWS) { showSelection(); return; }
    const r = vrOf(+q - 1);
    if (r < 0) { toast(`Row ${q} is hidden by a filter`); showSelection(); return; }
    select(r, sel.ac);
    return;
  }
  const m = q.toUpperCase().match(/^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/);
  if (!m) {
    const c = findColumn(q);
    if (c < 0) { toast(`No column named "${q}"`); showSelection(); return; }
    select(sel.ar, c);
    return;
  }
  const r = vrOf(+m[2] - 1), c = colNum(m[1]);
  if (r < 0) { toast(`Row ${m[2]} is hidden by a filter`); showSelection(); return; }
  if (m[3]) {
    const r2 = vrOf(+m[4] - 1);
    select(r, c, r2 < 0 ? r : r2, colNum(m[3]));
  } else {
    select(r, c);
  }
}

// findColumn resolves a column name or header, or returns -1. A header that
// matches exactly wins, then column letters inside the data (so "AB" means
// column AB, not "Abbreviation"), then the first header containing the text,
// then column letters past the data.
function findColumn(q) {
  const name = q.toLowerCase(), n = maxCols();
  const heads = [];
  if (ss.header) for (let c = 0; c < n; c++) heads.push(String(val(sheet, 0, c)).trim().toLowerCase());
  const exact = heads.indexOf(name);
  if (exact >= 0) return exact;
  const letters = /^[a-z]{1,3}$/.test(name) ? colNum(name) : -1;
  if (letters >= 0 && letters < n) return letters;
  const part = heads.findIndex((h) => h.includes(name));
  if (part >= 0) return part;
  return letters < MAX_COLS ? letters : -1;
}

function clearSelection() {
  const { r0, r1, c0, c1 } = dataRect();
  const ops = [];
  for (let r = r0; r <= r1; r++) {
    const d = dr(r);
    for (let c = c0; c <= Math.min(c1, (sheet.values[d] || []).length - 1); c++) {
      if (editText(sheet, d, c) !== '') ops.push({ op: 'set', sheet: si, r: d, c, text: '' });
    }
  }
  commit(ops);
}

// shiftFormula moves a formula's relative references by (dy, dx), the way
// Excel does when you copy a formula to another cell.
const REF_RE = /(^|[^A-Za-z0-9_.$])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(!'])/g;
function shiftFormula(text, dy, dx) {
  if (!text.startsWith('=') || doc.format !== 'xlsx' || (!dy && !dx)) return text;
  return text.split('"').map((part, i) => (i % 2 ? part : part.replace(REF_RE, (m, pre, ca, col, ra, row) => {
    const c = ca ? colNum(col) : colNum(col) + dx;
    const r = ra ? +row - 1 : +row - 1 + dy;
    if (c < 0 || r < 0 || c >= MAX_COLS || r >= MAX_ROWS) return pre + '#REF!';
    return pre + ca + colName(c) + ra + (r + 1);
  }))).join('"');
}

// fill is Ctrl+D (down) and Ctrl+R (right): copy the first row or column of
// the selection across the rest. With one row selected, fill from the row above.
function fill(down) {
  let { r0, r1, c0, c1 } = selRect();
  if (down && r0 === r1) r0 = Math.max(0, r0 - 1);
  if (!down && c0 === c1) c0 = Math.max(0, c0 - 1);
  // A whole column or row only fills as far as the data goes.
  if (r1 >= nRows - 1) r1 = Math.max(r0, viewRows() - 1);
  if (c1 >= nCols - 1) c1 = Math.max(c0, maxCols() - 1);
  const ops = [];
  if (down) {
    const d0 = dr(r0);
    for (let c = c0; c <= c1; c++) {
      const src = editText(sheet, d0, c);
      for (let r = r0 + 1; r <= r1; r++) {
        const d = dr(r);
        ops.push({ op: 'set', sheet: si, r: d, c, text: shiftFormula(src, d - d0, 0) });
      }
    }
  } else {
    for (let r = r0; r <= r1; r++) {
      const d = dr(r);
      const src = editText(sheet, d, c0);
      for (let c = c0 + 1; c <= c1; c++) ops.push({ op: 'set', sheet: si, r: d, c, text: shiftFormula(src, 0, c - c0) });
    }
  }
  commit(ops.filter((op) => op.text !== editText(sheet, op.r, op.c)));
}

// ---------- clipboard ----------

function isTextInput(el) {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function copySelection(cut) {
  const { r0, r1, c0, c1 } = dataRect();
  const last = Math.max(r0, r1);
  const lines = [], cells = [], drows = [];
  for (let r = r0; r <= last; r++) {
    const d = dr(r);
    const line = [], crow = [];
    for (let c = c0; c <= c1; c++) {
      const v = val(sheet, d, c);
      line.push(/[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
      crow.push(editText(sheet, d, c));
    }
    lines.push(line.join('\t'));
    cells.push(crow);
    drows.push(d);
  }
  const text = lines.join('\n');
  clip = { text, cells, drows, si, r0, c0, r1: last, c1, cut };
  showSelection();
  return text;
}

function parseTSV(text) {
  text = text.replace(/\r?\n$/, '');
  const rows = [[]];
  let cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === '\t') { rows[rows.length - 1].push(cur); cur = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') continue;
    else if (ch === '\n' || ch === '\r') { rows[rows.length - 1].push(cur); cur = ''; rows.push([]); }
    else cur += ch;
  }
  rows[rows.length - 1].push(cur);
  return rows;
}

function paste(text) {
  const internal = clip && text === clip.text;
  const src = internal ? clip.cells : parseTSV(text);
  const h = src.length, w = Math.max(...src.map((r) => r.length));
  const { r0, r1, c0, c1 } = selRect();
  // Tile the clipboard over the selection when it fits a whole number of times.
  const th = (r1 - r0 + 1) % h === 0 && r1 < nRows - 1 ? r1 - r0 + 1 : h;
  const tw = (c1 - c0 + 1) % w === 0 && c1 < nCols - 1 ? c1 - c0 + 1 : w;
  const ops = [];
  const dest = new Set();
  for (let i = 0; i < th; i++) {
    const d = dr(r0 + i);
    for (let j = 0; j < tw; j++) {
      let t = src[i % h][j % w] ?? '';
      const c = c0 + j;
      if (internal && !clip.cut) t = shiftFormula(t, d - clip.drows[i % h], c - (clip.c0 + (j % w)));
      ops.push({ op: 'set', sheet: si, r: d, c, text: t });
      dest.add(d + ',' + c);
    }
  }
  if (internal && clip.cut) {
    // A cut moves the cells: clear whatever part of the source wasn't pasted over.
    for (const d of clip.drows) {
      for (let c = clip.c0; c <= clip.c1; c++) {
        if (clip.si !== si || !dest.has(d + ',' + c)) ops.unshift({ op: 'set', sheet: clip.si, r: d, c, text: '' });
      }
    }
    clip = null;
  }
  commit(ops.filter((op) => op.text !== editText(doc.sheets[op.sheet], op.r, op.c)));
  select(r0, c0, r0 + th - 1, c0 + tw - 1, false);
}

document.addEventListener('copy', (e) => {
  if (isTextInput(e.target)) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', copySelection(false));
});
document.addEventListener('cut', (e) => {
  if (isTextInput(e.target)) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', copySelection(true));
});
document.addEventListener('paste', (e) => {
  if (isTextInput(e.target)) return;
  e.preventDefault();
  paste(e.clipboardData.getData('text/plain'));
});

// ---------- sorting ----------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const DATE_RE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/;

// sortKey turns a cell into something comparable: numbers (including dates
// and currency) as numbers, everything else as text.
function sortKey(display, edit) {
  if (display === '') return { blank: true };
  let n = edit !== undefined && !edit.startsWith('=') && edit !== '' ? Number(edit) : NaN;
  if (Number.isNaN(n)) n = toNumber(display);
  if (Number.isNaN(n) && DATE_RE.test(display)) n = Date.parse(display);
  return Number.isNaN(n) ? { text: display } : { num: n };
}

// compareKeys orders numbers before text, like Excel. Blanks always go last,
// whichever way you sort.
function compareKeys(a, b, desc) {
  if (a.blank || b.blank) return (a.blank ? 1 : 0) - (b.blank ? 1 : 0);
  let d;
  if (a.num !== undefined && b.num !== undefined) d = a.num - b.num;
  else if (a.num !== undefined) d = -1;
  else if (b.num !== undefined) d = 1;
  else d = collator.compare(a.text, b.text);
  return desc ? -d : d;
}

function sortBy(c, desc) {
  if (ed) commitEdit();
  const start = ss.header ? 1 : 0;
  const n = dataRows(sheet);
  if (n - start < 2) return;
  const keys = [];
  for (let r = start; r < n; r++) keys.push({ r, k: sortKey(val(sheet, r, c), sheet.edit[r + ',' + c]) });
  keys.sort((a, b) => compareKeys(a.k, b.k, desc));
  const order = keys.map((x) => x.r);
  ss.sort = { c, desc };
  if (order.every((r, i) => r === start + i)) { render(); toast('Already sorted'); return; }
  commit([{ op: 'reorder', sheet: si, r: start, order }]);
  toast(`Sorted by ${columnLabel(c)}, ${sortLabels(c)[desc ? 1 : 0]}`);
}

function isNumericColumn(c) {
  let nums = 0, total = 0;
  for (let r = ss.header ? 1 : 0; r < Math.min(dataRows(sheet), 2000); r++) {
    const v = val(sheet, r, c);
    if (!v) continue;
    total++;
    if (sortKey(v, sheet.edit[r + ',' + c]).num !== undefined) nums++;
  }
  return total > 0 && nums / total >= 0.8;
}

const TYPES = {
  text: ['abc', 'Text'], number: ['123', 'Number'], currency: ['$', 'Currency'], percent: ['%', 'Percent'],
  date: ['date', 'Date'], bool: ['y/n', 'Yes/No'],
};
const BOOL_RE = /^(true|false|yes|no)$/i;

function valueType(v) {
  const t = v.trim();
  if (BOOL_RE.test(t)) return 'bool';
  if (NUM_RE.test(t)) return t.endsWith('%') ? 'percent' : /[$€£¥]/.test(t) ? 'currency' : 'number';
  if (DATE_RE.test(t) && !Number.isNaN(Date.parse(t))) return 'date';
  return 'text';
}

// colType labels a column by the kind of values in it, looking at the same
// rows as isNumericColumn. A type needs 80% of the non-blank values; numbers,
// currency and percents together count as numbers; anything else is mixed.
function colType(c) {
  if (colTypes[c] !== undefined) return colTypes[c];
  const counts = {};
  let total = 0, sym = '$';
  for (let r = ss.header ? 1 : 0; r < Math.min(dataRows(sheet), 2000); r++) {
    const v = val(sheet, r, c);
    if (!v) continue;
    const t = valueType(v);
    if (t === 'currency' && !counts.currency) sym = v.match(/[$€£¥]/)[0];
    counts[t] = (counts[t] || 0) + 1;
    total++;
  }
  if (!total) return (colTypes[c] = null);
  const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const nums = (counts.number || 0) + (counts.currency || 0) + (counts.percent || 0);
  const of = (k, m) => `${TYPES[k][1]}: ${m.toLocaleString()} of ${total.toLocaleString()} values`;
  let type;
  if (n / total >= 0.8) type = { label: top === 'currency' ? sym : TYPES[top][0], title: of(top, n) };
  else if (nums / total >= 0.8) type = { label: TYPES.number[0], title: of('number', nums) };
  else {
    const mix = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, m]) => `${m.toLocaleString()} ${TYPES[k][1].toLowerCase()}`);
    type = { label: 'mix', title: 'Mixed: ' + mix.join(', ') };
  }
  return (colTypes[c] = type);
}

function sortLabels(c) {
  return isNumericColumn(c) ? ['smallest to largest', 'largest to smallest'] : ['A → Z', 'Z → A'];
}

function columnLabel(c) {
  const name = ss.header ? val(sheet, 0, c) : '';
  return name ? `${colName(c)} (${name})` : `column ${colName(c)}`;
}

// ---------- filtering ----------

// compileQuery turns what you type in a column's search box into a test.
//   north      contains "north" (any case)
//   =North     exactly "North" (any case)
//   !north     doesn't contain "north";  != or <> for not exactly
//   >10 <=5    numeric comparisons
function compileQuery(q) {
  q = q.trim();
  if (!q) return null;
  let m = q.match(/^(>=|<=|>|<)\s*(.+)$/);
  if (m) {
    const n = toNumber(m[2]);
    if (Number.isNaN(n)) return () => false;
    const op = m[1];
    return (v) => {
      const x = toNumber(v);
      if (Number.isNaN(x)) return false;
      return op === '>' ? x > n : op === '<' ? x < n : op === '>=' ? x >= n : x <= n;
    };
  }
  const lower = (s) => s.toLowerCase();
  if ((m = q.match(/^(!=|<>)(.*)$/))) { const t = lower(m[2].trim()); return (v) => lower(v) !== t; }
  if (q.startsWith('!')) { const t = lower(q.slice(1).trim()); return (v) => !lower(v).includes(t); }
  if (q.startsWith('=')) { const t = lower(q.slice(1).trim()); return (v) => lower(v) === t; }
  const t = lower(q);
  return (v) => lower(v).includes(t);
}

const isFiltering = (f) => !!f && (f.q.trim() !== '' || f.excluded.size > 0);

// refilter recomputes which rows pass the active sheet's filters.
function refilter() {
  const active = [...ss.filters].filter(([, f]) => isFiltering(f));
  if (!active.length) { view = null; return; }
  const tests = active.map(([c, f]) => [c, compileQuery(f.q), f.excluded]);
  const rows = [];
  const n = dataRows(sheet);
  let start = 0;
  if (ss.header && n > 0) { rows.push(0); start = 1; }
  for (let r = start; r < n; r++) {
    if (tests.every(([c, m, ex]) => { const v = val(sheet, r, c); return (!m || m(v)) && !ex.has(v); })) rows.push(r);
  }
  view = { rows, tail: n };
}

function applyFilters() {
  const before = view ? dr(sel.ar) : sel.ar;
  refilter();
  clip = null;
  if (!findBox.hidden) runFind();
  const r = vrOf(before);
  sel = { ar: Math.max(r, 0), ac: sel.ac, fr: Math.max(r, 0), fc: sel.ac };
  if (r < 0) vp.scrollTop = 0;
  showFilterInfo();
  growToData();
  render();
  showSelection();
}

function clearFilters() {
  if (!ss.filters.size) return;
  ss.filters.clear();
  applyFilters();
  if (!colMenu.hidden) closeColMenu();
}

function showFilterInfo() {
  const el = $('filterinfo');
  if (!view) { el.hidden = true; return; }
  const total = dataRows(sheet) - (ss.header ? 1 : 0);
  const shown = view.rows.length - (ss.header && dataRows(sheet) ? 1 : 0);
  el.hidden = false;
  el.replaceChildren(`Filtered: ${shown.toLocaleString()} of ${total.toLocaleString()} rows`);
  const btn = document.createElement('button');
  btn.textContent = `Clear filters (${MOD}${SHIFT}L)`;
  btn.addEventListener('click', clearFilters);
  el.append(btn);
}

// ---------- column menu: sort, search, filter ----------

let cm = null; // {c, f, values: [[value, count]], list, all, more}

function openColMenu(c) {
  if (ed) commitEdit();
  hideMenu();
  const f = ss.filters.get(c) || { q: '', excluded: new Set() };
  ss.filters.set(c, f);
  const counts = new Map();
  for (let r = ss.header ? 1 : 0; r < dataRows(sheet); r++) {
    const v = val(sheet, r, c);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const values = [...counts].sort((a, b) => compareKeys(sortKey(a[0]), sortKey(b[0]), false));
  const [asc, desc] = sortLabels(c);

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const title = el('div', 'cm-title', colName(c));
  if (ss.header && val(sheet, 0, c)) title.append(el('span', '', ' · ' + val(sheet, 0, c)));
  const type = colType(c);
  if (type) title.append(el('span', 'cm-type', ' · ' + type.title.split(':')[0]));

  const sortBox = el('div', 'cm-sort');
  const sortBtn = (label, isDesc) => {
    const b = el('button', 'cm-btn', 'Sort ' + label);
    b.append(el('kbd', '', ALT + (isDesc ? '↓' : '↑')));
    b.addEventListener('click', () => { closeColMenu(); sortBy(c, isDesc); });
    return b;
  };
  sortBox.append(sortBtn(asc, false), sortBtn(desc, true));

  const q = el('input', 'cm-q');
  q.placeholder = 'Search this column';
  q.spellcheck = false;
  q.value = f.q;
  const hint = el('div', 'cm-hint');
  hint.innerHTML = 'Also: <code>=exact</code> <code>!not</code> <code>&gt;10</code> <code>&lt;=5</code>';

  const list = el('div', 'cm-list');
  const foot = el('div', 'cm-foot');
  const hdr = el('label');
  const hdrBox = el('input');
  hdrBox.type = 'checkbox';
  hdrBox.checked = ss.header;
  hdr.append(hdrBox, 'Row 1 is headers');
  hdrBox.addEventListener('change', () => {
    ss.header = hdrBox.checked;
    applyFilters();
    openColMenu(c);
  });
  const clear = el('button', 'cm-btn', 'Clear filter');
  clear.addEventListener('click', () => { f.q = ''; f.excluded.clear(); q.value = ''; applyFilters(); renderList(); q.focus(); });
  foot.append(hdr, clear);

  colMenu.replaceChildren(title, sortBox, el('div', 'sep'), q, hint, list, foot);
  cm = { c, f, values, list, q };

  let timer;
  q.addEventListener('input', () => {
    f.q = q.value;
    renderList();
    clearTimeout(timer);
    timer = setTimeout(applyFilters, 120);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      clearTimeout(timer);
      applyFilters();
      closeColMenu();
    } else if (e.key === 'ArrowDown' && !e.altKey) {
      e.preventDefault();
      list.querySelector('input')?.focus();
    }
  });
  renderList();
  colMenu.hidden = false;
  const head = $('colhead').getBoundingClientRect();
  const x = head.left + colX[c] - vp.scrollLeft;
  const b = colMenu.getBoundingClientRect();
  colMenu.style.left = clamp(x, 8, innerWidth - b.width - 8) + 'px';
  colMenu.style.top = Math.min(head.bottom + 2, innerHeight - b.height - 8) + 'px';
  q.focus();
  q.select();
}

function renderList() {
  const { f, values, list } = cm;
  const m = compileQuery(f.q);
  const shown = m ? values.filter(([v]) => m(v)) : values;
  const items = [];
  const item = (label, count, checked, onChange, cls = '') => {
    const row = document.createElement('label');
    row.className = 'cm-item ' + cls;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    box.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
        e.preventDefault();
        const boxes = [...list.querySelectorAll('input')];
        const i = boxes.indexOf(box) + (e.key === 'ArrowDown' ? 1 : -1);
        if (i < 0) cm.q.focus(); else boxes[Math.min(i, boxes.length - 1)].focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        closeColMenu();
      }
    });
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = label;
    row.append(box, v);
    if (count !== undefined) {
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = count.toLocaleString();
      row.append(n);
    }
    return { row, box };
  };
  const included = shown.filter(([v]) => !f.excluded.has(v)).length;
  const all = item(m ? 'Select all matches' : 'Select all', undefined, included === shown.length, (on) => {
    for (const [v] of shown) on ? f.excluded.delete(v) : f.excluded.add(v);
    applyFilters();
    renderList();
  }, 'all');
  all.box.indeterminate = included > 0 && included < shown.length;
  items.push(all.row);
  for (const [v, count] of shown.slice(0, MAX_LIST)) {
    items.push(item(v === '' ? '(Blanks)' : v, count, !f.excluded.has(v), (on) => {
      on ? f.excluded.delete(v) : f.excluded.add(v);
      applyFilters();
      renderList();
    }).row);
  }
  if (shown.length > MAX_LIST) {
    const more = document.createElement('div');
    more.className = 'cm-more';
    more.textContent = `Showing ${MAX_LIST} of ${shown.length.toLocaleString()} values. Type to narrow.`;
    items.push(more);
  }
  if (!shown.length) {
    const none = document.createElement('div');
    none.className = 'cm-more';
    none.textContent = 'No matching values';
    items.push(none);
  }
  const focusedIdx = [...list.querySelectorAll('input')].indexOf(document.activeElement);
  list.replaceChildren(...items);
  if (focusedIdx >= 0) list.querySelectorAll('input')[focusedIdx]?.focus();
}

function closeColMenu() {
  if (colMenu.hidden) return;
  colMenu.hidden = true;
  if (cm && !isFiltering(cm.f)) ss.filters.delete(cm.c);
  cm = null;
  render();
  vp.focus({ preventScroll: true });
}

// Inside the menu, Option+↑ sorts ascending and Option+↓ descending, so
// Option+↓ twice from the grid sorts the column largest first.
colMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeColMenu(); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && cm) {
    e.preventDefault();
    e.stopPropagation(); // don't let the grid's Option+↓ reopen the menu
    const c = cm.c;
    closeColMenu();
    sortBy(c, e.key === 'ArrowDown');
  }
});
document.addEventListener('mousedown', (e) => {
  if (!colMenu.hidden && !colMenu.contains(e.target) && !e.target.closest('.dd')) closeColMenu();
});

// ---------- keyboard ----------

const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

document.addEventListener('keydown', (e) => {
  if (quitting) return;
  if (!menu.hidden) { if (e.key === 'Escape') hideMenu(); return; }
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && k === 's') { e.preventDefault(); save(); return; }
  if (mod && e.shiftKey && k === 'l') { e.preventDefault(); clearFilters(); return; }
  if (mod && e.shiftKey && k === 'f') { e.preventDefault(); openColMenu(sel.ac); return; }
  if (mod && k === 'f') { e.preventDefault(); openFind(); return; }
  if (mod && !e.shiftKey && k === 'g') { e.preventDefault(); openGoTo(); return; }
  if (isTextInput(e.target) || !colMenu.hidden) return;

  if (e.altKey && k === 'ArrowDown') { e.preventDefault(); openColMenu(sel.ac); return; }
  if (mod && k === 'z') { e.preventDefault(); undo(e.shiftKey); return; }
  if (mod && k === 'y') { e.preventDefault(); undo(true); return; }
  if (mod && k === 'a') { e.preventDefault(); select(0, 0, Math.max(viewRows(), 1) - 1, maxCols() - 1, false); return; }
  if (mod && k === 'd') { e.preventDefault(); fill(true); return; }
  if (mod && k === 'r') { e.preventDefault(); fill(false); return; }
  if (mod && (k === 'c' || k === 'x' || k === 'v')) return; // native copy/cut/paste events
  if (ARROWS[k]) {
    e.preventDefault();
    if (mod) jump(...ARROWS[k], e.shiftKey); else move(...ARROWS[k], e.shiftKey);
    return;
  }
  switch (k) {
    case 'Tab': e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return;
    case 'Enter': e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); return;
    case 'F2': e.preventDefault(); startEdit('edit'); return;
    case 'Delete': case 'Backspace': e.preventDefault(); clearSelection(); return;
    case 'Escape': clip = null; showSelection(); return;
    case 'Home': e.preventDefault(); mod ? select(0, 0) : select(sel.ar, 0); return;
    case 'PageDown': case 'PageUp': {
      e.preventDefault();
      const page = Math.max(1, Math.floor(vp.clientHeight / ROW_H) - 1) * (k === 'PageDown' ? 1 : -1);
      vp.scrollTop += page * ROW_H;
      move(page, 0, e.shiftKey);
      return;
    }
  }
  if (k === ' ' && e.shiftKey && !mod) { e.preventDefault(); const { r0, r1 } = selRect(); select(r0, 0, r1, MAX_COLS - 1, false); return; }
  if (k === ' ' && e.ctrlKey) { e.preventDefault(); const { c0, c1 } = selRect(); select(0, c0, MAX_ROWS - 1, c1, false); return; }
  if (e.key.length === 1 && !mod && !e.isComposing) {
    e.preventDefault();
    startEdit('enter', e.key);
  }
});

// ---------- mouse ----------

let drag = null; // {kind: 'cells' | 'rows' | 'cols' | 'resize', ...}
let lastMouse = null;

function cellAt(clientX, clientY) {
  const b = vp.getBoundingClientRect();
  const x = clamp(clientX - b.left, 0, vp.clientWidth - 1) + vp.scrollLeft;
  const y = clamp(clientY - b.top, 0, vp.clientHeight - 1) + vp.scrollTop;
  return [clamp(Math.floor(y / ROW_H), 0, nRows - 1), colAt(x)];
}

function inSelection(r, c) {
  const s = selRect();
  return r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1;
}

vp.addEventListener('mousedown', (e) => {
  if (e.target === editor) return;
  hideMenu();
  if (ed) commitEdit();
  const [r, c] = cellAt(e.clientX, e.clientY);
  if (e.button === 2 && inSelection(r, c)) return;
  e.preventDefault();
  vp.focus({ preventScroll: true });
  if (e.shiftKey) select(sel.ar, sel.ac, r, c, false); else select(r, c, r, c, false);
  if (e.button === 0) drag = { kind: 'cells' };
});
vp.addEventListener('dblclick', (e) => {
  if (e.target === editor) return;
  startEdit('edit');
});

$('colhead').addEventListener('mousedown', (e) => {
  hideMenu();
  if (ed) commitEdit();
  e.preventDefault();
  const c = +e.target.dataset.c;
  if (Number.isNaN(c)) return;
  if (e.target.closest('.dd')) {
    if (!colMenu.hidden && cm && cm.c === c) { closeColMenu(); return; }
    select(sel.ar, c, sel.ar, c, false);
    openColMenu(c);
    return;
  }
  vp.focus({ preventScroll: true });
  if (e.target.classList.contains('resizer')) {
    drag = { kind: 'resize', c, x: e.clientX, w: colW[c] };
    return;
  }
  if (e.button === 2 && inSelection(0, c) && selRect().r1 >= nRows - 1) return;
  select(0, e.shiftKey ? sel.ac : c, MAX_ROWS - 1, c, false);
  drag = { kind: 'cols' };
});
$('colhead').addEventListener('dblclick', (e) => {
  if (e.target.classList.contains('resizer')) autofit(+e.target.dataset.c);
});

$('rowhead').addEventListener('mousedown', (e) => {
  hideMenu();
  if (ed) commitEdit();
  e.preventDefault();
  vp.focus({ preventScroll: true });
  const r = +e.target.dataset.r;
  if (Number.isNaN(r)) return;
  if (e.button === 2 && inSelection(r, 0) && selRect().c1 >= MAX_COLS - 1) return;
  select(e.shiftKey ? sel.ar : r, 0, r, MAX_COLS - 1, false);
  drag = { kind: 'rows' };
});

function dragTo(clientX, clientY) {
  if (!drag) return;
  if (drag.kind === 'resize') {
    colW[drag.c] = Math.max(24, drag.w + clientX - drag.x);
    layout(); render(); showSelection();
    return;
  }
  const [r, c] = cellAt(clientX, clientY);
  if (drag.kind === 'cells') select(sel.ar, sel.ac, r, c, false);
  else if (drag.kind === 'cols') select(0, sel.ac, MAX_ROWS - 1, c, false);
  else select(sel.ar, 0, r, MAX_COLS - 1, false);
}

document.addEventListener('mousemove', (e) => {
  lastMouse = [e.clientX, e.clientY];
  dragTo(e.clientX, e.clientY);
});
document.addEventListener('mouseup', () => { drag = null; });

// Keep scrolling while you drag a selection past the edge of the grid.
setInterval(() => {
  if (!drag || drag.kind === 'resize' || !lastMouse) return;
  const b = vp.getBoundingClientRect();
  const [x, y] = lastMouse;
  const dx = x > b.right ? x - b.right : x < b.left ? x - b.left : 0;
  const dy = y > b.bottom ? y - b.bottom : y < b.top ? y - b.top : 0;
  if (!dx && !dy) return;
  if (drag.kind !== 'rows') vp.scrollLeft += dx;
  if (drag.kind !== 'cols') vp.scrollTop += dy;
  dragTo(x, y);
}, 50);

// ---------- context menu ----------

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

function showMenu(x, y) {
  closeColMenu();
  const { r0, r1, c0, c1 } = selRect();
  const wholeCols = r1 >= nRows - 1, wholeRows = c1 >= MAX_COLS - 1;
  const nr = Math.min(r1 - r0 + 1, 1000), nc = Math.min(c1 - c0 + 1, 1000);
  const [asc, desc] = sortLabels(sel.ac);
  const items = [
    ['Cut', MOD + 'X', () => document.execCommand('cut')],
    ['Copy', MOD + 'C', () => document.execCommand('copy')],
    ['Paste', MOD + 'V', () => navigator.clipboard.readText().then(paste, () => toast(`Use ${MOD}V to paste`))],
    null,
    [`Sort ${colName(sel.ac)}: ${asc}`, '', () => sortBy(sel.ac, false)],
    [`Sort ${colName(sel.ac)}: ${desc}`, '', () => sortBy(sel.ac, true)],
    [`Filter ${colName(sel.ac)}…`, ALT + '↓', () => openColMenu(sel.ac)],
    null,
  ];
  if (!wholeCols) {
    const rows = [];
    for (let r = r0; r <= Math.min(r1, r0 + nr - 1); r++) rows.push(dr(r));
    if (!view) {
      items.push(
        [`Insert ${plural(nr, 'row')} above`, '', () => commit([{ op: 'insertRows', sheet: si, r: dr(r0), n: nr }])],
        [`Insert ${plural(nr, 'row')} below`, '', () => commit([{ op: 'insertRows', sheet: si, r: dr(r1) + 1, n: nr }])],
      );
    }
    // With a filter on, delete only the visible rows, bottom first so the
    // row numbers above stay put.
    const del = view
      ? rows.sort((a, b) => b - a).map((r) => ({ op: 'deleteRows', sheet: si, r, n: 1 }))
      : [{ op: 'deleteRows', sheet: si, r: dr(r0), n: nr }];
    items.push([`Delete ${plural(nr, 'row')}`, '', () => commit(del)], null);
  }
  if (!wholeRows) {
    // Filters and the sort arrow are keyed by column, so moving columns
    // around drops them rather than leave them on the wrong column.
    const colOp = (op) => () => {
      if (ss.filters.size) { ss.filters.clear(); applyFilters(); toast('Filters cleared'); }
      ss.sort = null;
      commit([op]);
    };
    items.push(
      [`Insert ${plural(nc, 'column')} left`, '', colOp({ op: 'insertCols', sheet: si, c: c0, n: nc })],
      [`Insert ${plural(nc, 'column')} right`, '', colOp({ op: 'insertCols', sheet: si, c: c1 + 1, n: nc })],
      [`Delete ${plural(nc, 'column')}`, '', colOp({ op: 'deleteCols', sheet: si, c: c0, n: nc })],
      null,
    );
  }
  items.push(['Clear contents', '⌫', clearSelection]);

  menu.replaceChildren(...items.map((it) => {
    const d = document.createElement('div');
    if (!it) { d.className = 'msep'; return d; }
    d.className = 'mi';
    const label = document.createElement('span');
    label.textContent = it[0];
    const kbd = document.createElement('kbd');
    kbd.textContent = it[1];
    d.append(label, kbd);
    d.addEventListener('mousedown', (e) => e.stopPropagation());
    d.addEventListener('click', () => { hideMenu(); it[2](); });
    return d;
  }));
  menu.hidden = false;
  const b = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - b.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - b.height - 8) + 'px';
}

function hideMenu() { menu.hidden = true; }

for (const el of [vp, $('colhead'), $('rowhead')]) {
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY); });
}
document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) hideMenu(); });
window.addEventListener('blur', hideMenu);

// ---------- find ----------

function openFind() {
  if (ed) commitEdit();
  closeColMenu();
  findBox.hidden = false;
  findq.focus();
  findq.select();
}

function runFind() {
  const q = findq.value.toLowerCase();
  hitList = [];
  hitIdx = -1;
  if (q) {
    for (let r = 0; r < viewRows(); r++) {
      const row = sheet.values[dr(r)] || [];
      for (let c = 0; c < row.length; c++) {
        if (row[c] && row[c].toLowerCase().includes(q)) hitList.push([r, c]);
      }
    }
  }
  hits = hitList.length && hitList.length <= MAX_HITS ? new Set(hitList.map(([r, c]) => dr(r) + ',' + c)) : null;
  $('findn').textContent = q ? (hitList.length ? `${hitList.length} found` : 'No matches') : '';
  render();
}

function findNext(back) {
  if (!hitList.length) return;
  if (hitIdx < 0) {
    // Start from the active cell, like Excel.
    const after = hitList.findIndex(([r, c]) => r > sel.ar || (r === sel.ar && c > sel.ac));
    hitIdx = back ? (after <= 0 ? hitList.length : after) - 1 : (after < 0 ? 0 : after);
  } else {
    hitIdx = (hitIdx + (back ? -1 : 1) + hitList.length) % hitList.length;
  }
  const [r, c] = hitList[hitIdx];
  select(r, c);
  $('findn').textContent = `${hitIdx + 1} of ${hitList.length}`;
}

let findTimer;
findq.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 120); });
findq.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); if (hitIdx < 0 && !hitList.length) runFind(); findNext(e.shiftKey); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});

function closeFind() {
  findBox.hidden = true;
  hits = null; hitList = []; hitIdx = -1;
  render();
  vp.focus({ preventScroll: true });
}

// ---------- status bar ----------

let statsTimer;
function scheduleStats() { clearTimeout(statsTimer); statsTimer = setTimeout(updateStats, 60); }

function toNumber(s) {
  if (!s) return NaN;
  let t = s.trim().replace(/[$€£¥,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  const n = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
  if (t === '' || Number.isNaN(n)) return NaN;
  return neg ? -n : n;
}

function updateStats() {
  const el = $('stats');
  if (sel.ar === sel.fr && sel.ac === sel.fc) { el.replaceChildren(); return; }
  const { r0, r1, c0, c1 } = dataRect();
  let count = 0, nums = 0, sum = 0;
  for (let r = r0; r <= r1; r++) {
    const d = dr(r);
    const row = sheet.values[d] || [];
    for (let c = c0; c <= Math.min(c1, row.length - 1); c++) {
      if (!row[c]) continue;
      count++;
      const e = sheet.edit[d + ',' + c];
      let n = e !== undefined && !e.startsWith('=') ? Number(e) : NaN;
      if (Number.isNaN(n)) n = toNumber(row[c]);
      if (!Number.isNaN(n)) { nums++; sum += n; }
    }
  }
  const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  const parts = [['Count', count]];
  if (nums) parts.push(['Sum', fmt(sum)], ['Average', fmt(sum / nums)]);
  el.replaceChildren(...parts.flatMap(([k, v]) => {
    const b = document.createElement('b');
    b.textContent = v;
    return [document.createTextNode(k + ':'), b];
  }));
}

// ---------- sheets, saving, misc ----------

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren(...doc.sheets.map((s, i) => {
    const d = document.createElement('div');
    d.className = 'tab' + (i === si ? ' on' : '');
    d.textContent = s.name;
    d.addEventListener('click', () => switchSheet(i));
    return d;
  }));
}

function switchSheet(i) {
  if (ed) commitEdit();
  closeColMenu();
  if (ss) ss.widths = colW;
  si = i;
  sheet = doc.sheets[si];
  ss = sheetState[si] || (sheetState[si] = { widths: autoWidths(sheet), header: true, filters: new Map(), sort: null });
  colW = ss.widths;
  nRows = MIN_ROWS; nCols = MIN_COLS;
  refilter();
  layout(); growToData();
  vp.scrollTop = 0; vp.scrollLeft = 0;
  if (!findBox.hidden) runFind();
  showFilterInfo();
  renderTabs();
  select(0, 0);
}

function setDirty(d) {
  const was = dirty;
  dirty = d;
  document.body.classList.toggle('dirty', d);
  document.title = (d ? '● ' : '') + doc.name;
  $('savelabel').textContent = d ? 'Unsaved changes · Save' : 'All changes saved';
  if (d && !was && !toldAboutSave) {
    toldAboutSave = true;
    toast(`You have unsaved changes. Press ${MOD}S to save.`, 4000);
  }
}

async function save(force = false) {
  if (ed) commitEdit();
  if (!dirty && !force) { toast('No changes to save'); return; }
  $('savelabel').textContent = 'Saving…';
  await queue;
  try {
    await api('save', { force });
    setDirty(false);
    toast('Saved ' + doc.name);
  } catch (err) {
    setDirty(true);
    if (err.status === 409 && confirm(`${doc.name} changed on disk since grid opened it. Overwrite it with your version?`)) {
      return save(true);
    }
    toast('Save failed: ' + err.message);
  }
}

$('savebtn').addEventListener('click', () => save());
$('savekbd').textContent = MOD + 'S';
$('savebtn').title = `Save (${MOD}S)`;

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

async function init() {
  try {
    doc = await api('doc');
  } catch (err) {
    document.body.textContent = 'grid: ' + (err.status === 403 ? 'this link has expired. Use the URL grid printed in your terminal.' : err.message);
    return;
  }
  doc.sheets.forEach(normalize);
  $('fname').textContent = doc.name;
  $('fname').title = doc.path;
  setDirty(doc.dirty);
  switchSheet(0);
  vp.focus();
  listenForQuit();
}

init();
