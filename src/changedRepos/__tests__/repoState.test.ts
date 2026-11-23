import { describe, it, expect } from 'vitest';
import { GitStatus, type GitBranch, type GitChange, type GitRepository } from '../gitApi.js';
import {
  branchLabel,
  buildFileTree,
  fileCount,
  isInFolder,
  needsAttention,
  pushRepos,
  remoteRepos,
  repoState,
  statusInfo,
  type AttentionOptions,
} from '../repoState.js';

// Minimal fakes: the helpers only read `fsPath` from a Uri and plain fields from the state.
const uri = (fsPath: string) => ({ fsPath }) as unknown as GitChange['uri'];
const change = (fsPath: string, status: number, originalPath = fsPath): GitChange => ({
  uri: uri(fsPath),
  originalUri: uri(originalPath),
  renameUri: undefined,
  status,
});

interface FakeRepo {
  root?: string;
  head?: GitBranch;
  merge?: GitChange[];
  index?: GitChange[];
  workingTree?: GitChange[];
  untracked?: GitChange[];
  message?: string;
}

function fakeRepo(r: FakeRepo = {}): GitRepository {
  return {
    rootUri: uri(r.root ?? '/ws/repo-a'),
    inputBox: { value: r.message ?? '' },
    state: {
      HEAD: r.head,
      mergeChanges: r.merge ?? [],
      indexChanges: r.index ?? [],
      workingTreeChanges: r.workingTree ?? [],
      untrackedChanges: r.untracked,
      onDidChange: () => ({ dispose() {} }),
    },
  } as unknown as GitRepository;
}

const ALL_ON: AttentionOptions = { includeUnpushed: true, includeBehind: true, includeNoUpstream: true };
const ALL_OFF: AttentionOptions = { includeUnpushed: false, includeBehind: false, includeNoUpstream: false };
const tracked = (ahead = 0, behind = 0): GitBranch => ({
  name: 'main',
  commit: 'abcdef1234567890',
  upstream: { remote: 'origin', name: 'main' },
  ahead,
  behind,
});

describe('statusInfo', () => {
  it.each([
    [GitStatus.INDEX_MODIFIED, 'index', 'M', 'st-stage-modified', false],
    [GitStatus.MODIFIED, 'workingTree', 'M', 'st-modified', false],
    [GitStatus.TYPE_CHANGED, 'workingTree', 'T', 'st-modified', false],
    [GitStatus.INDEX_ADDED, 'index', 'A', 'st-added', false],
    [GitStatus.INTENT_TO_ADD, 'workingTree', 'A', 'st-added', false],
    [GitStatus.INDEX_DELETED, 'index', 'D', 'st-stage-deleted', true],
    [GitStatus.DELETED, 'workingTree', 'D', 'st-deleted', true],
    [GitStatus.INDEX_RENAMED, 'index', 'R', 'st-renamed', false],
    [GitStatus.INTENT_TO_RENAME, 'workingTree', 'R', 'st-renamed', false],
    [GitStatus.INDEX_COPIED, 'index', 'C', 'st-added', false],
    [GitStatus.UNTRACKED, 'untracked', 'U', 'st-untracked', false],
  ] as const)('status %i in %s → %s', (status, group, letter, cls, deleted) => {
    expect(statusInfo(status, group)).toEqual({ letter, cls, deleted });
  });

  it('marks a conflict with "!" in the merge group', () => {
    expect(statusInfo(GitStatus.BOTH_MODIFIED, 'merge')).toEqual({ letter: '!', cls: 'st-conflict', deleted: false });
  });

  it('marks an unknown status outside the merge group with "?"', () => {
    expect(statusInfo(GitStatus.IGNORED, 'workingTree')).toEqual({ letter: '?', cls: 'st-conflict', deleted: false });
  });
});

describe('fileCount', () => {
  it('is 0 for a clean repository', () => {
    expect(fileCount(fakeRepo())).toBe(0);
  });

  it('counts a path that is both staged and modified once', () => {
    const repo = fakeRepo({
      index: [change('/ws/repo-a/a.txt', GitStatus.INDEX_MODIFIED)],
      workingTree: [change('/ws/repo-a/a.txt', GitStatus.MODIFIED), change('/ws/repo-a/b.txt', GitStatus.MODIFIED)],
    });
    expect(fileCount(repo)).toBe(2);
  });

  it('includes merge and separate untracked changes', () => {
    const repo = fakeRepo({
      merge: [change('/ws/repo-a/m.txt', GitStatus.BOTH_MODIFIED)],
      untracked: [change('/ws/repo-a/new.txt', GitStatus.UNTRACKED)],
    });
    expect(fileCount(repo)).toBe(2);
  });
});

