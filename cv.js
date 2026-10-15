// A CV in this app: { name, kind: 'pdf'|'text', file?, text?, segs, roles, leaves,
// warnings, pageCount?, pages? (rendered canvases), parseConfirmed?, parseFixes? }.
// Building, the user's parse fixes, and the JSON form used in project files.

import { segmentPdf, segmentText } from './segment.js';
import { structureCv, leavesOf, parseWarnings, labelSegs, makeRole, findDateRange } from './structure.js';
import { readPdfText } from './pdf.js';

export function buildCv(name, segs, kind, extra = {}) {
  const { roles } = structureCv(segs);
  return { name, kind, segs, roles, leaves: leavesOf(segs), warnings: [], parseFixes: 0, ...extra };
}

export async function cvFromPdf(file) {
  const pages = await readPdfText(file);
  const segs = segmentPdf(pages);
  const c = buildCv(file.name, segs, 'pdf', { file, pageCount: pages.length });
  c.warnings = parseWarnings(pages);
  return c;
}

export const cvFromText = (text, name = 'Pasted CV') => buildCv(name, segmentText(text), 'text', { text });

// Plain text of a PDF (for job descriptions picked as files): one line per segment.
export async function pdfToText(file) {
  const segs = segmentPdf(await readPdfText(file));
  return segs.map((s) => s.text).join('\n');
}

// ---------- parse fixes (job-hunting parse check) ----------

const topSeg = (cv, id) => cv.segs.find((s) => s.kind === 'seg' && s.id === id);

function detach(cv, s) {
  if (s.role) s.role.headerIds = s.role.headerIds.filter((x) => x !== s.id);
  s.role = null;
  s.roleLine = false;
}

// Drops roles no segment points at any more, keeps the rest in document order.
function tidyRoles(cv) {
  const used = [];
  for (const s of cv.segs) if (s.kind === 'seg' && s.role && !used.includes(s.role)) used.push(s.role);
  cv.roles = used;
}

function after(cv) {
  labelSegs(cv.segs);
  tidyRoles(cv);
  cv.leaves = leavesOf(cv.segs);
  cv.index = null; // buildIndex cache in match.js
  cv.parseFixes = (cv.parseFixes || 0) + 1;
  cv.parseConfirmed = false;
}

// Section of one segment. Leaving Experience drops the role.
export function fixSection(cv, id, section) {
  const s = topSeg(cv, id);
  if (!s || s.section === section) return;
  s.section = section;
  if (section !== 'experience') detach(cv, s);
  s.fixed = true;
  after(cv);
}

// Role of one segment: an existing role, null (none), or 'new' (a new role named
// after this line, dated from the line if it has dates). A role implies Experience.
export function fixRole(cv, id, roleIdx) {
  const s = topSeg(cv, id);
  if (!s) return;
  detach(cv, s);
  if (roleIdx === 'new') {
    const r = findDateRange(s.text);
    const title = r && r.index > 2 ? s.text.slice(0, r.index) : s.text.slice(0, 80);
    const role = makeRole(title, r ? [r.start, r.end] : [null, null], s.id);
    s.role = role;
    s.roleLine = true;
    s.section = 'experience';
  } else if (roleIdx != null && cv.roles[roleIdx]) {
    s.role = cv.roles[roleIdx];
    s.section = 'experience';
  }
  s.fixed = true;
  after(cv);
  return s.role;
}

// Role-level fixes: title and dates (already normalised by parseDate()).
export function fixRoleDates(cv, role, start, end) {
  role.dates = [start, end];
  role.fixed = true;
  after(cv);
}
export function touchRole(cv, role) {
  role.fixed = true;
  after(cv);
}

// ---------- JSON form (project files) ----------

const ROLE_KEYS = ['title', 'short', 'dates', 'headerIds', 'counted', 'fixed'];
const SEG_KEYS = ['kind', 'id', 'text', 'heading', 'bullet', 'tabular', 'page', 'boxes', 'section', 'dates', 'label', 'roleLine', 'sub', 'fixed'];
const CHILD_KEYS = ['id', 'text', 'range', 'boxes', 'kind', 'section', 'dates', 'page', 'parentId', 'label'];
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };

export function cvToJson(cv, fileId = null) {
  const ri = (r) => { const i = r ? cv.roles.indexOf(r) : -1; return i < 0 ? null : i; };
  return {
    name: cv.name, kind: cv.kind, file: fileId, text: cv.text ?? null,
    pageCount: cv.pageCount ?? null, warnings: cv.warnings || [],
    parseConfirmed: !!cv.parseConfirmed, parseFixes: cv.parseFixes || 0,
    roles: cv.roles.map((r) => pick(r, ROLE_KEYS)),
    segs: cv.segs.map((s) => {
      const o = pick(s, SEG_KEYS);
      if (s.kind === 'seg') o.role = ri(s.role);
      if (s.children) o.children = s.children.map((c) => ({ ...pick(c, CHILD_KEYS), role: ri(c.role) }));
      return o;
    })
  };
}

export function cvFromJson(j, file = null) {
  if (!j || !Array.isArray(j.segs) || !Array.isArray(j.roles)) throw new Error('a CV entry has no segments');
  const roles = j.roles.map((r) => ({ headerIds: [], counted: true, ...r }));
  const role = (i) => (Number.isInteger(i) ? roles[i] || null : null);
  const segs = j.segs.map((s) => {
    const o = { ...s };
    if (s.kind === 'seg') o.role = role(s.role);
    else delete o.role;
    if (s.children) o.children = s.children.map((c) => ({ ...c, role: role(c.role) }));
    return o;
  });
  return {
    name: j.name || 'CV', kind: j.kind === 'pdf' ? 'pdf' : 'text', file, text: j.text ?? undefined,
    pageCount: j.pageCount ?? undefined, warnings: j.warnings || [],
    parseConfirmed: !!j.parseConfirmed, parseFixes: j.parseFixes || 0,
    segs, roles, leaves: leavesOf(segs)
  };
}
