import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseReposFile, type ReposEntry } from '../reposFile.js';
import {
  chooseTargetFolder,
  computeDrift,
  describeDrift,
  entryNameFor,
  findExtras,
  isFrozen,
  matchDayProblems,
  normalizeFreeze,
  normalizeRemoteUrl,
  parseStatusV2,
  planLock,
  planUnlock,
  sameRemote,
  summaryLine,
  targetFolderCandidates,
  type RepoFacts,
} from '../model.js';

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';

function entries(yaml: string): ReposEntry[] {
  const r = parseReposFile(`repositories:\n${yaml}`);
  if (!r.ok) throw new Error(r.error);
  return r.file.entries;
}
const [BRANCH, PINNED, LOCKED, HG] = entries(
  [
    '  hmi:\n    type: git\n    url: git@github.com:HMU-Robotics/hmi.git\n    version: jazzy',
    `  ruckig:\n    type: git\n    url: git@github.com:pantor/ruckig.git\n    version: ${H1}`,
    `  my_bot:\n    type: git\n    url: git@github.com:HMU-Robotics/my_bot.git\n    version: ${H1}  # locked: jazzy`,
    '  old:\n    type: svn\n    url: https://svn/x',
  ].join('\n'),
);

const onBranch = (branch: string, commit = H1): RepoFacts => ({ exists: true, head: { kind: 'branch', branch, commit } });

describe('freeze', () => {
  it('normalizes the setting', () => {
    expect(normalizeFreeze(undefined)).toBe('pinned');
    expect(normalizeFreeze('none')).toBe('none');
    expect(normalizeFreeze(['a', ' ', 3, ' b '])).toEqual(['a', 'b']);
  });

  it('freezes hand-pinned entries but not entries our Lock pinned', () => {
    expect(isFrozen(PINNED, 'pinned')).toBe(true);
    expect(isFrozen(LOCKED, 'pinned')).toBe(false);
    expect(isFrozen(BRANCH, 'pinned')).toBe(false);
    expect(isFrozen(PINNED, 'none')).toBe(false);
    expect(isFrozen(BRANCH, ['hmi'])).toBe(true);
  });
});

describe('target folder', () => {
  it('chooses the candidate where most entries exist; ties keep the first', () => {
    const on = new Set(['/ws/ros_ws/src/a', '/ws/ros_ws/src/b', '/ws/a'].map((p) => path.resolve(p)));
    const exists = (p: string) => on.has(path.resolve(p));
    const c = targetFolderCandidates('/ws/ros_ws.repos', '/ws');
    expect(c).toEqual(['/ws', '/ws/src', '/ws/ros_ws/src'].map((p) => path.join(p)));
    expect(chooseTargetFolder(c, ['a', 'b'], exists)).toEqual({ folder: path.resolve('/ws/ros_ws/src'), found: 2 });
    expect(chooseTargetFolder(c, ['x'], exists)).toEqual({ folder: path.resolve('/ws'), found: 0 });
  });
});

describe('remote urls', () => {
  it.each([
    ['git@github.com:HMU-Robotics/hmi.git', 'github.com/hmu-robotics/hmi'],
    ['https://github.com/HMU-Robotics/hmi', 'github.com/hmu-robotics/hmi'],
    ['https://user@github.com/HMU-Robotics/hmi.git/', 'github.com/hmu-robotics/hmi'],
    ['ssh://git@github.com:22/HMU-Robotics/hmi.git', 'github.com/hmu-robotics/hmi'],
    ['/home/me/.remotes/hmi.git', '/home/me/.remotes/hmi'],
  ])('%s → %s', (url, norm) => expect(normalizeRemoteUrl(url)).toBe(norm));

  it('treats ssh and https of one repository as the same remote', () => {
    expect(sameRemote('git@github.com:a/b.git', 'https://github.com/a/b')).toBe(true);
    expect(sameRemote('git@github.com:a/b.git', 'git@github.com:a/c.git')).toBe(false);
  });
});

