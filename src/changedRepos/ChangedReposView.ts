import * as path from 'path';
import * as vscode from 'vscode';
import { GitStatus, type GitApi, type GitChange, type GitRepository } from './gitApi.js';

/**
 * "Changed Repos" panel: a Source Control style view that lists only the
 * repositories that need attention (changed files, unpushed or unpulled
 * commits). Each repository shows the same groups as Source Control
 * (Merge Changes, Staged Changes, Changes) and supports commit, stage,
 * unstage, discard, push, pull and sync. Each repository also has a Git Graph
 * button that opens that repository in its own graph tab.
 */

const VIEW_ID = 'multiRepoGraph.changedRepos';
const CFG = 'multiRepoGraph.changedRepos';
const CTX_SHOWING_ALL = 'multiRepoGraph.changedRepos.showingAll';

type GroupKind = 'merge' | 'index' | 'workingTree' | 'untracked';

const GROUP_LABEL: Record<GroupKind, string> = {
  merge: 'Merge Changes',
  index: 'Staged Changes',
  workingTree: 'Changes',
  untracked: 'Untracked Changes',
};

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

function repoName(repo: GitRepository): string {
  return path.basename(repo.rootUri.fsPath);
}

function branchLabel(repo: GitRepository): string {
  const head = repo.state.HEAD;
  if (head?.name) return head.name;
  if (head?.commit) return `${head.commit.slice(0, 8)} (detached)`;
  return '?';
}

function groupChanges(repo: GitRepository, kind: GroupKind): GitChange[] {
  const s = repo.state;
  switch (kind) {
    case 'merge':
      return s.mergeChanges;
    case 'index':
      return s.indexChanges;
    case 'workingTree':
      return s.workingTreeChanges;
    case 'untracked':
      return s.untrackedChanges ?? [];
  }
}

function fileCount(repo: GitRepository): number {
  const paths = new Set<string>();
  for (const kind of ['merge', 'index', 'workingTree', 'untracked'] as GroupKind[]) {
    for (const ch of groupChanges(repo, kind)) paths.add(ch.uri.fsPath);
  }
  return paths.size;
}

function needsAttention(repo: GitRepository): boolean {
  const c = cfg();
  const head = repo.state.HEAD;
  return (
    fileCount(repo) > 0 ||
    (c.includeUnpushed && (head?.ahead ?? 0) > 0) ||
    (c.includeBehind && (head?.behind ?? 0) > 0) ||
    (c.includeNoUpstream && !!head?.name && !head.upstream)
  );
}

// ---------------------------------------------------------------------------
// Tree nodes
// ---------------------------------------------------------------------------

class RepoNode extends vscode.TreeItem {
  readonly kind = 'repo' as const;
  constructor(readonly repo: GitRepository, isWorkspaceRoot: boolean) {
    const files = fileCount(repo);
    super(repoName(repo), files > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    const head = repo.state.HEAD;
    const ahead = head?.ahead ?? 0;
    const behind = head?.behind ?? 0;
    const parts = [branchLabel(repo)];
    if (ahead > 0 || behind > 0) parts.push(`${behind}↓ ${ahead}↑`);
    if (head?.name && !head.upstream) parts.push('not published');
    this.description = parts.join('  ');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${repoName(repo)}**${isWorkspaceRoot ? ' (workspace root)' : ''}`,
        `\`${repo.rootUri.fsPath}\``,
        `Branch: ${branchLabel(repo)}`,
        `Changed files: ${files}`,
        `Commits to push: ${ahead} · Commits to pull: ${behind}`,
      ].join('\n\n'),
    );
    const conflicts = repo.state.mergeChanges.length > 0;
    this.iconPath = new vscode.ThemeIcon(
      conflicts ? 'warning' : 'repo',
      conflicts
        ? new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')
        : files > 0
          ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
          : undefined,
    );
    // Flags for the "when" clauses of the inline buttons in package.json.
    const flags = ['repo'];
    if (files > 0) flags.push('files');
    if (ahead > 0) flags.push('ahead');
    if (behind > 0) flags.push('behind');
    if (head?.name && !head.upstream) flags.push('unpublished');
    this.contextValue = flags.join(':');
    this.id = `repo:${repo.rootUri.fsPath}`;
  }
}

