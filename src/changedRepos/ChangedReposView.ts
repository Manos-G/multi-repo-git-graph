import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitStatus, type GitApi, type GitChange, type GitRepository } from './gitApi.js';
import {
  GROUP_ORDER,
  branchLabel,
  groupChanges,
  needsAttention,
  pushRepos,
  remoteRepos,
  repoName,
  repoState,
  type GroupKind,
  type ViewState,
} from './repoState.js';
import { GitExecutor } from '../services/GitExecutor.js';
import { VcsToolWorkspace } from '../vcstool/VcsToolWorkspace.js';
import { registerVcstoolCommands } from '../vcstool/vcstoolCommands.js';
import { MatchDayPanel } from '../vcstool/MatchDayPanel.js';

/**
 * "Changed Repos" panel.
 *
 * A webview view that copies the look and behavior of the Source Control view,
 * but lists only the repositories that need attention (changed files, commits
 * to push or pull). Each repository has a message box, a Commit / Sync /
 * Publish button, the Merge / Staged / Changes groups, and a Git Graph button
 * that opens the repository in its own graph tab.
 *
 * The page itself is plain HTML, CSS and JavaScript in resources/changed-repos.
 */

const VIEW_ID = 'multiRepoGraph.changedRepos';
const CFG = 'multiRepoGraph.changedRepos';
const CTX_SHOWING_ALL = 'multiRepoGraph.changedRepos.showingAll';

function cfg() {
  const c = vscode.workspace.getConfiguration(CFG);
  return {
    includeUnpushed: c.get<boolean>('includeUnpushed', true),
    includeBehind: c.get<boolean>('includeBehind', true),
    includeNoUpstream: c.get<boolean>('includeNoUpstream', false),
    smartCommit: c.get<'ask' | 'always' | 'never'>('smartCommit', 'ask'),
    confirmDiscard: c.get<boolean>('confirmDiscard', true),
    showStatusBar: c.get<boolean>('showStatusBar', true),
  };
}

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------

const unstagedPaths = (repo: GitRepository) => [
  ...repo.state.workingTreeChanges.map((c) => c.uri.fsPath),
  ...(repo.state.untrackedChanges ?? []).map((c) => c.uri.fsPath),
];

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface ChangedReposDeps {
  /** Opens the repository in its own graph tab (reveals the tab if it is already open). */
  openGraph(repoRoot: vscode.Uri): Promise<void> | void;
  log: vscode.LogOutputChannel;
}

/** Arguments that the right-click menus of the page pass to the commands (from data-vscode-context). */
interface MenuContext {
  repoPath?: string;
  group?: GroupKind;
  filePath?: string;
}

class ChangedReposPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  showAll = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly git: GitApi,
    private readonly deps: ChangedReposDeps,
    private readonly onChange: () => void,
    private readonly vcs: VcsToolWorkspace,
  ) {}

  // ----- data --------------------------------------------------------------

  /** Every repository VS Code's Git support has open, except frozen ones (they have their own group). */
  sortedRepos(): GitRepository[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const frozen = this.vcs.frozenPaths();
    return this.git.repositories.filter((r) => !frozen.has(path.resolve(r.rootUri.fsPath))).sort((a, b) => {
      if (a.rootUri.fsPath === root) return -1;
      if (b.rootUri.fsPath === root) return 1;
      return repoName(a).localeCompare(repoName(b), undefined, { sensitivity: 'base' });
    });
  }

  changedRepos(): GitRepository[] {
    const opts = cfg();
    // A repository that differs from its .repos file needs attention too, even when it is clean.
    return this.sortedRepos().filter((r) => needsAttention(r, opts) || this.vcs.driftNotes(r.rootUri.fsPath).length > 0);
  }

  findRepo(repoPath: string | undefined): GitRepository | undefined {
    return repoPath ? this.git.repositories.find((r) => r.rootUri.fsPath === repoPath) : undefined;
  }

  findChange(repo: GitRepository, group: GroupKind | undefined, filePath: string | undefined): GitChange | undefined {
    const groups = group ? [group] : GROUP_ORDER;
    for (const g of groups) {
      const ch = groupChanges(repo, g).find((c) => c.uri.fsPath === filePath);
      if (ch) return ch;
    }
    return undefined;
  }

  postState(): void {
    if (!this.view) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const changed = this.changedRepos();
    const list = this.showAll ? this.sortedRepos() : changed;
    const state: ViewState = {
      repos: list.map((r) => ({ ...repoState(r, root), drift: this.vcs.driftNotes(r.rootUri.fsPath) })),
      vcs: this.vcs.viewState(),
      total: this.git.repositories.length,
      changed: changed.length,
      showAll: this.showAll,
    };
    void this.view.webview.postMessage({ type: 'state', state });
    this.view.badge = changed.length > 0 ? { value: changed.length, tooltip: `${changed.length} repositories need attention` } : undefined;
    this.view.description = this.showAll ? `all ${state.total}` : `${changed.length} of ${state.total}`;
  }

  // ----- webview -----------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.postState());
    view.onDidDispose(() => (this.view = undefined));
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('changed-repos', 'view.css')}">
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('changed-repos', 'view.js')}"></script>
</body>
</html>`;
  }

  private async onMessage(m: {
    type: string;
    action?: string;
    repo?: string;
    group?: GroupKind;
    file?: string;
    value?: string;
    message?: string;
    name?: string;
    path?: string;
    fix?: string;
  }): Promise<void> {
    if (m.type === 'ready') return this.postState();
    if (m.type === 'showAll') return this.setShowAll(true);
    if (m.type === 'fetchAll') return void vscode.commands.executeCommand(`${CFG}.fetchAll`);
    if (m.type === 'vcs') {
      // A .repos button: the command name and its arguments come from the page.
      const allowed = ['check', 'lockVersions', 'unlockVersions', 'restoreVersions', 'matchDayCheck', 'chooseTargetFolder', 'writeRecommendedSettings', 'cloneMissing', 'addToFile', 'openFile', 'fix'];
      if (m.action && allowed.includes(m.action)) {
        void vscode.commands.executeCommand(`multiRepoGraph.vcstool.${m.action}`, { file: m.file, name: m.name, path: m.path, action: m.fix });
      }
      return;
    }
    const repo = this.findRepo(m.repo);
    if (!repo) return;
    switch (m.type) {
      case 'setMessage':
        repo.inputBox.value = m.value ?? '';
        return;
      case 'commit':
        return this.commit(repo, m.message ?? repo.inputBox.value, (m.action as CommitMode) ?? 'commit');
      case 'commitMenu':
        return this.commitMenu(repo, m.message ?? repo.inputBox.value);
      case 'repoAction':
        return this.repoAction(repo, m.action ?? '');
      case 'groupAction':
        return this.groupAction(repo, m.group, m.action ?? '');
      case 'fileAction':
        return this.fileAction(repo, m.group, m.file, m.action ?? '');
    }
  }

  setShowAll(value: boolean): void {
    this.showAll = value;
    void vscode.commands.executeCommand('setContext', CTX_SHOWING_ALL, value);
    this.postState();
    this.onChange();
  }

  // ----- actions -----------------------------------------------------------

  /** Runs a Git operation with a progress bar in the panel, and reports a failure the way Source Control does. */
  async run(title: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await vscode.window.withProgress({ location: { viewId: VIEW_ID }, title }, fn);
      return true;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e.stderr || e.message || String(err)).trim();
      this.deps.log.error(`${title}: ${msg}`);
      void vscode.window.showErrorMessage(`${title} failed: ${msg.split('\n')[0]}`);
      return false;
    }
  }

  private async confirmDiscard(what: string, untracked: number): Promise<boolean> {
    if (!cfg().confirmDiscard) return true;
    const extra = untracked > 0 ? ` ${untracked} untracked file(s) will be deleted.` : '';
    const answer = await vscode.window.showWarningMessage(
      `Are you sure you want to discard ${what}?${extra} This cannot be undone.`,
      { modal: true },
      'Discard',
    );
    return answer === 'Discard';
  }

  async commit(repo: GitRepository, message: string, mode: CommitMode): Promise<void> {
    const name = repoName(repo);
    if (!message.trim()) {
      void vscode.window.showWarningMessage(`${name}: write a commit message first.`);
      return;
    }
    if (repo.state.mergeChanges.length > 0 && repo.state.indexChanges.length === 0) {
      void vscode.window.showWarningMessage(`${name}: resolve the merge conflicts and stage the files first.`);
      return;
    }
    repo.inputBox.value = message;

    let stageFirst = false;
    if (repo.state.indexChanges.length === 0) {
      const unstaged = unstagedPaths(repo);
      if (unstaged.length === 0) {
        void vscode.window.showInformationMessage(`${name}: there are no changes to commit.`);
        return;
      }
      const smart = cfg().smartCommit;
      if (smart === 'never') {
        void vscode.window.showInformationMessage(`${name}: there are no staged changes. Stage files first.`);
        return;
      }
      if (smart === 'ask') {
        const answer = await vscode.window.showWarningMessage(
          `There are no staged changes to commit in ${name}. Do you want to stage all your changes and commit them directly?`,
          { modal: true },
          'Yes',
          'Always',
        );
        if (!answer) return;
        if (answer === 'Always') await vscode.workspace.getConfiguration(CFG).update('smartCommit', 'always', vscode.ConfigurationTarget.Global);
      }
      stageFirst = true;
    }

    const ok = await this.run(`Committing in ${name}`, async () => {
      if (stageFirst) await repo.add(unstagedPaths(repo));
      await repo.commit(message);
      repo.inputBox.value = '';
    });
    if (!ok) return;
    void this.view?.webview.postMessage({ type: 'committed', repo: repo.rootUri.fsPath });
    if (mode === 'commitPush') await this.push(repo);
    if (mode === 'commitSync') await this.sync(repo);
  }

  private async commitMenu(repo: GitRepository, message: string): Promise<void> {
    const items: (vscode.QuickPickItem & { mode: CommitMode })[] = [
      { label: '$(check) Commit', mode: 'commit' },
      { label: '$(arrow-up) Commit & Push', mode: 'commitPush' },
      { label: '$(sync) Commit & Sync', mode: 'commitSync' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Commit in ${repoName(repo)}` });
    if (pick) await this.commit(repo, message, pick.mode);
  }

  async push(repo: GitRepository): Promise<void> {
    const head = repo.state.HEAD;
    if (head?.name && !head.upstream) {
      // Same as "Publish Branch" in Source Control: push and set the upstream on "origin".
      await this.run(`Publishing ${repoName(repo)}`, () => repo.push('origin', head.name, true));
      return;
    }
    await this.run(`Pushing ${repoName(repo)}`, () => repo.push());
  }

  async sync(repo: GitRepository): Promise<void> {
    const head = repo.state.HEAD;
    if (head?.name && !head.upstream) return this.push(repo);
    await this.run(`Syncing ${repoName(repo)}`, async () => {
      if ((repo.state.HEAD?.behind ?? 0) > 0) await repo.pull();
      if ((repo.state.HEAD?.ahead ?? 0) > 0) await repo.push();
    });
  }

  async repoAction(repo: GitRepository, action: string): Promise<void> {
    const name = repoName(repo);
    switch (action) {
      case 'openGraph':
        await this.deps.openGraph(repo.rootUri);
        return;
      case 'sync':
        return this.sync(repo);
      case 'publish':
      case 'push':
        return this.push(repo);
      case 'pull':
        await this.run(`Pulling ${name}`, () => repo.pull());
        return;
      case 'fetch':
        await this.run(`Fetching ${name}`, () => repo.fetch());
        return;
      case 'refresh':
        await this.run(`Refreshing ${name}`, () => repo.status());
        return;
      case 'stageAll':
        await this.run(`Staging in ${name}`, () => repo.add(unstagedPaths(repo)));
        return;
      case 'unstageAll':
        await this.run(`Unstaging in ${name}`, () => repo.revert(repo.state.indexChanges.map((c) => c.uri.fsPath)));
        return;
      case 'discardAll': {
        const paths = unstagedPaths(repo);
        if (paths.length === 0) return;
        const untracked = [...repo.state.workingTreeChanges, ...(repo.state.untrackedChanges ?? [])].filter((c) => c.status === GitStatus.UNTRACKED).length;
        if (await this.confirmDiscard(`all ${paths.length} changes in ${name}`, untracked)) {
          await this.run(`Discarding in ${name}`, () => repo.clean(paths));
        }
        return;
      }
      case 'terminal':
        vscode.window.createTerminal({ name, cwd: repo.rootUri }).show();
        return;
      case 'reveal':
        await vscode.commands.executeCommand('revealInExplorer', repo.rootUri);
        return;
      case 'more': {
        const items: (vscode.QuickPickItem & { action?: string })[] = [
          { label: '$(git-branch) Open Git Graph', action: 'openGraph' },
          { label: 'Changes', kind: vscode.QuickPickItemKind.Separator },
          { label: '$(add) Stage All Changes', action: 'stageAll' },
          { label: '$(remove) Unstage All Changes', action: 'unstageAll' },
          { label: '$(discard) Discard All Changes', action: 'discardAll' },
          { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
          { label: '$(sync) Sync', action: 'sync' },
          { label: '$(arrow-down) Pull', action: 'pull' },
          { label: '$(arrow-up) Push', action: 'push' },
          { label: '$(cloud-download) Fetch', action: 'fetch' },
          { label: 'Other', kind: vscode.QuickPickItemKind.Separator },
          { label: '$(terminal) Open in Terminal', action: 'terminal' },
          { label: '$(folder-opened) Reveal in Explorer View', action: 'reveal' },
        ];
        const pick = await vscode.window.showQuickPick(items, { title: `${name} (${branchLabel(repo)})` });
        if (pick?.action) await this.repoAction(repo, pick.action);
        return;
      }
    }
  }

  async groupAction(repo: GitRepository, group: GroupKind | undefined, action: string): Promise<void> {
    if (!group) return;
    const name = repoName(repo);
    const changes = groupChanges(repo, group);
    const paths = changes.map((c) => c.uri.fsPath);
    if (action === 'stage') await this.run(`Staging in ${name}`, () => repo.add(paths));
    if (action === 'unstage') await this.run(`Unstaging in ${name}`, () => repo.revert(paths));
    if (action === 'discard') {
      const untracked = changes.filter((c) => c.status === GitStatus.UNTRACKED).length;
      if (await this.confirmDiscard(`${paths.length} changes in ${name}`, untracked)) {
        await this.run(`Discarding in ${name}`, () => repo.clean(paths));
      }
    }
  }

  async fileAction(repo: GitRepository, group: GroupKind | undefined, filePath: string | undefined, action: string): Promise<void> {
    const change = this.findChange(repo, group, filePath);
    if (!change || !group) return;
    const name = repoName(repo);
    const file = path.basename(change.uri.fsPath);
    switch (action) {
      case 'open':
        return this.openChange(repo, group, change);
      case 'openFile':
        await vscode.commands.executeCommand('vscode.open', change.uri);
        return;
      case 'stage':
        await this.run(`Staging ${file}`, () => repo.add([change.uri.fsPath]));
        return;
      case 'unstage':
        await this.run(`Unstaging ${file}`, () => repo.revert([change.uri.fsPath]));
        return;
      case 'discard': {
        const untracked = change.status === GitStatus.UNTRACKED ? 1 : 0;
        const what = untracked ? `the untracked file "${file}" in ${name}` : `changes in "${file}" in ${name}`;
        if (await this.confirmDiscard(what, 0)) await this.run(`Discarding ${file}`, () => repo.clean([change.uri.fsPath]));
        return;
      }
    }
  }

  /** Opens the same diff as Source Control: staged = HEAD ↔ index; unstaged = index (or HEAD) ↔ file on disk. */
  async openChange(repo: GitRepository, group: GroupKind, change: GitChange): Promise<void> {
    const git = this.git;
    const name = path.basename(change.uri.fsPath);
    const st = change.status;
    const open = (uri: vscode.Uri) => vscode.commands.executeCommand('vscode.open', uri);
    const diff = (left: vscode.Uri, right: vscode.Uri, title: string) => vscode.commands.executeCommand('vscode.diff', left, right, title);
    if (group === 'index') {
      if (st === GitStatus.INDEX_ADDED || st === GitStatus.INTENT_TO_ADD) {
        await open(git.toGitUri(change.uri, ''));
      } else if (st === GitStatus.INDEX_DELETED) {
        await open(git.toGitUri(change.originalUri, 'HEAD'));
      } else {
        await diff(git.toGitUri(change.originalUri, 'HEAD'), git.toGitUri(change.uri, ''), `${name} (Index)`);
      }
      return;
    }
    if (st === GitStatus.UNTRACKED || st === GitStatus.INTENT_TO_ADD || group === 'merge') {
      await open(change.uri);
    } else if (st === GitStatus.DELETED) {
      await open(git.toGitUri(change.originalUri, '~'));
    } else {
      await diff(git.toGitUri(change.originalUri, '~'), change.uri, `${name} (Working Tree) — ${repoName(repo)}`);
    }
  }

  // ----- commands used by the right-click menus and the view title ---------

  menuRepo(ctx: MenuContext | undefined): GitRepository | undefined {
    return this.findRepo(ctx?.repoPath);
  }
}

