// Turns a CV into numbered segments the model can cite by ID, plus (for PDFs)
// the page geometry needed to highlight each one. All of this is plain code:
// the model only ever returns IDs, never quoted text.
//
// Output of both segmentPdf() and segmentText():
//   [{ kind: 'heading', text }
//    { kind: 'seg', id: '12', text, heading, bullet, tabular, page?, boxes?, children?: [{ id: '12.1', text, boxes? }] }]
// structure.js then adds section / role / dates / label.
// boxes are { page, x, y, w, h } in PDF points, top-left origin.

const BULLET_RE = /^\s*(?:[•·▪‣◦●○■□►▸➢✓✔*\-–—−]|\d{1,2}[.)])\s+/;
const SKILLS_HEADING_RE = /skill|technolog|tool|stack|competenc|language|expertise|proficienc|certif|interest|keyword/i;

// ---------- shared helpers ----------

let measureFn = null;
function measure(s) {
  if (!measureFn) {
    try {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
      const ctx = c.getContext('2d');
      ctx.font = '100px sans-serif';
      measureFn = (t) => ctx.measureText(t).width;
    } catch {
      measureFn = (t) => t.length; // no canvas (e.g. Node): character-proportional estimate
    }
  }
  return measureFn(s);
}

// Fraction of a text item's width covered by its first k characters.
function frac(str, k) {
  if (k <= 0) return 0;
  if (k >= str.length) return 1;
  const full = measure(str);
  return full > 0 ? measure(str.slice(0, k)) / full : k / str.length;
}

function isHeadingText(s) {
  s = s.trim();
  if (!s || s.length > 50) return false;
  if (/[.,;|·•!?]/.test(s.replace(/:$/, ''))) return false;
  const words = s.split(/\s+/).length;
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase() && words <= 5) return true;
  if (s.endsWith(':') && words <= 4) return true;
  return false;
}

// Splits a packed list-like line ("Python, SQL | Docker · Git") into
// [start, end) ranges. Separators inside brackets don't count, and "/" only
// counts when spaced (so "CI/CD" stays whole). Returns null if it isn't a list.
function splitList(text, underSkills) {
  const raw = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    else if (depth === 0 && (',;|·•'.includes(ch) || (ch === '/' && text[i - 1] === ' ' && text[i + 1] === ' '))) {
      raw.push([start, i]);
      start = i + 1;
    }
  }
  raw.push([start, text.length]);

  const parts = [];
  for (let [a, b] of raw) {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /[\s.]/.test(text[b - 1])) b--;
    const label = text.slice(a, b).match(/^[^:]{1,30}:\s+/); // "Tools: Docker" -> "Docker"
    if (label) a += label[0].length;
    if (b > a) parts.push([a, b]);
  }
  if (parts.length < 2) return null;
  const lens = parts.map(([a, b]) => b - a);
  const max = Math.max(...lens);
  const avg = lens.reduce((s, n) => s + n, 0) / lens.length;
  const allWords = parts.every(([a, b]) => /[A-Za-z]{2}/.test(text.slice(a, b)));
  if (underSkills && max <= 60 && allWords) return parts;
  if (parts.length >= 4 && avg <= 25 && max <= 40 && allWords) return parts;
  return null;
}

// Splits an inline run of achievements joined by spaced dashes ("Senior BI Analyst -
// Own the weekly dashboard - Built the pipelines") into [start, end) ranges. Each
// clause after the first must read like one: a capitalised word, then a word that
// isn't Title Case ("Own the", "Wrote SQL"), at least three words. With two parts the
// first must be a clause too; with three or more it may be a role name.
const isClause = (t) => /^[A-Z][a-z]{2,}\s+(?![A-Z][a-z])\S/.test(t) && t.split(/\s+/).length >= 3;
function splitDashes(text) {
  const parts = [];
  let start = 0;
  for (const m of text.matchAll(/\s[-–]\s/g)) { parts.push([start, m.index]); start = m.index + m[0].length; }
  parts.push([start, text.length]);
  if (parts.length < 2) return null;
  const t = parts.map(([a, b]) => text.slice(a, b).trim());
  if (!t.slice(1).every(isClause)) return null;
  if (parts.length < 3 && !isClause(t[0])) return null;
  return parts.map(([a, b]) => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /[\s.;,]/.test(text[b - 1])) b--;
    return [a, b];
  });
}

