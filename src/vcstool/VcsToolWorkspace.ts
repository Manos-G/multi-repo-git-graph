// The vcstool workspace: finds the .repos files, knows how every listed repository on disk
// differs from its file, opens the non-frozen repositories in VS Code's Git support, and
// runs the few git commands vcstool features need through GitExecutor.
//
// Two sources of facts, on purpose:
// - repositories open in VS Code's Git support: its state (branch, ahead/behind, changes, remotes);
// - frozen and not-yet-open repositories: their .git files (gitFiles.ts), no git process at all.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GitExecutor } from '../services/GitExecutor.js';
import type { GitApi, GitRepository } from '../changedRepos/gitApi.js';
import { pathsEqual } from '../utils/repoIdentity.js';
import { findRepoRoot, readHead, readOriginUrl, resolveGitDirs, type FileReader, type HeadState } from './gitFiles.js';
import {
  chooseTargetFolder,
  computeDrift,
  describeDrift,
  entryNameFor,
  findExtras,
  isFrozen,
  isRealDrift,
  normalizeFreeze,
  summaryLine,
  targetFolderCandidates,
  type Drift,
  type RepoFacts,
  type VcsView,
} from './model.js';
import { isCommitHash, lockedFrom, parseReposFile, type ReposEntry, type ReposFile } from './reposFile.js';

export const VCS_CFG = 'multiRepoGraph.vcstool';

/** For commands that talk to a remote: fail instead of waiting for a password prompt nobody can see. */
export const NETWORK_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };

export const diskReader: FileReader = {
  readFile(p) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
};

export interface VcsEntryState {
  entry: ReposEntry;
  path: string;
  frozen: boolean;
  facts: RepoFacts;
  drift: Drift[];
  /** Whether VS Code's Git support has the repository open. */
  openInGit: boolean;
}

export interface VcsFileState {
  filePath: string;
  fileName: string;
  /** The repository that contains the .repos file (where Lock commits it). */
  mainRepo?: string;
  targetFolder: string;
  targetAuto: boolean;
  /** How many entries exist in the target folder. */
  targetFound: number;
  error?: string;
  parsed?: ReposFile;
  entries: VcsEntryState[];
  extras: { name: string; path: string }[];
  summary: string;
}



