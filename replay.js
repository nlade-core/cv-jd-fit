// "See an example": replays a stored result (samples/recorded-example.json, a
// project file) for the bundled sample JD and a made-up CV. Nothing is computed
// and the model isn't used; the pacing is illustrative, not measured.

import { parseProject, cvResolver } from './project.js';
import { candFromJson, showCandidate, refresh, hideResult } from './result.js';
import { renderPdf } from './pdf.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let token = 0;
let loaded = null;

async function load() {
  if (loaded) return loaded;
  const [proj, pdf] = await Promise.all([
    fetch('samples/recorded-example.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); }),
    fetch('samples/sample-cv.pdf').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
  ]);
  const p = parseProject(proj);
  const cv = cvResolver(p)(p.hiring.single.cv);
  cv.file = new File([pdf], cv.name, { type: 'application/pdf' });
  loaded = { p, cv };
  return loaded;
}

const wait = (ms, t) => new Promise((res, rej) => setTimeout(() => (t === token ? res() : rej(new Error('cancelled'))), ms));

export function stopReplay() { token++; }

export async function startReplay(setLastShown) {
  const t = ++token;
  const status = $('replay-status');
  status.textContent = 'Loading the recording…';
  let data;
  try { data = await load(); } catch (e) { status.textContent = 'Could not load the recorded example (' + e.message + ').'; return; }
  if (t !== token) return;
  const { p, cv } = data;
  const rec = p.hiring.single;

  // the JD and its criteria, as recorded
  $('replay-jd').textContent = p.hiring.jd.text;
  const list = $('replay-criteria');
  list.innerHTML = '';
  for (const c of rec.criteria) {
    const li = el('li');
    li.append(el('span', 'importance-tag ' + c.importance, c.importance), el('span', 'type-tag', c.type), ' ', c.text);
    list.append(li);
  }

  const full = candFromJson(rec, cv);
  const cand = {
    cv, criteria: full.criteria, results: full.criteria.map(() => ({ state: 'pending', evidence: [], override: null })),
    timing: null, frame: 'replay', readonly: true,
    title: 'Recorded example — ' + cv.name,
    timerText: 'Recorded example: a replay of a stored result, not a live run. Pacing is illustrative.'
  };
  setLastShown(cand);
  if (!cv.pages) cv.pages = await renderPdf(cv.file).catch(() => null);
  if (t !== token) return;
  showCandidate(cand);
  status.textContent = 'Replaying…';
  try {
    await wait(600, t);
    for (let i = 0; i < cand.criteria.length; i++) {
      cand.results[i] = { ...cand.results[i], state: 'running' };
      refresh(cand, i);
      const years = !!full.results[i].years;
      // deterministic, roughly model-like pacing: code-computed years land fast
      await wait(years ? 180 : 700 + ((i * 397) % 600), t);
      cand.results[i] = full.results[i];
      refresh(cand, i);
    }
    status.textContent = 'Done. This was a recording; nothing was computed just now.';
  } catch { /* left the example */ }
}

export function leaveReplay() { stopReplay(); hideResult(); }
