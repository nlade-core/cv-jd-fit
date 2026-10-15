// The result view, shared by hiring, job hunting and the recorded example.
// A candidate is { cv, criteria, results, timing, frame: 'hiring'|'seeker'|'replay',
// title?, readonly?, onChange?, stopped? }.

import { matchCandidate, effectiveStatus, derivedStatus, computeScore, SCORE_EXPLAINER, STATUS_LABEL, sectionList } from './match.js';
import { renderPdf } from './pdf.js';

const $ = (id) => document.getElementById(id);
const resultPanel = $('result-panel'), resultTitle = $('result-title'), timerEl = $('timer');
const scoreValue = $('score-value'), scoreLabel = $('score-label'), scoreNote = $('score-note'), critResults = $('crit-results');
const listHint = $('list-hint'), docTitle = $('doc-title');
const evidenceView = $('evidence-view'), hlTip = $('hl-tip');

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const secs = (ms) => (ms / 1000).toFixed(1) + ' s';

let shown = null;
let openIdx = -1;
export const shownCandidate = () => shown;

// ---------- running ----------

export async function runCandidate(cand, signal, show) {
  cand.results = cand.criteria.map(() => ({ state: 'pending', evidence: [], override: null }));
  cand.stopped = false;
  if (show) showCandidate(cand, show === 'scroll');
  try {
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
  } catch (e) {
    if (signal?.aborted) {
      cand.stopped = true;
      cand.results.forEach((r) => { if (r.state === 'running' || r.state === 'pending') r.state = 'stopped'; });
      if (shown === cand) { cand.criteria.forEach((c, i) => updateRow(i)); renderTimer(); }
      cand.onChange?.();
    }
    throw e;
  }
}

export function refresh(cand, i) {
  if (shown === cand) { updateRow(i); updateScore(); updateMarks(); renderTimer(); }
  cand.onChange?.(i);
}

// ---------- the view ----------

export function hideResult() {
  shown = null;
  resultPanel.hidden = true;
  clearTimeout(timerTick);
}

export function showCandidate(cand, scroll = false) {
  shown = cand;
  openIdx = -1;
  resultPanel.hidden = false;
  resultPanel.dataset.frame = cand.frame || 'hiring';
  const seeker = cand.frame === 'seeker';
  resultTitle.textContent = cand.title || (cand.cv.kind === 'pdf' ? `Result — ${cand.cv.name}` : 'Result');
  scoreLabel.textContent = seeker ? '/ 100 coverage' : '/ 100';
  docTitle.textContent = seeker ? 'Your CV' : 'The CV';
  listHint.textContent = cand.readonly
    ? 'Open a criterion to see its evidence; click an evidence line to find it on the CV.'
    : 'Open a criterion to see its evidence. While one is open, click a line on the CV to add it as evidence.';
  critResults.innerHTML = '';
  cand.criteria.forEach((c, i) => critResults.append(buildRow(i)));
  cand.criteria.forEach((c, i) => updateRow(i));
  updateScore();
  renderDocument();
  renderTimer();
  if (cand.cv.kind === 'pdf' && !cand.cv.pages && cand.cv.file) {
    renderPdf(cand.cv.file).then((pages) => { cand.cv.pages = pages; if (shown === cand) renderDocument(); cand.onRendered?.(); }).catch(() => {});
  }
  if (scroll) resultPanel.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
}

// Re-draw the document (e.g. once a PDF finishes rendering elsewhere).
export function redrawDocument(cand) { if (shown === cand) renderDocument(); }