describe('needsAttention', () => {
  it('lists a repository with changed files even when every option is off', () => {
    const repo = fakeRepo({ head: tracked(), workingTree: [change('/ws/repo-a/a.txt', GitStatus.MODIFIED)] });
    expect(needsAttention(repo, ALL_OFF)).toBe(true);
  });

  it('does not list a clean, in-sync repository', () => {
    expect(needsAttention(fakeRepo({ head: tracked() }), ALL_ON)).toBe(false);
  });

  it('lists commits to push only with includeUnpushed', () => {
    const repo = fakeRepo({ head: tracked(2, 0) });
    expect(needsAttention(repo, { ...ALL_OFF, includeUnpushed: true })).toBe(true);
    expect(needsAttention(repo, { ...ALL_ON, includeUnpushed: false })).toBe(false);
  });

  it('lists commits to pull only with includeBehind', () => {
    const repo = fakeRepo({ head: tracked(0, 3) });
    expect(needsAttention(repo, { ...ALL_OFF, includeBehind: true })).toBe(true);
    expect(needsAttention(repo, { ...ALL_ON, includeBehind: false })).toBe(false);
  });

  it('lists a branch without upstream only with includeNoUpstream', () => {
    const repo = fakeRepo({ head: { name: 'feature' } });
    expect(needsAttention(repo, { ...ALL_OFF, includeNoUpstream: true })).toBe(true);
    expect(needsAttention(repo, { ...ALL_ON, includeNoUpstream: false })).toBe(false);
  });

  it('does not treat a detached HEAD as a branch without upstream', () => {
    expect(needsAttention(fakeRepo({ head: { commit: 'abcdef1234' } }), ALL_ON)).toBe(false);
  });
});

describe('remoteRepos (Fetch All / Pull All)', () => {
  it('keeps only repositories whose branch has an upstream, in order', () => {
    const a = fakeRepo({ root: '/ws/a', head: tracked() });
    const unpublished = fakeRepo({ root: '/ws/b', head: { name: 'feature' } });
    const detached = fakeRepo({ root: '/ws/c', head: { commit: 'abcdef1234' } });
    const noHead = fakeRepo({ root: '/ws/d' });
    const e = fakeRepo({ root: '/ws/e', head: tracked(0, 4) });
    expect(remoteRepos([a, unpublished, detached, noHead, e])).toEqual([a, e]);
  });

  it('returns a new array, so the caller can use it as a work queue', () => {
    const repos = [fakeRepo({ head: tracked() })];
    const queue = remoteRepos(repos);
    queue.shift();
    expect(repos).toHaveLength(1);
  });
});

describe('pushRepos (Push All)', () => {
  it('keeps only repositories with an upstream and commits to push', () => {
    const ahead = fakeRepo({ root: '/ws/a', head: tracked(2, 0) });
    const diverged = fakeRepo({ root: '/ws/b', head: tracked(1, 3) });
    const behindOnly = fakeRepo({ root: '/ws/c', head: tracked(0, 3) });
    const inSync = fakeRepo({ root: '/ws/d', head: tracked() });
    expect(pushRepos([ahead, diverged, behindOnly, inSync])).toEqual([ahead, diverged]);
  });

  it('never publishes a branch without an upstream', () => {
    const unpublished = fakeRepo({ head: { name: 'feature', ahead: 5 } });
    expect(pushRepos([unpublished])).toEqual([]);
  });
});

describe('branchLabel', () => {
  it('shows the branch name', () => {
    expect(branchLabel(fakeRepo({ head: tracked() }))).toBe('main');
  });

  it('shows a short hash for a detached HEAD', () => {
    expect(branchLabel(fakeRepo({ head: { commit: '0123456789abcdef' } }))).toBe('01234567 (detached)');
  });

  it('shows "?" when there is no HEAD yet', () => {
    expect(branchLabel(fakeRepo())).toBe('?');
  });
});

