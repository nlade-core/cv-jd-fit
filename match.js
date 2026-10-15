// Matching, decided in code: which CV sections each criterion sees, what the
// status is, and the score. The model only ever returns evidence IDs.

import { SECTIONS, SECTION_NAMES, compactView, computeYears, dateSpan } from './structure.js';
import { buildIndex } from './segment.js';
import { yearsNeeded } from './jd.js';
import { findEvidence } from './model.js';

export const ROUTES = {
  degree: ['education', 'certifications'],
  skill: ['skills', 'experience', 'profile'],
  domain: ['experience', 'profile'],
  leadership: ['experience', 'profile'],
  other: SECTIONS
};

export const STATUS_LABEL = { met: 'Met', possible: 'Possible', notfound: 'Not found' };

// A criterion's sections; falls back to the whole CV if none of them has any lines
// (e.g. a CV without headings), so a missing heading never becomes a silent "not found".
export function route(crit, cv) {
  let sections = ROUTES[crit.type] || SECTIONS;
  const has = new Set(cv.segs.filter((s) => s.kind === 'seg').map((s) => s.section));
  let fallback = false;
  if (!sections.some((s) => has.has(s))) { sections = SECTIONS; fallback = true; }
  const ids = [];
  for (const s of cv.segs) {
    if (s.kind !== 'seg' || !sections.includes(s.section)) continue;
    if (s.children) ids.push(...s.children.map((c) => c.id)); else ids.push(s.id);
  }
  return { sections: sections.filter((s) => has.has(s)), ids, fallback, view: compactView(cv.segs, sections) };
}

export function derivedStatus(r) {
  if (r.years) return r.years.status;
  if (r.evidence.some((e) => e.kind === 'direct')) return 'met';
  if (r.evidence.length) return 'possible';
  return 'notfound';
}
export const effectiveStatus = (r) => r.override || derivedStatus(r);

// Score from the statuses: Met 1, Possible ½, Not found 0; required counts double.
export const SCORE_EXPLAINER = 'Met counts 1, Possible ½, Not found 0; required criteria count double. Overrides count as set.';
export function computeScore(criteria, results) {
  let got = 0, total = 0;
  criteria.forEach((c, i) => {
    const r = results[i];
    if (!r || r.state !== 'done') return;
    const w = c.importance === 'required' ? 2 : 1;
    const v = { met: 1, possible: 0.5, notfound: 0 }[effectiveStatus(r)];
    got += w * v; total += w;
  });
  return total ? Math.round((100 * got) / total) : null;
}

export function yearsResult(crit, cv) {
  const need = yearsNeeded(crit.text);
  const y = computeYears(cv.roles);
  const counted = y.roles.filter((r) => r.counted);
  const status = !counted.length ? 'notfound' : y.months >= need * 12 ? 'met' : 'possible';
  return {
    need, months: y.months, status,
    roles: y.roles.map(({ role, months, counted }) => ({ title: role.title, span: dateSpan(role.dates), dates: role.dates, months, counted, ids: role.headerIds }))
  };
}

// Model evidence -> leaf IDs that were actually shown to the model; direct wins over indirect.
function resolve(raw, cv, allowed) {
  const index = cv.index || (cv.index = buildIndex(cv.segs));
  const kinds = new Map();
  for (const e of raw) {
    const id = String(e?.id ?? '').replace(/[^\d.]/g, '').replace(/^\.+|\.+$/g, '');
    const kind = e?.kind === 'direct' ? 'direct' : 'indirect';
    for (const leaf of index.get(id) || []) {
      if (!allowed.has(leaf.id)) continue;
      if (kinds.get(leaf.id) !== 'direct') kinds.set(leaf.id, kind);
    }
  }
  const order = cv.leaves.map((l) => l.id);
  return [...kinds].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([id, kind]) => ({ id, kind, by: 'model' }));
}

export const routingLog = []; // { candidate, criterion, type, sections, ids, chars } -- for inspection in devtools
if (typeof window !== 'undefined') window.cvjdfitRouting = routingLog;

// Runs every criterion against one CV, in order, calling onResult(i, result) as each finishes.
export async function matchCandidate(cv, criteria, { onStart, onResult, signal } = {}) {
  for (let i = 0; i < criteria.length; i++) {
    signal?.throwIfAborted();
    const crit = criteria[i];
    onStart?.(i);
    let r;
    if (crit.type === 'years' && yearsNeeded(crit.text) !== null) {
      const years = yearsResult(crit, cv);
      r = { state: 'done', years, evidence: years.roles.filter((x) => x.counted).flatMap((x) => x.ids).map((id) => ({ id, kind: 'direct', by: 'code' })), routed: { sections: ['experience'], ids: [], model: false } };
    } else {
      const rt = route(crit.type === 'years' ? { ...crit, type: 'other' } : crit, cv);
      routingLog.push({ candidate: cv.name, criterion: crit.text, type: crit.type, sections: rt.sections, ids: rt.ids, chars: rt.view.length });
      try {
        const raw = await findEvidence(crit.text, rt.view, signal);
        r = { state: 'done', evidence: resolve(raw, cv, new Set(rt.ids)), routed: { sections: rt.sections, ids: rt.ids, fallback: rt.fallback, model: true } };
      } catch (e) {
        if (signal?.aborted) throw e;
        r = { state: 'error', error: e.message, evidence: [], routed: { sections: rt.sections, ids: rt.ids, model: true } };
      }
    }
    r.override = null;
    onResult?.(i, r);
  }
}

export const sectionList = (secs) => secs.map((s) => SECTION_NAMES[s]).join(', ');
