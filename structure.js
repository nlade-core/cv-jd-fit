// Adds structure to segment.js output, all in code:
//   section  experience / skills / education / profile / certifications / other (from headings)
//   role     { title, short, dates: [start, end] } for experience lines under a dated role
//   label    "Experience › Performance Data Scientist (2022–present) › bullet 3"
// and builds the compact numbered view the model sees, the years-of-experience
// computation, and parse warnings.

export const SECTIONS = ['profile', 'experience', 'skills', 'education', 'certifications', 'other'];
export const SECTION_NAMES = {
  profile: 'Profile', experience: 'Experience', skills: 'Skills',
  education: 'Education', certifications: 'Certifications', other: 'Other'
};

// Order matters: the first match wins.
const SECTION_RES = [
  ['certifications', /certif|licen[cs]e|accreditation|training|courses?\b/i],
  ['education', /educat|qualification|academic|degree|universit/i],
  ['skills', /skill|technolog|tool|stack|competenc|expertise|proficienc|languages?\b|keywords?/i],
  ['experience', /experience|employment|work history|career|positions?|professional background|work\b/i],
  ['profile', /profile|summary|about me|objective|personal statement|introduction/i],
  ['other', /interest|hobb|reference|volunteer|publication|award|achievement|projects?\b|contact|personal|activities|talks|presentations|other/i]
];

// Plain lines only become headings when they are clearly just a section name.
const PLAIN_HEADING_RE = /^(?:(?:professional|work|relevant|career|technical|key|core|personal|selected|employment)\s+)?(?:experience|employment(?: history)?|work history|career history|history|skills(?:\s+(?:and|&)\s+\w+)?|education|qualifications|profile|summary|about(?: me)?|certifications?|training|courses|interests|hobbies|references|volunteering|publications|projects|awards|achievements|languages|toolkit)\s*:?$/i;

function sectionOf(text) {
  const t = text.trim().replace(/:$/, '');
  if (t.length > 45 || t.split(/\s+/).length > 5) return null;
  if (/[—–,]|\s-\s|\bat\b|\d{4}/.test(t)) return null; // "Analyst — Harbour Bank": a role, not a section
  for (const [name, re] of SECTION_RES) if (re.test(t)) return name;
  return null;
}

// ---------- dates ----------

const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DATE = `(?:${MON}\\s+(?:19|20)\\d{2}|(?:19|20)\\d{2}-(?:0[1-9]|1[0-2])|(?:0?[1-9]|1[0-2])\\/(?:19|20)\\d{2}|(?:19|20)\\d{2})`;
const END = `(?:${DATE}|present|current|now|today|to date|ongoing)`;
// Separator: a dash, arrow, "to", a table bar, or (table cells) just whitespace.
const RANGE_RE = new RegExp(`(${DATE})(?:\\s*(?:–|—|-|−|→|to|until|\\|)\\s*|\\s+)(${END})`, 'i');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "Aug 2022" -> "2022-08", "2019" -> "2019", "present" -> "present"
function normDate(s) {
  s = s.trim().toLowerCase();
  if (/present|current|now|today|date|ongoing/.test(s)) return 'present';
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) return `${m[1]}-${m[2]}`;
  if ((m = s.match(/^(\d{1,2})\/(\d{4})$/))) return `${m[2]}-${m[1].padStart(2, '0')}`;
  if ((m = s.match(/^([a-z]+)\.?\s+(\d{4})$/))) return `${m[2]}-${String(MONTHS.indexOf(m[1].slice(0, 3)) + 1).padStart(2, '0')}`;
  return s.match(/\d{4}/)[0];
}

export function findDateRange(text) {
  const m = text.match(RANGE_RE);
  if (!m) return null;
  const start = normDate(m[1]), end = normDate(m[2]);
  if (end !== 'present' && end.slice(0, 4) < start.slice(0, 4)) return null;
  return { start, end, index: m.index, length: m[0].length };
}

const yearOf = (d) => (d === 'present' ? 'present' : d.slice(0, 4));
export const dateSpan = ([s, e]) => (yearOf(s) === yearOf(e) ? yearOf(s) : `${yearOf(s)}–${yearOf(e)}`);

// Month index (year*12 + month0). A bare year starts in January and ends in
// December, so "2019–2022" counts as 48 months.
function monthIndex(d, isEnd, now) {
  if (d === 'present') return now.getFullYear() * 12 + now.getMonth();
  const y = +d.slice(0, 4);
  const m = d.length > 4 ? +d.slice(5, 7) - 1 : (isEnd ? 11 : 0);
  return y * 12 + m;
}

