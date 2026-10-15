import { segmentPdf, segmentText } from './segment.js';
import { structureCv, leavesOf, segmentsJson, parseWarnings, SECTION_NAMES } from './structure.js';
import { requirementLines, numberedView, chunkLines, heuristicCriteria, jdHash, yearsNeeded, TYPES } from './jd.js';
import { initModel, onModelState, whenReady, extractCriteria, model } from './model.js';
import { matchCandidate, effectiveStatus, derivedStatus, computeScore, SCORE_EXPLAINER, STATUS_LABEL, sectionList } from './match.js';
import { readPdfText, renderPdf } from './pdf.js';
import { initBatch } from './batch.js';

// GH Pages serves every nlade-core project from the same origin
// (nlade-core.github.io), so localStorage is shared across all of them --
// unprefixed keys here can collide with another repo's. Always namespace.
const STORAGE_PREFIX = 'cvjdfit.';
const CV_STORAGE_KEY = STORAGE_PREFIX + 'cv';
const JD_STORAGE_KEY = STORAGE_PREFIX + 'jd';
const CRITERIA_KEY = (hash) => STORAGE_PREFIX + 'criteria.' + hash;

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage disabled/full: the page still works for this session */ }
}
function readJson(key) {
  try { return JSON.parse(readStorage(key)); } catch { return null; }
}

const SAMPLE_CV_TEXT = `Alex Morgan
Software Engineer

SUMMARY
Full-stack software engineer with 5 years of experience building and shipping
web applications, internal tools, and APIs. Comfortable across the stack, with
a focus on JavaScript/TypeScript and pragmatic, well-tested code.

SKILLS
JavaScript, TypeScript, Node.js, React, HTML/CSS, Python, REST APIs, SQL
(PostgreSQL), Git, Docker, basic AWS (EC2, S3, Lambda), unit & integration
testing (Jest), CI/CD pipelines (GitHub Actions).

EXPERIENCE
Software Engineer — Northwind Data (2022–present)
- Built and maintained a React/TypeScript front end for an internal analytics
  dashboard used by ~200 employees.
- Designed and implemented REST APIs in Node.js backed by PostgreSQL.
- Introduced automated testing (Jest) and a CI pipeline, cutting regression
  bugs reported in production by roughly a third.
- Migrated a legacy jQuery admin panel to React incrementally, with no
  downtime.

Junior Developer — Fenwick Software (2020–2022)
- Worked on a customer-facing booking platform (Node.js, Express, MySQL).
- Fixed bugs, wrote small features, and shadowed senior engineers on system
  design decisions.
- Wrote developer documentation for onboarding new hires.

EDUCATION
B.Sc. Computer Science — University of Leeds (2016–2019)

OTHER
Occasional open-source contributor. Comfortable working independently or in
small cross-functional teams. No formal experience with mobile development,
Kubernetes, or machine learning.`;

const $ = (id) => document.getElementById(id);
const statusPill = $('status-pill');
const cvTextEl = $('cv-text'), cvFileInput = $('cv-file'), cvFileStatus = $('cv-file-status'), cvFileClear = $('cv-file-clear'), cvWarnings = $('cv-warnings');
const jdInput = $('jd-input'), note = $('note');
const criteriaBox = $('criteria-box'), criteriaList = $('criteria-list'), criteriaStateEl = $('criteria-state'), criteriaSource = $('criteria-source');
const critAdd = $('crit-add'), critConfirm = $('crit-confirm');
const resultPanel = $('result-panel'), resultTitle = $('result-title'), timerEl = $('timer');
const scoreValue = $('score-value'), scoreNote = $('score-note'), critResults = $('crit-results');
const evidenceView = $('evidence-view'), hlTip = $('hl-tip');
const explainer = $('explainer'), dlText = $('dl-text'), dlProgress = $('dl-progress'), dlActivate = $('dl-activate');

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const secs = (ms) => (ms / 1000).toFixed(1) + ' s';