type CommitMode = 'commit' | 'commitPush' | 'commitSync';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function getGitApi(log: vscode.LogOutputChannel): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<{ enabled: boolean; getAPI(v: 1): GitApi }>('vscode.git');
  if (!ext) {
    log.warn('Changed Repos: the built-in Git extension is not available');
    return undefined;
  }
  const exports = ext.isActive ? ext.exports : await ext.activate();
  if (!exports.enabled) {
    log.warn('Changed Repos: the built-in Git extension is disabled');
    return undefined;
  }
  return exports.getAPI(1);
}

export async function registerChangedReposView(context: vscode.ExtensionContext, deps: ChangedReposDeps): Promise<void> {
  const git = await getGitApi(deps.log);
  if (!git) return;

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  statusBar.command = 'workbench.view.extension.multiRepoGraph';
  context.subscriptions.push(statusBar);

  const updateStatusBar = () => {
    const changed = panel.changedRepos().length;
    const total = git.repositories.length;
    if (cfg().showStatusBar && total > 0) {
      statusBar.text = changed > 0 ? `$(repo) ${changed} changed` : '$(repo) all clean';
      statusBar.tooltip = `${changed} of ${total} repositories have changed files or commits to push or pull`;
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };

  // vcstool (.repos) support: the workspace opens the listed repositories, so it starts with the panel.
  const vcs = new VcsToolWorkspace(git, new GitExecutor(deps.log), deps.log);
  context.subscriptions.push(vcs);
  const panel = new ChangedReposPanel(context, git, deps, updateStatusBar, vcs);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, panel, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  // Many repositories can report a change at the same moment, so redraw at most every 200 ms.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      panel.postState();
      updateStatusBar();
    }, 200);
  };
  const watched = new Map<GitRepository, vscode.Disposable>();
  const watch = (repo: GitRepository) => {
    if (!watched.has(repo)) watched.set(repo, repo.state.onDidChange(schedule));
    schedule();
  };
  git.repositories.forEach(watch);
  context.subscriptions.push(
    git.onDidOpenRepository(watch),
    git.onDidCloseRepository((repo) => {
      watched.get(repo)?.dispose();
      watched.delete(repo);
      schedule();
    }),
    { dispose: () => watched.forEach((d) => d.dispose()) },
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(CFG) && schedule()),
  );
  void vscode.commands.executeCommand('setContext', CTX_SHOWING_ALL, false);
  context.subscriptions.push(vcs.onDidChange(schedule));
  registerVcstoolCommands(context, {
    workspace: vcs,
    log: deps.log,
    pushRepo: async (repoPath) => {
      const repo = panel.findRepo(repoPath);
      if (repo) return panel.push(repo);
      // A frozen repository is not open in VS Code's Git support: push it with git directly.
      const r = await vcs.gitOrError(repoPath, ['push'], { GIT_TERMINAL_PROMPT: '0' });
      if (!r.ok) void vscode.window.showErrorMessage(`Push failed in ${path.basename(repoPath)}: ${r.error.split('\n')[0]}`);
    },
    openMatchDay: () => MatchDayPanel.show(context, vcs),
  });
  void vcs.refresh();

  const reg = (id: string, fn: (ctx?: MenuContext) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`${CFG}.${id}`, fn));

  // View title buttons.
  reg('showAll', () => panel.setShowAll(true));
  reg('showChangedOnly', () => panel.setShowAll(false));
  reg('refresh', () => panel.run('Refreshing repositories', () => Promise.all(git.repositories.map((r) => r.status()))));
  // Runs one remote operation on the selected repositories, 4 at a time.
  // A failure in one repository does not stop the others; all failures are reported together.
  const runOnAllRemotes = (
    title: string,
    verb: string,
    select: (repos: readonly GitRepository[]) => GitRepository[],
    op: (r: GitRepository) => Promise<void>,
  ) =>
    panel.run(title, async () => {
      const queue = select(git.repositories);
      if (queue.length === 0) {
        void vscode.window.showInformationMessage(`${verb} All: no repositories to ${verb.toLowerCase()}.`);
        return;
      }
      const failures: string[] = [];
      const worker = async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          try {
            await op(r);
          } catch (err) {
            failures.push(`${repoName(r)}: ${(err as Error).message ?? err}`);
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (failures.length > 0) {
        void vscode.window.showWarningMessage(`${verb} failed in ${failures.length} repositories: ${failures.slice(0, 3).join(' | ')}`);
      }
    });
  reg('fetchAll', () => runOnAllRemotes('Fetching all repositories', 'Fetch', remoteRepos, (r) => r.fetch()));
  reg('pullAll', () => runOnAllRemotes('Pulling all repositories', 'Pull', remoteRepos, (r) => r.pull()));
  reg('pushAll', () => runOnAllRemotes('Pushing all repositories', 'Push', pushRepos, (r) => r.push()));

  // Right-click menu commands. VS Code passes the row's data-vscode-context object.
  const repoCmd = (id: string, action: string) =>
    reg(id, (ctx) => {
      const repo = panel.menuRepo(ctx);
      return repo ? panel.repoAction(repo, action) : undefined;
    });
  repoCmd('openGraph', 'openGraph');
  repoCmd('sync', 'sync');
  repoCmd('pull', 'pull');
  repoCmd('push', 'push');
  repoCmd('fetch', 'fetch');
  repoCmd('stageAll', 'stageAll');
  repoCmd('unstageAll', 'unstageAll');
  repoCmd('discardAll', 'discardAll');
  repoCmd('openTerminal', 'terminal');
  repoCmd('revealInExplorer', 'reveal');
  reg('commit', (ctx) => {
    const repo = panel.menuRepo(ctx);
    return repo ? panel.commit(repo, repo.inputBox.value, 'commit') : undefined;
  });
  const groupCmd = (id: string, action: string) =>
    reg(id, (ctx) => {
      const repo = panel.menuRepo(ctx);
      return repo ? panel.groupAction(repo, ctx?.group, action) : undefined;
    });
  groupCmd('stageGroup', 'stage');
  groupCmd('unstageGroup', 'unstage');
  groupCmd('discardGroup', 'discard');
  const fileCmd = (id: string, action: string) =>
    reg(id, (ctx) => {
      const repo = panel.menuRepo(ctx);
      return repo ? panel.fileAction(repo, ctx?.group, ctx?.filePath, action) : undefined;
    });
  fileCmd('openChange', 'open');
  fileCmd('openFile', 'openFile');
  fileCmd('stageFile', 'stage');
  fileCmd('unstageFile', 'unstage');
  fileCmd('discardFile', 'discard');
}