let timerTick = null;
function renderTimer() {
  clearTimeout(timerTick);
  const t = shown?.timing;
  if (shown?.timerText) { timerEl.textContent = shown.timerText; return; }
  if (!t) { timerEl.textContent = ''; return; }
  const now = performance.now();
  const n = shown.criteria.length;
  const first = t.tFirst != null ? secs(t.tFirst - t.t0) : '…';
  const total = t.tEnd != null ? secs(t.tEnd - t.t0) : shown.stopped ? 'stopped' : `${secs(now - t.t0)} so far`;
  timerEl.textContent = `${t.restored ? 'When it ran: ' : 'From both inputs ready: '}first result ${first} · all ${n} criteria ${total}`;
  if (t.tEnd == null && !shown.stopped && !t.restored) timerTick = setTimeout(renderTimer, 100);
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

const canEdit = (i) => !shown.readonly && shown.results[i]?.state === 'done' && !shown.results[i].years;
const leafById = (id) => shown.cv.leaves.find((l) => l.id === id);

// Job-hunting wording: factual, no advice.
function seekerLine(c, r) {
  const st = effectiveStatus(r);
  if (r.years) {
    const yrs = (r.years.months / 12).toFixed(1);
    if (st === 'met') return `This JD asks for ${r.years.need} years; your CV shows ${yrs} years of dated experience.`;
    if (st === 'possible') return `This JD asks for ${r.years.need} years; your CV shows ${yrs} years of dated experience.`;
    return `This JD asks for ${r.years.need} years; your CV doesn't show dated roles under Experience.`;
  }
  if (st === 'met') return 'Your CV shows this directly.';
  if (st === 'possible') return `Evidence exists for “${c.text}”, but it's weak or buried: only indirect lines.`;
  return `This JD asks for “${c.text}”; your CV doesn't show it.`;
}

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
  li.classList.toggle('landed', r.state === 'done');

  const body = li.querySelector('.crit-body');
  body.innerHTML = '';
  if (r.state !== 'done') {
    body.append(el('p', 'routed', r.state === 'error' ? 'The model call failed: ' + r.error : 'Not checked yet.'));
    return;
  }
  if (shown.frame === 'seeker') body.append(el('p', 'frame-line ' + effectiveStatus(r), seekerLine(c, r)));

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
    if (!r.evidence.length) ul.append(el('li', 'ev-none', shown.readonly ? 'No supporting line found.' : 'No supporting line found. Click a line on the CV to add one.'));
    r.evidence.forEach((ev, k) => {
      const leaf = leafById(ev.id);
      if (!leaf) return;
      const row = el('li', 'ev-line');
      const go = el('button', 'ev-go');
      go.type = 'button';
      go.append(el('span', 'ev-label', leaf.label), el('span', 'ev-text', leaf.text));
      go.addEventListener('click', () => focusLine(ev.id));
      const tags = el('span', 'ev-tags');
      tags.append(el('span', 'kind-tag ' + ev.kind, ev.kind));
      if (ev.by === 'you') tags.append(el('span', 'kind-tag you', 'added by you'));
      row.append(go, tags);
      if (!shown.readonly) {
        const rm = el('button', 'icon-btn', '✕');
        rm.type = 'button';
        rm.setAttribute('aria-label', `Remove evidence: ${leaf.label}`);
        rm.addEventListener('click', () => { r.evidence.splice(k, 1); edited(i); });
        row.append(rm);
      }
      ul.append(row);
    });
    body.append(ul);

    if (!shown.readonly) {
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
  }

  if (shown.readonly) return;
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
    if (c.kind === 'pdf') evidenceView.append(el('p', 'hint', c.file ? 'Rendering the PDF pages…' : 'The original PDF isn\'t in this project file, so this is the text that was read from it.'));
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

// ---------- candidate JSON (project files) ----------

export function candToJson(cand, cvId) {
  const t = cand.timing || {};
  const ms = (x) => (x != null && t.t0 != null ? Math.round(x - t.t0) : null);
  return {
    cv: cvId,
    criteria: cand.criteria.map(({ text, type, importance }) => ({ text, type, importance })),
    results: cand.results.map((r) => ({ ...r, state: r.state === 'running' || r.state === 'pending' ? 'stopped' : r.state })),
    timing: { firstMs: t.restored ? t.firstMs : ms(t.tFirst), totalMs: t.restored ? t.totalMs : ms(t.tEnd) },
    stopped: !!cand.stopped || cand.results.some((r) => r.state === 'running' || r.state === 'pending'),
    failed: !!cand.failed
  };
}

export function candFromJson(j, cv, extra = {}) {
  const timing = { t0: 0, tFirst: j.timing?.firstMs ?? null, tEnd: j.timing?.totalMs ?? null, firstMs: j.timing?.firstMs ?? null, totalMs: j.timing?.totalMs ?? null, restored: true };
  return {
    cv,
    criteria: (j.criteria || []).map((c) => ({ text: String(c.text || ''), type: c.type, importance: c.importance })),
    results: (j.results || []).map((r) => ({ evidence: [], override: null, ...r })),
    timing, stopped: !!j.stopped, failed: !!j.failed, ...extra
  };
}
