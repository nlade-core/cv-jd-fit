// Project file: one versioned JSON file with everything on the page, saved by a
// download and opened again with a file picker. Nothing is uploaded anywhere.
//
// { format: 'cv-jd-fit', version: 1, mode: 'hiring'|'seeker', createdAt, exportedAt,
//   app: { page }, model: { state, availability, ... },
//   cvs: [cv JSON], files: { id: { name, type, size, base64 } } | {},
//   hiring?: {...}, seeker?: {...} }

import { cvToJson, cvFromJson } from './cv.js';

export const FORMAT = 'cv-jd-fit';
export const VERSION = 1;

function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fileFromB64(f) {
  const bin = atob(f.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], f.name || 'cv.pdf', { type: f.type || 'application/pdf' });
}

// flow: the hiring or seeker module (exportState). includePdfs: embed the PDFs.
export async function buildProject({ mode, flow, model, includePdfs, createdAt }) {
  const cvs = [], cvIds = new Map();
  const files = {}, fileIds = new Map();
  const fileId = (file) => {
    if (!file) return null;
    if (!fileIds.has(file)) fileIds.set(file, 'f' + (fileIds.size + 1));
    return fileIds.get(file);
  };
  const addCv = (cv) => {
    if (!cvIds.has(cv)) { cvIds.set(cv, cvs.length); cvs.push(cvToJson(cv, includePdfs ? fileId(cv.file) : null)); }
    return cvIds.get(cv);
  };
  const state = flow.exportState({ addCv });
  if (includePdfs) {
    for (const [file, id] of fileIds) files[id] = { name: file.name, type: file.type || 'application/pdf', size: file.size, base64: b64FromBuffer(await file.arrayBuffer()) };
  }
  const now = new Date().toISOString();
  return {
    format: FORMAT, version: VERSION, mode,
    createdAt: createdAt || now, exportedAt: now,
    app: { page: location.origin + location.pathname },
    model: { ...model },
    pdfsIncluded: !!includePdfs,
    cvs, files,
    [mode]: state
  };
}

// Throws an Error with a message meant for the user.
export function parseProject(text) {
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('That file isn\'t a project file (it isn\'t valid JSON).'); }
  if (!p || typeof p !== 'object' || p.format !== FORMAT) throw new Error('That file isn\'t a cv-jd-fit project file.');
  if (!Number.isInteger(p.version) || p.version < 1) throw new Error(`Unknown project file version (${JSON.stringify(p.version)}). This page reads version ${VERSION}.`);
  if (p.version > VERSION) throw new Error(`This project file is version ${p.version}, saved by a newer cv-jd-fit. This page reads version ${VERSION} only, so it wasn't opened.`);
  if (p.mode !== 'hiring' && p.mode !== 'seeker') throw new Error('The project file has no valid mode (hiring or job hunting).');
  if (!Array.isArray(p.cvs) || !p[p.mode]) throw new Error('The project file is incomplete.');
  return p;
}

// -> getCv(index) that rebuilds each CV once (with its PDF if it was embedded).
export function cvResolver(p) {
  const cache = new Map();
  return (i) => {
    if (!cache.has(i)) {
      const j = p.cvs[i];
      if (!j) throw new Error('The project file refers to a CV that isn\'t in it.');
      const f = j.file && p.files?.[j.file] ? fileFromB64(p.files[j.file]) : null;
      cache.set(i, cvFromJson(j, f));
    }
    return cache.get(i);
  };
}

export function download(project) {
  const blob = new Blob([JSON.stringify(project, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName(project);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return { name: a.download, size: blob.size };
}

function fileName(p) {
  const d = new Date(p.exportedAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `cv-jd-fit-${p.mode === 'hiring' ? 'hiring' : 'job-hunting'}-${stamp}.json`;
}

export const kb = (n) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