describe('computeDrift', () => {
  it('is empty when on the expected branch with the same origin', () => {
    expect(computeDrift(BRANCH, { ...onBranch('jazzy'), originUrl: 'https://github.com/HMU-Robotics/hmi' })).toEqual([]);
  });

  it('reports a different branch and a detached HEAD', () => {
    expect(computeDrift(BRANCH, onBranch('main'))).toEqual([{ kind: 'branch', expected: 'jazzy', actual: 'main' }]);
    expect(computeDrift(BRANCH, { exists: true, head: { kind: 'detached', commit: H2 } })).toEqual([
      { kind: 'branch', expected: 'jazzy', actual: 'detached at 22222222' },
    ]);
  });

  it('accepts a detached checkout of the tag the file names', () => {
    expect(computeDrift(BRANCH, { exists: true, head: { kind: 'detached', commit: H2 }, versionCommit: H2 })).toEqual([]);
  });

  it('compares pinned commits, by prefix, with ahead/behind when known', () => {
    expect(computeDrift(PINNED, onBranch('x', H1))).toEqual([]);
    const [short] = entries('  a:\n    version: 1111111');
    expect(computeDrift(short, onBranch('x', H1))).toEqual([]);
    expect(computeDrift(PINNED, { ...onBranch('x', H2), pinned: { ahead: 2, behind: 0 } })[0]).toMatchObject({ relation: 'ahead', ahead: 2 });
    expect(computeDrift(PINNED, { ...onBranch('x', H2), pinned: { ahead: 0, behind: 3 } })[0]).toMatchObject({ relation: 'behind' });
    expect(computeDrift(PINNED, { ...onBranch('x', H2), pinned: { ahead: 1, behind: 1 } })[0]).toMatchObject({ relation: 'diverged' });
    expect(computeDrift(PINNED, onBranch('x', H2))[0]).toMatchObject({ relation: 'different' });
  });

  it('reports a different origin', () => {
    expect(computeDrift(BRANCH, { ...onBranch('jazzy'), originUrl: 'git@github.com:fork/hmi.git' })).toEqual([
      { kind: 'url', expected: 'git@github.com:HMU-Robotics/hmi.git', actual: 'git@github.com:fork/hmi.git' },
    ]);
  });

  it('reports missing, not-a-repository and unsupported types first and alone', () => {
    expect(computeDrift(BRANCH, { exists: false, head: { kind: 'notGit' } })).toEqual([{ kind: 'missing' }]);
    expect(computeDrift(BRANCH, { exists: true, head: { kind: 'notGit' } })).toEqual([{ kind: 'notGit' }]);
    expect(computeDrift(HG, { exists: false, head: { kind: 'notGit' } })).toEqual([{ kind: 'unsupported', type: 'svn' }]);
  });

  it('describes drift in a sentence', () => {
    expect(describeDrift({ kind: 'branch', expected: 'jazzy', actual: 'main' }, 'ros_ws.repos')).toBe('on main, ros_ws.repos says jazzy');
    expect(describeDrift({ kind: 'commit', expected: H1, actual: H2, relation: 'ahead', ahead: 1, behind: 0 }, 'f')).toBe('1 commit after the pinned 11111111');
    expect(describeDrift({ kind: 'commit', expected: H1, actual: H2, relation: 'different' }, 'f')).toBe('on 22222222, pinned 11111111');
  });
});

describe('summaryLine', () => {
  it('shows only the non-zero counts', () => {
    expect(summaryLine('ros_ws.repos', { repos: 27, drift: 2, missing: 1, extra: 0, unsupported: 0 })).toBe('ros_ws.repos · 27 repos · 2 drift · 1 missing');
    expect(summaryLine('a.repos', { repos: 3, drift: 0, missing: 0, extra: 1, unsupported: 1 })).toBe('a.repos · 3 repos · 1 not in file · 1 not supported');
  });
});

describe('extras', () => {
  it('lists found repositories that are not entries and not excluded', () => {
    expect(findExtras(['/s/b', '/s/a', '/s/x'], ['/s/a'], ['/s/x'])).toEqual([path.resolve('/s/b')]);
    expect(entryNameFor('/s', '/s/drivers/lidar')).toBe('drivers/lidar');
  });
});