// ---------- network counter: anything not from this site's own origin ----------

const net = { requests: 0, bytes: 0, urls: [] };
function renderNet() {
  const t = $('net-text');
  t.textContent = net.requests
    ? `${net.bytes.toLocaleString()} bytes, ${net.requests} request${net.requests === 1 ? '' : 's'} to other sites`
    : '0 bytes sent';
  $('net-counter').classList.toggle('alert', net.requests > 0);
}
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!/^https?:/i.test(e.name)) continue;
      if (new URL(e.name).origin === location.origin) continue;
      net.requests++;
      net.bytes += e.transferSize || e.encodedBodySize || 0;
      net.urls.push(e.name);
    }
    renderNet();
  }).observe({ type: 'resource', buffered: true });
} catch { /* PerformanceObserver unavailable: the counter stays at its initial text */ }
window.cvjdfitNetwork = net;

// ---------- model status + first-visit explainer ----------

onModelState((m) => {
  const labels = {
    checking: 'checking model…', loading: 'loading model…', downloadable: 'model needs download',
    downloading: `downloading model ${Math.round(m.progress * 100)}%`, 'needs-activation': 'model needs download',
    ready: 'model ready', unavailable: 'model unavailable on this device', missing: 'not supported in this browser', error: 'model error'
  };
  const cls = { ready: 'available', downloadable: 'downloadable', downloading: 'downloadable', 'needs-activation': 'downloadable', unavailable: 'unavailable', missing: 'missing', error: 'unavailable' };
  statusPill.className = 'status-pill ' + (cls[m.state] || '');
  statusPill.textContent = labels[m.state] || m.state;
  const downloading = ['downloadable', 'downloading', 'needs-activation'].includes(m.state);
  explainer.hidden = !downloading;
  dlActivate.hidden = m.state !== 'needs-activation';
  dlProgress.value = m.progress || 0;
  dlText.textContent = m.state === 'downloading' ? `Downloading… ${Math.round(m.progress * 100)}%` : m.state === 'needs-activation' ? 'Waiting for a click' : 'Starting download…';
  if (m.state === 'missing') note.textContent = 'Open this in a recent desktop Chrome with the on-device model enabled.';
  else if (m.state === 'unavailable') note.textContent = 'The on-device model isn\'t available on this device.';
  else if (m.state === 'error') note.textContent = 'Model error: ' + m.error;
});
const modelUsable = () => !['missing', 'unavailable', 'error'].includes(model.state);
initModel();

// ---------- CV input: parsed the moment it arrives ----------

let cv = null; // { name, kind, file?, segs, roles, leaves, warnings, pages? }

function buildCv(name, segs, kind, extra = {}) {
  const { roles } = structureCv(segs);
  return { name, kind, segs, roles, leaves: leavesOf(segs), warnings: [], ...extra };
}
window.cvjdfit = { get cv() { return cv; }, segmentsJson: () => (cv ? segmentsJson(cv.segs) : []) };

export async function cvFromPdf(file) {
  const pages = await readPdfText(file);
  const segs = segmentPdf(pages);
  const c = buildCv(file.name, segs, 'pdf', { file, pageCount: pages.length });
  c.warnings = parseWarnings(pages);
  return c;
}

function showWarnings(list) {
  cvWarnings.innerHTML = '';
  for (const w of list) cvWarnings.append(el('li', null, w));
  cvWarnings.hidden = !list.length;
}

cvTextEl.value = readStorage(CV_STORAGE_KEY) ?? SAMPLE_CV_TEXT;
jdInput.value = readStorage(JD_STORAGE_KEY) ?? '';

function cvFromTextarea() {
  const text = cvTextEl.value;
  cv = text.trim() ? buildCv('Pasted CV', segmentText(text), 'text') : null;
}

