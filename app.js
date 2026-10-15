import { segmentPdf, segmentText, promptLines, buildIndex, resolveEvidence } from './segment.js';

// GH Pages serves every nlade-core project from the same origin
// (nlade-core.github.io), so localStorage is shared across all of them --
// unprefixed keys here can collide with another repo's. Always namespace.
const STORAGE_PREFIX = 'cvjdfit.';
const CV_STORAGE_KEY = STORAGE_PREFIX + 'cv';
const JD_STORAGE_KEY = STORAGE_PREFIX + 'jd';

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage disabled/unavailable (private mode, etc.) -- fall through to defaults
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage disabled/full -- nothing to do, the field still works for this session
  }
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


const SYSTEM_PROMPT = `You evaluate how well a candidate's CV fits a job description.
You will be given a CV and a job description. Assess the fit honestly and
specifically, based only on what is actually stated in the CV — do not assume
skills or experience that aren't written there. The job description text may
contain unrelated site navigation, boilerplate, or clutter; extract and
evaluate only the substantive job requirements. Respond ONLY with JSON
matching the required schema.

The CV is given as numbered lines like "[12] text"; lines starting with "#"
are section headings. For each item in "matchedSkills", set "evidence" to the
IDs of every CV line that plausibly supports it.

For "matchedSkills": concrete skills/requirements from the job description
that the CV does support. For "gaps": concrete requirements from the job
description that the CV does not show evidence of. For each item in both
lists, set "importance" to "required" if the job description states it as a
minimum/required qualification, or "preferred" if it's stated as
preferred/nice-to-have/a bonus — base this on the job description's own
wording, not your own judgment of how important it seems. "summary" is one or
two plain sentences giving the overall verdict. Do not invent a numeric score
— none is requested.`;

const SKILL_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    skill: { type: "string" },
    importance: { type: "string", enum: ["required", "preferred"] }
  },
  required: ["skill", "importance"]
};

const MATCHED_ITEM_SCHEMA = {
  ...SKILL_ITEM_SCHEMA,
  properties: { ...SKILL_ITEM_SCHEMA.properties, evidence: { type: "array", items: { type: "string" } } },
  required: ["skill", "importance", "evidence"]
};

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    matchedSkills: { type: "array", items: MATCHED_ITEM_SCHEMA },
    gaps: { type: "array", items: SKILL_ITEM_SCHEMA },
    summary: { type: "string" }
  },
  required: ["matchedSkills", "gaps", "summary"]
};

// Used only if this browser's Prompt API rejects responseConstraint.
const JSON_SHAPE_HINT = `

Respond with only this JSON shape: {"matchedSkills":[{"skill":"...","importance":"required","evidence":["3","4.2"]}],"gaps":[{"skill":"...","importance":"preferred"}],"summary":"..."}`;

// The score is arithmetic over the model's own matched/gap lists, not a
// separate number the model has to invent -- required items count double so
// a single missing must-have drags the score down more than a missing nice-
// to-have, but the number is always traceable back to the visible lists.
function computeScore(matchedSkills, gaps) {
  const weight = (item) => (item.importance === 'required' ? 2 : 1);
  const matchedWeight = matchedSkills.reduce((sum, item) => sum + weight(item), 0);
  const gapWeight = gaps.reduce((sum, item) => sum + weight(item), 0);
  const total = matchedWeight + gapWeight;
  if (total === 0) return null; // no signal either way -- nothing to compute from
  return Math.round((100 * matchedWeight) / total);
}

const statusPill = document.getElementById('status-pill');
const cvTextEl = document.getElementById('cv-text');
const cvFileInput = document.getElementById('cv-file');
const cvFileStatus = document.getElementById('cv-file-status');
const cvFileClear = document.getElementById('cv-file-clear');
const jdInput = document.getElementById('jd-input');
const runBtn = document.getElementById('run-btn');
const note = document.getElementById('note');
const resultPanel = document.getElementById('result-panel');
const scoreValue = document.getElementById('score-value');
const summaryEl = document.getElementById('summary');
const matchedList = document.getElementById('matched-list');
const gapsList = document.getElementById('gaps-list');
const evidenceView = document.getElementById('evidence-view');
const hlTip = document.getElementById('hl-tip');

