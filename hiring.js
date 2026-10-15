// Hiring: paste or upload the JD -> confirm criteria -> one CV, or a folder batch.

import { jdHash, yearsNeeded } from './jd.js';
import { criteriaEditor, extractJd, modelUsable, plainCrit } from './criteria.js';
import { cvFromPdf, cvFromText, pdfToText, cvToJson, cvFromJson } from './cv.js';
import { runCandidate, showCandidate, shownCandidate, redrawDocument, candToJson, candFromJson } from './result.js';
import { effectiveStatus, computeScore, STATUS_LABEL } from './match.js';
import { renderPdf } from './pdf.js';
import { initBatch } from './batch.js';
import { readStorage, writeStorage, readJson } from './store.js';

const CV_STORAGE_KEY = 'cv', JD_STORAGE_KEY = 'jd';
const CRITERIA_KEY = (hash) => 'criteria.' + hash;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function initHiring({ onChange, setLastShown }) {
  const cvTextEl = $('cv-text'), cvFileInput = $('cv-file'), cvFileStatus = $('cv-file-status'), cvFileClear = $('cv-file-clear'), cvWarnings = $('cv-warnings');
  const jdInput = $('jd-input'), jdFile = $('jd-file'), note = $('note');

  let cv = null;
  let single = null; // the last single-CV candidate
  let jdKey = null, extractAbort = null, runAbort = null;
  let batch = null;

  const editor = criteriaEditor($('criteria-box'), {
    ids: { state: 'criteria-state', source: 'criteria-source', list: 'criteria-list', add: 'crit-add', confirm: 'crit-confirm' },
    onState: (s) => { batch?.setCriteriaReady(s === 'confirmed'); onChange(); },
    onConfirm: (list) => {
      if (jdKey) writeStorage(CRITERIA_KEY(jdKey), JSON.stringify(list.map(plainCrit)));
      editor.setSource('Saved for this job description in this browser.');
      maybeRun();
    }
  });

  function showWarnings(list) {
    cvWarnings.innerHTML = '';
    for (const w of list) cvWarnings.append(el('li', null, w));
    cvWarnings.hidden = !list.length;
  }

  // ---------- CV ----------

  cvTextEl.value = readStorage(CV_STORAGE_KEY) ?? '';
  jdInput.value = readStorage(JD_STORAGE_KEY) ?? '';

  const cvFromTextarea = () => { const t = cvTextEl.value; cv = t.trim() ? cvFromText(t) : null; };

  let cvTextTimer;
  cvTextEl.addEventListener('input', () => {
    writeStorage(CV_STORAGE_KEY, cvTextEl.value);
    clearTimeout(cvTextTimer);
    cvTextTimer = setTimeout(() => { cvFromTextarea(); maybeRun(false); }, 900);
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

  function pdfStatus(c) {
    return `Using ${c.name}: ${c.pageCount ?? '?'} page${c.pageCount === 1 ? '' : 's'}, ${c.leaves.length} lines, ${c.roles.length} dated role${c.roles.length === 1 ? '' : 's'}.`;
  }

  cvFileInput.addEventListener('change', async () => {
    const file = cvFileInput.files[0];
    if (!file) return;
    cvFileStatus.textContent = 'Reading PDF…';
    try {
      const c = await cvFromPdf(file);
      showWarnings(c.warnings);
      if (!c.leaves.length) {
        cvFileInput.value = '';
        cvFileStatus.textContent = 'No selectable text in that PDF (it may be a scanned image). Paste the CV text instead.';
        cvFileClear.hidden = true;
        cvTextEl.disabled = false;
        return;
      }
      cv = c;
      cvTextEl.disabled = true;
      cvFileClear.hidden = false;
      cvFileStatus.textContent = pdfStatus(c);
      maybeRun();
      // Pages render in the background; matching doesn't wait for them.
      renderPdf(file).then((pages) => { c.pages = pages; if (shownCandidate()?.cv === c) redrawDocument(shownCandidate()); }).catch(() => {});
    } catch (e) {
      cvFileStatus.textContent = 'Could not read that PDF: ' + e.message;
    }
  });
  cvFileClear.addEventListener('click', useTextSource);

  // ---------- JD -> criteria ----------

  let jdTimer;
  jdInput.addEventListener('input', () => {
    writeStorage(JD_STORAGE_KEY, jdInput.value);
    clearTimeout(jdTimer);
    jdTimer = setTimeout(onJdChange, 700);
  });

  jdFile.addEventListener('change', async () => {
    const file = jdFile.files[0];
    jdFile.value = '';
    if (!file) return;
    try {
      jdInput.value = /\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? await pdfToText(file) : await file.text();
      writeStorage(JD_STORAGE_KEY, jdInput.value);
      onJdChange();
    } catch (e) {
      note.textContent = 'Could not read that file: ' + e.message;
    }
  });

  async function onJdChange() {
    const text = jdInput.value.trim();
    if (!text) { jdKey = null; extractAbort?.abort(); editor.clear(); return; }
    const key = jdHash(text);
    if (key === jdKey) return;
    jdKey = key;
    extractAbort?.abort();

    const saved = readJson(CRITERIA_KEY(key));
    if (Array.isArray(saved) && saved.length) {
      editor.setSource('Loaded the criteria you confirmed earlier for this job description.');
      editor.set(saved, 'confirmed');
      maybeRun(false);
      return;
    }
    const ctrl = (extractAbort = new AbortController());
    editor.setSource('');
    editor.extracting();
    try {
      const out = await extractJd(text, ctrl.signal);
      if (ctrl.signal.aborted) return;
      editor.setSource(out.source);
      if (out.warning) note.textContent = out.warning;
      editor.set(out.criteria, 'draft');
    } catch { /* aborted by a newer JD */ }
  }

  // ---------- single-CV run ----------

  // scroll: bring the result into view (not while the user is typing a CV).
  function maybeRun(scroll = true) {
    if (cv?.kind === 'pdf') cvFileStatus.textContent = pdfStatus(cv) + (editor.state === 'confirmed' ? '' : ' Results start once you confirm the criteria.');
    if (!cv || editor.state !== 'confirmed' || !editor.criteria.length) return;
    if (!modelUsable() && editor.criteria.some((c) => c.type !== 'years' || yearsNeeded(c.text) === null)) {
      note.textContent = 'Matching needs the on-device model, which isn\'t available here.';
    }
    runAbort?.abort();
    const ctrl = (runAbort = new AbortController());
    single = { cv, criteria: editor.criteria.map((c) => ({ ...c })), results: [], timing: { t0: performance.now(), tFirst: null, tEnd: null }, frame: 'hiring', onChange };
    setLastShown(single);
    runCandidate(single, ctrl.signal, scroll ? 'scroll' : true).catch(() => {}).finally(onChange);
  }

  batch = initBatch({
    getCriteria: () => editor.criteria.map((c) => ({ ...c })),
    cvFromPdf,
    runCandidate,
    open: (cand) => { setLastShown(cand); showCandidate(cand, true); },
    isShown: (cand) => shownCandidate() === cand,
    effectiveStatus, computeScore, STATUS_LABEL,
    onChange
  });
  batch.setCriteriaReady(editor.state === 'confirmed');

  // ---------- project file ----------

  // addFile(File) -> id or null; addCv(cv) -> id
  function exportState({ addCv }) {
    const b = batch.getState();
    return {
      jd: { text: jdInput.value, criteria: editor.criteria.map(plainCrit), state: editor.state === 'extracting' ? 'draft' : editor.state },
      cv: cv ? addCv(cv) : null,
      single: single ? candToJson(single, addCv(single.cv)) : null,
      batch: b ? { criteria: b.criteria.map(plainCrit), sort: b.sort, skipped: b.skipped, rows: b.rows.map((c) => candToJson(c, addCv(c.cv))) } : null,
      shown: shownCandidate() === single && single ? 'single' : b && b.rows.includes(shownCandidate()) ? b.rows.indexOf(shownCandidate()) : null
    };
  }

  function restore(h, getCv) {
    extractAbort?.abort(); runAbort?.abort();
    clearTimeout(jdTimer); clearTimeout(cvTextTimer);
    jdInput.value = h.jd?.text || '';
    jdKey = jdInput.value.trim() ? jdHash(jdInput.value.trim()) : null;
    if (h.jd?.criteria?.length) {
      editor.setSource('Restored from a project file.');
      editor.set(h.jd.criteria, h.jd.state === 'confirmed' ? 'confirmed' : 'draft');
    } else editor.clear();

    cv = h.cv != null ? getCv(h.cv) : null;
    showWarnings(cv?.warnings || []);
    if (cv?.kind === 'pdf') {
      cvTextEl.disabled = true;
      cvFileClear.hidden = false;
      cvFileStatus.textContent = pdfStatus(cv) + (cv.file ? '' : ' (text only: the PDF wasn\'t saved in the project file)');
      if (cv.file && !cv.pages) renderPdf(cv.file).then((pages) => { cv.pages = pages; redrawDocument(shownCandidate()); }).catch(() => {});
    } else {
      cvFileInput.value = '';
      cvFileClear.hidden = true;
      cvTextEl.disabled = false;
      cvFileStatus.textContent = 'or paste the text below';
      if (cv?.text != null) cvTextEl.value = cv.text;
    }

    single = h.single ? candFromJson(h.single, getCv(h.single.cv), { frame: 'hiring', onChange }) : null;
    const rows = (h.batch?.rows || []).map((r) => candFromJson(r, getCv(r.cv), { frame: 'hiring' }));
    batch.restore(h.batch ? { criteria: h.batch.criteria.map((c) => ({ ...c })), rows, sort: h.batch.sort, skipped: h.batch.skipped } : null);
    batch.setCriteriaReady(editor.state === 'confirmed');
    const show = h.shown === 'single' ? single : Number.isInteger(h.shown) ? rows[h.shown] : single || rows[0] || null;
    return show;
  }

  // ---------- start ----------
  cvFromTextarea();
  if (jdInput.value.trim()) onJdChange();

  return {
    exportState, restore,
    get current() { return cv; },
    files: () => [cv?.file, single?.cv.file, ...(batch.getState()?.rows || []).map((c) => c.cv.file)].filter(Boolean)
  };
}
