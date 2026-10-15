// JD -> criteria (requirement lines picked in code, criteria written by the model,
// one per line as a fallback), and the editor where they are checked and confirmed.

import { requirementLines, numberedView, chunkLines, heuristicCriteria, yearsNeeded, TYPES } from './jd.js';
import { extractCriteria, model } from './model.js';

export const modelUsable = () => !['missing', 'unavailable', 'error'].includes(model.state);

let nextId = 1;
export const newCrit = (c) => ({ id: nextId++, text: c.text || '', type: TYPES.includes(c.type) ? c.type : 'skill', importance: c.importance === 'preferred' ? 'preferred' : 'required' });
export const plainCrit = ({ text, type, importance }) => ({ text, type, importance });

// -> { criteria: [crit], source, warning? }. Throws AbortError if aborted.
export async function extractJd(text, signal) {
  const { lines, fromSections } = requirementLines(text);
  const source = fromSections
    ? `Read ${lines.length} lines from the requirement sections (company blurb, duties, benefits and equal-opportunity text left out).`
    : `No requirement headings found, so all ${lines.length} lines of the job description were read.`;
  let list = [], warning = null;
  if (modelUsable()) {
    try {
      for (const chunk of chunkLines(lines)) {
        const out = await extractCriteria(numberedView(chunk), signal);
        for (const c of out) {
          const src = lines.find((l) => l.n === Number(c.line));
          // The section heading wins over the model's tag when it's explicit ("Desirable", "Essential").
          list.push({ ...c, importance: src?.hint || c.importance });
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      warning = 'The model could not extract criteria (' + e.message + '); showing one per requirement line instead.';
      list = [];
    }
  }
  signal?.throwIfAborted();
  if (!list.length) list = heuristicCriteria(lines);
  const seen = new Set();
  const criteria = list.map(newCrit).filter((c) => {
    const k = c.text.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
  return { criteria, source, warning };
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// Builds the editor inside `box`. States: empty | extracting | draft | confirmed.
export function criteriaEditor(box, { onState, onConfirm, confirmText = 'Confirm criteria', ids = {} } = {}) {
  box.classList.add('criteria-box');
  box.innerHTML = '';
  const h = el('h3', null, 'Criteria ');
  const stateEl = el('span', 'crit-state');
  h.append(stateEl);
  const sourceEl = el('p', 'hint crit-source');
  const list = el('ul', 'criteria-list');
  const actions = el('div', 'criteria-actions');
  const addBtn = el('button', 'link-btn crit-add', '+ Add criterion');
  addBtn.type = 'button';
  const confirmBtn = el('button', 'primary-btn crit-confirm', confirmText);
  confirmBtn.type = 'button';
  actions.append(addBtn, confirmBtn);
  box.append(h, sourceEl, list, actions);
  if (ids.state) stateEl.id = ids.state;
  if (ids.source) sourceEl.id = ids.source;
  if (ids.list) list.id = ids.list;
  if (ids.add) addBtn.id = ids.add;
  if (ids.confirm) confirmBtn.id = ids.confirm;

  const ed = { state: 'empty', criteria: [] };

  function setState(s, render = true) {
    ed.state = s;
    box.hidden = s === 'empty';
    stateEl.textContent = { extracting: 'reading the job description…', draft: 'check, then confirm', confirmed: 'confirmed' }[s] || '';
    stateEl.className = 'crit-state ' + s;
    confirmBtn.textContent = s === 'confirmed' ? 'Confirmed ✓' : confirmText;
    confirmBtn.disabled = s === 'extracting' || s === 'confirmed' || !ed.criteria.length;
    addBtn.disabled = s === 'extracting';
    if (render) renderList();
    onState?.(s);
  }

  function renderList() {
    list.innerHTML = '';
    if (ed.state === 'extracting') {
      list.append(el('li', 'crit-placeholder', model.state === 'ready' ? 'Extracting criteria…' : 'Waiting for the model, then extracting criteria…'));
      return;
    }
    ed.criteria.forEach((c) => {
      const li = el('li', 'crit-edit');
      const text = el('input');
      text.type = 'text'; text.value = c.text; text.setAttribute('aria-label', 'Criterion');
      text.addEventListener('input', () => { c.text = text.value; setState('draft', false); });
      const type = el('select');
      type.setAttribute('aria-label', 'Type');
      for (const t of TYPES) type.append(new Option(t, t, false, t === c.type));
      type.addEventListener('change', () => { c.type = type.value; setState('draft'); list.querySelectorAll('select[aria-label="Type"]')[ed.criteria.indexOf(c)]?.focus(); });
      const imp = el('select');
      imp.setAttribute('aria-label', 'Importance');
      for (const t of ['required', 'preferred']) imp.append(new Option(t, t, false, t === c.importance));
      imp.addEventListener('change', () => { c.importance = imp.value; setState('draft', false); });
      const del = el('button', 'icon-btn', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', `Delete criterion: ${c.text}`);
      del.addEventListener('click', () => { ed.criteria = ed.criteria.filter((x) => x !== c); setState('draft'); });
      li.append(text, type, imp, del);
      if (c.type === 'years' && yearsNeeded(c.text) === null) li.append(el('span', 'crit-warn', 'No number of years in the text — it will be checked as text.'));
      list.append(li);
    });
  }

  addBtn.addEventListener('click', () => {
    ed.criteria.push(newCrit({ text: '', type: 'skill', importance: 'required' }));
    setState('draft');
    list.querySelector('li:last-child input')?.focus();
  });
  confirmBtn.addEventListener('click', () => {
    ed.criteria = ed.criteria.filter((c) => c.text.trim());
    if (!ed.criteria.length) return;
    setState('confirmed');
    onConfirm?.(ed.criteria);
  });

  Object.assign(ed, {
    setSource(t) { sourceEl.textContent = t || ''; },
    clear() { ed.criteria = []; setState('empty'); },
    extracting() { ed.criteria = []; setState('extracting'); },
    set(criteria, state) { ed.criteria = criteria.map((c) => newCrit(c)); setState(state); },
    setState
  });
  setState('empty');
  return ed;
}
