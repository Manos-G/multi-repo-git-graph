// PURE: every decision about a vcstool workspace that does not need VS Code or git:
// which folder the paths start in, which entries are frozen, how the disk differs from
// the file (drift), the panel's summary line, extra repositories, what Lock / Unlock
// write, and the match-day problem list. The I/O lives in VcsToolWorkspace.
import * as path from 'path';
import { isCommitHash, lockedFrom, LOCK_MARKER, type ReposEntry, type VersionEdit } from './reposFile.js';
import type { HeadState } from './gitFiles.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type FreezeSetting = 'pinned' | 'none' | string[];

export function normalizeFreeze(value: unknown): FreezeSetting {
  if (value === 'none') return 'none';
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  return 'pinned';
}

/**
 * A frozen repository is not opened in VS Code's Git support and is checked only by reading
 * its .git files. `pinned` freezes entries whose version is a commit hash — except entries our
 * own Lock pinned (`# locked: <branch>`), which are still worked on and must stay open.
 */
export function isFrozen(entry: ReposEntry, setting: FreezeSetting): boolean {
  if (setting === 'none') return false;
  if (Array.isArray(setting)) return setting.includes(entry.name) || setting.includes(path.posix.basename(entry.name));
  return isCommitHash(entry.version) && !lockedFrom(entry);
}

// ---------------------------------------------------------------------------
// Target folder
// ---------------------------------------------------------------------------

/**
 * Where the entry paths start: the candidate in which most entries exist. Ties keep the earlier
 * candidate, so the file's own folder wins when nothing is cloned yet.
 */
export function chooseTargetFolder(
  candidates: readonly string[],
  entryNames: readonly string[],
  exists: (p: string) => boolean,
): { folder: string; found: number } {
  const unique = [...new Set(candidates.map((c) => path.resolve(c)))];
  let best = { folder: unique[0] ?? '', found: -1 };
  for (const folder of unique) {
    const found = entryNames.filter((n) => exists(path.join(folder, n))).length;
    if (found > best.found) best = { folder, found };
  }
  return { folder: best.folder, found: Math.max(best.found, 0) };
}