// ---------- structure ----------

const cleanTitle = (s) => s.replace(/\(\s*\)/g, '').replace(/^[\s,|—–\-()*:]+|[\s,|—–\-(*:]+$/g, '').replace(/\s+/g, ' ').trim();
const shortTitle = (t) => t.split(/\s+[—–-]\s+|,\s+|\s+\|\s+|\s+at\s+|\s*\(/)[0].trim() || t;

export function structureCv(segs) {
  let section = 'profile'; // anything before the first heading (name, contact, opening summary)
  let role = null, pendingTitle = null;
  const roles = [];
  const counts = new Map(); // label counters per role / section

  for (const s of segs) {
    // A short plain line that is just a section name ("Experience") counts as a heading.
    if (s.kind === 'seg' && !s.bullet && !s.children && PLAIN_HEADING_RE.test(s.text.trim())) {
      s.kind = 'heading';
    }
    if (s.kind === 'heading') {
      const sec = sectionOf(s.text);
      if (sec) {
        section = sec; role = null; pendingTitle = null;
        s.section = sec;
        continue;
      }
      s.section = section;
      s.sub = true; // a sub-heading inside a section, e.g. "Senior Data Scientist — Meridian Health"
      if (section === 'experience') {
        const r = findDateRange(s.text);
        if (r && r.index > 2) {
          role = newRole(cleanTitle(s.text.slice(0, r.index)), r, null);
          roles.push(role);
          pendingTitle = null;
        } else {
          const known = findRole(roles, s.text);
          if (known) { role = known; pendingTitle = null; } else pendingTitle = { title: cleanTitle(s.text), seg: null };
        }
      }
      continue;
    }

    s.section = section;
    if (section === 'experience' && !s.bullet) {
      const r = findDateRange(s.text);
      if (r) {
        const before = cleanTitle(s.text.slice(0, r.index));
        const title = before.length >= 3 ? before : pendingTitle?.title;
        if (title) {
          role = newRole(title, r, s.id);
          roles.push(role);
          if (before.length < 3 && pendingTitle?.seg) { pendingTitle.seg.role = role; pendingTitle.seg.roleLine = true; role.headerIds.unshift(pendingTitle.seg.id); }
          s.roleLine = true;
          pendingTitle = null;
        }
      } else if (findRole(roles, s.text)) {
        role = findRole(roles, s.text); // the role named again above its detail, e.g. after a summary table
        if (s.text.length <= 90 && !/^\S+(?:\s+\S+)*\s+[-–—:|]\s+\S.{25,}/.test(s.text)) s.roleLine = true;
        pendingTitle = null;
      } else if (s.text.length <= 90) {
        pendingTitle = { title: cleanTitle(s.text), seg: s };
      }
    } else if (s.bullet) pendingTitle = null;

    if (section === 'experience' && role) s.role = role;
  }

  // labels and flat fields, now that roles are known
  for (const s of segs) {
    if (s.kind !== 'seg') continue;
    const sec = SECTION_NAMES[s.section];
    let where;
    if (s.role) {
      const head = `${sec} › ${s.role.short} (${dateSpan(s.role.dates)})`;
      if (s.roleLine) where = `${head} › role line`;
      else {
        const n = (counts.get(s.role) || 0) + 1;
        counts.set(s.role, n);
        where = `${head} › ${s.bullet ? 'bullet' : 'line'} ${n}`;
      }
    } else {
      const n = (counts.get(s.section) || 0) + 1;
      counts.set(s.section, n);
      where = `${sec} › line ${n}`;
    }
    s.label = where;
    s.dates = s.role ? s.role.dates : null;
    if (s.children) {
      s.children.forEach((c, k) => {
        Object.assign(c, { kind: 'seg', section: s.section, role: s.role || null, dates: s.dates, page: s.page, parentId: s.id, label: `${where} › item ${k + 1}` });
      });
    }
  }
  return { segs, roles };
}

const NOT_WORK_RE = /career break|sabbatical|parental leave|maternity|paternity|caring responsibilit|travell?ing/i;

function newRole(title, r, segId) {
  return { title, short: shortTitle(title), dates: [r.start, r.end], headerIds: segId ? [segId] : [], counted: !NOT_WORK_RE.test(title) };
}

// A known role named again: by its title, by its company alone ("Lumen Retail Group"),
// or as "Senior BI Analyst - first bullet…" when a heading ran into its first line.
function findRole(roles, text) {
  const t = cleanTitle(text).toLowerCase();
  if (!t) return null;
  return roles.find((r) => {
    const title = r.title.toLowerCase(), short = r.short.toLowerCase();
    if (t === title || t === short) return true;
    if (t.length >= 6 && t.length <= 60 && title.includes(t)) return true;
    return t.startsWith(short) && /^\s*[-–—:|]\s+\S/.test(t.slice(short.length));
  }) || null;
}

// Flat leaf list in document order: the units the model cites and the UI highlights.
// Each is { id, section, role, dates, page, boxes, text, label }.
export function leavesOf(segs) {
  const out = [];
  for (const s of segs) {
    if (s.kind !== 'seg') continue;
    if (s.children) out.push(...s.children);
    else out.push(s);
  }
  return out;
}

// JSON-friendly copy of the leaves (role reduced to its title) -- what "structured segments" means.
export function segmentsJson(segs) {
  return leavesOf(segs).map((l) => ({
    id: l.id, section: l.section, role: l.role ? l.role.title : null, dates: l.dates,
    page: l.page ?? null, boxes: l.boxes ?? null, text: l.text, label: l.label
  }));
}

// The compact text the model sees for a set of sections: section and role header
// lines, then "[id] text" lines. Never the JSON.
export function compactView(segs, sections) {
  const want = new Set(sections);
  const out = [];
  let lastSec = null, lastRole = null;
  for (const s of segs) {
    if (s.kind !== 'seg' || !want.has(s.section)) continue;
    if (s.section !== lastSec) { out.push(`## ${SECTION_NAMES[s.section]}`); lastSec = s.section; lastRole = null; }
    if (s.role && s.role !== lastRole) { out.push(`### ${s.role.title} (${dateSpan(s.role.dates)})`); lastRole = s.role; }
    if (s.children) out.push(s.children.map((c) => `[${c.id}] ${c.text}`).join('; '));
    else out.push(`[${s.id}] ${s.text}`);
  }
  return out.join('\n');
}

// Years of experience: every dated role in the Experience section counts
// (except career breaks and similar, which are listed as not counted), and
// overlapping ranges are merged so concurrent jobs aren't double-counted.
export function computeYears(roles, now = new Date()) {
  const spans = roles.map((r) => {
    const a = monthIndex(r.dates[0], false, now), b = monthIndex(r.dates[1], true, now);
    return { role: r, a, b: Math.max(a, b), months: Math.max(0, b - a + 1), counted: r.counted };
  });
  const sorted = spans.filter((s) => s.counted).sort((p, q) => p.a - q.a);
  let total = 0, cur = null;
  for (const s of sorted) {
    if (!cur || s.a > cur.b + 1) { if (cur) total += cur.b - cur.a + 1; cur = { a: s.a, b: s.b }; }
    else cur.b = Math.max(cur.b, s.b);
  }
  if (cur) total += cur.b - cur.a + 1;
  return { months: total, roles: spans.map(({ role, months, counted }) => ({ role, months, counted })) };
}

// ---------- parse warnings ----------

// pages: [{ items }] from pdf.js. Returns human-readable strings.
export function parseWarnings(pages) {
  const warnings = [];
  let allText = '';
  pages.forEach((pg, i) => {
    const text = pg.items.map((it) => it.str).join(' ');
    allText += text + ' ';
    const chars = text.replace(/\s/g, '').length;
    if (chars < 40) warnings.push(`Page ${i + 1} has ${chars ? 'almost no' : 'no'} selectable text — probably a scanned image.`);
  });
  const chars = allText.replace(/\s/g, '');
  if (chars.length && chars.length < 300) warnings.push(`Very little text overall (${chars.length} characters).`);
  if (chars.length >= 40) {
    const repl = (chars.match(/�/g) || []).length;
    const odd = (chars.match(/[^\p{L}\p{N}.,;:!?'"()\[\]{}\-–—•·/&@%+#*|’‘“”…£$€]/gu) || []).length;
    if (repl / chars.length > 0.02 || odd / chars.length > 0.2) {
      warnings.push(`The text looks garbled (${Math.round((100 * (repl + odd)) / chars.length)}% unusual characters) — the PDF's font encoding may be broken.`);
    }
  }
  return warnings;
}
