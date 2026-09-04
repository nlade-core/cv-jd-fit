# cv-jd-fit

Paste a job description, get a fit score against a CV — scored entirely on-device via Chrome's built-in AI. Nothing you paste is ever sent to a server.

## Why this exists

First validation step for an on-device CV↔JD matching tool: before building real CV upload, PDF extraction, or a recruiter/candidate persona split, this answers the one question that actually mattered — is the on-device model any good at the matching itself? So the CV here is a fixed, hardcoded sample. Only the job-description side is live; paste in any real posting to test it.

## Scope (deliberately minimal)

**In:**
- One hardcoded sample CV
- Paste-a-JD, get a score + matched skills + gaps + one-line summary
- Model availability check with a visible status pill (not a silent failure if unsupported)

**Explicitly not built yet** — cut so this MVP could ship fast and test the real unknown:
- Real CV upload / PDF extraction
- Recruiter vs. candidate persona split
- Many-to-one batching (many CVs, or many JDs)
- OCR fallback (only needed for the deck↔thesis sibling idea — CVs and JDs test clean as plain text)
- Any "review/edit extracted text" flow

## Running it

Needs a recent desktop Chrome with the on-device model (Prompt API / `LanguageModel`) available. Serve the folder locally rather than opening `index.html` directly:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`. If the status pill says "needs download," the first click on "Check fit" will trigger it — that's expected and only happens once.
