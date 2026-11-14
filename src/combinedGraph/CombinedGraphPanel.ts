// The combined graph tab ("All Repositories"): one timeline of every repository.
//
// The backend only answers questions: one page of one repository's log, the lock lines
// of the .repos files, a commit's details, a diff. The webview (webview-ui/src/combined)
// owns the per-repository buffers, the merge, the lanes and the filters — the same split
// as the normal graph, whose topology is computed in the webview too.
import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
  CombinedDetails,
  CombinedRepo,
  CombinedRequest,
  CombinedResponse,
  CombinedSettings,
  LockLine,
} from '../../shared/combinedGraph.js';
import type { GitExecutor } from '../services/GitExecutor.js';
import type { GitDiffService } from '../services/GitDiffService.js';
import type { GitApi } from '../changedRepos/gitApi.js';
import { buildGitShowUriParts } from '../utils/gitShowUri.js';
import { pathsEqual } from '../utils/repoIdentity.js';
import type { VcsToolWorkspace } from '../vcstool/VcsToolWorkspace.js';
import { combinedLogArgs, findLockLines, isEmptyRepoError, parseCombinedLog, type FileVersion } from './combinedLog.js';

export const COMBINED_CFG = 'multiRepoGraph.combinedGraph';

export interface CombinedGraphDeps {
  git: GitApi;
  vcs: VcsToolWorkspace;
  executor: GitExecutor;
  log: vscode.LogOutputChannel;
  diffService(repoPath: string): GitDiffService;
  /** Open (or reveal) the repository's own graph tab and select the commit there. */
  revealCommit(repoPath: string, hash: string): Promise<void>;
}

export class CombinedGraphPanel {
  private static current: CombinedGraphPanel | undefined;

  static show(context: vscode.ExtensionContext, deps: CombinedGraphDeps): void {
    if (CombinedGraphPanel.current) {
      CombinedGraphPanel.current.panel.reveal();
      return;
    }
    CombinedGraphPanel.current = new CombinedGraphPanel(context, deps);
  }

