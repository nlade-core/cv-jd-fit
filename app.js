const CV_TEXT = `Alex Morgan
Software Engineer

SUMMARY
Full-stack software engineer with 5 years of experience building and shipping
web applications, internal tools, and APIs. Comfortable across the stack, with
a focus on JavaScript/TypeScript and pragmatic, well-tested code.

SKILLS
JavaScript, TypeScript, Node.js, React, HTML/CSS, Python, REST APIs, SQL
(PostgreSQL), Git, Docker, basic AWS (EC2, S3, Lambda), unit & integration
testing (Jest), CI/CD pipelines (GitHub Actions).

EXPERIENCE
Software Engineer — Northwind Data (2022–present)
- Built and maintained a React/TypeScript front end for an internal analytics
  dashboard used by ~200 employees.
- Designed and implemented REST APIs in Node.js backed by PostgreSQL.
- Introduced automated testing (Jest) and a CI pipeline, cutting regression
  bugs reported in production by roughly a third.
- Migrated a legacy jQuery admin panel to React incrementally, with no
  downtime.

Junior Developer — Fenwick Software (2020–2022)
- Worked on a customer-facing booking platform (Node.js, Express, MySQL).
- Fixed bugs, wrote small features, and shadowed senior engineers on system
  design decisions.
- Wrote developer documentation for onboarding new hires.

EDUCATION
B.Sc. Computer Science — University of Leeds (2016–2019)

OTHER
Occasional open-source contributor. Comfortable working independently or in
small cross-functional teams. No formal experience with mobile development,
Kubernetes, or machine learning.`;

const SYSTEM_PROMPT = `You evaluate how well a candidate's CV fits a job description.
You will be given a CV and a job description. Assess the fit honestly and
specifically, based only on what is actually stated in the CV — do not assume
skills or experience that aren't written there. Respond ONLY with JSON matching
the required schema. "score" is 0-100, where 100 means an excellent match.
"matchedSkills" lists concrete skills/requirements from the job description
that the CV does support. "gaps" lists concrete requirements from the job
description that the CV does not show evidence of. "summary" is one or two
plain sentences giving the overall verdict.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    matchedSkills: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
    summary: { type: "string" }
  },
  required: ["score", "matchedSkills", "gaps", "summary"]
};

const statusPill = document.getElementById('status-pill');
const cvTextEl = document.getElementById('cv-text');
const jdInput = document.getElementById('jd-input');
const runBtn = document.getElementById('run-btn');
const note = document.getElementById('note');
const resultPanel = document.getElementById('result-panel');
const scoreValue = document.getElementById('score-value');
const summaryEl = document.getElementById('summary');
const matchedList = document.getElementById('matched-list');
const gapsList = document.getElementById('gaps-list');

cvTextEl.textContent = CV_TEXT;

let modelAvailability = null;
let prewarmedSession = null; // only ever set when availability was already 'available' at load time

async function checkCapability() {
  if (!self.LanguageModel) {
    statusPill.className = 'status-pill missing';
    statusPill.textContent = 'not supported in this browser';
    note.textContent = 'Open this in a recent desktop Chrome with the on-device model enabled.';
    return;
  }
  try {
    const availability = await LanguageModel.availability();
    modelAvailability = availability;
    statusPill.className = 'status-pill ' + availability;
    statusPill.textContent = availability === 'downloadable' ? 'model needs download' : availability;

    if (availability === 'unavailable') {
      note.textContent = 'The on-device model isn\'t available on this device.';
      return;
    }
    runBtn.disabled = false;

    if (availability === 'available') {
      // Silent warm-up is only safe when nothing needs to be downloaded --
      // never trigger a real download without an explicit click.
      prewarmedSession = LanguageModel.create({ initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }] });
    } else if (availability === 'downloadable') {
      note.textContent = 'First run will download the on-device model — this may take a while.';
    }
  } catch (e) {
    statusPill.className = 'status-pill unavailable';
    statusPill.textContent = 'error';
    note.textContent = e.message;
  }
}
checkCapability();

function renderResult(data) {
  resultPanel.hidden = false;
  scoreValue.textContent = String(data.score);
  summaryEl.textContent = data.summary;
  matchedList.innerHTML = '';
  (data.matchedSkills || []).forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s;
    matchedList.appendChild(li);
  });
  gapsList.innerHTML = '';
  (data.gaps || []).forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s;
    gapsList.appendChild(li);
  });
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Model response was not valid JSON.');
  }
}

async function runMatch() {
  const jdText = jdInput.value.trim();
  if (!jdText) {
    note.textContent = 'Paste a job description first.';
    return;
  }

  runBtn.disabled = true;
  resultPanel.hidden = true;
  note.textContent = modelAvailability === 'downloadable'
    ? 'Downloading model — this only happens once…'
    : 'Checking fit…';

  let session = null;
  try {
    if (prewarmedSession) {
      session = await prewarmedSession;
      prewarmedSession = null; // one-shot; a fresh session is created for any subsequent run
    } else {
      session = await LanguageModel.create({
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            note.textContent = `Downloading model… ${Math.round(e.loaded * 100)}%`;
          });
        }
      });
    }

    note.textContent = 'Checking fit…';
    const raw = await session.prompt(
      `CV:\n${CV_TEXT}\n\nJob description:\n${jdText}`,
      { responseConstraint: RESPONSE_SCHEMA }
    );
    const data = extractJson(raw);
    renderResult(data);
    note.textContent = '';
  } catch (e) {
    note.textContent = 'Something went wrong: ' + e.message;
  } finally {
    if (session) session.destroy();
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', runMatch);