export class VcsToolWorkspace implements vscode.Disposable {
  files: VcsFileState[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  /** Repositories we asked VS Code to open (asked once per session; VS Code remembers them). */
  private readonly opened = new Set<string>();
  /** `git rev-list` answers for pinned drift, keyed by path|pin|head, so a redraw spawns nothing. */
  private readonly pinnedCache = new Map<string, { ahead: number; behind: number } | null>();
  /** Tag/branch → commit answers for detached checkouts, keyed by path|version|head. */
  private readonly versionCache = new Map<string, string | null>();
  /** Uncommitted file counts of frozen repositories from the last match-day check. */
  readonly frozenChanges = new Map<string, number>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly git: GitApi,
    private readonly executor: GitExecutor,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(VCS_CFG)) {
          this.rewatch();
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rewatch();
        this.scheduleRefresh();
      }),
      // Frozen repositories have no watcher; coming back to the window is when they are re-read.
      vscode.window.onDidChangeWindowState((s) => s.focused && this.scheduleRefresh()),
      git.onDidOpenRepository((r) => {
        this.watchRepo(r);
        this.scheduleRefresh();
      }),
      git.onDidCloseRepository(() => this.scheduleRefresh()),
    );
    git.repositories.forEach((r) => this.watchRepo(r));
    this.rewatch();
  }

  private readonly repoWatch = new Map<GitRepository, vscode.Disposable>();
  private watchRepo(repo: GitRepository) {
    if (!this.repoWatch.has(repo)) this.repoWatch.set(repo, repo.state.onDidChange(() => this.scheduleRefresh()));
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.watchers.forEach((d) => d.dispose());
    this.repoWatch.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  // ----- discovery -----------------------------------------------------------

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** `*.repos` in each workspace folder and one folder below, or the files named in the setting. */
  findFiles(): string[] {
    const configured = vscode.workspace.getConfiguration(VCS_CFG).get<string[]>('files', []).filter((f) => typeof f === 'string' && f.trim());
    const root = this.workspaceRoot();
    if (configured.length > 0) {
      return configured.map((f) => (path.isAbsolute(f) ? f : path.join(root ?? '', f))).filter((f) => fs.existsSync(f));
    }
    const found: string[] = [];
    const scan = (dir: string, depth: number) => {
      let list: fs.Dirent[];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        if (e.isFile() && e.name.endsWith('.repos')) found.push(path.join(dir, e.name));
        else if (depth === 0 && e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') scan(path.join(dir, e.name), 1);
      }
    };
    for (const f of vscode.workspace.workspaceFolders ?? []) scan(f.uri.fsPath, 0);
    return found.sort();
  }

  private rewatch() {
    this.watchers.forEach((d) => d.dispose());
    this.watchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '{*.repos,*/*.repos}'));
      w.onDidChange(() => this.scheduleRefresh());
      w.onDidCreate(() => this.scheduleRefresh());
      w.onDidDelete(() => this.scheduleRefresh());
      this.watchers.push(w);
    }
    for (const f of vscode.workspace.getConfiguration(VCS_CFG).get<string[]>('files', [])) {
      const abs = path.isAbsolute(f) ? f : path.join(this.workspaceRoot() ?? '', f);
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(abs)), path.basename(abs)));
      w.onDidChange(() => this.scheduleRefresh());
      this.watchers.push(w);
    }
  }

  // ----- state -----------------------------------------------------------------

  scheduleRefresh(delay = 300): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  /** Re-read everything. Concurrent calls share one run. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh()
      .catch((e) => this.log.error(`vcstool: refresh failed: ${e}`))
      .finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  findGitRepo(p: string): GitRepository | undefined {
    return this.git.repositories.find((r) => pathsEqual(r.rootUri.fsPath, p));
  }

  readFile(filePath: string): VcsFileState {
    const fileName = path.basename(filePath);
    const base: VcsFileState = {
      filePath,
      fileName,
      mainRepo: findRepoRoot(path.dirname(filePath), diskReader),
      targetFolder: path.dirname(filePath),
      targetAuto: true,
      targetFound: 0,
      entries: [],
      extras: [],
      summary: fileName,
    };
    const text = diskReader.readFile(filePath);
    if (text === undefined) return { ...base, error: 'The file cannot be read.' };
    const parsed = parseReposFile(text);
    if (!parsed.ok) return { ...base, error: parsed.line !== undefined ? `Line ${parsed.line + 1}: ${parsed.error}` : parsed.error };
    const file = parsed.file;

    const root = this.workspaceRoot();
    const configuredTarget = vscode.workspace.getConfiguration(VCS_CFG).get<string>('targetFolder', '').trim();
    let targetFolder: string;
    let targetAuto = true;
    const names = file.entries.map((e) => e.name);
    if (configuredTarget) {
      targetFolder = path.resolve(root ?? path.dirname(filePath), configuredTarget);
      targetAuto = false;
    } else {
      targetFolder = chooseTargetFolder(targetFolderCandidates(filePath, root), names, (p) => fs.existsSync(p)).folder;
    }
    const targetFound = names.filter((n) => fs.existsSync(path.join(targetFolder, n))).length;
    return { ...base, parsed: file, targetFolder, targetAuto, targetFound };
  }

  private async doRefresh(): Promise<void> {
    const freeze = normalizeFreeze(vscode.workspace.getConfiguration(VCS_CFG).get('freeze', 'pinned'));
    const files: VcsFileState[] = [];
    for (const filePath of this.findFiles()) {
      const state = this.readFile(filePath);
      if (state.parsed) {
        state.entries = await Promise.all(state.parsed.entries.map((entry) => this.entryState(state, entry, freeze)));
        state.extras = this.scanExtras(state);
      }
      const drift = state.entries.filter((e) => e.drift.some(isRealDrift)).length;
      const missing = state.entries.filter((e) => e.drift.some((d) => d.kind === 'missing')).length;
      const unsupported = state.entries.filter((e) => e.drift.some((d) => d.kind === 'unsupported')).length;
      state.summary = state.error
        ? `${state.fileName} · cannot be read`
        : summaryLine(state.fileName, { repos: state.entries.length, drift, missing, extra: state.extras.length, unsupported });
      files.push(state);
    }
    this.files = files;
    this.openRepositories();
    this.emitter.fire();
  }

  private async entryState(file: VcsFileState, entry: ReposEntry, freeze: ReturnType<typeof normalizeFreeze>): Promise<VcsEntryState> {
    const p = path.resolve(file.targetFolder, entry.name);
    const frozen = isFrozen(entry, freeze);
    const repo = this.findGitRepo(p);
    const facts = repo && !frozen ? this.factsFromGit(repo, p) : this.factsFromFiles(p);
    if (frozen && this.frozenChanges.has(p)) facts.changes = this.frozenChanges.get(p);
    const version = entry.version?.trim();
    const commit = facts.head.kind === 'branch' ? facts.head.commit : facts.head.kind === 'detached' ? facts.head.commit : undefined;
    // Two cheap git questions, only for non-frozen repositories, and cached by (pin, HEAD).
    if (!frozen && commit && version && isCommitHash(version) && !commit.startsWith(version.toLowerCase())) {
      facts.pinned = (await this.pinnedPosition(p, version, commit)) ?? undefined;
    }
    if (!frozen && facts.head.kind === 'detached' && version && !isCommitHash(version)) {
      facts.versionCommit = (await this.resolveVersion(p, version, facts.head.commit)) ?? undefined;
    }
    return { entry, path: p, frozen, facts, drift: computeDrift(entry, facts), openInGit: !!repo };
  }

  factsFromFiles(p: string): RepoFacts {
    const exists = fs.existsSync(p);
    const head: HeadState = exists ? readHead(p, diskReader) : { kind: 'notGit' };
    return { exists, head, originUrl: head.kind === 'notGit' ? undefined : readOriginUrl(p, diskReader) };
  }

  private factsFromGit(repo: GitRepository, p: string): RepoFacts {
    const h = repo.state.HEAD;
    // VS Code's state lags a moment behind a checkout; the HEAD file is the truth and costs one read.
    const fileHead = readHead(p, diskReader);
    const head: HeadState =
      fileHead.kind !== 'notGit' ? fileHead : h?.name ? { kind: 'branch', branch: h.name, commit: h.commit } : h?.commit ? { kind: 'detached', commit: h.commit } : { kind: 'notGit' };
    const s = repo.state;
    const changed = new Set<string>();
    for (const list of [s.mergeChanges, s.indexChanges, s.workingTreeChanges, s.untrackedChanges ?? []]) for (const c of list) changed.add(c.uri.fsPath);
    const origin = s.remotes?.find((r) => r.name === 'origin');
    return {
      exists: true,
      head,
      originUrl: origin?.fetchUrl ?? origin?.pushUrl ?? readOriginUrl(p, diskReader),
      changes: changed.size,
      hasUpstream: head.kind === 'branch' ? !!h?.upstream : undefined,
      ahead: h?.ahead,
      behind: h?.behind,
    };
  }

  private async pinnedPosition(p: string, pin: string, head: string): Promise<{ ahead: number; behind: number } | null> {
    const key = `${p}|${pin}|${head}`;
    if (this.pinnedCache.has(key)) return this.pinnedCache.get(key)!;
    const r = await this.git_(p, ['rev-list', '--left-right', '--count', `${pin}...${head}`]);
    const m = r !== undefined ? /^(\d+)\s+(\d+)/.exec(r) : null;
    const value = m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
    this.pinnedCache.set(key, value);
    return value;
  }

  private async resolveVersion(p: string, version: string, head: string): Promise<string | null> {
    const key = `${p}|${version}|${head}`;
    if (this.versionCache.has(key)) return this.versionCache.get(key)!;
    const r = await this.git_(p, ['rev-parse', '--verify', '--quiet', `${version}^{commit}`]);
    const value = r?.trim() || null;
    this.versionCache.set(key, value);
    return value;
  }

  /** Git repositories directly in the target folder (and one level deeper) that the file does not list. */
  private scanExtras(file: VcsFileState): { name: string; path: string }[] {
    const found: string[] = [];
    const scan = (dir: string, depth: number) => {
      let list: fs.Dirent[];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (resolveGitDirs(p, diskReader)) found.push(p);
        else if (depth < 1) scan(p, depth + 1);
      }
    };
    if (fs.existsSync(file.targetFolder)) scan(file.targetFolder, 0);
    const entryPaths = file.entries.map((e) => e.path);
    return findExtras(found, entryPaths, file.mainRepo ? [file.mainRepo] : []).map((p) => ({ name: entryNameFor(file.targetFolder, p), path: p }));
  }

  // ----- opening repositories ------------------------------------------------

  /**
   * Open the main repository, every non-frozen listed repository and every extra one in VS Code's
   * Git support. Frozen ones are never opened: no `git status`, no watchers for them.
   */
  private openRepositories(): void {
    if (!this.git.openRepository) return;
    const targets = new Set<string>();
    for (const f of this.files) {
      if (f.mainRepo) targets.add(f.mainRepo);
      for (const e of f.entries) if (!e.frozen && e.facts.exists && e.facts.head.kind !== 'notGit') targets.add(e.path);
      for (const x of f.extras) targets.add(x.path);
    }
    for (const p of targets) {
      if (this.opened.has(p) || this.findGitRepo(p)) continue;
      this.opened.add(p);
      this.git.openRepository(vscode.Uri.file(p)).then(
        (r) => r || this.log.warn(`vcstool: VS Code did not open ${p}`),
        (e) => this.log.warn(`vcstool: cannot open ${p}: ${e}`),
      );
    }
  }

  /** Paths of frozen repositories, which the Changed Repos panel lists in its own group. */
  frozenPaths(): Set<string> {
    const set = new Set<string>();
    for (const f of this.files) for (const e of f.entries) if (e.frozen) set.add(path.resolve(e.path));
    return set;
  }

  /** Drift sentences for a repository path (for its row in the panel). */
  driftNotes(repoPath: string): string[] {
    for (const f of this.files) {
      const e = f.entries.find((x) => pathsEqual(x.path, repoPath));
      if (e) return e.drift.filter(isRealDrift).map((d) => describeDrift(d, f.fileName));
    }
    return [];
  }

  /** Re-read only the frozen repositories' HEAD files ("Check"). */
  async check(): Promise<void> {
    this.pinnedCache.clear();
    this.versionCache.clear();
    await this.refresh();
  }

  // ----- git ----------------------------------------------------------------------

  /** Runs git in a repository; stdout on success, undefined on failure (logged). */
  async git_(cwd: string, args: string[], env?: Record<string, string>): Promise<string | undefined> {
    const r = await this.executor.execute({ args, cwd, env });
    if (r.success) return r.value.stdout;
    this.log.info(`vcstool: git ${args.join(' ')} in ${cwd}: ${r.error.message}`);
    return undefined;
  }

  /** Like git_, but returns the error message instead of swallowing it. */
  async gitOrError(cwd: string, args: string[], env?: Record<string, string>): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    const r = await this.executor.execute({ args, cwd, env });
    return r.success ? { ok: true, stdout: r.value.stdout } : { ok: false, error: r.error.message };
  }

  /** `git status --porcelain` file count (the match-day check and Restore use it on every repository). */
  async countChanges(p: string): Promise<number | undefined> {
    const out = await this.git_(p, ['status', '--porcelain', '--untracked-files=normal']);
    return out === undefined ? undefined : out.split('\n').filter((l) => l.trim()).length;
  }

  /** Is the commit on any remote branch? undefined when git could not answer. */
  async onRemote(p: string, commit: string): Promise<boolean | undefined> {
    const out = await this.git_(p, ['branch', '-r', '--contains', commit]);
    return out === undefined ? undefined : out.trim().length > 0;
  }

  /** What the Changed Repos page draws for the .repos files (plain data; see resources/changed-repos/view.js). */
  viewState(): VcsView[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const git = vscode.workspace.getConfiguration('git');
    const detection = git.inspect('autoRepositoryDetection');
    const recommend =
      detection?.workspaceValue !== false || git.inspect('repositoryScanMaxDepth')?.workspaceValue !== undefined;
    return this.files.map((f) => {
      const rel = (p: string) => (root ? path.relative(root, p) || '.' : p);
      const frozen = f.entries.filter((e) => e.frozen);
      return {
        file: f.filePath,
        fileName: f.fileName,
        summary: f.summary,
        error: f.error,
        target: { display: rel(f.targetFolder), auto: f.targetAuto, found: f.targetFound, total: f.entries.length },
        lock: VcsToolWorkspace.lockState(f),
        recommendSettings: recommend,
        missing: f.entries
          .filter((e) => e.drift.some((d) => d.kind === 'missing'))
          .map((e) => ({ name: e.entry.name, path: e.path, version: e.entry.version ?? '' })),
        unsupported: f.entries
          .filter((e) => e.drift.some((d) => d.kind === 'unsupported'))
          .map((e) => ({ name: e.entry.name, type: e.entry.type ?? '' })),
        extras: f.extras,
        frozen: frozen
          .filter((e) => !e.drift.some((d) => d.kind === 'missing' || d.kind === 'unsupported'))
          .map((e) => ({ name: e.entry.name, path: e.path, version: e.entry.version ?? '', openInGit: e.openInGit, ...VcsToolWorkspace.frozenNote(e, f.fileName) })),
      };
    });
  }

  /** The file's lock state for the panel header. */
  static lockState(f: VcsFileState): 'locked' | 'partly' | 'unlocked' {
    const git = f.entries.filter((e) => (e.entry.type ?? 'git') === 'git');
    const locked = git.filter((e) => !!lockedFrom(e.entry)).length;
    if (locked === 0) return 'unlocked';
    return locked === git.filter((e) => !e.frozen || lockedFrom(e.entry)).length ? 'locked' : 'partly';
  }

  /** One sentence for a frozen repository's row. */
  static frozenNote(e: VcsEntryState, fileName: string): { warn: boolean; note: string } {
    const notes = e.drift.map((d) => describeDrift(d, fileName));
    if ((e.facts.changes ?? 0) > 0) notes.push(`${e.facts.changes} uncommitted file${e.facts.changes === 1 ? '' : 's'}`);
    // On its pin the row's version says it all; only a difference needs words.
    return notes.length > 0 ? { warn: true, note: notes.join(' · ') } : { warn: false, note: '' };
  }
}