function numberAndSplit(segs) {
  let n = 0;
  for (const s of segs) {
    if (s.kind !== 'seg') continue;
    s.id = String(++n);
    let parts = s.tabular ? null : splitList(s.text, SKILLS_HEADING_RE.test(s.heading || ''));
    if (!parts && !s.tabular && (parts = splitDashes(s.text))) s.dashSplit = true;
    if (parts) {
      s.children = parts.map(([a, b], k) => ({ id: `${s.id}.${k + 1}`, text: s.text.slice(a, b), range: [a, b] }));
    }
  }
  return segs;
}

// A table's header row ("Role | Employer | From | To", "Skill | Level"): every cell is
// a column name. It's kept as a header, never as a line that can become evidence.
const TABLE_HEAD_RE = /^(?:job\s+)?(?:role|title|job|position|employer|company|organi[sz]ation|client|from|to|start|end|dates?|period|years?|duration|location|skills?|level|proficiency|tools?|technology|experience|qualification|degree|institution|university|school|course|grade|subject|certification|issuer|awarded|description)$/i;
export const isTableHead = (cells) => cells.length >= 2 && cells.every((c) => TABLE_HEAD_RE.test(c.trim()));

// ---------- PDF ----------

function normItems(rawItems, page, H) {
  const out = [];
  for (const it of rawItems) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // rotated text: skip
    const size = Math.abs(d) || Math.abs(a) || it.height || 10;
    let x = e, w = it.width;
    const lead = it.str.length - it.str.trimStart().length;
    const trail = it.str.length - it.str.trimEnd().length;
    if (lead || trail) {
      const x0 = x + w * frac(it.str, lead), x1 = x + w * frac(it.str, it.str.length - trail);
      x = x0; w = x1 - x0;
    }
    const base = H - f; // baseline, top-left origin
    out.push({ str: it.str.trim(), page, x, w, base, size, top: base - size * 0.82, bottom: base + size * 0.22 });
  }
  return out;
}

// Finds a vertical gutter (two-column layout) as an x-band that almost no
// text item crosses, with real text on both sides of it.
function findGutter(items, W) {
  if (items.length < 12) return null;
  const BIN = 2, nb = Math.ceil(W / BIN) + 1;
  const cover = new Int32Array(nb);
  for (const it of items) {
    const b0 = Math.max(0, Math.floor(it.x / BIN)), b1 = Math.min(nb - 1, Math.floor((it.x + it.w) / BIN));
    for (let b = b0; b <= b1; b++) cover[b]++;
  }
  const tol = Math.max(1, Math.round(items.length * 0.04));
  let best = null;
  for (let b = 0; b < nb; b++) {
    if (cover[b] > tol) continue;
    let e = b;
    while (e + 1 < nb && cover[e + 1] <= tol) e++;
    const g0 = b * BIN, g1 = (e + 1) * BIN, mid = (g0 + g1) / 2;
    b = e;
    if (g1 - g0 < 10 || mid < W * 0.2 || mid > W * 0.8) continue;
    const left = items.filter((it) => it.x + it.w <= g0 + BIN).length;
    const right = items.filter((it) => it.x >= g1 - BIN).length;
    const rightEdge = items.filter((it) => it.x >= g1 - BIN && it.x <= g1 + 6).length;
    if (left < 4 || right < 4 || rightEdge < 3) continue;
    if (!best || g1 - g0 > best.g1 - best.g0) best = { g0, g1 };
  }
  return best;
}

function buildLines(items, col) {
  items = items.slice().sort((p, q) => p.base - q.base || p.x - q.x);
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.base - it.base) < 0.35 * Math.min(last.size, it.size)) {
      last.items.push(it);
      last.size = Math.max(last.size, it.size);
    } else {
      lines.push({ items: [it], base: it.base, size: it.size, page: it.page, col });
    }
  }
  return lines.map(finishLine);
}

function pieceX(p, local) {
  return p.it.x + p.it.w * frac(p.it.str, p.off + local);
}

