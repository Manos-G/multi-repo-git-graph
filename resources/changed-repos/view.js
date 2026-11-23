// Changed Repos panel page. Plain JavaScript, no build step.
// The extension sends the state; this page draws it like the Source Control view
// and sends the user's actions back to the extension.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  // keys: repo path; repo path + '|' + group kind; repo path + '|' + group kind + '|dir|' + folder path (tree view)
  const collapsed = new Set(saved.collapsed || []);
  const root = document.getElementById('root');
  // Three parts: the .repos files on top, the repositories, the Frozen group at the bottom.
  root.innerHTML = '<div id="vcs-top"></div><div id="repos"></div><div id="vcs-bottom"></div>';
  const vcsTop = document.getElementById('vcs-top');
  const reposEl = document.getElementById('repos');
  const vcsBottom = document.getElementById('vcs-bottom');
  const frozenOpen = new Set(saved.frozenOpen || []); // the Frozen group starts collapsed

  /** One DOM section per repository, kept between updates so the message box keeps its text, focus and cursor. */
  const sections = new Map();
  let state = null;
  let selectedKey = null;

  const post = (msg) => vscode.postMessage(msg);
  const saveState = () => vscode.setState({ collapsed: [...collapsed], frozenOpen: [...frozenOpen] });

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
    renderVcs();
    if (state.repos.length === 0) {
      sections.forEach((s) => s.el.remove());
      sections.clear();
      reposEl.innerHTML = `
        <div class="empty">
          <p>All ${state.total} repositories are clean and in sync.</p>
          <div class="primary secondary"><div class="main" data-act="showAll">${icon('eye')}<span>Show All Repositories</span></div></div>
          <div class="primary secondary"><div class="main" data-act="fetchAll">${icon('cloud-download')}<span>Fetch All Repositories</span></div></div>
          <p class="hint">Repositories inside other folders are found when the setting "git.repositoryScanMaxDepth" is high enough.</p>
        </div>`;
      return;
    }
    const empty = reposEl.querySelector('.empty');
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
      if (reposEl.children[index] !== s.el) reposEl.insertBefore(s.el, reposEl.children[index] || null);
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
      <div class="drift-list"></div>
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
      driftList: el.querySelector('.drift-list'),
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
    s.driftList.innerHTML = (repo.drift || [])
      .map((d) => `<div class="row drift-row" title="${esc(d)}">${icon('warning', 'icon')}<span class="label">${esc(d)}</span></div>`)
      .join('');

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
      const gActions = changeActions(g.kind, 'group', true);
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
      if (state.viewMode === 'tree' && g.tree) html += treeRows(repo, g, g.tree, 0);
      else for (const f of g.files) html += fileRow(repo, g, f, null);
    }
    s.groups.innerHTML = html;
  }

  // Stage / unstage / discard buttons of a group, a folder (prefix 'group' or 'folder') or a file.
  function changeActions(kind, prefix, all) {
    const what = all ? 'All Changes' : 'Changes';
    if (kind === 'index') return action('remove', 'Unstage ' + what, prefix + ':unstage');
    if (kind === 'merge') return action('add', 'Stage ' + what, prefix + ':stage');
    return action('discard', 'Discard ' + what, prefix + ':discard') + action('add', 'Stage ' + what, prefix + ':stage');
  }

  // Tree view rows: an 8px step per level, like VS Code's trees. A file row has no twisty, so
  // its icon starts where a folder's twisty would; null depth = list view (fixed indent, folder shown).
  const TREE_BASE = 20;
  const TREE_STEP = 8;

  function fileRow(repo, g, f, depth) {
    const key = repo.path + '|' + g.kind + '|' + f.path;
    const fActions = action('go-to-file', 'Open File', 'file:openFile') + changeActions(g.kind, 'file', false);
    const indent = depth === null ? '' : ` style="padding-left:${TREE_BASE + 16 + depth * TREE_STEP}px"`;
    return `
          <div class="row file-row${f.deleted ? ' deleted' : ''}${selectedKey === key ? ' selected' : ''}" tabindex="0"${indent}
               data-group="${g.kind}" data-file="${esc(f.path)}" data-key="${esc(key)}"
               title="${esc((f.dir ? f.dir + '/' : '') + f.name)}"
               data-vscode-context="${ctx({ webviewSection: 'file-' + g.kind, repoPath: repo.path, group: g.kind, filePath: f.path })}">
            ${icon(fileIcon(f.name), 'icon')}
            <span class="label ${f.cls}">${esc(f.name)}</span>
            ${depth === null ? `<span class="desc">${esc(f.dir)}</span>` : ''}
            <span class="spacer"></span>
            <span class="actions">${fActions}</span>
            <span class="letter ${f.cls}">${esc(f.letter)}</span>
          </div>`;
  }

  function treeRows(repo, g, node, depth) {
    let html = '';
    for (const folder of node.folders) {
      const key = repo.path + '|' + g.kind + '|dir|' + folder.path;
      const isCollapsed = collapsed.has(key);
      html += `
          <div class="row folder-row" tabindex="0" style="padding-left:${TREE_BASE + depth * TREE_STEP}px"
               data-group="${g.kind}" data-folder="${esc(folder.path)}" data-key="${esc(key)}" title="${esc(folder.path)}"
               data-vscode-context="${ctx({ webviewSection: 'folder-' + g.kind, repoPath: repo.path, group: g.kind, folderPath: folder.path })}">
            ${icon(isCollapsed ? 'chevron-right' : 'chevron-down', 'twisty')}
            <span class="label">${esc(folder.name)}</span>
            <span class="spacer"></span>
            <span class="actions">${changeActions(g.kind, 'folder', false)}</span>
          </div>`;
      if (!isCollapsed) html += treeRows(repo, g, folder, depth + 1);
    }
    for (const i of node.files) html += fileRow(repo, g, g.files[i], depth);
    return html;
  }

  // ----- .repos files (vcstool) --------------------------------------------------

  const vcsAction = (name, title, act, extra) =>
    `<span class="action" role="button" tabindex="0" title="${esc(title)}" aria-label="${esc(title)}" data-act="vcs:${act}"${extra || ''}>${icon(name)}</span>`;
  const textButton = (label, act, data) => `<span class="text-button" role="button" tabindex="0" data-act="vcs:${act}"${data}>${esc(label)}</span>`;
  const dataAttrs = (o) => Object.entries(o).map(([k, v]) => (v ? ` data-${k}="${esc(v)}"` : '')).join('');
  const shortVersion = (v) => (/^[0-9a-f]{7,40}$/i.test(v) ? v.slice(0, 8) : v);

  function renderVcs() {
    const files = state.vcs || [];
    let top = '';
    let frozen = [];
    for (const v of files) {
      const d = dataAttrs({ file: v.file });
      const lock = v.lock === 'locked' ? icon('lock', 'lock-state') : v.lock === 'partly' ? icon('lock-small', 'lock-state') : '';
      top += `
        <div class="vcs-file">
          <div class="row vcs-row" tabindex="0"${d} title="${esc(v.summary + '\n' + v.file)}">
            ${icon('file-code', 'icon')}
            <span class="label">${esc(v.summary)}</span>${lock}
            <span class="spacer"></span>
            <span class="actions">
              ${vcsAction('lock', 'Lock Versions…', 'lockVersions', d)}
              ${vcsAction('unlock', 'Unlock Versions…', 'unlockVersions', d)}
              ${vcsAction('history', 'Restore Versions…', 'restoreVersions', d)}
              ${vcsAction('go-to-file', 'Open File', 'openFile', d)}
            </span>
            <span class="actions always">
              ${vcsAction('refresh', 'Check (re-read every repository)', 'check', d)}
              ${vcsAction('checklist', 'Match-Day Check', 'matchDayCheck', d)}
            </span>
          </div>`;
      if (v.error) {
        top += `<div class="row vcs-sub error-row">${icon('error', 'icon')}<span class="label">${esc(v.error)}</span></div>`;
      } else {
        top += `
          <div class="row vcs-sub" title="Paths in ${esc(v.fileName)} start in this folder">
            ${icon('folder', 'icon')}
            <span class="label">paths start in ${esc(v.target.display)}</span>
            <span class="desc">${v.target.auto ? 'automatic · ' : ''}${v.target.found} of ${v.target.total} exist</span>
            <span class="spacer"></span>
            <span class="actions">${vcsAction('edit', 'Change Folder…', 'chooseTargetFolder', d)}</span>
          </div>`;
      }
      if (v.recommendSettings && !v.error) {
        top += `
          <div class="row vcs-sub" title="VS Code still opens repositories on its own, so frozen repositories get git status and file watchers.">
            ${icon('settings-gear', 'icon')}
            <span class="label">Recommended Git settings are not set</span>
            <span class="spacer"></span>
            ${textButton('Apply…', 'writeRecommendedSettings', d)}
          </div>`;
      }
      for (const m of v.missing) {
        top += `
          <div class="row vcs-sub missing-row" title="${esc(m.path)}">
            ${icon('warning', 'icon')}
            <span class="label">${esc(m.name)}</span>
            <span class="desc">missing${m.version ? ' · ' + esc(shortVersion(m.version)) : ''}</span>
            <span class="spacer"></span>
            ${textButton('Clone', 'cloneMissing', dataAttrs({ file: v.file, name: m.name }))}
          </div>`;
      }
      for (const x of v.extras) {
        top += `
          <div class="row vcs-sub" title="${esc(x.path)}">
            ${icon('question', 'icon')}
            <span class="label">${esc(x.name)}</span>
            <span class="desc">not in ${esc(v.fileName)}</span>
            <span class="spacer"></span>
            ${textButton('Add to File', 'addToFile', dataAttrs({ file: v.file, path: x.path }))}
          </div>`;
      }
      for (const u of v.unsupported) {
        top += `<div class="row vcs-sub">${icon('circle-slash', 'icon')}<span class="label">${esc(u.name)}</span><span class="desc">type "${esc(u.type)}" not supported</span></div>`;
      }
      top += '</div>';
      frozen = frozen.concat(v.frozen.map((f) => Object.assign({ file: v.file }, f)));
    }
    vcsTop.innerHTML = top;

    if (frozen.length === 0) {
      vcsBottom.innerHTML = '';
      return;
    }
    const open = frozenOpen.has('frozen');
    const warnings = frozen.filter((f) => f.warn).length;
    let html = `
      <div class="row group-row frozen-group" tabindex="0" data-act="vcs-toggle-frozen" title="Pinned repositories. VS Code's Git support does not open them; they are checked by reading their .git files.">
        ${icon(open ? 'chevron-down' : 'chevron-right', 'twisty')}
        <span class="label">Frozen</span>
        ${warnings ? `<span class="desc frozen-warn">${icon('warning')} ${warnings} changed</span>` : ''}
        <span class="spacer"></span>
        <span class="badge">${frozen.length}</span>
      </div>`;
    if (open) {
      for (const f of frozen) {
        const d = dataAttrs({ file: f.file, name: f.name, path: f.path });
        const note = f.note + (f.openInGit ? ' · open in Source Control' : '');
        html += `
          <div class="row file-row frozen-row${f.warn ? ' warn' : ''}" tabindex="0" title="${esc(f.path)}">
            ${icon(f.warn ? 'warning' : 'lock-small', 'icon')}
            <span class="label">${esc(f.name)}</span>
            <span class="desc">${esc(shortVersion(f.version))}${note ? ' · ' + esc(note) : ''}</span>
            <span class="spacer"></span>
            <span class="actions">
              ${vcsAction('terminal', 'Open in Terminal', 'fix', d + ' data-fix="openTerminal"')}
              ${vcsAction('folder-opened', 'Reveal in Explorer View', 'fix', d + ' data-fix="reveal"')}
            </span>
          </div>`;
      }
    }
    vcsBottom.innerHTML = html;
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
      if (act === 'vcs-toggle-frozen') {
        if (frozenOpen.has('frozen')) frozenOpen.delete('frozen');
        else frozenOpen.add('frozen');
        saveState();
        return renderVcs();
      }
      if (act.startsWith('vcs:')) {
        const ds = actEl.dataset;
        return post({ type: 'vcs', action: act.slice(4), file: ds.file, name: ds.name, path: ds.path, fix: ds.fix });
      }
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
      if (kind === 'folder') return post({ type: 'folderAction', action: name, repo: repoPath, group: row.dataset.group, folder: row.dataset.folder });
      return;
    }
    if (!row) return;
    if (row.classList.contains('repo-row')) return toggle(repoPath);
    if (row.classList.contains('group-row')) return toggle(repoPath + '|' + row.dataset.group);
    if (row.classList.contains('folder-row')) return toggle(row.dataset.key);
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