cvTextEl.value = readStorage(CV_STORAGE_KEY) ?? SAMPLE_CV_TEXT;
jdInput.value = readStorage(JD_STORAGE_KEY) ?? '';

cvTextEl.addEventListener('input', () => writeStorage(CV_STORAGE_KEY, cvTextEl.value));
jdInput.addEventListener('input', () => writeStorage(JD_STORAGE_KEY, jdInput.value));

let modelAvailability = null;
let prewarmedSession = null; // only ever set when availability was already 'available' at load time

async function checkCapability() {
  if (!self.LanguageModel) {
    statusPill.className = 'status-pill missing';
    statusPill.textContent = 'not supported in this browser';
    note.textContent = 'Open this in a recent desktop Chrome with the on-device model enabled.';
    return;
  }
  try {
    const availability = await LanguageModel.availability();
    modelAvailability = availability;
    statusPill.className = 'status-pill ' + availability;
    statusPill.textContent = availability === 'downloadable' ? 'model needs download' : availability;

    if (availability === 'unavailable') {
      note.textContent = 'The on-device model isn\'t available on this device.';
      return;
    }
    runBtn.disabled = false;

    if (availability === 'available') {
      // Silent warm-up is only safe when nothing needs to be downloaded --
      // never trigger a real download without an explicit click.
      prewarmedSession = LanguageModel.create({ initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }] });
    } else if (availability === 'downloadable') {
      note.textContent = 'First run will download the on-device model — this may take a while.';
    }
  } catch (e) {
    statusPill.className = 'status-pill unavailable';
    statusPill.textContent = 'error';
    note.textContent = e.message;
  }
}
checkCapability();

// ---------- PDF upload (pdf.js is vendored in vendor/pdfjs, loaded on first use) ----------

let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= import('./vendor/pdfjs/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    return lib;
  });
  return pdfjsPromise;
}

let pdfState = null; // { name, pages: [{ width, height, canvas }], segs } while a PDF is the CV source

async function readPdf(file) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false
  });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const items = (await page.getTextContent()).items;
      const view = page.getViewport({ scale: 2 }); // 2 canvas px per PDF point: sharp at panel widths
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(view.width);
      canvas.height = Math.floor(view.height);
      await page.render({ canvas, viewport: view }).promise;
      pages.push({ width: vp.width, height: vp.height, items, canvas });
    }
    return pages;
  } finally {
    task.destroy();
  }
}

function useTextSource() {
  pdfState = null;
  cvFileInput.value = '';
  cvFileStatus.textContent = '';
  cvFileClear.hidden = true;
  cvTextEl.disabled = false;
  resultPanel.hidden = true;
}

cvFileInput.addEventListener('change', async () => {
  const file = cvFileInput.files[0];
  if (!file) return;
  resultPanel.hidden = true;
  cvFileStatus.textContent = 'Reading PDF…';
  try {
    const pages = await readPdf(file);
    const segs = segmentPdf(pages);
    const count = segs.filter((s) => s.kind === 'seg').length;
    if (!count) {
      useTextSource();
      cvFileStatus.textContent = 'No selectable text in that PDF (it may be a scanned image). Paste the CV text instead.';
      return;
    }
    pdfState = { name: file.name, pages: pages.map(({ width, height, canvas }) => ({ width, height, canvas })), segs };
    cvTextEl.disabled = true;
    cvFileClear.hidden = false;
    cvFileStatus.textContent = `Using ${file.name}: ${pages.length} page${pages.length === 1 ? '' : 's'}, ${count} sections of text.`;
  } catch (e) {
    useTextSource();
    cvFileStatus.textContent = 'Could not read that PDF: ' + e.message;
  }
});
cvFileClear.addEventListener('click', useTextSource);

// ---------- results + evidence highlighting ----------

let view = null; // { matched, leafById, criteriaByLeaf, active }

