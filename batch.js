// Batch: a folder (or a multi-file pick) of PDFs, checked one after another
// against the confirmed criteria, streaming rows into a comparison table.
// Read-only: nothing is ever written back to the folder.

export function initBatch(deps) {
  const $ = (id) => document.getElementById(id);
  const pickBtn = $('batch-pick'), filesInput = $('batch-files'), filesLabel = $('batch-files-label');
  const stopBtn = $('batch-stop'), hint = $('batch-hint');
  const progressBox = $('batch-progress'), bar = $('batch-bar'), eta = $('batch-eta');
  const skippedEl = $('batch-skipped'), table = $('batch-table');
  const thead = table.querySelector('thead'), tbody = table.querySelector('tbody');

  const hasPicker = typeof window.showDirectoryPicker === 'function';
  pickBtn.hidden = !hasPicker;

  let ready = false, running = false, abort = null;
  let rows = []; // { cand, tr, order }
  let criteria = [];
  let sort = 'none'; // none | desc | asc

  function setEnabled() {
    const on = ready && !running;
    pickBtn.disabled = !on;
    filesInput.disabled = !on;
    filesLabel.setAttribute('aria-disabled', String(!on));
    hint.textContent = !ready ? 'Confirm the criteria first.' : running ? '' : hasPicker ? 'Pick a folder, or individual PDF files.' : 'Pick the PDF files (select several at once).';
  }

  pickBtn.addEventListener('click', async () => {
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'read' }); } catch { return; } // cancelled
    const files = [], skipped = [];
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file') continue;
      if (/\.pdf$/i.test(entry.name)) files.push(await entry.getFile());
      else skipped.push(entry.name);
    }
    start(files, skipped);
  });

  filesInput.addEventListener('change', () => {
    const all = [...filesInput.files];
    filesInput.value = '';
    start(all.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf'), all.filter((f) => !(/\.pdf$/i.test(f.name) || f.type === 'application/pdf')).map((f) => f.name));
  });

  stopBtn.addEventListener('click', () => abort?.abort());

  function buildHead() {
    thead.innerHTML = '';
    const tr = document.createElement('tr');
    const th0 = document.createElement('th');
    th0.scope = 'col'; th0.textContent = 'Candidate';
    const thS = document.createElement('th');
    thS.scope = 'col';
    thS.className = 'score-col';
    const sb = document.createElement('button');
    sb.type = 'button'; sb.className = 'sort-btn'; sb.textContent = 'Score';
    sb.addEventListener('click', () => { sort = sort === 'desc' ? 'asc' : sort === 'asc' ? 'none' : 'desc'; applySort(); });
    thS.append(sb);
    tr.append(th0, thS);
    criteria.forEach((c) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.title = `${c.text} (${c.type}, ${c.importance})`;
      th.textContent = c.text.length > 26 ? c.text.slice(0, 24) + '…' : c.text;
      if (c.importance === 'required') th.classList.add('req');
      tr.append(th);
    });
    thead.append(tr);
    updateSortHeader();
  }

  function updateSortHeader() {
    const th = thead.querySelector('.score-col');
    if (!th) return;
    th.setAttribute('aria-sort', sort === 'desc' ? 'descending' : sort === 'asc' ? 'ascending' : 'none');
    th.querySelector('.sort-btn').textContent = 'Score' + (sort === 'desc' ? ' ↓' : sort === 'asc' ? ' ↑' : ' ↕');
  }

  function applySort() {
    const score = (r) => deps.computeScore(r.cand.criteria, r.cand.results) ?? -1;
    const sorted = rows.slice().sort((a, b) => (sort === 'none' ? a.order - b.order : sort === 'desc' ? score(b) - score(a) || a.order - b.order : score(a) - score(b) || a.order - b.order));
    for (const r of sorted) tbody.append(r.tr);
    updateSortHeader();
  }

  function addRow(cand, order) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'cand-btn'; btn.textContent = cand.cv.name;
    btn.addEventListener('click', (e) => { e.stopPropagation(); open(cand); });
    th.append(btn);
    const warn = document.createElement('div');
    warn.className = 'row-warn';
    th.append(warn);
    const tdS = document.createElement('td');
    tdS.className = 'score-cell';
    tr.append(th, tdS);
    criteria.forEach(() => tr.append(document.createElement('td')));
    tr.addEventListener('click', () => open(cand));
    tbody.append(tr);
    const row = { cand, tr, order };
    rows.push(row);
    renderRow(row);
    return row;
  }

  function open(cand) {
    if (!cand.cv.leaves.length) return;
    deps.open(cand);
    for (const r of rows) r.tr.classList.toggle('current', r.cand === cand);
  }

  function renderRow(row) {
    const { cand, tr } = row;
    const warn = tr.querySelector('.row-warn');
    warn.textContent = (cand.cv.warnings || []).join(' ');
    warn.hidden = !warn.textContent;
    const s = deps.computeScore(cand.criteria, cand.results);
    const done = cand.results.filter((r) => r.state === 'done').length;
    const scoreCell = tr.querySelector('.score-cell');
    scoreCell.textContent = s === null ? '–' : String(s);
    if (cand.stopped) scoreCell.append(' ', Object.assign(document.createElement('span'), { className: 'partial', textContent: `(stopped, ${done}/${cand.criteria.length})` }));
    else if (cand.results.length && done < cand.criteria.length && !cand.failed) scoreCell.append(' …');
    const cells = tr.querySelectorAll('td:not(.score-cell)');
    cand.criteria.forEach((c, i) => {
      const r = cand.results[i];
      const td = cells[i];
      td.innerHTML = '';
      if (!r || cand.failed) { td.textContent = '—'; return; }
      if (r.state === 'done') {
        const st = deps.effectiveStatus(r);
        const b = document.createElement('span');
        b.className = `status-badge ${st}${r.override ? ' overridden' : ''}`;
        b.textContent = deps.STATUS_LABEL[st] + (r.override ? '*' : '');
        if (r.override) b.title = 'Status set by you';
        td.append(b);
      } else if (r.state === 'running') td.append(Object.assign(document.createElement('span'), { className: 'status-badge running', textContent: '…' }));
      else if (r.state === 'error') td.textContent = 'error';
      else td.textContent = '—';
    });
  }

  async function start(files, skipped) {
    if (!ready || running) return;
    criteria = deps.getCriteria();
    rows = [];
    tbody.innerHTML = '';
    buildHead();
    table.hidden = false;
    skippedEl.hidden = !skipped.length;
    skippedEl.textContent = skipped.length ? `Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'} that ${skipped.length === 1 ? 'isn\'t a PDF' : 'aren\'t PDFs'}: ${skipped.join(', ')}` : '';
    if (!files.length) { eta.textContent = 'No PDFs found.'; progressBox.hidden = false; bar.value = 0; return; }

    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    running = true;
    abort = new AbortController();
    const signal = abort.signal;
    stopBtn.hidden = false;
    setEnabled();
    progressBox.hidden = false;
    bar.max = files.length;
    bar.value = 0;
    const t0 = performance.now();
    let done = 0;
    const tick = () => {
      const avg = done ? (performance.now() - t0) / done : null;
      const left = files.length - done;
      eta.textContent = `${done} of ${files.length} CVs` + (signal.aborted ? ' — stopped' : left === 0 ? ' — done' : avg ? ` · about ${Math.ceil((avg * left) / 1000)} s left` : ' · estimating time left…');
    };
    tick();

    try {
      for (let k = 0; k < files.length; k++) {
        if (signal.aborted) break;
        const file = files[k];
        let cv;
        try {
          cv = await deps.cvFromPdf(file);
        } catch (e) {
          cv = { name: file.name, kind: 'pdf', file, segs: [], roles: [], leaves: [], warnings: ['Could not read this PDF: ' + e.message] };
        }
        if (!cv.leaves.length && !cv.warnings.length) cv.warnings.push('No selectable text found.');
        const cand = { cv, criteria, results: [], timing: { t0: performance.now(), tFirst: null, tEnd: null } };
        const row = addRow(cand, k);
        cand.onChange = () => { renderRow(row); if (sort !== 'none') applySort(); };
        if (!cv.leaves.length) {
          cand.failed = true;
          renderRow(row);
        } else {
          try {
            await deps.runCandidate(cand, signal, false);
          } catch (e) {
            if (!signal.aborted) throw e;
            cand.stopped = true;
            cand.results.forEach((r) => { if (r.state === 'running' || r.state === 'pending') r.state = 'stopped'; });
            renderRow(row);
            break;
          }
        }
        done++;
        bar.value = done;
        tick();
      }
    } finally {
      running = false;
      abort = null;
      stopBtn.hidden = true;
      tick();
      setEnabled();
      if (sort !== 'none') applySort();
    }
  }

  setEnabled();
  return {
    setCriteriaReady(v) { ready = v; setEnabled(); }
  };
}