let cvTextTimer;
cvTextEl.addEventListener('input', () => {
  writeStorage(CV_STORAGE_KEY, cvTextEl.value);
  clearTimeout(cvTextTimer);
  cvTextTimer = setTimeout(() => { cvFromTextarea(); maybeRun(); }, 900);
});

function useTextSource() {
  cvFileInput.value = '';
  cvFileStatus.textContent = 'or paste the text below';
  cvFileClear.hidden = true;
  cvTextEl.disabled = false;
  showWarnings([]);
  cvFromTextarea();
  maybeRun();
}

cvFileInput.addEventListener('change', async () => {
  const file = cvFileInput.files[0];
  if (!file) return;
  cvFileStatus.textContent = 'Reading PDF…';
  try {
    const c = await cvFromPdf(file);
    const count = c.leaves.length;
    showWarnings(c.warnings);
    if (!count) {
      cvFileInput.value = '';
      cvFileStatus.textContent = 'No selectable text in that PDF (it may be a scanned image). Paste the CV text instead.';
      cvFileClear.hidden = true;
      cvTextEl.disabled = false;
      return;
    }
    cv = c;
    cvTextEl.disabled = true;
    cvFileClear.hidden = false;
    cvFileStatus.textContent = `Using ${file.name}: ${c.pageCount} page${c.pageCount === 1 ? '' : 's'}, ${count} lines, ${c.roles.length} dated role${c.roles.length === 1 ? '' : 's'}.`;
    maybeRun();
    // Pages render in the background; matching doesn't wait for them.
    renderPdf(file).then((pages) => {
      c.pages = pages;
      if (shown?.cv === c) renderDocument();
    }).catch(() => {});
  } catch (e) {
    cvFileStatus.textContent = 'Could not read that PDF: ' + e.message;
  }
});
cvFileClear.addEventListener('click', useTextSource);

// ---------- JD -> criteria (extracted the moment the JD is pasted) ----------

let criteria = [];
let critState = 'empty'; // empty | extracting | draft | confirmed
let jdKey = null;
let extractAbort = null;
let nextCritId = 1;
const newCrit = (c) => ({ id: nextCritId++, text: c.text || '', type: TYPES.includes(c.type) ? c.type : 'skill', importance: c.importance === 'preferred' ? 'preferred' : 'required' });

let jdTimer;
jdInput.addEventListener('input', () => {
  writeStorage(JD_STORAGE_KEY, jdInput.value);
  clearTimeout(jdTimer);
  jdTimer = setTimeout(onJdChange, 700);
});