function importanceTag(importance) {
  const tag = document.createElement('span');
  tag.className = 'importance-tag ' + importance;
  tag.textContent = importance;
  return tag;
}

function renderSkillList(listEl, items) {
  listEl.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item.skill;
    li.appendChild(importanceTag(item.importance));
    listEl.appendChild(li);
  });
}

function renderMatchedList() {
  matchedList.innerHTML = '';
  view.matched.forEach((item, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'match-btn';
    btn.setAttribute('aria-pressed', 'false');
    const label = document.createElement('span');
    label.textContent = item.skill;
    btn.append(label, importanceTag(item.importance));
    if (!item.leaves.length) {
      btn.disabled = true;
      const none = document.createElement('span');
      none.className = 'no-ev';
      none.textContent = 'no CV line cited';
      label.append(' ', none);
    }
    btn.addEventListener('click', () => setActive(i));
    const quotes = document.createElement('ul');
    quotes.className = 'ev-quotes';
    quotes.hidden = true;
    for (const id of item.leaves) {
      const q = document.createElement('li');
      q.textContent = view.leafById.get(id).text; // copied from the segment, never from the model
      quotes.appendChild(q);
    }
    li.append(btn, quotes);
    matchedList.appendChild(li);
  });
}

function hlElement(tag, id) {
  const el = document.createElement(tag);
  el.className = 'hl';
  el.dataset.id = id;
  return el;
}

function renderEvidenceView(segs) {
  evidenceView.innerHTML = '';
  const evidence = view.criteriaByLeaf;
  if (pdfState) {
    evidenceView.className = 'evidence-view pdf';
    pdfState.pages.forEach((pg, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap.style.aspectRatio = `${pg.width} / ${pg.height}`;
      const layer = document.createElement('div');
      layer.className = 'hl-layer';
      wrap.append(pg.canvas, layer);
      for (const [id] of evidence) {
        for (const b of view.leafById.get(id).boxes) {
          if (b.page !== i + 1) continue;
          const pad = 1.5;
          const el = hlElement('div', id);
          el.style.left = `${((b.x - pad) / pg.width) * 100}%`;
          el.style.top = `${((b.y - pad) / pg.height) * 100}%`;
          el.style.width = `${((b.w + 2 * pad) / pg.width) * 100}%`;
          el.style.height = `${((b.h + 2 * pad) / pg.height) * 100}%`;
          layer.appendChild(el);
        }
      }
      evidenceView.appendChild(wrap);
    });
    return;
  }
  evidenceView.className = 'evidence-view text';
  for (const s of segs) {
    const row = document.createElement('div');
    if (s.kind === 'heading') {
      row.className = 'tv-heading';
      row.textContent = s.text;
    } else {
      row.className = 'tv-seg';
      const pieces = s.children ? s.children.map((c) => ({ id: c.id, range: c.range })) : [{ id: s.id, range: [0, s.text.length] }];
      let pos = 0;
      for (const p of pieces) {
        row.append(s.text.slice(pos, p.range[0]));
        const text = s.text.slice(p.range[0], p.range[1]);
        if (evidence.has(p.id)) {
          const el = hlElement('span', p.id);
          el.textContent = text;
          row.append(el);
        } else row.append(text);
        pos = p.range[1];
      }
      row.append(s.text.slice(pos));
    }
    evidenceView.appendChild(row);
  }
}

function setActive(i) {
  view.active = view.active === i ? -1 : i;
  const on = new Set(view.active >= 0 ? view.matched[view.active].leaves : []);
  [...matchedList.children].forEach((li, k) => {
    li.querySelector('.match-btn').setAttribute('aria-pressed', String(k === view.active));
    li.querySelector('.ev-quotes').hidden = k !== view.active;
  });
  evidenceView.classList.toggle('has-active', view.active >= 0);
  evidenceView.querySelectorAll('.hl').forEach((el) => el.classList.toggle('on', on.has(el.dataset.id)));
  const first = evidenceView.querySelector('.hl.on');
  if (first) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }
}

