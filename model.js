// The on-device model (Prompt API). Two short base sessions are created as soon
// as the page loads -- one for evidence, one for JD criteria -- and every call
// runs on a clone(), so each prompt starts from the short instructions only.
// Calls are queued and run one at a time.

import { TYPES } from './jd.js';

const LANG = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
};

const EVIDENCE_SYSTEM = `You find evidence in a CV for one job criterion.
CV lines are numbered like [12]; lines starting with # are section and role headers.
Return the IDs of every line that plausibly supports the criterion, each tagged:
- "direct": the line states it (the same skill, tool, degree or experience)
- "indirect": the line only suggests it (a related tool, similar work, a transferable skill)
Include every plausibly supporting line, not just the best one. Do not judge overall fit.
Return an empty list only if no line is related at all. Respond only with JSON.`;

const EXTRACT_SYSTEM = `You turn job-ad requirement lines into short criteria for screening CVs.
Lines are numbered like [3]; lines starting with # are the ad's section headings.
For each real requirement write a short criterion (at most 10 words) and tag:
- type: "skill" (a tool, language or technique), "years" (a minimum number of years of experience; keep the number in the text), "degree" (a degree or formal qualification), "domain" (industry or subject knowledge), "leadership" (leading, managing or mentoring people), or "other"
- importance: "preferred" if the line or its heading says desirable, nice to have, bonus, preferred or a plus; otherwise "required"
- line: the number of the line it came from
A line that lists several separate skills becomes several criteria. Skip lines that are not requirements. Respond only with JSON.`;

const EVIDENCE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['evidence'],
  properties: {
    evidence: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'kind'],
        properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['direct', 'indirect'] } }
      }
    }
  }
};
const EVIDENCE_HINT = '\n\nRespond with only this JSON shape: {"evidence":[{"id":"12","kind":"direct"},{"id":"4.2","kind":"indirect"}]}';

const CRITERIA_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'type', 'importance', 'line'],
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: TYPES },
          importance: { type: 'string', enum: ['required', 'preferred'] },
          line: { type: 'integer' }
        }
      }
    }
  }
};
const CRITERIA_HINT = '\n\nRespond with only this JSON shape: {"criteria":[{"text":"Python","type":"skill","importance":"required","line":3}]}';

// ---------- state ----------

const listeners = new Set();
export const model = { state: 'checking', progress: 0, error: null };
function set(patch) { Object.assign(model, patch); for (const fn of listeners) fn(model); }
export function onModelState(fn) { listeners.add(fn); fn(model); }

let bases = null;          // { evidence, extract } once created
let creating = null;
let readyResolve;
const readyPromise = new Promise((r) => (readyResolve = r));
export const whenReady = () => readyPromise;

export async function initModel() {
  if (!self.LanguageModel) { set({ state: 'missing' }); return; }
  let availability;
  try {
    availability = await LanguageModel.availability(LANG);
  } catch (e) {
    set({ state: 'error', error: e.message }); return;
  }
  if (availability === 'unavailable') { set({ state: 'unavailable' }); return; }
  set({ state: availability === 'available' ? 'loading' : availability }); // 'downloadable' | 'downloading'
  startCreate();
}

export function startCreate() {
  if (bases || creating) return creating;
  creating = (async () => {
    const monitor = (m) => m.addEventListener('downloadprogress', (e) => {
      if (model.state !== 'ready') set({ state: 'downloading', progress: e.loaded });
    });
    const evidence = await LanguageModel.create({ ...LANG, monitor, initialPrompts: [{ role: 'system', content: EVIDENCE_SYSTEM }] });
    const extract = await LanguageModel.create({ ...LANG, initialPrompts: [{ role: 'system', content: EXTRACT_SYSTEM }] });
    bases = { evidence, extract };
    set({ state: 'ready', progress: 1 });
    readyResolve(bases);
    return bases;
  })();
  creating.catch((e) => {
    creating = null;
    if (e?.name === 'NotAllowedError') {
      // A first download needs a click or key press on the page; retry on the first one.
      set({ state: 'needs-activation' });
      const retry = () => { removeEventListener('pointerdown', retry, true); removeEventListener('keydown', retry, true); set({ state: 'downloadable' }); startCreate(); };
      addEventListener('pointerdown', retry, true);
      addEventListener('keydown', retry, true);
    } else set({ state: 'error', error: e?.message || String(e) });
  });
  return creating;
}

// ---------- calls ----------

let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function fork(base, system, signal) {
  if (typeof base.clone === 'function') return base.clone({ signal });
  return LanguageModel.create({ ...LANG, signal, initialPrompts: [{ role: 'system', content: system }] });
}

// responseConstraint when supported; a plain prompt with the shape spelled out otherwise.
let constraintSupported = true;
async function promptJson(session, text, schema, hint, signal) {
  if (constraintSupported) {
    try {
      return await session.prompt(text, { responseConstraint: schema, signal });
    } catch (e) {
      if (!(e instanceof TypeError) && e?.name !== 'NotSupportedError') throw e;
      constraintSupported = false;
    }
  }
  return session.prompt(text + hint, { signal });
}

export function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Model response was not valid JSON.');
  }
}

async function call(kind, system, text, schema, hint, signal) {
  const b = await whenReady();
  return enqueue(async () => {
    signal?.throwIfAborted();
    const session = await fork(b[kind], system, signal);
    try {
      return extractJson(await promptJson(session, text, schema, hint, signal));
    } finally {
      session.destroy();
    }
  });
}

// Input tokens for a piece of text: the model's own count when the session offers
// one (measureInputUsage; countPromptTokens on older builds), else ~4 characters a token.
export async function measureTokens(text) {
  const est = { tokens: Math.ceil(text.length / 4), measured: false };
  const s = bases?.evidence;
  const fn = s && (s.measureInputUsage || s.countPromptTokens);
  if (!fn) return est;
  try {
    const n = await enqueue(() => fn.call(s, text));
    return Number.isFinite(n) ? { tokens: n, measured: true } : est;
  } catch { return est; }
}

// -> [{ id, kind }]
export async function findEvidence(criterionText, cvView, signal) {
  const data = await call('evidence', EVIDENCE_SYSTEM, `Criterion: ${criterionText}\n\nCV lines:\n${cvView}`, EVIDENCE_SCHEMA, EVIDENCE_HINT, signal);
  return Array.isArray(data.evidence) ? data.evidence : [];
}

// -> [{ text, type, importance, line }]
export async function extractCriteria(numbered, signal) {
  const data = await call('extract', EXTRACT_SYSTEM, `Requirement lines:\n${numbered}`, CRITERIA_SCHEMA, CRITERIA_HINT, signal);
  return Array.isArray(data.criteria) ? data.criteria : [];
}