  private readonly panel: vscode.WebviewPanel;
  private openedAt = Date.now();
  private repos: CombinedRepo[] = [];
  private gitMs = 0;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly deps: CombinedGraphDeps,
  ) {
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel('multiRepoGraph.combinedGraph', 'All Repositories', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    this.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    this.panel.webview.html = this.html(dist);
    this.panel.onDidDispose(() => (CombinedGraphPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((m: CombinedRequest) => void this.onMessage(m));
  }

  private post(m: CombinedResponse) {
    void this.panel.webview.postMessage(m);
  }

  private html(dist: vscode.Uri): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = w.asWebviewUri(vscode.Uri.joinPath(dist, 'assets', 'combined.js'));
    const style = w.asWebviewUri(vscode.Uri.joinPath(dist, 'assets', 'combined.css'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; img-src ${w.cspSource} data:; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}"><title>All Repositories</title></head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  // ----- data -----------------------------------------------------------------------

  /** Every repository VS Code's Git support has open, plus the frozen ones on disk (off by default). Main repository first. */
  private async listRepos(): Promise<CombinedRepo[]> {
    await this.deps.vcs.refresh();
    const frozen = this.deps.vcs.frozenPaths();
    const list: CombinedRepo[] = [];
    const seen = new Set<string>();
    const add = (p: string, isFrozen: boolean) => {
      const key = path.resolve(p);
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ path: p, name: path.basename(p), frozen: isFrozen });
    };
    for (const r of this.deps.git.repositories) add(r.rootUri.fsPath, frozen.has(path.resolve(r.rootUri.fsPath)));
    for (const f of this.deps.vcs.files) for (const e of f.entries) if (e.frozen && e.facts.exists && e.facts.head.kind !== 'notGit') add(e.path, true);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const mains = new Set(this.deps.vcs.files.map((f) => f.mainRepo).filter((m): m is string => !!m));
    const rank = (r: CombinedRepo) => (root && pathsEqual(r.path, root) ? 0 : mains.has(r.path) ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** The lock lines of every .repos file: its history, and which commits changed the locked versions. */
  private async lockLines(): Promise<LockLine[]> {
    const all: LockLine[] = [];
    for (const f of this.deps.vcs.files) {
      if (!f.mainRepo) continue;
      const rel = path.relative(f.mainRepo, f.filePath).split(path.sep).join('/');
      const out = await this.deps.vcs.git_(f.mainRepo, ['log', '-n', '200', '--format=%H%x00%ct%x00%s', '--', rel]);
      if (!out) continue;
      const versions: FileVersion[] = out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [hash, date, subject] = l.split('\0');
          return { hash, date: Number(date), subject };
        });
      let next = 0;
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (let i = next++; i < versions.length; i = next++) {
            versions[i].text = await this.deps.vcs.git_(f.mainRepo!, ['show', `${versions[i].hash}:${rel}`]);
          }
        }),
      );
      all.push(...findLockLines(versions, f.fileName));
    }
    return all.sort((a, b) => b.date - a.date);
  }

  private settings(): CombinedSettings {
    const c = vscode.workspace.getConfiguration(COMBINED_CFG);
    const colors = vscode.workspace.getConfiguration('multiRepoGraph').get<unknown>('graphColors');
    return {
      graphColors: Array.isArray(colors) ? colors.filter((x): x is string => typeof x === 'string') : [],
      changeSetMinutes: Math.max(1, c.get<number>('changeSetMinutes', 15)),
      pageSize: Math.min(2000, Math.max(50, c.get<number>('pageSize', 200))),
    };
  }

  private async init(): Promise<void> {
    this.openedAt = Date.now();
    this.gitMs = 0;
    this.repos = await this.listRepos();
    const lockLines = await this.lockLines();
    this.post({ type: 'init', payload: { repos: this.repos, lockLines, settings: this.settings(), openedAt: this.openedAt } });
  }

  private async onMessage(m: CombinedRequest): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.init();
      case 'refresh':
        this.post({ type: 'reset' });
        return this.init();
      case 'loadPage': {
        const { requestId, repo, skip, count, query } = m.payload;
        if (!this.repos.some((r) => r.path === repo)) return;
        const started = Date.now();
        const r = await this.deps.executor.execute({ args: combinedLogArgs(skip, count + 1, query), cwd: repo });
        this.gitMs += Date.now() - started;
        if (!r.success) {
          const empty = isEmptyRepoError(r.error.message);
          if (!empty) this.deps.log.warn(`Combined graph: git log failed in ${repo}: ${r.error.message}`);
          this.post({ type: 'page', payload: { requestId, repo, skip, commits: [], hasMore: false, error: empty ? undefined : r.error.message.split('\n')[0] } });
          return;
        }
        // One extra commit tells whether there is more, without a second command.
        const commits = parseCombinedLog(r.value.stdout);
        const hasMore = commits.length > count;
        this.post({ type: 'page', payload: { requestId, repo, skip, commits: hasMore ? commits.slice(0, count) : commits, hasMore } });
        return;
      }
      case 'getDetails': {
        const { repo, hash } = m.payload;
        const r = await this.deps.diffService(repo).getCommitDetails(hash);
        if (!r.success) return this.post({ type: 'details', payload: { repo, hash, error: r.error.message } });
        const d = r.value;
        const details: CombinedDetails = {
          repo,
          hash,
          body: d.body,
          parents: d.parents,
          files: d.files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, additions: f.additions, deletions: f.deletions })),
        };
        return this.post({ type: 'details', payload: details });
      }
      case 'openDiff': {
        const { repo, hash, parent, file, oldFile, status } = m.payload;
        const side = (revision: string, filePath: string) =>
          vscode.Uri.from({ scheme: 'git-show', ...buildGitShowUriParts({ repoPath: repo, revision, filePath, label: path.basename(filePath) }) });
        const right = side(hash, file);
        if (status === 'added') return void vscode.commands.executeCommand('vscode.open', right);
        const left = side(parent ?? `${hash}~1`, oldFile ?? file);
        if (status === 'deleted') return void vscode.commands.executeCommand('vscode.open', left);
        await vscode.commands.executeCommand('vscode.diff', left, right, `${file} (${hash.slice(0, 7)}) — ${path.basename(repo)}`);
        return;
      }
      case 'openInRepoGraph':
        return this.deps.revealCommit(m.payload.repo, m.payload.hash);
      case 'reportTiming': {
        const { firstRenderMs, commits, repos } = m.payload;
        this.deps.log.info(
          `Combined graph: first screen in ${firstRenderMs} ms — ${commits} commits from ${repos} repositories (git log total ${this.gitMs} ms)`,
        );
        return;
      }
    }
  }
}