function xAt(pieces, idx) {
  for (const p of pieces) if (idx >= p.start && idx <= p.start + p.len) return pieceX(p, idx - p.start);
  const last = pieces[pieces.length - 1];
  return last.it.x + last.it.w;
}

// cols: x where each column of a table starts (from its header row), or null.
const colOf = (cols, x, size) => { let k = 0; while (k + 1 < cols.length && cols[k + 1] <= x + 0.5 * size) k++; return k; };

function finishLine(l, cols = null) {
  l.items.sort((a, b) => a.x - b.x);
  let text = '', prev = null;
  const pieces = [];
  l.tabular = false;
  for (const it of l.items) {
    if (prev) {
      if (it.str === prev.str && Math.abs(it.x - prev.x) < 1) continue; // overprinted duplicate
      const gap = it.x - (prev.x + prev.w);
      if (gap > 2 * l.size || (cols && colOf(cols, it.x, l.size) !== colOf(cols, prev.x, l.size))) { l.tabular = true; text += ' | '; }
      else if (gap > 0.12 * l.size) text += ' ';
    }
    pieces.push({ it, start: text.length, off: 0, len: it.str.length });
    text += it.str;
    prev = it;
  }
  l.x1 = prev.x + prev.w;
  l.top = Math.min(...l.items.map((i) => i.top));
  const m = text.match(BULLET_RE);
  l.bullet = !!m;
  if (m) {
    const k = m[0].length;
    text = text.slice(k);
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      if (p.start + p.len <= k) pieces.splice(i, 1);
      else if (p.start < k) { const cut = k - p.start; p.off += cut; p.len -= cut; p.start = 0; }
      else p.start -= k;
    }
  }
  l.text = text;
  l.pieces = pieces;
  l.indent = pieces.length ? pieceX(pieces[0], 0) : l.items[0].x;
  return l;
}

function orderPage(items, W) {
  const g = findGutter(items, W);
  if (!g) return { lines: buildLines(items, 'S'), gutter: null };
  const mid = (g.g0 + g.g1) / 2;
  const F = [], L = [], R = [];
  for (const it of items) {
    if (it.x < g.g0 && it.x + it.w > g.g1) F.push(it);
    else (it.x + it.w / 2 < mid ? L : R).push(it);
  }
  // Items sharing a baseline with a full-width line belong to that line.
  const fBases = F.map((i) => i.base);
  const sameBase = (it) => fBases.some((b) => Math.abs(b - it.base) < 0.35 * it.size);
  for (const arr of [L, R]) for (let i = arr.length - 1; i >= 0; i--) if (sameBase(arr[i])) F.push(...arr.splice(i, 1));
  const fl = buildLines(F, 'F'), ll = buildLines(L, 'L'), rl = buildLines(R, 'R');
  // Read in bands between full-width lines: left column, then right column.
  const lines = [];
  let li = 0, ri = 0;
  for (const f of fl) {
    while (li < ll.length && ll[li].base < f.base) lines.push(ll[li++]);
    while (ri < rl.length && rl[ri].base < f.base) lines.push(rl[ri++]);
    lines.push(f);
  }
  lines.push(...ll.slice(li), ...rl.slice(ri));
  return { lines, gutter: g };
}

function boxesFor(pieces, a, b) {
  const rects = [];
  for (const p of pieces) {
    const s = Math.max(a, p.start), e = Math.min(b, p.start + p.len);
    if (e <= s) continue;
    const x0 = pieceX(p, s - p.start), x1 = pieceX(p, e - p.start);
    const r = { page: p.it.page, x: x0, y: p.it.top, w: x1 - x0, h: p.it.bottom - p.it.top };
    const last = rects[rects.length - 1];
    if (last && last.page === r.page && Math.abs(last.y - r.y) < 0.5 * r.h && r.x - (last.x + last.w) < 1.5 * r.h) {
      const nx = Math.min(last.x, r.x), ny = Math.min(last.y, r.y);
      last.w = Math.max(last.x + last.w, r.x + r.w) - nx;
      last.h = Math.max(last.y + last.h, r.y + r.h) - ny;
      last.x = nx; last.y = ny;
    } else rects.push(r);
  }
  return rects;
}

