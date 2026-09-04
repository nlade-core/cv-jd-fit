# cv-jd-fit

Paste a job description, get a fit score against a CV — scored entirely on-device via Chrome's built-in AI. Nothing you paste is ever sent to a server.

## Why this exists

First validation step for an on-device CV↔JD matching tool: before building real CV upload, PDF extraction, or a recruiter/candidate persona split, this answers the one question that actually mattered — is the on-device model any good at the matching itself? So the CV here is a fixed, hardcoded sample. Only the job-description side is live; paste in any real posting to test it.

**Result: yes.** Tested against two real, contrasting postings pulled live from Greenhouse and AI Dev Jobs — a backend/React/TypeScript role scored 78/100 against the fake CV's actual stack, a senior ML engineer role requiring production PyTorch/TensorFlow experience scored 30/100 against the same CV, which explicitly disclaims ML experience. The model correctly discriminated, and named the real, specific missing requirements in both cases rather than vague filler.

## Scope (deliberately minimal)

**In:**
- One hardcoded sample CV
- Paste-a-JD, get matched skills + gaps (each tagged `required`/`preferred`, from the job description's own wording) + a one-line summary
- The score is **computed, not model-generated** — a plain weighted formula over the matched/gap lists (required items count double), so the number is always traceable back to the visible lists rather than a separate, unverifiable LLM guess
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
