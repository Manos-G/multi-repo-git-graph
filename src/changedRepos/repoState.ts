// Pure helpers of the Changed Repos panel: they turn a vscode.git repository
// into the plain state the page draws. No `vscode` runtime import, so they can
// be unit-tested without VS Code (src/changedRepos/__tests__/).
import * as path from 'path';
import { GitStatus, type GitChange, type GitRepository } from './gitApi.js';
import type { VcsView } from '../vcstool/model.js';

export type GroupKind = 'merge' | 'index' | 'workingTree' | 'untracked';
export const GROUP_ORDER: GroupKind[] = ['merge', 'index', 'workingTree', 'untracked'];
export const GROUP_LABEL: Record<GroupKind, string> = {
  merge: 'Merge Changes',
  index: 'Staged Changes',
  workingTree: 'Changes',
  untracked: 'Untracked Changes',
};

/** The `multiRepoGraph.changedRepos.include*` settings that decide which repositories are listed. */
export interface AttentionOptions {
  includeUnpushed: boolean;
  includeBehind: boolean;
  includeNoUpstream: boolean;
}

export const repoName = (repo: GitRepository) => path.basename(repo.rootUri.fsPath);

export function branchLabel(repo: GitRepository): string {
  const head = repo.state.HEAD;
  if (head?.name) return head.name;
  if (head?.commit) return `${head.commit.slice(0, 8)} (detached)`;
  return '?';
}

export function groupChanges(repo: GitRepository, kind: GroupKind): GitChange[] {
  const s = repo.state;
  if (kind === 'merge') return s.mergeChanges;
  if (kind === 'index') return s.indexChanges;
  if (kind === 'workingTree') return s.workingTreeChanges;
  return s.untrackedChanges ?? [];
}

/** Number of distinct changed paths; a file both staged and modified counts once. */
export function fileCount(repo: GitRepository): number {
  const paths = new Set<string>();
  for (const g of GROUP_ORDER) for (const ch of groupChanges(repo, g)) paths.add(ch.uri.fsPath);
  return paths.size;
}

export function needsAttention(repo: GitRepository, opts: AttentionOptions): boolean {
  const head = repo.state.HEAD;
  return (
    fileCount(repo) > 0 ||
    (opts.includeUnpushed && (head?.ahead ?? 0) > 0) ||
    (opts.includeBehind && (head?.behind ?? 0) > 0) ||
    (opts.includeNoUpstream && !!head?.name && !head.upstream)
  );
}

/**
 * The repositories that Fetch All and Pull All work on: those whose current branch has an upstream.
 * A detached HEAD or an unpublished branch has nothing to fetch or pull from. Returns a new array.
 */
export function remoteRepos(repos: readonly GitRepository[]): GitRepository[] {
  return repos.filter((r) => !!r.state.HEAD?.upstream);
}

/**
 * The repositories that Push All works on: an upstream and at least one commit to push.
 * Branches without an upstream are left out on purpose: Push All never publishes (creates
 * remote branches); that stays a per-repository Publish Branch. Returns a new array.
 */
export function pushRepos(repos: readonly GitRepository[]): GitRepository[] {
  return remoteRepos(repos).filter((r) => (r.state.HEAD?.ahead ?? 0) > 0);
}

/** Status letter and color class, the same as the Source Control view uses. */
export function statusInfo(status: number, group: GroupKind): { letter: string; cls: string; deleted: boolean } {
  const S = GitStatus;
  switch (status) {
    case S.INDEX_MODIFIED:
      return { letter: 'M', cls: 'st-stage-modified', deleted: false };
    case S.MODIFIED:
    case S.TYPE_CHANGED:
      return { letter: status === S.TYPE_CHANGED ? 'T' : 'M', cls: 'st-modified', deleted: false };
    case S.INDEX_ADDED:
    case S.INTENT_TO_ADD:
      return { letter: 'A', cls: 'st-added', deleted: false };
    case S.INDEX_DELETED:
      return { letter: 'D', cls: 'st-stage-deleted', deleted: true };
    case S.DELETED:
      return { letter: 'D', cls: 'st-deleted', deleted: true };
    case S.INDEX_RENAMED:
    case S.INTENT_TO_RENAME:
      return { letter: 'R', cls: 'st-renamed', deleted: false };
    case S.INDEX_COPIED:
      return { letter: 'C', cls: 'st-added', deleted: false };
    case S.UNTRACKED:
      return { letter: 'U', cls: 'st-untracked', deleted: false };
    default:
      return { letter: group === 'merge' ? '!' : '?', cls: 'st-conflict', deleted: false };
  }
}

// ---------------------------------------------------------------------------
// State sent to the page
// ---------------------------------------------------------------------------

export interface FileState {
  path: string;
  name: string;
  dir: string;
  letter: string;
  cls: string;
  deleted: boolean;
}
export interface GroupState {
  kind: GroupKind;
  label: string;
  files: FileState[];
}
export interface RepoState {
  path: string;
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  unpublished: boolean;
  isWorkspaceRoot: boolean;
  message: string;
  fileCount: number;
  groups: GroupState[];
  /** How the repository differs from its .repos file (one sentence each); empty when it matches or is not listed. */
  drift?: string[];
}
export interface ViewState {
  repos: RepoState[];
  /** The vcstool .repos files (header, missing, extras, frozen group); see VcsToolWorkspace.viewState. */
  vcs?: VcsView[];
  total: number;
  changed: number;
  showAll: boolean;
}

export function repoState(repo: GitRepository, root: string | undefined): RepoState {
  const head = repo.state.HEAD;
  const groups: GroupState[] = [];
  for (const kind of GROUP_ORDER) {
    const changes = groupChanges(repo, kind);
    if (changes.length === 0) continue;
    groups.push({
      kind,
      label: GROUP_LABEL[kind],
      files: [...changes]
        .sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath))
        .map((c) => {
          const rel = path.relative(repo.rootUri.fsPath, c.uri.fsPath);
          const dir = path.dirname(rel);
          return { path: c.uri.fsPath, name: path.basename(rel), dir: dir === '.' ? '' : dir, ...statusInfo(c.status, kind) };
        }),
    });
  }
  return {
    path: repo.rootUri.fsPath,
    name: repoName(repo),
    branch: branchLabel(repo),
    ahead: head?.ahead ?? 0,
    behind: head?.behind ?? 0,
    hasUpstream: !!head?.upstream,
    unpublished: !!head?.name && !head.upstream,
    isWorkspaceRoot: repo.rootUri.fsPath === root,
    message: repo.inputBox.value,
    fileCount: fileCount(repo),
    groups,
  };
}
