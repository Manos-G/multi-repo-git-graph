// Match-day check page. Plain JavaScript, no build step (like resources/changed-repos).
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const icon = (n, extra) => `<span class="codicon codicon-${n}${extra ? ' ' + extra : ''}"></span>`;
  let running = false;
  let result = null;

  function header(status) {
    return `
      <div class="toolbar">
        <h1>${icon('checklist')} Match-Day Check</h1>
        <span class="spacer"></span>
        <button class="secondary" data-act="rerun-quick" ${running ? 'disabled' : ''} title="Check again without fetching">${icon('refresh')} Re-check</button>
        <button data-act="rerun" ${running ? 'disabled' : ''} title="Fetch every repository, then check">${icon('cloud-download')} Fetch and Check</button>
      </div>
      ${status}`;
  }

  function render() {
    if (!result) {
      root.innerHTML = header(`<div class="status running">${icon('loading', 'codicon-modifier-spin')} Fetching and checking every repository…</div>`);
      return;
    }
    const total = result.files.reduce((n, f) => n + f.problems.length, 0);
    const errors = result.files.filter((f) => f.error);
    const when = new Date(result.checkedAt).toLocaleTimeString();
    const repos = result.files.reduce((n, f) => n + f.repos, 0);
    const meta = `${repos} repositories · checked at ${when} in ${(result.durationMs / 1000).toFixed(1)} s${result.fetched ? '' : ' · without fetch'}`;
    let status;
    if (running) status = `<div class="status running">${icon('loading', 'codicon-modifier-spin')} Checking…</div>`;
    else if (total === 0 && errors.length === 0 && result.files.length > 0)
      status = `<div class="status ready">${icon('pass-filled')} Ready <span class="meta">${esc(meta)}</span></div>`;
    else if (result.files.length === 0) status = `<div class="status problems">${icon('warning')} No .repos file found in this workspace.</div>`;
    else
      status = `<div class="status problems">${icon('warning')} ${total} problem${total === 1 ? '' : 's'} <span class="meta">${esc(meta)}</span></div>`;

    let body = '';
    if (result.fetchFailed.length) {
      body += `<div class="note">${icon('info')} Fetch failed in ${esc(result.fetchFailed.join(', '))}. "Not pushed" and "not on the remote" may be out of date there.</div>`;
    }
    for (const f of result.files) {
      body += `<section><h2><a href="#" data-act="openFile" data-file="${esc(f.file)}">${icon('file')} ${esc(f.fileName)}</a></h2>`;
      if (f.error) body += `<div class="problem">${icon('error', 'err')}<span class="repo">${esc(f.fileName)}</span><span class="msg">${esc(f.error)}</span></div>`;
      else if (f.problems.length === 0) body += `<div class="ok">${icon('check')} All ${f.repos} repositories are ready.</div>`;
      for (const p of f.problems) {
        const fix = p.fix
          ? `<button class="secondary" data-act="fix" data-action="${esc(p.fix)}" data-file="${esc(f.file)}" data-name="${esc(p.repo)}" data-path="${esc(p.path)}">${esc(p.fixLabel || 'Fix')}</button>`
          : '';
        body += `<div class="problem">${icon('warning', 'warn')}<span class="repo" title="${esc(p.path)}">${esc(p.repo)}</span><span class="msg">${esc(p.message)}</span><span class="spacer"></span>${fix}</div>`;
      }
      body += '</section>';
    }
    root.innerHTML = header(status) + body;
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    e.preventDefault();
    const act = el.dataset.act;
    if (act === 'rerun') vscode.postMessage({ type: 'rerun', fetch: true });
    else if (act === 'rerun-quick') vscode.postMessage({ type: 'rerun', fetch: false });
    else if (act === 'openFile') vscode.postMessage({ type: 'openFile', file: el.dataset.file });
    else if (act === 'fix') {
      el.disabled = true;
      vscode.postMessage({ type: 'fix', action: el.dataset.action, file: el.dataset.file, name: el.dataset.name, path: el.dataset.path });
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'running') running = true;
    else if (m.type === 'result') {
      running = false;
      result = m.result;
    } else if (m.type === 'failed') {
      running = false;
      root.innerHTML = header(`<div class="status problems">${icon('error')} The check failed: ${esc(m.error)}</div>`);
      return;
    }
    render();
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
