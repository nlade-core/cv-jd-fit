// Job hunting: upload the CV -> check how it was read (and fix it) -> add one or
// more JDs -> Met / Possible / Not found per JD, with a coverage table.

import { SECTIONS, SECTION_NAMES, dateSpan, parseDate, setRoleTitle, hasDates } from './structure.js';
import { criteriaEditor, extractJd, plainCrit } from './criteria.js';
import { cvFromPdf, cvFromText, pdfToText, fixSection, fixRole, fixRoleDates, touchRole, cvToJson } from './cv.js';
import { runCandidate, showCandidate, shownCandidate, hideResult, redrawDocument, candToJson, candFromJson } from './result.js';
import { effectiveStatus, computeScore } from './match.js';
import { renderPdf } from './pdf.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function initSeeker({ onChange, setLastShown }) {
  const fileInput = $('seek-cv-file'), fileStatus = $('seek-cv-status'), warnings = $('seek-cv-warnings');
  const pasteText = $('seek-cv-text'), pasteUse = $('seek-cv-use');
  const parsePanel = $('parse-panel'), parseList = $('parse-list'), parseConfirm = $('parse-confirm'), parseState = $('parse-state'), parseSummary = $('parse-summary');
  const jdPanel = $('seek-jd-panel'), jdInput = $('seek-jd-input'), jdAdd = $('seek-jd-add'), jdFiles = $('seek-jd-files'), jdList = $('seek-jd-list'), jdNote = $('seek-jd-note');
  const tablePanel = $('seek-table-panel'), table = $('seek-table');

  let cv = null;
  let jds = []; // { id, name, text, editor, li, cand, extracting, abort }
  let nextJd = 1;
  let runAbort = null;

  // ---------- CV ----------

  function setCv(c, status) {
    cv = c;
    runAbort?.abort();
    for (const j of jds) j.cand = null;
    hideResult();
    setLastShown(null);
    fileStatus.textContent = status;
    warnings.innerHTML = '';
    for (const w of c.warnings || []) warnings.append(el('li', null, w));
    warnings.hidden = !(c.warnings || []).length;
    parsePanel.hidden = false;
    renderParse();
    renderJds();
    onChange();
    if (c.kind === 'pdf' && c.file && !c.pages) renderPdf(c.file).then((p) => { c.pages = p; redrawDocument(shownCandidate()); }).catch(() => {});
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    fileStatus.textContent = 'Reading PDF…';
    try {
      const c = await cvFromPdf(file);
      if (!c.leaves.length) {
        fileStatus.textContent = 'No selectable text in that PDF (it may be a scanned image). Paste the CV text instead.';
        return;
      }
      setCv(c, `Read ${file.name}: ${c.pageCount} page${c.pageCount === 1 ? '' : 's'}, ${c.leaves.length} lines, ${c.roles.length} dated role${c.roles.length === 1 ? '' : 's'}.`);
    } catch (e) {
      fileStatus.textContent = 'Could not read that PDF: ' + e.message;
    }
  });
  pasteUse.addEventListener('click', () => {
    if (!pasteText.value.trim()) return;
    const c = cvFromText(pasteText.value, 'Your CV (pasted)');
    setCv(c, `Read the pasted text: ${c.leaves.length} lines, ${c.roles.length} dated role${c.roles.length === 1 ? '' : 's'}.`);
  });

  // ---------- parse check ----------

  // Groups top-level segments: section (first-appearance order) -> role -> segments.
  function groups() {
    const out = [];
    let cur = null;
    for (const s of cv.segs) {
      if (s.kind !== 'seg') continue;
      let g = out.find((x) => x.section === s.section);
      if (!g) { g = { section: s.section, parts: [] }; out.push(g); }
      const key = s.role || null;
      cur = g.parts.find((p) => p.role === key);
      if (!cur) { cur = { role: key, segs: [] }; g.parts.push(cur); }
      cur.segs.push(s);
    }
    return out;
  }

  function renderParse(focusKey) {
    parseList.innerHTML = '';
    const yrs = cv.roles.filter((r) => hasDates(r)).length;
    parseSummary.textContent = `${cv.leaves.length} lines in ${new Set(cv.segs.filter((s) => s.kind === 'seg').map((s) => s.section)).size} sections; ${cv.roles.length} role${cv.roles.length === 1 ? '' : 's'} under Experience, ${yrs} with dates.` + (cv.parseFixes ? ` You've made ${cv.parseFixes} fix${cv.parseFixes === 1 ? '' : 'es'}.` : '');
    for (const g of groups()) {
      const sec = el('section', 'pc-section');
      sec.append(el('h3', 'pc-sec-title', SECTION_NAMES[g.section]));
      for (const part of g.parts) {
        const box = el('div', 'pc-role' + (part.role ? '' : ' none'));
        if (part.role) box.append(roleHeader(part.role));
        const ul = el('ul', 'pc-segs');
        for (const s of part.segs) ul.append(segRow(s));
        box.append(ul);
        sec.append(box);
      }
      parseList.append(sec);
    }
    updateParseState();
    if (focusKey) parseList.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  function roleHeader(role) {
    const ri = cv.roles.indexOf(role);
    const head = el('div', 'pc-role-head');
    const t = el('input', 'pc-title');
    t.type = 'text'; t.value = role.title; t.dataset.key = `title-${ri}`;
    t.setAttribute('aria-label', 'Role title');
    t.addEventListener('change', () => { setRoleTitle(role, t.value); touchRole(cv, role); fixed(`title-${ri}`); });
    const from = dateInput(role, 0, ri), to = dateInput(role, 1, ri);
    const dates = el('span', 'pc-dates');
    dates.append(from, el('span', 'pc-dash', '–'), to);
    head.append(t, dates);
    if (!hasDates(role)) head.append(el('span', 'pc-warn', 'Add both dates or this role won\'t count towards years of experience.'));
    else if (!role.counted) head.append(el('span', 'pc-note', 'Not counted towards years (career break or similar).'));
    if (role.fixed) head.append(el('span', 'kind-tag you', 'fixed by you'));
    return head;
  }

  function dateInput(role, k, ri) {
    const i = el('input', 'pc-date');
    i.type = 'text';
    i.value = role.dates?.[k] ? pretty(role.dates[k]) : '';
    i.placeholder = k ? 'to' : 'from';
    i.dataset.key = `date-${ri}-${k}`;
    i.setAttribute('aria-label', k ? 'Role end date' : 'Role start date');
    i.title = 'A year (2019), a month and year (Mar 2021 or 2021-03), or "present"';
    i.addEventListener('change', () => {
      const v = parseDate(i.value);
      if (!v || (k === 0 && v === 'present')) {
        i.setAttribute('aria-invalid', 'true');
        parseState.textContent = 'Dates are a year (2019), a month and year (Mar 2021 or 2021-03), or "present" for the end date.';
        parseState.className = 'pc-state bad';
        return;
      }
      const d = role.dates ? role.dates.slice() : [null, null];
      d[k] = v;
      fixRoleDates(cv, role, d[0], d[1]);
      fixed(`date-${ri}-${k}`);
    });
    return i;
  }

  function segRow(s) {
    const li = el('li', 'pc-seg' + (s.fixed ? ' fixed' : ''));
    const text = el('span', 'pc-text', s.text.length > 160 ? s.text.slice(0, 157) + '…' : s.text);
    text.title = s.text;
    const sel = el('select');
    sel.dataset.key = `sec-${s.id}`;
    sel.setAttribute('aria-label', `Section for: ${s.text.slice(0, 60)}`);
    for (const k of SECTIONS) sel.append(new Option(SECTION_NAMES[k], k, false, k === s.section));
    sel.addEventListener('change', () => { fixSection(cv, s.id, sel.value); fixed(`sec-${s.id}`); });
    const role = el('select');
    role.dataset.key = `role-${s.id}`;
    role.setAttribute('aria-label', `Role for: ${s.text.slice(0, 60)}`);
    role.append(new Option('no role', '', false, !s.role));
    cv.roles.forEach((r, k) => role.append(new Option(`${r.short} (${dateSpan(r.dates)})`, String(k), false, r === s.role)));
    role.append(new Option('New role from this line…', 'new'));
    role.addEventListener('change', () => {
      const r = fixRole(cv, s.id, role.value === '' ? null : role.value === 'new' ? 'new' : +role.value);
      fixed(role.value === 'new' && r ? `title-${cv.roles.indexOf(r)}` : `role-${s.id}`);
    });
    const ctl = el('span', 'pc-ctl');
    ctl.append(sel, role);
    li.append(text, ctl);
    if (s.children) li.append(el('span', 'pc-items', `${s.children.length} items: ${s.children.map((c) => c.text).join(' · ')}`));
    return li;
  }

  const pretty = (d) => {
    if (d === 'present') return 'present';
    const m = d.match(/^(\d{4})-(\d{2})$/);
    return m ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1]} ${m[1]}` : d;
  };

  function fixed(focusKey) {
    for (const j of jds) j.stale = !!j.cand;
    renderParse(focusKey);
    renderJds();
    onChange();
  }

  function updateParseState() {
    parseConfirm.disabled = !!cv.parseConfirmed;
    parseConfirm.textContent = cv.parseConfirmed ? 'Confirmed ✓' : cv.parseFixes && jds.some((j) => j.cand) ? 'Confirm and re-check the JDs' : 'This is right — continue';
    parseState.className = 'pc-state' + (cv.parseConfirmed ? ' ok' : '');
    parseState.textContent = cv.parseConfirmed ? 'Matching uses exactly this.' : 'Check the sections, roles and dates, then confirm.';
    jdPanel.hidden = !cv.parseConfirmed && !jds.length;
  }

  parseConfirm.addEventListener('click', () => {
    cv.parseConfirmed = true;
    for (const j of jds) if (j.stale || !j.cand) { j.stale = false; j.dirty = true; }
    updateParseState();
    jdPanel.hidden = false;
    onChange();
    if (!jds.length) jdInput.focus();
    pump();
  });

  // ---------- JDs ----------

  const jdName = (text) => (text.split('\n').map((l) => l.replace(/^#+\s*|\*\*/g, '').trim()).find((l) => l) || 'Job description').slice(0, 70);

  function addJd(text, name) {
    text = text.trim();
    if (!text) return null;
    const j = { id: nextJd++, name: name || jdName(text), text, cand: null, dirty: true, stale: false };
    jds.push(j);
    buildJdItem(j);
    extract(j);
    renderJds();
    onChange();
    return j;
  }

  async function extract(j) {
    j.abort?.abort();
    const ctrl = (j.abort = new AbortController());
    j.extracting = true;
    j.editor.extracting();
    renderJds();
    try {
      const out = await extractJd(j.text, ctrl.signal);
      j.editor.setSource(out.source + (out.warning ? ' ' + out.warning : ''));
      j.editor.set(out.criteria, 'draft');
    } catch { return; } finally { if (j.abort === ctrl) j.extracting = false; }
    j.dirty = true;
    renderJds();
    pump();
  }

  jdAdd.addEventListener('click', () => {
    if (addJd(jdInput.value)) { jdInput.value = ''; jdNote.textContent = 'Added. Paste another, or pick files.'; }
  });
  jdFiles.addEventListener('change', async () => {
    const files = [...jdFiles.files];
    jdFiles.value = '';
    const bad = [];
    for (const f of files) {
      try {
        const text = /\.pdf$/i.test(f.name) || f.type === 'application/pdf' ? await pdfToText(f) : await f.text();
        if (!addJd(text, f.name.replace(/\.(txt|md|pdf)$/i, ''))) bad.push(f.name);
      } catch { bad.push(f.name); }
    }
    jdNote.textContent = `Added ${files.length - bad.length} job description${files.length - bad.length === 1 ? '' : 's'}.` + (bad.length ? ` Couldn't read: ${bad.join(', ')}.` : '');
  });

  function buildJdItem(j) {
    const li = el('li', 'jd-item');
    const head = el('div', 'jd-head');
    const name = el('strong', 'jd-name', j.name);
    const st = el('span', 'jd-status');
    const open = el('button', 'link-btn jd-open', 'Show result');
    open.type = 'button';
    open.addEventListener('click', () => showJd(j, true));
    const rm = el('button', 'icon-btn', '✕');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove job description: ${j.name}`);
    rm.addEventListener('click', () => removeJd(j));
    head.append(name, st, open, rm);
    const det = el('details', 'jd-review');
    const sum = el('summary', null, 'Review the criteria (optional)');
    const box = el('div');
    det.append(sum, box);
    li.append(head, det);
    j.li = li; j.statusEl = st; j.openBtn = open; j.summary = sum;
    j.editor = criteriaEditor(box, {
      confirmText: 'Use these criteria',
      onConfirm: () => { j.dirty = true; renderJds(); onChange(); pump(); }
    });
    jdList.append(li);
  }

  function removeJd(j) {
    j.abort?.abort();
    if (shownCandidate() === j.cand) { hideResult(); setLastShown(null); }
    if (running === j) runAbort?.abort();
    jds = jds.filter((x) => x !== j);
    j.li.remove();
    renderJds();
    onChange();
  }

  function jdStatusText(j) {
    if (j.extracting) return 'reading the criteria…';
    if (!j.editor.criteria.length) return 'no criteria';
    const n = j.editor.criteria.length;
    if (!cv?.parseConfirmed) return `${n} criteria · waiting for the CV check`;
    if (!j.cand) return `${n} criteria · queued`;
    const done = j.cand.results.filter((r) => r.state === 'done').length;
    if (running === j) return `checking ${done}/${n}…`;
    const s = computeScore(j.cand.criteria, j.cand.results);
    return (j.stale || j.dirty ? 'out of date · ' : '') + (s === null ? `${done}/${n} done` : `coverage ${s}/100`) + (j.cand.stopped ? ' (stopped)' : '');
  }

  function renderJds() {
    for (const j of jds) {
      j.statusEl.textContent = jdStatusText(j);
      j.openBtn.hidden = !j.cand;
      j.summary.textContent = `Review the ${j.editor.criteria.length || ''} criteria (optional)`.replace('  ', ' ');
      j.li.classList.toggle('current', !!j.cand && shownCandidate() === j.cand);
    }
    renderTable();
  }

  // ---------- running, one JD at a time ----------

  let running = null, pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (!cv?.parseConfirmed) break;
        const j = jds.find((x) => x.dirty && !x.extracting && x.editor.criteria.length);
        if (!j) break;
        j.dirty = false;
        j.stale = false;
        await runJd(j);
      }
    } finally { pumping = false; }
  }

  async function runJd(j) {
    const ctrl = (runAbort = new AbortController());
    const wasShown = j.cand && shownCandidate() === j.cand;
    const cand = { cv, criteria: j.editor.criteria.map((c) => ({ ...c })), results: [], timing: { t0: performance.now(), tFirst: null, tEnd: null }, frame: 'seeker', title: `${j.name} — against your CV` };
    cand.onChange = () => { renderJds(); onChange(); };
    j.cand = cand;
    running = j;
    const show = wasShown || !shownCandidate();
    if (show) setLastShown(cand);
    renderJds();
    try { await runCandidate(cand, ctrl.signal, show); } catch { /* stopped */ } finally { running = null; renderJds(); onChange(); }
  }

  function showJd(j, scroll) {
    if (!j.cand) return;
    setLastShown(j.cand);
    showCandidate(j.cand, scroll);
    renderJds();
  }

  // JDs as rows, sorted by coverage (unfinished ones last).
  function renderTable() {
    const withRuns = jds.filter((j) => j.cand);
    tablePanel.hidden = jds.length < 2 || !withRuns.length;
    if (tablePanel.hidden) return;
    const thead = table.querySelector('thead'), tbody = table.querySelector('tbody');
    thead.innerHTML = '<tr><th scope="col">Job description</th><th scope="col" aria-sort="descending">Coverage ↓</th><th scope="col">Met</th><th scope="col">Possible</th><th scope="col">Not found</th></tr>';
    tbody.innerHTML = '';
    const rows = jds.map((j) => {
      const c = j.cand;
      const done = c ? c.results.filter((r) => r.state === 'done') : [];
      const finished = c && done.length === c.criteria.length;
      const count = (st) => (c ? c.results.filter((r) => r.state === 'done' && effectiveStatus(r) === st).length : 0);
      return { j, score: c ? computeScore(c.criteria, c.results) : null, finished, met: count('met'), possible: count('possible'), notfound: count('notfound'), n: c?.criteria.length || j.editor.criteria.length };
    }).sort((a, b) => (b.finished - a.finished) || ((b.score ?? -1) - (a.score ?? -1)) || a.j.id - b.j.id);
    for (const r of rows) {
      const tr = el('tr');
      if (r.j.cand && shownCandidate() === r.j.cand) tr.className = 'current';
      const th = el('th');
      th.scope = 'row';
      const b = el('button', 'cand-btn', r.j.name);
      b.type = 'button';
      b.disabled = !r.j.cand;
      b.addEventListener('click', (e) => { e.stopPropagation(); showJd(r.j, true); });
      th.append(b);
      const score = el('td', 'score-cell', r.score == null ? '–' : String(r.score));
      if (r.j.cand && !r.finished) score.append(el('span', 'partial', running === r.j ? ' …' : ` (${r.met + r.possible + r.notfound}/${r.n})`));
      tr.append(th, score, el('td', null, String(r.met)), el('td', null, String(r.possible)), el('td', null, String(r.notfound)));
      if (r.j.cand) tr.addEventListener('click', () => showJd(r.j, true));
      tbody.append(tr);
    }
  }

  // ---------- project file ----------

  function exportState({ addCv }) {
    const cvId = cv ? addCv(cv) : null;
    return {
      cv: cvId,
      jds: jds.map((j) => ({
        name: j.name, text: j.text,
        criteria: j.editor.criteria.map(plainCrit),
        state: j.editor.state === 'confirmed' ? 'confirmed' : 'draft',
        result: j.cand ? candToJson(j.cand, cvId) : null
      })),
      shown: jds.findIndex((j) => j.cand && j.cand === shownCandidate())
    };
  }

  function restore(s, getCv) {
    runAbort?.abort();
    for (const j of jds) j.abort?.abort();
    jds = [];
    jdList.innerHTML = '';
    cv = s.cv != null ? getCv(s.cv) : null;
    hideResult();
    if (cv) {
      fileStatus.textContent = `Restored ${cv.name} from a project file${cv.kind === 'pdf' && !cv.file ? ' (text only: the PDF wasn\'t saved in it)' : ''}.`;
      warnings.innerHTML = '';
      for (const w of cv.warnings || []) warnings.append(el('li', null, w));
      warnings.hidden = !(cv.warnings || []).length;
      parsePanel.hidden = false;
      if (cv.kind === 'pdf' && cv.file && !cv.pages) renderPdf(cv.file).then((p) => { cv.pages = p; redrawDocument(shownCandidate()); }).catch(() => {});
    } else {
      parsePanel.hidden = true;
      fileStatus.textContent = '';
    }
    for (const x of s.jds || []) {
      const j = { id: nextJd++, name: String(x.name || jdName(x.text || '')), text: String(x.text || ''), cand: null, dirty: false, stale: false };
      jds.push(j);
      buildJdItem(j);
      j.editor.setSource('Restored from a project file.');
      j.editor.set(x.criteria || [], x.state === 'confirmed' ? 'confirmed' : 'draft');
      if (x.result && cv) {
        j.cand = candFromJson(x.result, cv, { frame: 'seeker', title: `${j.name} — against your CV` });
        j.cand.onChange = () => { renderJds(); onChange(); };
      } else j.dirty = !!j.editor.criteria.length;
    }
    if (cv) renderParse();
    jdPanel.hidden = !cv?.parseConfirmed && !jds.length;
    renderJds();
    const shown = Number.isInteger(s.shown) && s.shown >= 0 ? jds[s.shown]?.cand : jds.find((j) => j.cand)?.cand;
    return shown || null;
  }

  return {
    exportState, restore,
    files: () => (cv?.file ? [cv.file] : []),
    afterShow: () => renderJds()
  };
}