async function onJdChange() {
  const text = jdInput.value.trim();
  if (!text) {
    jdKey = null; criteria = []; setCritState('empty'); return;
  }
  const key = jdHash(text);
  if (key === jdKey) return;
  jdKey = key;
  extractAbort?.abort();

  const saved = readJson(CRITERIA_KEY(key));
  if (Array.isArray(saved) && saved.length) {
    criteria = saved.map(newCrit);
    criteriaSource.textContent = 'Loaded the criteria you confirmed earlier for this job description.';
    setCritState('confirmed');
    maybeRun();
    return;
  }

  const { lines, fromSections } = requirementLines(text);
  criteriaSource.textContent = fromSections
    ? `Read ${lines.length} lines from the requirement sections (company blurb, duties, benefits and equal-opportunity text left out).`
    : `No requirement headings found, so all ${lines.length} lines of the job description were read.`;
  const ctrl = (extractAbort = new AbortController());
  criteria = [];
  setCritState('extracting');

  let list = [];
  if (modelUsable()) {
    try {
      for (const chunk of chunkLines(lines)) {
        const out = await extractCriteria(numberedView(chunk), ctrl.signal);
        for (const c of out) {
          const src = lines.find((l) => l.n === Number(c.line));
          // The section heading wins over the model's tag when it's explicit ("Desirable", "Essential").
          list.push({ ...c, importance: src?.hint || c.importance });
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      note.textContent = 'The model could not extract criteria (' + e.message + '); showing one per requirement line instead.';
      list = [];
    }
  }
  if (ctrl.signal.aborted) return;
  if (!list.length) list = heuristicCriteria(lines);
  const seen = new Set();
  criteria = list.map(newCrit).filter((c) => {
    const k = c.text.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
  setCritState('draft');
}

function setCritState(s, render = true) {
  critState = s;
  criteriaBox.hidden = s === 'empty';
  criteriaStateEl.textContent = { extracting: 'reading the job description…', draft: 'check, then confirm', confirmed: 'confirmed' }[s] || '';
  criteriaStateEl.className = 'crit-state ' + s;
  critConfirm.textContent = s === 'confirmed' ? 'Confirmed ✓' : 'Confirm criteria';
  critConfirm.disabled = s === 'extracting' || s === 'confirmed' || !criteria.length;
  critAdd.disabled = s === 'extracting';
  if (render) renderCriteriaEditor();
  batch.setCriteriaReady(s === 'confirmed');
}

function renderCriteriaEditor() {
  criteriaList.innerHTML = '';
  if (critState === 'extracting') {
    criteriaList.append(el('li', 'crit-placeholder', model.state === 'ready' ? 'Extracting criteria…' : 'Waiting for the model, then extracting criteria…'));
    return;
  }
  criteria.forEach((c) => {
    const li = el('li', 'crit-edit');
    const text = el('input');
    text.type = 'text'; text.value = c.text; text.setAttribute('aria-label', 'Criterion');
    text.addEventListener('input', () => { c.text = text.value; markDraft(); });
    const type = el('select');
    type.setAttribute('aria-label', 'Type');
    for (const t of TYPES) type.append(new Option(t, t, false, t === c.type));
    type.addEventListener('change', () => { c.type = type.value; markDraft(true); criteriaList.querySelectorAll('select[aria-label="Type"]')[criteria.indexOf(c)]?.focus(); });
    const imp = el('select');
    imp.setAttribute('aria-label', 'Importance');
    for (const t of ['required', 'preferred']) imp.append(new Option(t, t, false, t === c.importance));
    imp.addEventListener('change', () => { c.importance = imp.value; markDraft(); });
    const del = el('button', 'icon-btn', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete criterion: ${c.text}`);
    del.addEventListener('click', () => { criteria = criteria.filter((x) => x !== c); markDraft(true); });
    li.append(text, type, imp, del);
    if (c.type === 'years' && yearsNeeded(c.text) === null) li.append(el('span', 'crit-warn', 'No number of years in the text — it will be checked as text.'));
    criteriaList.append(li);
  });
}

// Any edit un-confirms; the list is only rebuilt when rows are added or removed,
// so typing in a field never loses focus.
function markDraft(rerender = false) {
  setCritState('draft', rerender);
}

critAdd.addEventListener('click', () => {
  criteria.push(newCrit({ text: '', type: 'skill', importance: 'required' }));
  markDraft(true);
  criteriaList.querySelector('li:last-child input')?.focus();
});

critConfirm.addEventListener('click', () => {
  criteria = criteria.filter((c) => c.text.trim());
  if (!criteria.length) return;
  writeStorage(CRITERIA_KEY(jdKey), JSON.stringify(criteria.map(({ text, type, importance }) => ({ text, type, importance }))));
  criteriaSource.textContent = 'Saved for this job description in this browser.';
  setCritState('confirmed');
  maybeRun();
});

// ---------- single-CV run: starts when both inputs are ready ----------

let runAbort = null;
let shown = null; // the candidate in the result panel: { cv, criteria, results, timing, onChange? }
let openIdx = -1;

function maybeRun() {
  if (!cv || critState !== 'confirmed' || !criteria.length) return;
  if (!modelUsable() && criteria.some((c) => c.type !== 'years' || yearsNeeded(c.text) === null)) {
    note.textContent = 'Matching needs the on-device model, which isn\'t available here.';
  }
  runAbort?.abort();
  const ctrl = (runAbort = new AbortController());
  const cand = { cv, criteria: criteria.map((c) => ({ ...c })), results: [], timing: { t0: performance.now(), tFirst: null, tEnd: null } };
  runCandidate(cand, ctrl.signal, true).catch(() => {});
}

// Shared by the single run and the batch.
export async function runCandidate(cand, signal, show) {
  cand.results = cand.criteria.map(() => ({ state: 'pending', evidence: [], override: null }));
  if (show) showCandidate(cand);
  await matchCandidate(cand.cv, cand.criteria, {
    signal,
    onStart: (i) => { cand.results[i].state = 'running'; refresh(cand, i); },
    onResult: (i, r) => {
      cand.results[i] = r;
      const now = performance.now();
      cand.timing.tFirst ??= now;
      if (i === cand.criteria.length - 1) cand.timing.tEnd = now;
      refresh(cand, i);
    }
  });
}

function refresh(cand, i) {
  if (shown === cand) { updateRow(i); updateScore(); updateMarks(); renderTimer(); }
  cand.onChange?.(i);
}

// ---------- result view ----------

export function showCandidate(cand, scroll = false) {
  shown = cand;
  openIdx = -1;
  resultPanel.hidden = false;
  resultTitle.textContent = cand.cv.kind === 'pdf' ? `Result — ${cand.cv.name}` : 'Result';
  critResults.innerHTML = '';
  cand.criteria.forEach((c, i) => critResults.append(buildRow(i)));
  cand.criteria.forEach((c, i) => updateRow(i));
  updateScore();
  renderDocument();
  renderTimer();
  if (cand.cv.kind === 'pdf' && !cand.cv.pages && cand.cv.file) {
    renderPdf(cand.cv.file).then((pages) => { cand.cv.pages = pages; if (shown === cand) renderDocument(); }).catch(() => {});
  }
  if (scroll) resultPanel.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
}

let timerTick = null;
function renderTimer() {
  const t = shown?.timing;
  if (!t) { timerEl.textContent = ''; return; }
  const now = performance.now();
  const first = t.tFirst != null ? secs(t.tFirst - t.t0) : '…';
  const total = t.tEnd != null ? secs(t.tEnd - t.t0) : `${secs(now - t.t0)} so far`;
  const n = shown.criteria.length;
  timerEl.textContent = `From both inputs ready: first result ${first} · all ${n} criteria ${total}`;
  clearTimeout(timerTick);
  if (t.tEnd == null && !shown.stopped) timerTick = setTimeout(renderTimer, 100);
}

function updateScore() {
  const s = computeScore(shown.criteria, shown.results);
  scoreValue.textContent = s === null ? '–' : String(s);
  const done = shown.results.filter((r) => r.state === 'done').length;
  scoreNote.textContent = SCORE_EXPLAINER + (done < shown.criteria.length ? ` (${done} of ${shown.criteria.length} done so far.)` : '');
}

function badge(status, overridden) {
  const b = el('span', `status-badge ${status}${overridden ? ' overridden' : ''}`, STATUS_LABEL[status] || status);
  if (overridden) b.title = 'Status set by you';
  return b;
}

function buildRow(i) {
  const c = shown.criteria[i];
  const li = el('li', 'crit-row');
  li.dataset.i = i;
  const head = el('button', 'crit-head');
  head.type = 'button';
  head.id = `crit-head-${i}`;
  head.setAttribute('aria-expanded', 'false');
  head.setAttribute('aria-controls', `crit-body-${i}`);
  const tags = el('span', 'tags');
  tags.append(el('span', 'importance-tag ' + c.importance, c.importance), el('span', 'type-tag', c.type));
  head.append(el('span', 'chev'), el('span', 'crit-text', c.text), tags, el('span', 'status-slot'));
  head.addEventListener('click', () => toggleOpen(i));
  const body = el('div', 'crit-body');
  body.id = `crit-body-${i}`;
  body.hidden = true;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-labelledby', head.id);
  li.append(head, body);
  return li;
}

function toggleOpen(i) {
  openIdx = openIdx === i ? -1 : i;
  evidenceView.querySelectorAll('.seg-box.focus').forEach((b) => b.classList.remove('focus'));
  [...critResults.children].forEach((li, k) => {
    li.querySelector('.crit-head').setAttribute('aria-expanded', String(k === openIdx));
    li.querySelector('.crit-body').hidden = k !== openIdx;
    li.classList.toggle('open', k === openIdx);
  });
  evidenceView.classList.toggle('adding', openIdx >= 0 && canEdit(openIdx));
  updateMarks();
  const first = evidenceView.querySelector('.seg-box.on');
  if (first) first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

const canEdit = (i) => shown.results[i]?.state === 'done' && !shown.results[i].years;
const leafById = (id) => shown.cv.leaves.find((l) => l.id === id);

function updateRow(i) {
  const li = critResults.children[i];
  if (!li) return;
  const r = shown.results[i], c = shown.criteria[i];
  const slot = li.querySelector('.status-slot');
  slot.innerHTML = '';
  if (r.state === 'pending') slot.append(el('span', 'status-badge pending', 'waiting'));
  else if (r.state === 'running') slot.append(el('span', 'status-badge running', 'checking…'));
  else if (r.state === 'error') slot.append(el('span', 'status-badge error', 'error'));
  else if (r.state === 'stopped') slot.append(el('span', 'status-badge pending', 'stopped'));
  else {
    slot.append(badge(effectiveStatus(r), !!r.override));
    if (r.override) slot.append(el('span', 'ovr-mark', 'overridden'));
  }

  const body = li.querySelector('.crit-body');
  body.innerHTML = '';
  if (r.state !== 'done') {
    body.append(el('p', 'routed', r.state === 'error' ? 'The model call failed: ' + r.error : 'Not checked yet.'));
    return;
  }

  if (r.years) {
    const y = r.years;
    body.append(el('p', 'routed', `Computed in code, no model call. Every dated role under Experience counts; overlapping dates are merged; a bare year counts from January to December.`));
    const ul = el('ul', 'ev-lines');
    for (const role of y.roles) {
      const row = el('li', 'ev-line' + (role.counted ? '' : ' muted'));
      const go = el('button', 'ev-go');
      go.type = 'button';
      go.append(el('span', 'ev-label', `${role.span}${role.counted ? ` · ${role.months} months` : ' · not counted (career break)'}`), el('span', 'ev-text', role.title));
      if (role.ids[0]) go.addEventListener('click', () => focusLine(role.ids[0]));
      else go.disabled = true;
      row.append(go);
      ul.append(row);
    }
    body.append(ul);
    const yrs = (y.months / 12).toFixed(1);
    body.append(el('p', 'years-sum', `Total ${y.months} months (${yrs} years) against ${y.need} required → ${STATUS_LABEL[y.status]}.`));
  } else {
    const rt = r.routed;
    body.append(el('p', 'routed', `Searched ${sectionList(rt.sections)} — ${rt.ids.length} lines${rt.fallback ? ' (no matching section found, so the whole CV)' : ''}.`));
    const ul = el('ul', 'ev-lines');
    if (!r.evidence.length) ul.append(el('li', 'ev-none', 'No supporting line found. Click a line on the CV to add one.'));
    r.evidence.forEach((ev, k) => {
      const leaf = leafById(ev.id);
      if (!leaf) return;
      const row = el('li', 'ev-line');
      const go = el('button', 'ev-go');
      go.type = 'button';
      go.append(el('span', 'ev-label', leaf.label), el('span', 'ev-text', leaf.text));
      go.addEventListener('click', () => focusLine(ev.id));
      const kind = el('span', 'kind-tag ' + ev.kind, ev.kind);
      const tags = el('span', 'ev-tags');
      tags.append(kind);
      if (ev.by === 'you') tags.append(el('span', 'kind-tag you', 'added by you'));
      const rm = el('button', 'icon-btn', '✕');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove evidence: ${leaf.label}`);
      rm.addEventListener('click', () => { r.evidence.splice(k, 1); edited(i); });
      row.append(go, tags, rm);
      ul.append(row);
    });
    body.append(ul);

    // keyboard-friendly way to add a line
    const add = el('label', 'ev-add');
    add.append('Add a line: ');
    const sel = el('select');
    sel.append(new Option('choose…', ''));
    const have = new Set(r.evidence.map((e) => e.id));
    for (const l of shown.cv.leaves) if (!have.has(l.id)) sel.append(new Option(`${l.label}: ${l.text.slice(0, 60)}`, l.id));
    sel.addEventListener('change', () => { if (sel.value) addEvidence(i, sel.value); });
    add.append(sel);
    body.append(add);
  }

  const ovr = el('label', 'ovr');
  ovr.append('Status: ');
  const sel = el('select');
  sel.append(new Option(`automatic (${STATUS_LABEL[derivedStatus(r)]})`, ''));
  for (const s of ['met', 'possible', 'notfound']) sel.append(new Option(STATUS_LABEL[s] + ' (override)', s, false, r.override === s));
  sel.addEventListener('change', () => { r.override = sel.value || null; edited(i, true); });
  ovr.append(sel);
  body.append(ovr);
}

function edited(i, keepFocusOnOverride = false) {
  updateRow(i);
  updateScore();
  updateMarks();
  shown.onChange?.(i);
  if (keepFocusOnOverride) critResults.children[i]?.querySelector('.ovr select')?.focus();
}

function addEvidence(i, id) {
  const r = shown.results[i];
  if (!canEdit(i) || r.evidence.some((e) => e.id === id)) return;
  r.evidence.push({ id, kind: 'direct', by: 'you' });
  const order = shown.cv.leaves.map((l) => l.id);
  r.evidence.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  edited(i);
}

// ---------- the document (PDF pages or text) ----------

function renderDocument() {
  evidenceView.innerHTML = '';
  const c = shown.cv;
  if (c.kind === 'pdf' && c.pages) {
    evidenceView.className = 'evidence-view pdf';
    c.pages.forEach((pg, i) => {
      const wrap = el('div', 'pdf-page');
      wrap.style.aspectRatio = `${pg.width} / ${pg.height}`;
      const layer = el('div', 'hl-layer');
      wrap.append(pg.canvas, layer);
      for (const leaf of c.leaves) {
        for (const b of leaf.boxes || []) {
          if (b.page !== i + 1) continue;
          const pad = 1.5;
          const box = el('div', 'seg-box');
          box.dataset.id = leaf.id;
          box.style.left = `${((b.x - pad) / pg.width) * 100}%`;
          box.style.top = `${((b.y - pad) / pg.height) * 100}%`;
          box.style.width = `${((b.w + 2 * pad) / pg.width) * 100}%`;
          box.style.height = `${((b.h + 2 * pad) / pg.height) * 100}%`;
          layer.append(box);
        }
      }
      evidenceView.append(wrap);
    });
  } else {
    evidenceView.className = 'evidence-view text';
    if (c.kind === 'pdf') evidenceView.append(el('p', 'hint', 'Rendering the PDF pages…'));
    for (const s of c.segs) {
      if (s.kind === 'heading') { evidenceView.append(el('div', s.sub ? 'tv-sub' : 'tv-heading', s.text)); continue; }
      const row = el('div', 'tv-seg');
      const pieces = s.children ? s.children.map((ch) => ({ id: ch.id, range: ch.range })) : [{ id: s.id, range: [0, s.text.length] }];
      let pos = 0;
      for (const p of pieces) {
        row.append(s.text.slice(pos, p.range[0]));
        const span = el('span', 'seg-box', s.text.slice(p.range[0], p.range[1]));
        span.dataset.id = p.id;
        row.append(span);
        pos = p.range[1];
      }
      row.append(s.text.slice(pos));
      evidenceView.append(row);
    }
  }
  evidenceView.classList.toggle('adding', openIdx >= 0 && canEdit(openIdx));
  updateMarks();
}

function evidenceMap() {
  const m = new Map(); // leaf id -> [criterion text]
  shown.results.forEach((r, i) => {
    if (r.state !== 'done') return;
    for (const e of r.evidence) {
      if (!m.has(e.id)) m.set(e.id, []);
      m.get(e.id).push(shown.criteria[i].text);
    }
  });
  return m;
}

function updateMarks() {
  if (!shown) return;
  const ev = evidenceMap();
  const on = new Set(openIdx >= 0 ? shown.results[openIdx].evidence.map((e) => e.id) : []);
  evidenceView.classList.toggle('has-active', openIdx >= 0);
  evidenceView.querySelectorAll('.seg-box').forEach((b) => {
    b.classList.toggle('ev', ev.has(b.dataset.id));
    b.classList.toggle('on', on.has(b.dataset.id));
  });
}

function focusLine(id) {
  evidenceView.querySelectorAll('.seg-box.focus').forEach((b) => b.classList.remove('focus'));
  const boxes = evidenceView.querySelectorAll(`.seg-box[data-id="${CSS.escape(id)}"]`);
  boxes.forEach((b) => b.classList.add('focus'));
  boxes[0]?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

evidenceView.addEventListener('click', (e) => {
  const box = e.target.closest('.seg-box');
  if (!box || openIdx < 0 || !canEdit(openIdx)) return;
  addEvidence(openIdx, box.dataset.id);
  updateMarks();
  hlTip.hidden = true;
});

evidenceView.addEventListener('pointerover', (e) => {
  const box = e.target.closest('.seg-box');
  if (!box || !shown) return;
  const supports = evidenceMap().get(box.dataset.id);
  const adding = openIdx >= 0 && canEdit(openIdx) && !box.classList.contains('on');
  if (!supports && !adding) { hlTip.hidden = true; return; }
  hlTip.innerHTML = '';
  hlTip.append(el('strong', null, leafById(box.dataset.id)?.label || ''));
  if (supports) {
    const ul = el('ul');
    for (const name of supports) ul.append(el('li', null, name));
    hlTip.append(el('div', null, 'Supports:'), ul);
  }
  if (adding) hlTip.append(el('div', 'tip-add', 'Click to add as evidence'));
  hlTip.hidden = false;
  moveTip(e);
});
evidenceView.addEventListener('pointermove', (e) => { if (!hlTip.hidden) moveTip(e); });
evidenceView.addEventListener('pointerout', (e) => {
  if (e.target.closest('.seg-box') && !e.relatedTarget?.closest?.('.seg-box')) hlTip.hidden = true;
});
function moveTip(e) {
  const r = hlTip.getBoundingClientRect();
  const x = Math.min(e.clientX + 14, innerWidth - r.width - 8);
  const y = e.clientY + 16 + r.height > innerHeight ? e.clientY - r.height - 10 : e.clientY + 16;
  hlTip.style.left = `${Math.max(8, x)}px`;
  hlTip.style.top = `${Math.max(8, y)}px`;
}

// ---------- batch ----------

const batch = initBatch({
  getCriteria: () => criteria.map((c) => ({ ...c })),
  cvFromPdf,
  runCandidate,
  open: (cand) => showCandidate(cand, true),
  isShown: (cand) => shown === cand,
  effectiveStatus, computeScore, STATUS_LABEL
});

// ---------- start: everything that can happen before the user acts ----------

cvFromTextarea();
setCritState('empty');
if (jdInput.value.trim()) onJdChange();
