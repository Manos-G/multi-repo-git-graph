// Changed Repos panel page. Plain JavaScript, no build step.
// The extension sends the state; this page draws it like the Source Control view
// and sends the user's actions back to the extension.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const collapsed = new Set(saved.collapsed || []); // keys: repo path, or repo path + '|' + group kind
  const root = document.getElementById('root');

  /** One DOM section per repository, kept between updates so the message box keeps its text, focus and cursor. */
  const sections = new Map();
  let state = null;
  let selectedKey = null;

  const post = (msg) => vscode.postMessage(msg);
  const saveState = () => vscode.setState({ collapsed: [...collapsed] });

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ctx = (obj) => esc(JSON.stringify(Object.assign({ preventDefaultContextMenuItems: true }, obj)));
  const icon = (name, extra) => `<span class="codicon codicon-${name}${extra ? ' ' + extra : ''}"></span>`;
  const action = (name, title, act, data) =>
    `<span class="action" role="button" tabindex="0" title="${esc(title)}" aria-label="${esc(title)}" data-act="${act}"${
      data ? ` data-arg="${esc(data)}"` : ''
    }>${icon(name)}</span>`;

  const CODE_EXT = /\.(py|c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|mjs|cjs|rs|go|java|kt|cs|sh|bash|zsh|cmake|xml|launch|urdf|xacro|sdf|yaml|yml|toml|ini|cfg|msg|srv|action|html|css|scss)$/i;
  function fileIcon(name) {
    if (/\.json$/i.test(name)) return 'json';
    if (/\.(md|markdown|rst)$/i.test(name)) return 'markdown';
    if (/\.(png|jpe?g|gif|svg|bmp|webp|ico)$/i.test(name)) return 'file-media';
    if (/\.(zip|tar|gz|tgz|xz|7z)$/i.test(name)) return 'file-zip';
    if (/\.pdf$/i.test(name)) return 'file-pdf';
    if (/^(CMakeLists\.txt|Makefile|Dockerfile|package\.xml)$/i.test(name) || CODE_EXT.test(name)) return 'file-code';
    return 'file';
  }

  // ----- drawing -------------------------------------------------------------

  function render() {
    if (!state) return;
    if (state.repos.length === 0) {
      sections.forEach((s) => s.el.remove());
      sections.clear();
      root.innerHTML = `
        <div class="empty">
          <p>All ${state.total} repositories are clean and in sync.</p>
          <div class="primary secondary"><div class="main" data-act="showAll">${icon('eye')}<span>Show All Repositories</span></div></div>
          <div class="primary secondary"><div class="main" data-act="fetchAll">${icon('cloud-download')}<span>Fetch All Repositories</span></div></div>
          <p class="hint">Repositories inside other folders are found when the setting "git.repositoryScanMaxDepth" is high enough.</p>
        </div>`;
      return;
    }
    const empty = root.querySelector('.empty');
    if (empty) empty.remove();

    const seen = new Set();
    state.repos.forEach((repo, index) => {
      seen.add(repo.path);
      let s = sections.get(repo.path);
      if (!s) {
        s = createSection(repo);
        sections.set(repo.path, s);
      }
      updateSection(s, repo);
      if (root.children[index] !== s.el) root.insertBefore(s.el, root.children[index] || null);
    });
    for (const [key, s] of sections) {
      if (!seen.has(key)) {
        s.el.remove();
        sections.delete(key);
      }
    }
  }

  function createSection(repo) {
    const el = document.createElement('div');
    el.className = 'repo';
    el.dataset.repo = repo.path;
    el.innerHTML = `
      <div class="row repo-row" tabindex="0"></div>
      <div class="repo-body">
        <div class="input-wrap"><textarea class="message" rows="1" spellcheck="true"></textarea></div>
        <div class="button-wrap"></div>
        <div class="groups"></div>
      </div>`;
    const ta = el.querySelector('textarea');
    let timer = null;
    ta.addEventListener('input', () => {
      autosize(ta);
      clearTimeout(timer);
      timer = setTimeout(() => post({ type: 'setMessage', repo: repo.path, value: ta.value }), 250);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        post({ type: 'commit', repo: repo.path, message: ta.value });
      }
    });
    return {
      el,
      header: el.querySelector('.repo-row'),
      body: el.querySelector('.repo-body'),
      inputWrap: el.querySelector('.input-wrap'),
      ta,
      buttons: el.querySelector('.button-wrap'),
      groups: el.querySelector('.groups'),
    };
  }

  function autosize(ta) {
    // Empty box: one line, like Source Control (the placeholder must not make it taller).
    if (ta.value === '') {
      ta.style.height = '26px';
      return;
    }
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 200) + 'px';
  }

  function updateSection(s, repo) {
    const isCollapsed = collapsed.has(repo.path);
    const hasFiles = repo.fileCount > 0;

    // Header: twisty, name, branch, sync status, and the buttons.
    const sync =
      repo.ahead > 0 || repo.behind > 0
        ? `<span class="sync-status" title="${repo.behind} to pull, ${repo.ahead} to push"><span class="pair">${repo.behind}${icon('arrow-down')}</span><span class="pair">${repo.ahead}${icon('arrow-up')}</span></span>`
        : repo.unpublished
          ? `<span class="sync-status" title="Branch is not published">${icon('cloud-upload')}</span>`
          : '';
    s.header.setAttribute('data-vscode-context', ctx({ webviewSection: 'repo', repoPath: repo.path }));
    s.header.title = repo.path;
    s.header.innerHTML = `
      ${icon(isCollapsed ? 'chevron-right' : 'chevron-down', 'twisty')}
      ${icon('repo', 'icon')}
      <span class="label">${esc(repo.name)}</span>
      <span class="desc branch">${icon('git-branch')}${esc(repo.branch)}${hasFiles ? '*' : ''}</span>
      <span class="spacer"></span>
      <span class="actions">
        ${hasFiles ? action('check', 'Commit', 'commit') : ''}
        ${action('refresh', 'Refresh', 'repo:refresh')}
        ${action('ellipsis', 'More Actions...', 'repo:more')}
      </span>
      ${sync}
      <span class="actions always">${action('git-branch', 'Open Git Graph (own tab)', 'repo:openGraph').replace('class="action"', 'class="action graph-button"')}</span>`;

    s.body.classList.toggle('collapsed', isCollapsed);

    // Message box: shown when there is something to commit, like Source Control.
    s.inputWrap.style.display = hasFiles ? '' : 'none';
    s.ta.placeholder = `Message (Ctrl+Enter to commit on "${repo.branch}")`;
    if (document.activeElement !== s.ta && s.ta.value !== repo.message) {
      s.ta.value = repo.message;
    }
    autosize(s.ta);

    // Primary button: Commit, or Sync Changes / Publish Branch when there is nothing to commit.
    if (hasFiles) {
      s.buttons.innerHTML = `
        <div class="primary" title="Commit changes on &quot;${esc(repo.branch)}&quot;">
          <div class="main" data-act="commit">${icon('check')}<span>Commit</span></div>
          <div class="drop" data-act="commitMenu" title="More commit actions">${icon('chevron-down')}</div>
        </div>`;
    } else if (repo.unpublished) {
      s.buttons.innerHTML = `<div class="primary"><div class="main" data-act="repo:publish">${icon('cloud-upload')}<span>Publish Branch</span></div></div>`;
    } else if (repo.ahead > 0 || repo.behind > 0) {
      const counts = `${repo.behind > 0 ? repo.behind + '↓ ' : ''}${repo.ahead > 0 ? repo.ahead + '↑' : ''}`.trim();
      s.buttons.innerHTML = `<div class="primary"><div class="main" data-act="repo:sync">${icon('sync')}<span>Sync Changes ${counts}</span></div></div>`;
    } else {
      s.buttons.innerHTML = '';
    }

    // Groups and files.
    let html = '';
    for (const g of repo.groups) {
      const gKey = repo.path + '|' + g.kind;
      const gCollapsed = collapsed.has(gKey);
      const gActions =
        g.kind === 'index'
          ? action('remove', 'Unstage All Changes', 'group:unstage')
          : g.kind === 'merge'
            ? action('add', 'Stage All Changes', 'group:stage')
            : action('discard', 'Discard All Changes', 'group:discard') + action('add', 'Stage All Changes', 'group:stage');
      html += `
        <div class="row group-row" tabindex="0" data-group="${g.kind}"
             data-vscode-context="${ctx({ webviewSection: 'group', repoPath: repo.path, group: g.kind })}">
          ${icon(gCollapsed ? 'chevron-right' : 'chevron-down', 'twisty')}
          <span class="label">${esc(g.label)}</span>
          <span class="spacer"></span>
          <span class="actions">${gActions}</span>
          <span class="badge">${g.files.length}</span>
        </div>`;
      if (gCollapsed) continue;
      for (const f of g.files) {
        const key = repo.path + '|' + g.kind + '|' + f.path;
        const fActions =
          action('go-to-file', 'Open File', 'file:openFile') +
          (g.kind === 'index'
            ? action('remove', 'Unstage Changes', 'file:unstage')
            : g.kind === 'merge'
              ? action('add', 'Stage Changes', 'file:stage')
              : action('discard', 'Discard Changes', 'file:discard') + action('add', 'Stage Changes', 'file:stage'));
        html += `
          <div class="row file-row${f.deleted ? ' deleted' : ''}${selectedKey === key ? ' selected' : ''}" tabindex="0"
               data-group="${g.kind}" data-file="${esc(f.path)}" data-key="${esc(key)}"
               title="${esc((f.dir ? f.dir + '/' : '') + f.name)}"
               data-vscode-context="${ctx({ webviewSection: 'file-' + g.kind, repoPath: repo.path, group: g.kind, filePath: f.path })}">
            ${icon(fileIcon(f.name), 'icon')}
            <span class="label ${f.cls}">${esc(f.name)}</span>
            <span class="desc">${esc(f.dir)}</span>
            <span class="spacer"></span>
            <span class="actions">${fActions}</span>
            <span class="letter ${f.cls}">${esc(f.letter)}</span>
          </div>`;
      }
    }
    s.groups.innerHTML = html;
  }

  // ----- user input ------------------------------------------------------------

  function toggle(key) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    saveState();
    render();
  }

  function handle(target) {
    const repoEl = target.closest('.repo');
    const repoPath = repoEl ? repoEl.dataset.repo : undefined;
    const actEl = target.closest('[data-act]');
    const row = target.closest('.row');

    if (actEl) {
      const act = actEl.dataset.act;
      if (act === 'showAll') return post({ type: 'showAll' });
      if (act === 'fetchAll') return post({ type: 'fetchAll' });
      const s = sections.get(repoPath);
      const message = s ? s.ta.value : '';
      if (act === 'commit') return post({ type: 'commit', repo: repoPath, message });
      if (act === 'commitMenu') return post({ type: 'commitMenu', repo: repoPath, message });
      const [kind, name] = act.split(':');
      if (kind === 'repo') return post({ type: 'repoAction', action: name, repo: repoPath });
      if (kind === 'group') return post({ type: 'groupAction', action: name, repo: repoPath, group: row.dataset.group });
      if (kind === 'file') return post({ type: 'fileAction', action: name, repo: repoPath, group: row.dataset.group, file: row.dataset.file });
      return;
    }
    if (!row) return;
    if (row.classList.contains('repo-row')) return toggle(repoPath);
    if (row.classList.contains('group-row')) return toggle(repoPath + '|' + row.dataset.group);
    if (row.classList.contains('file-row')) {
      selectedKey = row.dataset.key;
      document.querySelectorAll('.file-row.selected').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      return post({ type: 'fileAction', action: 'open', repo: repoPath, group: row.dataset.group, file: row.dataset.file });
    }
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('textarea')) return;
    handle(e.target);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('textarea')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handle(e.target);
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      state = m.state;
      render();
    } else if (m.type === 'committed') {
      const s = sections.get(m.repo);
      if (s) {
        s.ta.value = '';
        autosize(s.ta);
      }
    }
  });

  post({ type: 'ready' });
})();
