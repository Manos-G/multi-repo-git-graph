import { describe, it, expect } from 'vitest';
import { combinedLogArgs, findLockLines, isEmptyRepoError, lockSignature, parseCombinedLog } from '../combinedLog.js';

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';

describe('combinedLogArgs', () => {
  it('asks for one page of HEAD in date order', () => {
    expect(combinedLogArgs(0, 200, {})).toEqual([
      'log',
      '--date-order',
      '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00%D',
      '--decorate=full',
      '--max-count=200',
      'HEAD',
      '--',
    ]);
  });

  it('adds skip, the time range and the git-side filters', () => {
    const a = combinedLogArgs(400, 100, { since: 1000, until: 2000, author: 'manos', search: 'odom' });
    expect(a).toContain('--skip=400');
    expect(a).toContain('--since=@1000');
    expect(a).toContain('--until=@2000');
    expect(a).toContain('--author=manos');
    expect(a).toContain('--grep=odom');
    expect(a).toContain('--fixed-strings');
    expect(a.slice(-2)).toEqual(['HEAD', '--']);
  });
});

describe('parseCombinedLog', () => {
  it('parses commits with both dates and refs, and skips junk', () => {
    const out = [
      [H1, `${H2} ${H3}`, 'Manos G', 'manos@example.com', '100', '200', 'Merge feature', 'HEAD -> refs/heads/jazzy, tag: refs/tags/v1'].join('\0'),
      'not a commit',
      [H2, '', 'Eleni', 'e@x', '50', '60', 'Initial', ''].join('\0'),
      '',
    ].join('\n');
    const c = parseCombinedLog(out);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ hash: H1, parents: [H2, H3], authorDate: 100, commitDate: 200, subject: 'Merge feature' });
    expect(c[0].refs.map((r) => [r.type, r.name])).toEqual([
      ['head', 'jazzy'],
      ['tag', 'v1'],
    ]);
    expect(c[1].parents).toEqual([]);
  });

  it('recognises an empty repository', () => {
    expect(isEmptyRepoError("fatal: your current branch 'main' does not have any commits yet")).toBe(true);
    expect(isEmptyRepoError('fatal: bad object')).toBe(false);
  });
});

describe('lock lines', () => {
  const file = (version: string, marker: boolean) =>
    `repositories:\n  hmi:\n    type: git\n    url: u\n    version: ${version}${marker ? '  # locked: jazzy' : ''}\n  ruckig:\n    type: git\n    url: u\n    version: ${H3}\n`;

  it('signs only the entries locked by Lock', () => {
    expect(lockSignature(file('jazzy', false))).toBe('');
    expect(lockSignature(file(H1, true))).toBe(`hmi=${H1}`);
  });

  it('finds commits that changed the locked versions or say "Lock"', () => {
    const versions = [
      { hash: 'e', date: 50, subject: 'Unlock versions', text: file('jazzy', false) },
      { hash: 'd', date: 40, subject: 'Lock versions for Match 2', text: file(H2, true) },
      { hash: 'c', date: 30, subject: 'Fix url', text: file(H1, true) }, // markers unchanged → not a lock
      { hash: 'b', date: 20, subject: 'Lock versions for Match 1', text: file(H1, true) },
      { hash: 'a', date: 10, subject: 'Add ros_ws.repos', text: file('jazzy', false) },
    ];
    expect(findLockLines(versions, 'ros_ws.repos').map((l) => [l.hash, l.subject])).toEqual([
      ['d', 'Lock versions for Match 2'],
      ['b', 'Lock versions for Match 1'],
    ]);
  });

  it('accepts a lock done by hand when the message says so', () => {
    const versions = [{ hash: 'x', date: 1, subject: 'lock everything for the final', text: file('jazzy', false) }];
    expect(findLockLines(versions, 'f')).toHaveLength(1);
  });
});