class MessageNode extends vscode.TreeItem {
  readonly kind = 'message' as const;
  constructor(readonly repo: GitRepository) {
    const draft = repo.inputBox.value.trim();
    super(draft ? draft.split('\n')[0] : `Message (Enter to commit on "${branchLabel(repo)}")`, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('edit');
    this.description = draft ? 'click to edit and commit' : '';
    this.tooltip = 'Write a commit message and commit';
    this.contextValue = 'message';
    this.id = `message:${repo.rootUri.fsPath}`;
    this.command = { command: 'multiRepoGraph.changedRepos.commit', title: 'Commit', arguments: [this] };
  }
}

class GroupNode extends vscode.TreeItem {
  readonly kind = 'group' as const;
  constructor(readonly repo: GitRepository, readonly group: GroupKind) {
    super(GROUP_LABEL[group], vscode.TreeItemCollapsibleState.Expanded);
    this.description = String(groupChanges(repo, group).length);
    this.contextValue = `group:${group}`;
    this.id = `group:${repo.rootUri.fsPath}:${group}`;
  }
}

class FileNode extends vscode.TreeItem {
  readonly kind = 'file' as const;
  constructor(readonly repo: GitRepository, readonly group: GroupKind, readonly change: GitChange) {
    super(change.uri, vscode.TreeItemCollapsibleState.None);
    const rel = path.relative(repo.rootUri.fsPath, change.uri.fsPath);
    const dir = path.dirname(rel);
    this.label = path.basename(rel);
    // The Git extension's file decorations add the status letter and color through resourceUri, as in Source Control.
    this.description = dir === '.' ? '' : dir;
    this.tooltip = rel;
    this.contextValue = `file:${group}`;
    this.id = `file:${repo.rootUri.fsPath}:${group}:${change.uri.fsPath}`;
    this.command = { command: 'multiRepoGraph.changedRepos.openChange', title: 'Open Changes', arguments: [this] };
  }
}

type Node = RepoNode | MessageNode | GroupNode | FileNode;

// ---------------------------------------------------------------------------
// Data provider
// ---------------------------------------------------------------------------

class Provider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  showAll = false;

  constructor(private readonly git: GitApi) {}

  refresh(): void {
    this.emitter.fire();
  }

  sortedRepos(): GitRepository[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return [...this.git.repositories].sort((a, b) => {
      if (a.rootUri.fsPath === root) return -1;
      if (b.rootUri.fsPath === root) return 1;
      return repoName(a).localeCompare(repoName(b), undefined, { sensitivity: 'base' });
    });
  }