/** The automatic candidates for a file: its folder, its `src/`, and `<workspace>/ros_ws/src`. */
export function targetFolderCandidates(reposFilePath: string, workspaceRoot: string | undefined): string[] {
  const dir = path.dirname(reposFilePath);
  const list = [dir, path.join(dir, 'src')];
  if (workspaceRoot) list.push(path.join(workspaceRoot, 'ros_ws', 'src'));
  return list;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * One comparable form for the ways a remote is written: `git@host:owner/repo.git`,
 * `ssh://git@host/owner/repo`, `https://user@host/owner/repo/` all become `host/owner/repo`.
 * Lower-cased, because the hosts this is used with (GitHub, GitLab) ignore case in paths.
 */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
    u = u.replace(/^([^/:]+):\d+\//, '$1/');
  }
  return u.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

export const sameRemote = (a: string, b: string) => normalizeRemoteUrl(a) === normalizeRemoteUrl(b);

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/** What is known about one repository on disk. Fields left undefined were not checked. */
export interface RepoFacts {
  exists: boolean;
  head: HeadState;
  originUrl?: string;
  /** Uncommitted files (from VS Code's Git state, or `git status` in the match-day check). */
  changes?: number;
  hasUpstream?: boolean;
  /** Commits not pushed to the upstream. */
  ahead?: number;
  behind?: number;
  /** Position relative to a pinned commit (`git rev-list --left-right --count pin...HEAD`). */
  pinned?: { ahead: number; behind: number };
  /** The commit a branch/tag version points to, when it was resolved (lets a tag checkout match). */
  versionCommit?: string;
}

export type Drift =
  | { kind: 'missing' }
  | { kind: 'notGit' }
  | { kind: 'unsupported'; type: string }
  | { kind: 'branch'; expected: string; actual: string }
  | { kind: 'commit'; expected: string; actual: string; relation: 'ahead' | 'behind' | 'diverged' | 'different'; ahead?: number; behind?: number }
  | { kind: 'url'; expected: string; actual: string };

const short = (h: string) => h.slice(0, 8);

export function headCommit(head: HeadState): string | undefined {
  return head.kind === 'branch' ? head.commit : head.kind === 'detached' ? head.commit : undefined;
}

export function computeDrift(entry: ReposEntry, facts: RepoFacts): Drift[] {
  const type = entry.type ?? 'git';
  if (type !== 'git') return [{ kind: 'unsupported', type }];
  if (!facts.exists) return [{ kind: 'missing' }];
  if (facts.head.kind === 'notGit') return [{ kind: 'notGit' }];

  const drift: Drift[] = [];
  const head = facts.head;
  const commit = headCommit(head);
  const version = entry.version?.trim();

  if (version && isCommitHash(version)) {
    if (!commit || !commit.toLowerCase().startsWith(version.toLowerCase())) {
      const p = facts.pinned;
      const relation = !p ? 'different' : p.ahead > 0 && p.behind === 0 ? 'ahead' : p.behind > 0 && p.ahead === 0 ? 'behind' : 'diverged';
      drift.push({ kind: 'commit', expected: version, actual: commit ?? '', relation, ahead: p?.ahead, behind: p?.behind });
    }
  } else if (version) {
    const onIt =
      (head.kind === 'branch' && head.branch === version) ||
      (head.kind === 'detached' && !!facts.versionCommit && head.commit === facts.versionCommit);
    if (!onIt) {
      drift.push({ kind: 'branch', expected: version, actual: head.kind === 'branch' ? head.branch : `detached at ${short(head.commit)}` });
    }
  }

  if (entry.url && facts.originUrl && !sameRemote(entry.url, facts.originUrl)) {
    drift.push({ kind: 'url', expected: entry.url, actual: facts.originUrl });
  }
  return drift;
}

export function describeDrift(d: Drift, fileName: string): string {
  switch (d.kind) {
    case 'missing':
      return 'missing';
    case 'notGit':
      return 'folder exists but is not a Git repository';
    case 'unsupported':
      return `type "${d.type}" is not supported`;
    case 'branch':
      return `on ${d.actual}, ${fileName} says ${d.expected}`;
    case 'url':
      return `origin is ${d.actual}, ${fileName} says ${d.expected}`;
    case 'commit': {
      const n = (k: number) => `${k} commit${k === 1 ? '' : 's'}`;
      if (d.relation === 'ahead') return `${n(d.ahead ?? 0)} after the pinned ${short(d.expected)}`;
      if (d.relation === 'behind') return `${n(d.behind ?? 0)} before the pinned ${short(d.expected)}`;
      if (d.relation === 'diverged') return `diverged from the pinned ${short(d.expected)} (${d.ahead}↑ ${d.behind}↓)`;
      return d.actual ? `on ${short(d.actual)}, pinned ${short(d.expected)}` : `no commit, pinned ${short(d.expected)}`;
    }
  }
}

/** Drift that the panel counts as "drift" (missing and unsupported are counted on their own). */
export const isRealDrift = (d: Drift) => d.kind === 'branch' || d.kind === 'commit' || d.kind === 'url' || d.kind === 'notGit';

export function summaryLine(fileName: string, counts: { repos: number; drift: number; missing: number; extra: number; unsupported: number }): string {
  const parts = [fileName, `${counts.repos} repos`];
  if (counts.drift) parts.push(`${counts.drift} drift`);
  if (counts.missing) parts.push(`${counts.missing} missing`);
  if (counts.extra) parts.push(`${counts.extra} not in file`);
  if (counts.unsupported) parts.push(`${counts.unsupported} not supported`);
  return parts.join(' · ');
}

/** Git repositories found in the target folder that the file does not list (and are not the main repository). */
export function findExtras(foundRepoPaths: readonly string[], entryPaths: readonly string[], exclude: readonly string[] = []): string[] {
  const known = new Set([...entryPaths, ...exclude].map((p) => path.resolve(p)));
  return foundRepoPaths.map((p) => path.resolve(p)).filter((p) => !known.has(p)).sort();
}

/** An entry key for a repository found on disk: its path relative to the target folder, with `/`. */
export function entryNameFor(targetFolder: string, repoPath: string): string {
  return path.relative(targetFolder, repoPath).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Lock / Unlock
// ---------------------------------------------------------------------------

export interface LockInput {
  entry: ReposEntry;
  exists: boolean;
  head: HeadState;
  /** Whether HEAD's commit is on a remote branch (after a fetch). undefined = could not be checked. */
  onRemote?: boolean;
}

export interface Blocker {
  name: string;
  reason: string;
}

export interface Plan {
  edits: Map<string, VersionEdit>;
  blockers: Blocker[];
  /** Entries left as they are, with why (shown, but they do not block). */
  skipped: Blocker[];
}

/**
 * `vcs export --exact`: every git entry gets the commit it is on. Refuses (blockers) when a
 * repository is missing, has no commit, or its commit is not on any remote — a locked file must
 * be reproducible by someone else. A branch version is replaced by its commit and remembered in
 * the `# locked: <branch>` comment, which Unlock and the freeze rule read.
 */
export function planLock(inputs: readonly LockInput[]): Plan {
  const edits = new Map<string, VersionEdit>();
  const blockers: Blocker[] = [];
  const skipped: Blocker[] = [];
  for (const { entry, exists, head, onRemote } of inputs) {
    if ((entry.type ?? 'git') !== 'git') {
      skipped.push({ name: entry.name, reason: `type "${entry.type}" is not supported` });
      continue;
    }
    if (!exists) {
      blockers.push({ name: entry.name, reason: 'missing on disk' });
      continue;
    }
    const commit = headCommit(head);
    if (head.kind === 'notGit' || !commit) {
      blockers.push({ name: entry.name, reason: head.kind === 'notGit' ? 'not a Git repository' : 'has no commit' });
      continue;
    }
    if (onRemote === false) {
      blockers.push({ name: entry.name, reason: `commit ${short(commit)} is not on the remote — push it first` });
      continue;
    }
    if (onRemote === undefined) {
      blockers.push({ name: entry.name, reason: 'could not check the remote (fetch failed)' });
      continue;
    }
    const from = lockedFrom(entry) ?? (entry.version && !isCommitHash(entry.version) ? entry.version : undefined);
    edits.set(entry.name, { version: commit, comment: from ? `${LOCK_MARKER} ${from}` : undefined });
  }
  return { edits, blockers, skipped };
}

/**
 * Write branch names back into the entries that Lock pinned (those with the `# locked:` comment):
 * the branch each repository is on now, or the remembered one when it is detached. Pins written by
 * hand (third-party libraries) are left alone.
 */
export function planUnlock(inputs: readonly LockInput[]): Plan {
  const edits = new Map<string, VersionEdit>();
  const skipped: Blocker[] = [];
  for (const { entry, head } of inputs) {
    const remembered = lockedFrom(entry);
    if (!remembered) continue;
    const branch = head.kind === 'branch' ? head.branch : remembered;
    edits.set(entry.name, { version: branch, comment: null });
    if (head.kind !== 'branch') skipped.push({ name: entry.name, reason: `detached — wrote back "${remembered}" from the lock comment` });
  }
  return { edits, blockers: [], skipped };
}

/** Whether a version of the file locked anything: some entry carries the lock comment. */
export const hasLockMarkers = (entries: readonly ReposEntry[]) => entries.some((e) => !!lockedFrom(e));

// ---------------------------------------------------------------------------
// Match-day check
// ---------------------------------------------------------------------------

export type FixAction = 'clone' | 'openScm' | 'push' | 'checkout' | 'reveal' | 'addToFile' | 'openTerminal';

export interface Problem {
  repo: string;
  path: string;
  message: string;
  fix?: FixAction;
  fixLabel?: string;
}

export interface MatchDayInput {
  entry: ReposEntry;
  path: string;
  frozen: boolean;
  facts: RepoFacts;
  drift: Drift[];
  /** For a pinned version: is that commit on a remote? undefined = not checked. */
  pinnedOnRemote?: boolean;
}

export function matchDayProblems(
  inputs: readonly MatchDayInput[],
  extras: readonly { name: string; path: string }[],
  fileName: string,
): Problem[] {
  const problems: Problem[] = [];
  for (const { entry, path: p, frozen, facts, drift, pinnedOnRemote } of inputs) {
    const add = (message: string, fix?: FixAction, fixLabel?: string) => problems.push({ repo: entry.name, path: p, message, fix, fixLabel });
    const fatal = drift.find((d) => d.kind === 'missing' || d.kind === 'notGit' || d.kind === 'unsupported');
    if (fatal) {
      if (fatal.kind === 'missing') add(`missing — listed in ${fileName} but not on disk`, 'clone', 'Clone');
      else if (fatal.kind === 'notGit') add(describeDrift(fatal, fileName), 'reveal', 'Reveal');
      else add(describeDrift(fatal, fileName));
      continue;
    }
    if ((facts.changes ?? 0) > 0) {
      add(`${facts.changes} uncommitted file${facts.changes === 1 ? '' : 's'}`, frozen ? 'openTerminal' : 'openScm', frozen ? 'Open in Terminal' : 'Open Changes');
    }
    if (facts.head.kind === 'branch') {
      if (facts.hasUpstream === false) add(`branch "${facts.head.branch}" is not published`, 'push', 'Publish');
      else if ((facts.ahead ?? 0) > 0) add(`${facts.ahead} commit${facts.ahead === 1 ? '' : 's'} not pushed`, 'push', 'Push');
    } else if (facts.head.kind === 'detached' && !isCommitHash(entry.version)) {
      add(`detached HEAD at ${short(facts.head.commit)}`, 'checkout', `Check Out ${entry.version ?? 'Branch'}`);
    }
    for (const d of drift) {
      if (d.kind === 'branch' || d.kind === 'commit') add(describeDrift(d, fileName), 'checkout', `Check Out ${d.kind === 'commit' ? short(d.expected) : d.expected}`);
      else if (d.kind === 'url') add(describeDrift(d, fileName), 'openTerminal', 'Open in Terminal');
    }
    if (isCommitHash(entry.version) && pinnedOnRemote === false) {
      add(`pinned commit ${short(entry.version!)} is not on the remote`, 'push', 'Push');
    }
  }
  for (const x of extras) {
    problems.push({ repo: x.name, path: x.path, message: `not in ${fileName}`, fix: 'addToFile', fixLabel: `Add to ${fileName}` });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// git status --porcelain=v2 --branch
// ---------------------------------------------------------------------------

export interface StatusSummary {
  changes: number;
  hasUpstream: boolean;
  ahead?: number;
  behind?: number;
}

/** One `git status --porcelain=v2 --branch` gives everything the match-day check needs per repository. */
export function parseStatusV2(out: string): StatusSummary {
  let changes = 0;
  let hasUpstream = false;
  let ahead: number | undefined;
  let behind: number | undefined;
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.upstream ')) hasUpstream = true;
    else if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (!line.startsWith('#')) changes++;
  }
  return { changes, hasUpstream, ahead, behind };
}

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

/** What the Changed Repos page draws for one .repos file (built by VcsToolWorkspace.viewState). */
export interface VcsView {
  file: string;
  fileName: string;
  summary: string;
  error?: string;
  target: { display: string; auto: boolean; found: number; total: number };
  lock: 'locked' | 'partly' | 'unlocked';
  /** Whether the workspace still lets VS Code open repositories on its own. */
  recommendSettings: boolean;
  missing: { name: string; path: string; version: string }[];
  unsupported: { name: string; type: string }[];
  extras: { name: string; path: string }[];
  frozen: { name: string; path: string; version: string; openInGit: boolean; warn: boolean; note: string }[];
}