describe('planLock', () => {
  it('writes each commit, remembers the branch, keeps hand pins without a marker', () => {
    const plan = planLock([
      { entry: BRANCH, exists: true, head: { kind: 'branch', branch: 'jazzy', commit: H2 }, onRemote: true },
      { entry: PINNED, exists: true, head: { kind: 'detached', commit: H1 }, onRemote: true },
      { entry: LOCKED, exists: true, head: { kind: 'branch', branch: 'jazzy', commit: H2 }, onRemote: true },
      { entry: HG, exists: false, head: { kind: 'notGit' } },
    ]);
    expect([...plan.edits]).toEqual([
      ['hmi', { version: H2, comment: 'locked: jazzy' }],
      ['ruckig', { version: H1, comment: undefined }],
      ['my_bot', { version: H2, comment: 'locked: jazzy' }],
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.skipped).toEqual([{ name: 'old', reason: 'type "svn" is not supported' }]);
  });

  it('refuses commits that are not on the remote, missing repositories and failed checks', () => {
    const plan = planLock([
      { entry: BRANCH, exists: true, head: { kind: 'branch', branch: 'jazzy', commit: H2 }, onRemote: false },
      { entry: PINNED, exists: false, head: { kind: 'notGit' } },
      { entry: LOCKED, exists: true, head: { kind: 'branch', branch: 'jazzy', commit: H2 }, onRemote: undefined },
    ]);
    expect(plan.blockers.map((b) => b.name)).toEqual(['hmi', 'ruckig', 'my_bot']);
    expect(plan.blockers[0].reason).toMatch(/not on the remote/);
  });
});

describe('planUnlock', () => {
  it('writes the current branch back only for entries our Lock pinned', () => {
    const plan = planUnlock([
      { entry: LOCKED, exists: true, head: { kind: 'branch', branch: 'feature', commit: H1 } },
      { entry: PINNED, exists: true, head: { kind: 'detached', commit: H1 } },
    ]);
    expect([...plan.edits]).toEqual([['my_bot', { version: 'feature', comment: null }]]);
  });

  it('uses the remembered branch for a detached repository', () => {
    const plan = planUnlock([{ entry: LOCKED, exists: true, head: { kind: 'detached', commit: H1 } }]);
    expect(plan.edits.get('my_bot')).toEqual({ version: 'jazzy', comment: null });
    expect(plan.skipped).toHaveLength(1);
  });
});

describe('matchDayProblems', () => {
  const base = (entry: ReposEntry, facts: RepoFacts, extra: Partial<{ frozen: boolean; pinnedOnRemote: boolean }> = {}) => ({
    entry,
    path: `/s/${entry.name}`,
    frozen: extra.frozen ?? false,
    facts,
    drift: computeDrift(entry, facts),
    pinnedOnRemote: extra.pinnedOnRemote,
  });

  it('is empty for a clean, pushed, matching workspace', () => {
    expect(matchDayProblems([base(BRANCH, { ...onBranch('jazzy'), changes: 0, hasUpstream: true, ahead: 0 })], [], 'f')).toEqual([]);
  });

  it('lists every kind of problem with its fix', () => {
    const problems = matchDayProblems(
      [
        base(BRANCH, { ...onBranch('main'), changes: 2, hasUpstream: true, ahead: 1 }),
        base(PINNED, { exists: false, head: { kind: 'notGit' } }),
        base(LOCKED, { ...onBranch('jazzy', H1), changes: 0, hasUpstream: true, ahead: 0 }, { pinnedOnRemote: false }),
        base(entries('  t:\n    version: jazzy')[0], { exists: true, head: { kind: 'detached', commit: H2 }, changes: 1 }, { frozen: true }),
      ],
      [{ name: 'extra_pkg', path: '/s/extra_pkg' }],
      'ros_ws.repos',
    );
    expect(problems.map((p) => [p.repo, p.message, p.fix])).toEqual([
      ['hmi', '2 uncommitted files', 'openScm'],
      ['hmi', '1 commit not pushed', 'push'],
      ['hmi', 'on main, ros_ws.repos says jazzy', 'checkout'],
      ['ruckig', 'missing — listed in ros_ws.repos but not on disk', 'clone'],
      ['my_bot', 'pinned commit 11111111 is not on the remote', 'push'],
      ['t', '1 uncommitted file', 'openTerminal'],
      ['t', 'detached HEAD at 22222222', 'checkout'],
      ['t', 'on detached at 22222222, ros_ws.repos says jazzy', 'checkout'],
      ['extra_pkg', 'not in ros_ws.repos', 'addToFile'],
    ]);
  });

  it('does not call a detached HEAD a problem when the file pins a commit', () => {
    expect(matchDayProblems([base(PINNED, { exists: true, head: { kind: 'detached', commit: H1 }, changes: 0 })], [], 'f')).toEqual([]);
  });

  it('reports an unpublished branch', () => {
    const p = matchDayProblems([base(BRANCH, { ...onBranch('jazzy'), changes: 0, hasUpstream: false })], [], 'f');
    expect(p.map((x) => x.fix)).toEqual(['push']);
  });
});

describe('parseStatusV2', () => {
  it('reads changes, upstream and ahead/behind', () => {
    const out = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head jazzy',
      '# branch.upstream origin/jazzy',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 a a src/x.cpp',
      '? new.txt',
      '',
    ].join('\n');
    expect(parseStatusV2(out)).toEqual({ changes: 2, hasUpstream: true, ahead: 2, behind: 1 });
  });

  it('has no upstream on a detached or unpublished HEAD', () => {
    expect(parseStatusV2('# branch.oid 1111\n# branch.head (detached)\n')).toEqual({ changes: 0, hasUpstream: false, ahead: undefined, behind: undefined });
  });
});