  changedRepos(): GitRepository[] {
    return this.sortedRepos().filter(needsAttention);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const repos = this.showAll ? this.sortedRepos() : this.changedRepos();
      return repos.map((r) => new RepoNode(r, r.rootUri.fsPath === root));
    }
    if (node instanceof RepoNode) {
      if (fileCount(node.repo) === 0) return [];
      const groups = (['merge', 'index', 'workingTree', 'untracked'] as GroupKind[])
        .filter((g) => groupChanges(node.repo, g).length > 0)
        .map((g) => new GroupNode(node.repo, g));
      return [new MessageNode(node.repo), ...groups];
    }
    if (node instanceof GroupNode) {
      return [...groupChanges(node.repo, node.group)]
        .sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath))
        .map((c) => new FileNode(node.repo, node.group, c));
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface ChangedReposDeps {
  /** Opens the repository in its own graph tab (reveals the tab if it is already open). */
  openGraph(repoRoot: vscode.Uri): Promise<void> | void;
  log: vscode.LogOutputChannel;
}

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

  const provider = new Provider(git);
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  statusBar.command = 'workbench.view.extension.multiRepoGraph';
  context.subscriptions.push(view, statusBar);

  const updateChrome = () => {
    const changed = provider.changedRepos().length;
    const total = git.repositories.length;
    view.badge = changed > 0 ? { value: changed, tooltip: `${changed} of ${total} repositories need attention` } : undefined;
    view.description = provider.showAll ? `all ${total}` : `${changed} of ${total}`;
    if (cfg().showStatusBar && total > 0) {
      statusBar.text = changed > 0 ? `$(repo) ${changed} changed` : '$(repo) all clean';
      statusBar.tooltip = `${changed} of ${total} repositories have changed files or commits to push or pull`;
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };

  // Many repositories can report a change at the same moment, so redraw at most every 250 ms.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      provider.refresh();
      updateChrome();
    }, 250);
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

  const setShowAll = (value: boolean) => {
    provider.showAll = value;
    void vscode.commands.executeCommand('setContext', CTX_SHOWING_ALL, value);
    provider.refresh();
    updateChrome();
  };
  setShowAll(false);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- command arguments come from VS Code menus (tree nodes, selections)
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`multiRepoGraph.changedRepos.${id}`, fn));

  /** Runs a Git operation and shows any failure the way Source Control does. */
  const run = async (title: string, fn: () => Promise<unknown>) => {
    try {
      await vscode.window.withProgress({ location: { viewId: VIEW_ID }, title }, fn);
    } catch (err) {
      const msg = (err as { stderr?: string; message?: string }).stderr || (err as Error).message || String(err);
      deps.log.error(`${title}: ${msg}`);
      void vscode.window.showErrorMessage(`${title} failed: ${msg.trim().split('\n')[0]}`);
    }
  };

  /** Files the command applies to: the clicked file plus any other selected files of the same repo and group. */
  const filesFor = (node: FileNode, selected?: Node[]): FileNode[] => {
    const all = selected && selected.length > 0 ? selected : [node];
    return all.filter((n): n is FileNode => n instanceof FileNode && n.repo === node.repo && n.group === node.group);
  };

  const repoOf = (node?: Node): GitRepository | undefined => node?.repo;

  const allWorkingPaths = (repo: GitRepository) => [
    ...repo.state.workingTreeChanges.map((c) => c.uri.fsPath),
    ...(repo.state.untrackedChanges ?? []).map((c) => c.uri.fsPath),
  ];

  const confirmDiscard = async (label: string, untracked: number): Promise<boolean> => {
    if (!cfg().confirmDiscard) return true;
    const extra = untracked > 0 ? ` ${untracked} untracked file(s) will be DELETED.` : '';
    const answer = await vscode.window.showWarningMessage(
      `Are you sure you want to discard ${label}?${extra} This cannot be undone.`,
      { modal: true },
      'Discard',
    );
    return answer === 'Discard';
  };

  // -------------------------------------------------------------------------
  // View commands
  // -------------------------------------------------------------------------

  reg('showAll', () => setShowAll(true));
  reg('showChangedOnly', () => setShowAll(false));
  reg('refresh', () => run('Refreshing repositories', () => Promise.all(git.repositories.map((r) => r.status()))));
  reg('fetchAll', () =>
    run('Fetching all repositories', async () => {
      const repos = git.repositories.filter((r) => !!r.state.HEAD?.upstream);
      const queue = [...repos];
      const failures: string[] = [];
      const worker = async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          try {
            await r.fetch();
          } catch (err) {
            failures.push(`${repoName(r)}: ${(err as Error).message ?? err}`);
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (failures.length > 0) {
        void vscode.window.showWarningMessage(`Fetch failed in ${failures.length} repositories: ${failures.slice(0, 3).join(' | ')}`);
      }
    }),
  );

  // -------------------------------------------------------------------------
  // Repository commands
  // -------------------------------------------------------------------------

  reg('openGraph', (node: Node) => {
    const repo = repoOf(node);
    return repo ? deps.openGraph(repo.rootUri) : undefined;
  });

  reg('commit', async (node: Node) => {
    const repo = repoOf(node);
    if (!repo) return;
    if (repo.state.mergeChanges.length > 0 && repo.state.indexChanges.length === 0) {
      void vscode.window.showWarningMessage(`${repoName(repo)}: resolve the merge conflicts and stage the files first.`);
      return;
    }
    const message = await vscode.window.showInputBox({
      title: `Commit in ${repoName(repo)} on "${branchLabel(repo)}"`,
      value: repo.inputBox.value,
      placeHolder: 'Commit message',
      prompt: 'The message is also kept as the draft in Source Control.',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter a commit message.'),
    });
    if (message === undefined) return;
    repo.inputBox.value = message; // keep the draft, in case the commit fails

    let stageFirst = false;
    if (repo.state.indexChanges.length === 0) {
      const working = allWorkingPaths(repo);
      if (working.length === 0) {
        void vscode.window.showInformationMessage(`${repoName(repo)}: there are no changes to commit.`);
        return;
      }
      const mode = cfg().smartCommit;
      if (mode === 'never') {
        void vscode.window.showInformationMessage(`${repoName(repo)}: there are no staged changes. Stage files first.`);
        return;
      }
      if (mode === 'ask') {
        const answer = await vscode.window.showWarningMessage(
          `There are no staged changes in ${repoName(repo)}. Stage all ${working.length} changes and commit them?`,
          { modal: true },
          'Yes',
          'Always',
        );
        if (!answer) return;
        if (answer === 'Always') await vscode.workspace.getConfiguration(CFG).update('smartCommit', 'always', vscode.ConfigurationTarget.Global);
      }
      stageFirst = true;
    }

    await run(`Committing in ${repoName(repo)}`, async () => {
      if (stageFirst) await repo.add(allWorkingPaths(repo));
      await repo.commit(message);
      repo.inputBox.value = '';
    });
  });

  reg('stageAll', (node: Node) => {
    const repo = repoOf(node);
    return repo ? run(`Staging all in ${repoName(repo)}`, () => repo.add(allWorkingPaths(repo))) : undefined;
  });
  reg('unstageAll', (node: Node) => {
    const repo = repoOf(node);
    return repo ? run(`Unstaging all in ${repoName(repo)}`, () => repo.revert(repo.state.indexChanges.map((c) => c.uri.fsPath))) : undefined;
  });
  reg('discardAll', async (node: Node) => {
    const repo = repoOf(node);
    if (!repo) return;
    const untracked = [...repo.state.workingTreeChanges, ...(repo.state.untrackedChanges ?? [])].filter(
      (c) => c.status === GitStatus.UNTRACKED,
    ).length;
    const count = allWorkingPaths(repo).length;
    if (count === 0) return;
    if (await confirmDiscard(`ALL ${count} unstaged changes in ${repoName(repo)}`, untracked)) {
      await run(`Discarding changes in ${repoName(repo)}`, () => repo.clean(allWorkingPaths(repo)));
    }
  });

  reg('push', (node: Node) => {
    const repo = repoOf(node);
    if (!repo) return;
    const head = repo.state.HEAD;
    if (head?.name && !head.upstream) {
      // Same as "Publish Branch" in Source Control: push and set the upstream on the first remote ("origin").
      return run(`Publishing ${repoName(repo)}`, () => repo.push('origin', head.name, true));
    }
    return run(`Pushing ${repoName(repo)}`, () => repo.push());
  });
  reg('pull', (node: Node) => {
    const repo = repoOf(node);
    return repo ? run(`Pulling ${repoName(repo)}`, () => repo.pull()) : undefined;
  });
  reg('sync', (node: Node) => {
    const repo = repoOf(node);
    if (!repo) return;
    return run(`Syncing ${repoName(repo)}`, async () => {
      if ((repo.state.HEAD?.behind ?? 0) > 0) await repo.pull();
      if ((repo.state.HEAD?.ahead ?? 0) > 0) await repo.push();
    });
  });
  reg('fetch', (node: Node) => {
    const repo = repoOf(node);
    return repo ? run(`Fetching ${repoName(repo)}`, () => repo.fetch()) : undefined;
  });
  reg('openTerminal', (node: Node) => {
    const repo = repoOf(node);
    if (!repo) return;
    vscode.window.createTerminal({ name: repoName(repo), cwd: repo.rootUri }).show();
  });
  reg('revealInExplorer', (node: Node) => {
    const repo = repoOf(node);
    if (repo) void vscode.commands.executeCommand('revealInExplorer', repo.rootUri);
  });

  // -------------------------------------------------------------------------
  // Group commands
  // -------------------------------------------------------------------------

  reg('stageGroup', (node: GroupNode) =>
    run(`Staging in ${repoName(node.repo)}`, () => node.repo.add(groupChanges(node.repo, node.group).map((c) => c.uri.fsPath))),
  );
  reg('unstageGroup', (node: GroupNode) =>
    run(`Unstaging in ${repoName(node.repo)}`, () => node.repo.revert(groupChanges(node.repo, node.group).map((c) => c.uri.fsPath))),
  );
  reg('discardGroup', async (node: GroupNode) => {
    const changes = groupChanges(node.repo, node.group);
    const untracked = changes.filter((c) => c.status === GitStatus.UNTRACKED).length;
    if (await confirmDiscard(`${changes.length} changes in ${repoName(node.repo)}`, untracked)) {
      await run(`Discarding in ${repoName(node.repo)}`, () => node.repo.clean(changes.map((c) => c.uri.fsPath)));
    }
  });

  // -------------------------------------------------------------------------
  // File commands (they also apply to the other selected files of the same group)
  // -------------------------------------------------------------------------

  reg('stageFile', (node: FileNode, selected?: Node[]) => {
    const files = filesFor(node, selected);
    return run(`Staging in ${repoName(node.repo)}`, () => node.repo.add(files.map((f) => f.change.uri.fsPath)));
  });
  reg('unstageFile', (node: FileNode, selected?: Node[]) => {
    const files = filesFor(node, selected);
    return run(`Unstaging in ${repoName(node.repo)}`, () => node.repo.revert(files.map((f) => f.change.uri.fsPath)));
  });
  reg('discardFile', async (node: FileNode, selected?: Node[]) => {
    const files = filesFor(node, selected);
    const untracked = files.filter((f) => f.change.status === GitStatus.UNTRACKED).length;
    const label = files.length === 1 ? `changes in "${path.basename(node.change.uri.fsPath)}"` : `changes in ${files.length} files`;
    if (await confirmDiscard(label, untracked)) {
      await run(`Discarding in ${repoName(node.repo)}`, () => node.repo.clean(files.map((f) => f.change.uri.fsPath)));
    }
  });
  reg('openFile', (node: FileNode) => vscode.commands.executeCommand('vscode.open', node.change.uri));

  reg('openChange', async (node: FileNode) => {
    const { change, group, repo } = node;
    const name = path.basename(change.uri.fsPath);
    const st = change.status;
    const open = (uri: vscode.Uri, title: string) => vscode.commands.executeCommand('vscode.open', uri, {}, title);
    const diff = (left: vscode.Uri, right: vscode.Uri, title: string) => vscode.commands.executeCommand('vscode.diff', left, right, title);

    // Same sides as Source Control:
    // staged: HEAD <-> index ("" ref); unstaged: index-or-HEAD ("~" ref) <-> file on disk.
    if (group === 'index') {
      if (st === GitStatus.INDEX_ADDED || st === GitStatus.INTENT_TO_ADD) return open(git.toGitUri(change.uri, ''), `${name} (Index)`);
      if (st === GitStatus.INDEX_DELETED) return open(git.toGitUri(change.originalUri, 'HEAD'), `${name} (Deleted)`);
      return diff(git.toGitUri(change.originalUri, 'HEAD'), git.toGitUri(change.uri, ''), `${name} (Index)`);
    }
    if (st === GitStatus.UNTRACKED || st === GitStatus.INTENT_TO_ADD) return open(change.uri, `${name} (Untracked)`);
    if (st === GitStatus.DELETED) return open(git.toGitUri(change.originalUri, '~'), `${name} (Deleted)`);
    if (group === 'merge') return vscode.commands.executeCommand('vscode.open', change.uri);
    return diff(git.toGitUri(change.originalUri, '~'), change.uri, `${name} (Working Tree) — ${repoName(repo)}`);
  });
}
