// Job-description handling in code: find the requirement sections, drop the
// company blurb / duties / benefits / equal-opportunity text, number what's left.

export const TYPES = ['skill', 'years', 'degree', 'domain', 'leadership', 'other'];

const REQ_HEADING_RE = /requirement|essential|desirabl|qualification|you('|’)?ll (have|bring|need)|you (have|bring|will have|need)|what you('|’)?ll bring|what you bring|looking for|about you|who you are|skills|experience|nice[- ]to[- ]haves?|bonus|must[- ]haves?|preferred|person spec|ideal candidate|competenc|criteria|what we need/i;
const DROP_HEADING_RE = /benefit|perk|what we offer|we offer|why (join|work)|equal|diversity|inclusion|salary|compensation|package|how to apply|about (us|the company|the team|the role)|who we are|our (values|culture|mission|story)|responsibilit|what you('|’)?ll do|the role|day[- ]to[- ]day|location|working hours|hours|interview|process/i;
const PREF_HEADING_RE = /desirabl|nice[- ]to[- ]have|bonus|preferred|\bplus\b|advantage|ideally/i;
const ESSENTIAL_HEADING_RE = /essential|required|requirement|must/i;
const DROP_LINE_RE = /equal opportunit|regardless of|we welcome applications|reasonable adjustment|protected characteristic|disabilit|sexual orientation|gender identity|right to work|apply now|click here|cookie/i;
const BULLET_RE = /^\s*(?:[•·▪‣◦●○■□►▸➢✓✔*\-–—−]|\d{1,2}[.)])\s+/;

function isHeadingLine(line, next) {
  const t = line.trim();
  if (/^#{1,6}\s/.test(t)) return true;
  if (BULLET_RE.test(t) || t.length > 70) return false;
  if (t.endsWith(':') && t.split(/\s+/).length <= 8) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4 && letters === letters.toUpperCase() && t.split(/\s+/).length <= 7) return true;
  // a short unpunctuated line followed by a bullet
  return !/[.,;!?]$/.test(t) && t.split(/\s+/).length <= 6 && !!next && BULLET_RE.test(next);
}

const cleanHeading = (t) => t.trim().replace(/^#{1,6}\s+/, '').replace(/[:*_]+$/g, '').replace(/^[*_]+/, '').trim();

// Returns { lines: [{ n, text, heading, hint }], fromSections: bool }
//   hint: 'required' | 'preferred' | null, from the section heading
export function requirementLines(jd) {
  const raw = jd.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const blocks = [];
  let cur = { heading: null, lines: [] };
  raw.forEach((line, i) => {
    if (isHeadingLine(line, raw[i + 1])) {
      blocks.push(cur);
      cur = { heading: cleanHeading(line), lines: [] };
    } else cur.lines.push(line.trim().replace(BULLET_RE, '').trim());
  });
  blocks.push(cur);

  const keep = (h) => h && !DROP_HEADING_RE.test(h) && REQ_HEADING_RE.test(h);
  // A heading that is both ("Skills and experience you'll need") keeps; one that only drops ("Benefits") drops.
  const kept = blocks.filter((b) => b.heading && (keep(b.heading) || (REQ_HEADING_RE.test(b.heading) && /essential|desirabl|requirement|qualification/i.test(b.heading))));
  const fromSections = kept.length > 0;
  const source = fromSections ? kept : blocks;

  const lines = [];
  for (const b of source) {
    const hint = b.heading ? (PREF_HEADING_RE.test(b.heading) ? 'preferred' : ESSENTIAL_HEADING_RE.test(b.heading) ? 'required' : null) : null;
    for (const text of b.lines) {
      if (DROP_LINE_RE.test(text) || text.length < 3) continue;
      lines.push({ n: lines.length + 1, text: text.replace(/\*\*|__/g, ''), heading: b.heading, hint });
    }
  }
  return { lines, fromSections };
}

// Numbered view for the model, with the section headings kept as context.
export function numberedView(lines) {
  const out = [];
  let last;
  for (const l of lines) {
    if (l.heading !== last) { if (l.heading) out.push(`# ${l.heading}`); last = l.heading; }
    out.push(`[${l.n}] ${l.text}`);
  }
  return out.join('\n');
}

// Split into small chunks so each extraction prompt stays short.
export function chunkLines(lines, maxLines = 20, maxChars = 1800) {
  const chunks = [];
  let cur = [], size = 0;
  for (const l of lines) {
    if (cur.length && (cur.length >= maxLines || size + l.text.length > maxChars)) { chunks.push(cur); cur = []; size = 0; }
    cur.push(l); size += l.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// "5+ years", "three years", "3-5 years" (takes the lower bound)
export function yearsNeeded(text) {
  const m = text.toLowerCase().match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?\+?\s*(?:years?|yrs)\b/);
  if (!m) return null;
  return NUM_WORDS[m[1]] ?? +m[1];
}

// Used only when the model can't run: one criterion per requirement line, typed by keywords.
export function heuristicCriteria(lines) {
  return lines.map((l) => ({
    text: l.text.length > 90 ? l.text.slice(0, 87) + '…' : l.text,
    type: guessType(l.text),
    importance: l.hint || 'required'
  }));
}

export function guessType(t) {
  if (yearsNeeded(t) !== null) return 'years';
  if (/degree|bsc|msc|phd|bachelor|master'?s|ba\b|beng|qualification|graduate/i.test(t)) return 'degree';
  if (/\blead|mentor|manag(e|ing) (a )?team|line manage|coach/i.test(t)) return 'leadership';
  if (/industry|sector|domain|knowledge of|background in/i.test(t)) return 'domain';
  return 'skill';
}

// FNV-1a over normalised JD text: the key for confirmed criteria.
export function jdHash(text) {
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