// Cells of a PDF line: items split at gaps wider than a short space.
function lineCells(l) {
  const cells = [];
  let prev = null;
  for (const it of l.items) {
    if (prev && it.x - (prev.x + prev.w) <= 0.6 * l.size) { const c = cells[cells.length - 1]; c.text += ' ' + it.str; }
    else cells.push({ x: it.x, text: it.str });
    prev = it;
  }
  return cells;
}

// Table header rows fix the column starts; the rows under them are re-joined with
// " | " between columns even where the gap is narrow ("Senior BI Analyst Brightmart
// Retail" -> "Senior BI Analyst | Brightmart Retail"). The table ends at the first
// line that doesn't sit in at least two columns or has text running across one.
function markTables(all) {
  for (let i = 0; i < all.length; i++) {
    const h = all[i];
    if (h.bullet) continue;
    const cells = lineCells(h);
    if (!isTableHead(cells.map((c) => c.text))) continue;
    const cols = cells.map((c) => c.x);
    h.tableHead = true;
    finishLine(h, cols);
    for (let j = i + 1; j < all.length; j++) {
      const l = all[j];
      if (l.page !== h.page || l.col !== h.col || l.bullet) break;
      const tol = 0.5 * l.size;
      if (l.items[0].x < cols[0] - l.size) break;
      if (l.items.some((it) => cols.some((c) => it.x < c - tol && it.x + it.w > c + tol))) break;
      if (new Set(l.items.map((it) => colOf(cols, it.x, l.size))).size < 2) break;
      finishLine(l, cols);
      i = j;
    }
  }
}

