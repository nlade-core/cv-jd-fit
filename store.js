// GH Pages serves every nlade-core project from the same origin
// (nlade-core.github.io), so localStorage is shared across all of them --
// unprefixed keys here can collide with another repo's. Always namespace.
const PREFIX = 'cvjdfit.';

export function readStorage(key) {
  try { return localStorage.getItem(PREFIX + key); } catch { return null; }
}
export function writeStorage(key, value) {
  try { localStorage.setItem(PREFIX + key, value); } catch { /* storage disabled/full: the page still works for this session */ }
}
export function readJson(key) {
  try { return JSON.parse(readStorage(key)); } catch { return null; }
}
