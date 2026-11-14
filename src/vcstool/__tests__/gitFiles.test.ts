import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { findRepoRoot, parsePackedRefs, parseRemoteUrl, readHead, readOriginUrl, type FileReader } from '../gitFiles.js';

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';

function fakeFs(files: Record<string, string>): FileReader {
  const norm = Object.fromEntries(Object.entries(files).map(([k, v]) => [path.resolve(k), v]));
  return { readFile: (p) => norm[path.resolve(p)] };
}

describe('readHead', () => {
  it('reads a branch from a loose ref', () => {
    const fs = fakeFs({ '/r/.git/HEAD': 'ref: refs/heads/jazzy\n', '/r/.git/refs/heads/jazzy': `${H1}\n` });
    expect(readHead('/r', fs)).toEqual({ kind: 'branch', branch: 'jazzy', commit: H1 });
  });

  it('falls back to packed-refs', () => {
    const fs = fakeFs({
      '/r/.git/HEAD': 'ref: refs/heads/feat/x\n',
      '/r/.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${H2} refs/heads/feat/x\n^${H1}\n`,
    });
    expect(readHead('/r', fs)).toEqual({ kind: 'branch', branch: 'feat/x', commit: H2 });
  });

  it('reports a branch without commits (new repository)', () => {
    expect(readHead('/r', fakeFs({ '/r/.git/HEAD': 'ref: refs/heads/main\n' }))).toEqual({ kind: 'branch', branch: 'main', commit: undefined });
  });

  it('reads a detached HEAD', () => {
    expect(readHead('/r', fakeFs({ '/r/.git/HEAD': `${H1}\n` }))).toEqual({ kind: 'detached', commit: H1 });
  });

  it('follows a gitdir file and a linked worktree commondir', () => {
    const fs = fakeFs({
      '/w/.git': 'gitdir: /main/.git/worktrees/w\n',
      '/main/.git/worktrees/w/HEAD': 'ref: refs/heads/topic\n',
      '/main/.git/worktrees/w/commondir': '../..\n',
      '/main/.git/refs/heads/topic': H2,
    });
    expect(readHead('/w', fs)).toEqual({ kind: 'branch', branch: 'topic', commit: H2 });
  });

  it('resolves a relative gitdir', () => {
    const fs = fakeFs({ '/ws/src/a/.git': 'gitdir: ../../.git/modules/a', '/ws/.git/modules/a/HEAD': H1 });
    expect(readHead('/ws/src/a', fs)).toEqual({ kind: 'detached', commit: H1 });
  });

  it('is notGit for a plain folder', () => {
    expect(readHead('/r', fakeFs({}))).toEqual({ kind: 'notGit' });
  });
});

describe('parsePackedRefs', () => {
  it('skips comments and peeled lines', () => {
    expect([...parsePackedRefs(`# x\n${H1} refs/tags/v1\n^${H2}\n${H2} refs/remotes/origin/main\n`)]).toEqual([
      ['refs/tags/v1', H1],
      ['refs/remotes/origin/main', H2],
    ]);
  });
});

describe('parseRemoteUrl / readOriginUrl', () => {
  const CONFIG = `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://u/x.git\n[remote "origin"]\n\turl = git@github.com:HMU-Robotics/hmi.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  it('reads the origin url', () => {
    expect(parseRemoteUrl(CONFIG)).toBe('git@github.com:HMU-Robotics/hmi.git');
    expect(parseRemoteUrl(CONFIG, 'upstream')).toBe('https://u/x.git');
    expect(parseRemoteUrl(CONFIG, 'none')).toBeUndefined();
  });
  it('reads it through the repository', () => {
    expect(readOriginUrl('/r', fakeFs({ '/r/.git/HEAD': H1, '/r/.git/config': CONFIG }))).toBe('git@github.com:HMU-Robotics/hmi.git');
  });
});

describe('findRepoRoot', () => {
  it('walks up to the folder with .git', () => {
    const fs = fakeFs({ '/ws/.git/HEAD': H1 });
    expect(findRepoRoot('/ws/ros_ws', fs)).toBe(path.resolve('/ws'));
    expect(findRepoRoot('/elsewhere', fs)).toBeUndefined();
  });
});