// pages: [{ width, height, items }] where items are pdf.js getTextContent() items.
export function segmentPdf(pages) {
  const all = [];
  pages.forEach((pg, i) => {
    const items = normItems(pg.items, i + 1, pg.height);
    if (!items.length) return;
    const { lines } = orderPage(items, pg.width);
    for (const col of ['S', 'L', 'R', 'F']) {
      const cl = lines.filter((l) => l.col === col);
      if (!cl.length) continue;
      const right = Math.max(...(col === 'F' ? lines : cl).map((l) => l.x1));
      cl.forEach((l) => (l.colRight = right));
    }
    all.push(...lines);
  });
  if (!all.length) return [];
  markTables(all);

  // Body font size (by characters) and tightest line pitch per font size.
  const sizeChars = new Map();
  for (const l of all) { const k = Math.round(l.size * 2) / 2; sizeChars.set(k, (sizeChars.get(k) || 0) + l.text.length); }
  const body = [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const minPitch = new Map();
  for (let i = 1; i < all.length; i++) {
    const p = all[i - 1], l = all[i];
    if (p.page !== l.page || p.col !== l.col || Math.abs(p.size - l.size) > 0.6) continue;
    const d = l.base - p.base;
    if (d < 0.9 * l.size || d > 2.2 * l.size) continue;
    const k = Math.round(l.size * 2) / 2;
    minPitch.set(k, Math.min(minPitch.get(k) ?? Infinity, d));
  }

  const isHeading = (l) => !l.bullet && !l.tabular && (isHeadingText(l.text) ||
    (l.size >= body * 1.12 && l.text.split(/\s+/).length <= 8 && !/[.,;|·•]$/.test(l.text)));

  const canContinue = (seg, l) => {
    const p = seg.lines[seg.lines.length - 1];
    if (l.bullet || l.tabular || seg.tabular) return false;
    if (l.page !== p.page || l.col !== p.col || Math.abs(l.size - p.size) > 0.6) return false;
    const pitch = l.base - p.base;
    const mp = minPitch.get(Math.round(l.size * 2) / 2) ?? 1.2 * l.size;
    if (pitch <= 0 || pitch > mp * 1.03 + 0.2) return false; // a blank gap / paragraph spacing
    if (Math.abs(l.indent - seg.indent) > 0.6 * l.size) return false; // not aligned with the text indent
    // Wrap test: the next line's first word would not have fitted on the previous line.
    const firstWord = l.text.split(/\s/)[0].length;
    const wordW = xAt(l.pieces, firstWord) - l.indent;
    return p.x1 + 0.25 * l.size + wordW * 0.9 >= p.colRight - 1;
  };

  const segs = [];
  let cur = null, heading = null;
  for (const l of all) {
    if (!l.pieces.length) continue;
    if (l.tableHead) { cur = null; segs.push({ kind: 'heading', table: true, text: l.text }); continue; }
    if (isHeading(l)) {
      cur = null;
      heading = l.text;
      segs.push({ kind: 'heading', text: l.text });
      continue;
    }
    if (cur && canContinue(cur, l)) {
      const joiner = /[A-Za-z]-$/.test(cur.text) ? '' : ' ';
      const off = cur.text.length + joiner.length;
      cur.pieces.push(...l.pieces.map((p) => ({ ...p, start: p.start + off })));
      cur.text += joiner + l.text;
      cur.lines.push(l);
      continue;
    }
    cur = { kind: 'seg', heading, page: l.page, lines: [l], text: l.text, pieces: l.pieces.slice(), indent: l.indent, tabular: l.tabular, bullet: l.bullet };
    segs.push(cur);
  }

  numberAndSplit(segs);
  for (const s of segs) {
    if (s.kind !== 'seg') continue;
    s.boxes = boxesFor(s.pieces, 0, s.text.length);
    if (s.children) for (const c of s.children) c.boxes = boxesFor(s.pieces, c.range[0], c.range[1]);
    delete s.lines; delete s.pieces; delete s.indent;
  }
  return segs;
}

// ---------- pasted text ----------

export function segmentText(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').replace(/\*\*|__/g, '').split('\n');
  const maxLen = Math.max(0, ...lines.map((l) => l.trim().length));
  const longLen = Math.max(30, 0.7 * maxLen);
  const segs = [];
  let cur = null, heading = null, prevLong = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const t = line.trim();
    if (!t) { cur = null; prevLong = false; continue; }
    if (/^[\s|:\-]+$/.test(t) && t.includes('-')) continue; // markdown table rule
    const md = t.match(/^#{1,6}\s+(.*)$/);
    const bm = t.match(BULLET_RE);
    if (md || (!bm && isHeadingText(t))) {
      heading = (md ? md[1] : t).trim();
      segs.push({ kind: 'heading', text: heading });
      cur = null; prevLong = false;
      continue;
    }
    const tableRow = /^\|.*\|$/.test(t);
    const text = tableRow ? t.replace(/^\|\s*|\s*\|$/g, '') : bm ? t.slice(bm[0].length) : t;
    if (tableRow && isTableHead(text.split('|'))) {
      segs.push({ kind: 'heading', table: true, text: text.split('|').map((c) => c.trim()).join(' | ') });
      cur = null; prevLong = false;
      continue;
    }
    const indented = /^\s/.test(line);
    if (cur && !bm && !tableRow && !cur.tabular && (prevLong || (indented && cur.bullet))) {
      cur.text += (/[A-Za-z]-$/.test(cur.text) ? '' : ' ') + text;
    } else {
      cur = { kind: 'seg', heading, text, bullet: !!bm, tabular: tableRow };
      segs.push(cur);
    }
    prevLong = t.length >= longLen;
  }
  numberAndSplit(segs);
  return segs;
}

// ---------- model input / output ----------

export function promptLines(segs) {
  return segs.map((s) => {
    if (s.kind === 'heading') return `# ${s.text}`;
    if (s.children) return s.children.map((c) => `[${c.id}] ${c.text}`).join('; ');
    return `[${s.id}] ${s.text}`;
  }).join('\n');
}

// id -> leaf segments (a parent ID expands to all its sub-segments).
export function buildIndex(segs) {
  const index = new Map();
  for (const s of segs) {
    if (s.kind !== 'seg') continue;
    if (s.children) {
      index.set(s.id, s.children);
      for (const c of s.children) index.set(c.id, [c]);
    } else index.set(s.id, [s]);
  }
  return index;
}

// Keeps only IDs that exist; returns leaf segment IDs in document order.
export function resolveEvidence(ids, index) {
  const out = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw).replace(/[^\d.]/g, '').replace(/^\.+|\.+$/g, '');
    for (const leaf of index.get(id) || []) out.add(leaf.id);
  }
  const order = [...index.keys()];
  return [...out].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