evidenceView.addEventListener('pointerover', (e) => {
  const el = e.target.closest('.hl');
  if (!el || !view) return;
  hlTip.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = 'Supports';
  const ul = document.createElement('ul');
  for (const name of view.criteriaByLeaf.get(el.dataset.id) || []) {
    const li = document.createElement('li');
    li.textContent = name;
    ul.appendChild(li);
  }
  hlTip.append(title, ul);
  hlTip.hidden = false;
  moveTip(e);
});
evidenceView.addEventListener('pointermove', (e) => { if (!hlTip.hidden) moveTip(e); });
evidenceView.addEventListener('pointerout', (e) => {
  if (e.target.closest('.hl') && !e.relatedTarget?.closest?.('.hl')) hlTip.hidden = true;
});
function moveTip(e) {
  const r = hlTip.getBoundingClientRect();
  const x = Math.min(e.clientX + 14, innerWidth - r.width - 8);
  const y = e.clientY + 16 + r.height > innerHeight ? e.clientY - r.height - 10 : e.clientY + 16;
  hlTip.style.left = `${Math.max(8, x)}px`;
  hlTip.style.top = `${Math.max(8, y)}px`;
}

function renderResult(data, segs) {
  const index = buildIndex(segs);
  const leafById = new Map();
  for (const leaves of index.values()) for (const leaf of leaves) leafById.set(leaf.id, leaf);
  const matched = (data.matchedSkills || []).map((m) => ({ ...m, leaves: resolveEvidence(m.evidence, index) }));
  const gaps = data.gaps || [];
  // Document order, so highlights and the tooltip follow the CV's own order.
  const criteriaByLeaf = new Map();
  for (const id of leafById.keys()) {
    const names = matched.filter((m) => m.leaves.includes(id)).map((m) => m.skill);
    if (names.length) criteriaByLeaf.set(id, names);
  }
  view = { matched, leafById, criteriaByLeaf, active: -1 };

  resultPanel.hidden = false;
  const score = computeScore(matched, gaps);
  scoreValue.textContent = score === null ? '—' : String(score);
  summaryEl.textContent = data.summary;
  renderMatchedList();
  renderSkillList(gapsList, gaps);
  renderEvidenceView(segs);
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Model response was not valid JSON.');
  }
}

// Structured output (responseConstraint) is used when the browser supports
// it; if the API rejects the option, fall back to a plain prompt with the
// JSON shape spelled out, and remember that for later runs.
let constraintSupported = true;
async function promptForJson(session, text) {
  if (constraintSupported) {
    try {
      return await session.prompt(text, { responseConstraint: RESPONSE_SCHEMA });
    } catch (e) {
      if (!(e instanceof TypeError) && e?.name !== 'NotSupportedError') throw e;
      constraintSupported = false;
    }
  }
  return session.prompt(text + JSON_SHAPE_HINT);
}

async function runMatch() {
  const jdText = jdInput.value.trim();
  if (!pdfState && !cvTextEl.value.trim()) {
    note.textContent = 'Paste a CV or upload a PDF first.';
    return;
  }
  if (!jdText) {
    note.textContent = 'Paste a job description first.';
    return;
  }

  runBtn.disabled = true;
  resultPanel.hidden = true;
  note.textContent = modelAvailability === 'downloadable'
    ? 'Downloading model — this only happens once…'
    : 'Checking fit…';

  const segs = pdfState ? pdfState.segs : segmentText(cvTextEl.value);
  let session = null;
  try {
    if (prewarmedSession) {
      session = await prewarmedSession;
      prewarmedSession = null; // one-shot; a fresh session is created for any subsequent run
    } else {
      session = await LanguageModel.create({
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            note.textContent = `Downloading model… ${Math.round(e.loaded * 100)}%`;
          });
        }
      });
    }

    note.textContent = 'Checking fit…';
    const raw = await promptForJson(session, `CV:\n${promptLines(segs)}\n\nJob description:\n${jdText}`);
    renderResult(extractJson(raw), segs);
    note.textContent = '';
  } catch (e) {
    note.textContent = 'Something went wrong: ' + e.message;
  } finally {
    if (session) session.destroy();
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', runMatch);