describe('repoState', () => {
  it('builds the groups in Source Control order, sorted by path, with relative names', () => {
    const repo = fakeRepo({
      root: '/ws/repo-a',
      head: tracked(1, 2),
      message: 'draft',
      merge: [change('/ws/repo-a/conflict.txt', GitStatus.BOTH_MODIFIED)],
      index: [change('/ws/repo-a/src/b.ts', GitStatus.INDEX_ADDED)],
      workingTree: [change('/ws/repo-a/z.txt', GitStatus.MODIFIED), change('/ws/repo-a/src/a.ts', GitStatus.DELETED)],
    });
    const s = repoState(repo, '/ws/repo-a');
    expect(s).toMatchObject({
      path: '/ws/repo-a',
      name: 'repo-a',
      branch: 'main',
      ahead: 1,
      behind: 2,
      hasUpstream: true,
      unpublished: false,
      isWorkspaceRoot: true,
      message: 'draft',
      fileCount: 4,
    });
    expect(s.groups.map((g) => [g.kind, g.label])).toEqual([
      ['merge', 'Merge Changes'],
      ['index', 'Staged Changes'],
      ['workingTree', 'Changes'],
    ]);
    expect(s.groups[2].files).toEqual([
      { path: '/ws/repo-a/src/a.ts', name: 'a.ts', dir: 'src', letter: 'D', cls: 'st-deleted', deleted: true },
      { path: '/ws/repo-a/z.txt', name: 'z.txt', dir: '', letter: 'M', cls: 'st-modified', deleted: false },
    ]);
  });

  it('leaves out empty groups and marks an unpublished branch', () => {
    const s = repoState(fakeRepo({ head: { name: 'feature' } }), '/ws/other');
    expect(s.groups).toEqual([]);
    expect(s).toMatchObject({ unpublished: true, hasUpstream: false, isWorkspaceRoot: false, ahead: 0, behind: 0 });
  });

  it('adds the separate Untracked Changes group when the Git extension fills it', () => {
    const s = repoState(fakeRepo({ untracked: [change('/ws/repo-a/new.txt', GitStatus.UNTRACKED)] }), undefined);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ kind: 'untracked', label: 'Untracked Changes' });
    expect(s.groups[0].files[0]).toMatchObject({ name: 'new.txt', letter: 'U', cls: 'st-untracked' });
  });
});

describe('buildFileTree', () => {
  // A readable picture of a tree: "name/" for a folder, file indexes as numbers.
  type Shape = (string | number | Shape)[];
  const shape = (n: ReturnType<typeof buildFileTree>): Shape => [
    ...n.folders.flatMap((f) => [f.name + '/', shape(f)]),
    ...n.files,
  ];

  it('puts files in their folders, folders first and sorted by name', () => {
    const tree = buildFileTree('/r', [['src'], [], ['docs'], ['src', 'b'], ['src']], true);
    expect(shape(tree)).toEqual(['docs/', [2], 'src/', ['b/', [3], 0, 4], 1]);
    expect(tree.path).toBe('/r');
    expect(tree.folders[1].folders[0].path).toBe('/r/src/b');
  });

  it('shows a chain of folders that only hold one folder as one row, keyed by the deepest folder', () => {
    const dirs = [
      ['Digital_image_processing', 'Lab 2026', 'Lab_1'],
      ['Digital_image_processing', 'Lab 2026', 'Lab_2'],
      ['Digital_image_processing', 'Lab 2026', 'Lab_2'],
    ];
    const tree = buildFileTree('/r', dirs, true);
    expect(shape(tree)).toEqual(['Digital_image_processing/Lab 2026/', ['Lab_1/', [0], 'Lab_2/', [1, 2]]]);
    expect(tree.folders[0].path).toBe('/r/Digital_image_processing/Lab 2026');
  });

  it('keeps every folder level when compact folders are off', () => {
    const tree = buildFileTree('/r', [['a', 'b', 'c']], false);
    expect(shape(tree)).toEqual(['a/', ['b/', ['c/', [0]]]]);
    expect(tree.folders[0].folders[0].folders[0].path).toBe('/r/a/b/c');
  });

  it('does not compact a folder that also holds files', () => {
    const tree = buildFileTree('/r', [['a'], ['a', 'b']], true);
    expect(shape(tree)).toEqual(['a/', ['b/', [1], 0]]);
  });
});

describe('isInFolder', () => {
  it.each([
    ['/r/src/a.ts', '/r/src', true],
    ['/r/src/deep/a.ts', '/r/src', true],
    ['/r/src', '/r/src', false],
    ['/r/srcx/a.ts', '/r/src', false],
    ['/r/other/a.ts', '/r/src', false],
    ['/r/..x/a.ts', '/r/..x', true],
  ])('%s in %s → %s', (file, folder, expected) => {
    expect(isInFolder(file, folder)).toBe(expected);
  });
});

describe('repoState tree view', () => {
  it('adds a tree to each group only in tree view mode', () => {
    const repo = fakeRepo({
      workingTree: [change('/ws/repo-a/src/util/a.ts', GitStatus.MODIFIED), change('/ws/repo-a/z.txt', GitStatus.MODIFIED)],
    });
    expect(repoState(repo, undefined).groups[0].tree).toBeUndefined();
    const tree = repoState(repo, undefined, { viewMode: 'tree' }).groups[0].tree!;
    expect(tree.folders.map((f) => [f.name, f.path, f.files])).toEqual([['src/util', '/ws/repo-a/src/util', [0]]]);
    expect(tree.files).toEqual([1]);
  });
});
