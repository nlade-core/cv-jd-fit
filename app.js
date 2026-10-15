// Boot: network counter, model status, the start page, the two modes, the
// recorded example, and project files.

import { initModel, onModelState, startCreate, model } from './model.js';
import { initHiring } from './hiring.js';
import { initSeeker } from './seeker.js';
import { startReplay, leaveReplay } from './replay.js';
import { showCandidate, hideResult, shownCandidate } from './result.js';
import { buildProject, parseProject, cvResolver, download, kb } from './project.js';
import { readStorage, writeStorage } from './store.js';

const $ = (id) => document.getElementById(id);
const statusPill = $('status-pill'), modelNote = $('model-note');
const explainer = $('explainer'), explainerTitle = $('explainer-title'), dlText = $('dl-text'), dlProgress = $('dl-progress'), dlActivate = $('dl-activate');

// ---------- network counter: anything not from this site's own origin ----------

const net = { requests: 0, bytes: 0, urls: [] };
function renderNet() {
  $('net-text').textContent = net.requests
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

// ---------- model: checked and sessions created on load, in the background ----------

const DOWNLOADING = ['downloadable', 'downloading', 'needs-activation'];
let firstAvailability = null;
onModelState((m) => {
  if (m.state !== 'checking' && !firstAvailability) firstAvailability = m.state === 'loading' ? 'available' : m.state;
  const labels = {
    checking: 'checking model…', loading: 'loading model…', downloadable: 'model needs download',
    downloading: `downloading model ${Math.round(m.progress * 100)}%`, 'needs-activation': 'model needs download — click to start',
    ready: 'model ready', unavailable: 'model unavailable on this device', missing: 'not supported in this browser', error: 'model error'
  };
  const cls = { ready: 'available', downloadable: 'downloadable', downloading: 'downloadable', 'needs-activation': 'downloadable', unavailable: 'unavailable', missing: 'missing', error: 'unavailable' };
  statusPill.className = 'status-pill ' + (cls[m.state] || '');
  statusPill.textContent = labels[m.state] || m.state;
  const dl = DOWNLOADING.includes(m.state);
  document.body.classList.toggle('model-downloading', dl);
  explainerTitle.textContent = dl ? 'Getting the on-device model ready' : 'How it works';
  dlProgress.hidden = !dl;
  dlProgress.value = m.progress || 0;
  dlActivate.hidden = m.state !== 'needs-activation';
  dlText.textContent = !dl ? '' : m.state === 'downloading' ? `Downloading… ${Math.round(m.progress * 100)}%` : m.state === 'needs-activation' ? 'Waiting for a click' : 'Starting download…';
  modelNote.textContent = m.state === 'missing' ? 'This browser doesn\'t have the on-device model: open the page in a recent desktop Chrome with it enabled. The recorded example still works.'
    : m.state === 'unavailable' ? 'The on-device model isn\'t available on this device. The recorded example still works.'
      : m.state === 'error' ? 'Model error: ' + m.error : '';
});
initModel();
const modelInfo = () => ({ state: model.state, availabilityAtLoad: firstAvailability, api: self.LanguageModel ? 'LanguageModel' : null });

// ---------- modes ----------

const MODES = ['splash', 'hiring', 'seeker', 'replay'];
const MODE_KEY = 'mode';
const TAGLINES = {
  splash: 'Check a CV against a job description, requirement by requirement, entirely in your browser.',
  hiring: 'Paste a job description, add a CV (or a folder of them), and see the evidence for each requirement.',
  seeker: 'Add your CV and one or more job descriptions, and see which requirements your CV shows.',
  replay: 'A recorded example: a stored result, replayed.'
};
let mode = 'splash';
const lastShown = { hiring: null, seeker: null, replay: null };
const setLastShown = (m) => (cand) => { lastShown[m] = cand; };

function setMode(m, { remember = true } = {}) {
  if (!MODES.includes(m)) m = 'splash';
  if (mode === 'replay' && m !== 'replay') leaveReplay();
  mode = m;
  document.body.dataset.mode = m;
  if (remember && (m === 'hiring' || m === 'seeker')) writeStorage(MODE_KEY, m);
  $('tagline').textContent = TAGLINES[m];
  const sw = $('switch-mode');
  sw.hidden = m === 'splash';
  sw.textContent = m === 'hiring' ? 'Switch to: I\'m job hunting' : m === 'seeker' ? 'Switch to: I\'m hiring' : 'Back to the start page';
  $('mode-label').textContent = { hiring: 'Mode: hiring', seeker: 'Mode: job hunting', replay: 'Recorded example', splash: '' }[m];
  $('export-pdfs').checked = m === 'hiring';
  const cand = lastShown[m];
  if (m === 'hiring' || m === 'seeker') { if (cand) { showCandidate(cand); flows[m].afterShow?.(); } else hideResult(); }
  else if (m === 'splash') hideResult();
  updateSize();
}

function choose(m) {
  // A click is the user gesture a first model download needs, so start it here.
  if (['downloadable', 'needs-activation'].includes(model.state)) startCreate();
  setMode(m);
  scrollTo({ top: 0 });
}
document.querySelectorAll('[data-choose]').forEach((b) => b.addEventListener('click', () => choose(b.dataset.choose)));
$('go-home').addEventListener('click', () => setMode('splash', { remember: false }));
$('switch-mode').addEventListener('click', () => {
  if (mode === 'hiring') choose('seeker');
  else if (mode === 'seeker') choose('hiring');
  else setMode('splash', { remember: false });
});
$('see-example').addEventListener('click', () => { setMode('replay', { remember: false }); startReplay(setLastShown('replay')); });
$('replay-again').addEventListener('click', () => startReplay(setLastShown('replay')));

// ---------- the flows ----------

let sizeTimer;
const touch = () => { clearTimeout(sizeTimer); sizeTimer = setTimeout(updateSize, 400); };
const flows = {
  hiring: initHiring({ onChange: touch, setLastShown: setLastShown('hiring') }),
  seeker: initSeeker({ onChange: touch, setLastShown: setLastShown('seeker') })
};

// ---------- project files ----------

const createdAt = {}; // per mode, kept from an opened project
const exportPdfs = $('export-pdfs'), exportSize = $('export-size'), projectMsg = $('project-msg');

async function updateSize() {
  if (mode !== 'hiring' && mode !== 'seeker') return;
  const flow = flows[mode];
  try {
    const p = await buildProject({ mode, flow, model: modelInfo(), includePdfs: false });
    const base = JSON.stringify(p, null, 1).length;
    const files = [...new Set(flow.files())];
    const pdfBytes = files.reduce((s, f) => s + Math.ceil(f.size / 3) * 4, 0);
    exportSize.textContent = files.length
      ? (exportPdfs.checked ? `File about ${kb(base + pdfBytes)}, with ${files.length} PDF${files.length === 1 ? '' : 's'} (${kb(pdfBytes)}).` : `File about ${kb(base)}; the PDFs would add ${kb(pdfBytes)}.`)
      : `File about ${kb(base)}. No PDFs to include.`;
  } catch (e) { exportSize.textContent = ''; }
}
exportPdfs.addEventListener('change', updateSize);

$('export-btn').addEventListener('click', async () => {
  try {
    const p = await buildProject({ mode, flow: flows[mode], model: modelInfo(), includePdfs: exportPdfs.checked, createdAt: createdAt[mode] });
    const { name, size } = download(p);
    projectMsg.textContent = `Saved ${name} (${kb(size)}) to your downloads. It contains personal data; it stays wherever you keep it.`;
  } catch (e) {
    projectMsg.textContent = 'Could not save the project: ' + e.message;
  }
});

async function importFile(file, msgEl) {
  if (!file) return;
  let p;
  try {
    p = parseProject(await file.text());
  } catch (e) {
    msgEl.textContent = e.message;
    return false;
  }
  try {
    const getCv = cvResolver(p);
    const cand = flows[p.mode].restore(p[p.mode], getCv);
    createdAt[p.mode] = p.createdAt;
    lastShown[p.mode] = cand;
    setMode(p.mode);
    const msg = `Opened ${file.name}, saved ${new Date(p.exportedAt).toLocaleString()}${p.pdfsIncluded ? '' : ' (no PDFs inside, so CVs show as text)'}.`;
    projectMsg.textContent = msg;
    msgEl.textContent = msgEl === projectMsg ? msg : '';
    return true;
  } catch (e) {
    msgEl.textContent = 'That project file is damaged and couldn\'t be opened: ' + e.message;
    return false;
  }
}
$('import-file').addEventListener('change', async (e) => { await importFile(e.target.files[0], projectMsg); e.target.value = ''; });
$('splash-import').addEventListener('change', async (e) => { await importFile(e.target.files[0], $('splash-msg')); e.target.value = ''; });

// for headless checks
window.cvjdfit = {
  get mode() { return mode; },
  shown: shownCandidate,
  build: (includePdfs) => buildProject({ mode, flow: flows[mode], model: modelInfo(), includePdfs, createdAt: createdAt[mode] })
};

// ---------- start ----------

setMode(readStorage(MODE_KEY) || 'splash', { remember: false });
