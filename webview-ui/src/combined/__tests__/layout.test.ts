import { describe, it, expect } from 'vitest';
import type { CombinedCommit, LockLine } from '@shared/combinedGraph';
import { buildCombinedLayout, commitKey, type RepoStream } from '../layout';
import { findChangeSets } from '../changeSets';
import { timeRangeQuery } from '../timeRange';

const c = (hash: string, commitDate: number, parents: string[] = [], email = 'a@x'): CombinedCommit => ({
  hash,
  parents,
  author: email,
  authorEmail: email,
  authorDate: commitDate,
  commitDate,
  subject: `commit ${hash}`,
  refs: [],
});
const oneDay = () => ({ key: 'd', label: 'Today' });
const byTen = (s: number) => ({ key: String(Math.floor(s / 10)), label: `day ${Math.floor(s / 10)}` });

// Repo 0: a3 → a2 → a1 (dates 30, 20, 10). Repo 1: b2 → b1 (25, 15).
const A: RepoStream = { repo: 0, commits: [c('a3', 30, ['a2']), c('a2', 20, ['a1']), c('a1', 10)], hasMore: false };
const B: RepoStream = { repo: 1, commits: [c('b2', 25, ['b1']), c('b1', 15)], hasMore: false };

const keys = (rows: ReturnType<typeof buildCombinedLayout>['rows']) => rows.map((r) => (r.kind === 'commit' ? r.commit.hash : r.key));

describe('buildCombinedLayout', () => {
  it('merges repositories newest first by commit date, with a day header', () => {
    const l = buildCombinedLayout([A, B], [], { dotsOnly: false, day: oneDay });
    expect(keys(l.rows)).toEqual(['day:d', 'a3', 'b2', 'a2', 'b1', 'a1']);
    expect(l.frontier).toBeUndefined();
    expect(l.bands).toEqual([
      { repo: 0, offset: 0, width: 1 },
      { repo: 1, offset: 1, width: 1 },
    ]);
  });

  it('puts each repository in its own lane and color', () => {
    const l = buildCombinedLayout([A, B], [], { dotsOnly: false, day: oneDay });
    expect(l.topology.nodes.get(commitKey(0, 'a2'))).toMatchObject({ lane: 0, colorIndex: 0 });
    expect(l.topology.nodes.get(commitKey(1, 'b1'))).toMatchObject({ lane: 1, colorIndex: 1 });
  });

  it("draws a repository's line straight through the other repositories' rows", () => {
    const l = buildCombinedLayout([A, B], [], { dotsOnly: false, day: oneDay });
    const row = (h: string) => l.rows.findIndex((r) => r.kind === 'commit' && r.commit.hash === h);
    // a3 → a2 crosses b2's row in lane 0; b2 → b1 crosses a2's row in lane 1
    expect(l.topology.passingLanesByRow.get(row('b2'))).toEqual([{ lane: 0, colorIndex: 0 }]);
    expect(l.topology.passingLanesByRow.get(row('a2'))).toEqual([{ lane: 1, colorIndex: 1 }]);
    // nothing crosses the last row; the day header above everything has no lines either
    expect(l.topology.passingLanesByRow.get(row('a1'))).toEqual([]);
    expect(l.topology.passingLanesByRow.get(0)).toEqual([]);
  });

  it('keeps commits with the same hash in two repositories apart', () => {
    const X: RepoStream = { repo: 0, commits: [c('same', 10)], hasMore: false };
    const Y: RepoStream = { repo: 1, commits: [c('same', 10)], hasMore: false };
    const l = buildCombinedLayout([X, Y], [], { dotsOnly: false, day: oneDay });
    expect(l.rows.filter((r) => r.kind === 'commit').map((r) => r.key)).toEqual(['0:same', '1:same']);
  });

  it('stops at the frontier and names the repository that must load more', () => {
    const l = buildCombinedLayout([{ ...A, commits: A.commits.slice(0, 2), hasMore: true }, B], [], { dotsOnly: false, day: oneDay });
    expect(keys(l.rows)).toEqual(['day:d', 'a3', 'b2', 'a2']);
    expect(l.frontier).toBe(20);
    expect(l.bottleneck).toEqual([0]);
  });

  it('shows nothing while a repository has not loaded its first page', () => {
    const l = buildCombinedLayout([A, { repo: 1, commits: [], hasMore: true }], [], { dotsOnly: false, day: oneDay });
    expect(l.rows).toEqual([]);
    expect(l.bottleneck).toEqual([1]);
  });

  it('gives a repository with merges a wider band', () => {
    const M: RepoStream = { repo: 0, commits: [c('m', 30, ['p1', 'p2']), c('p2', 25, ['p1']), c('p1', 20)], hasMore: false };
    const l = buildCombinedLayout([M, B], [], { dotsOnly: false, day: oneDay });
    expect(l.bands[0].width).toBe(2);
    expect(l.bands[1].offset).toBe(2);
    expect(l.totalLanes).toBe(3);
  });

  it('places lock lines between the commits around their date, under their day', () => {
    const lock: LockLine = { hash: 'L', date: 22, subject: 'Lock versions for Match 1', file: 'ros_ws.repos' };
    const l = buildCombinedLayout([A, B], [lock], { dotsOnly: false, day: byTen });
    expect(keys(l.rows)).toEqual(['day:3', 'a3', 'day:2', 'b2', 'lock:L', 'a2', 'day:1', 'b1', 'a1']);
    const lockRow = l.rows.findIndex((r) => r.kind === 'lock');
    // both repositories' lines cross the lock row
    expect(l.topology.passingLanesByRow.get(lockRow)?.map((p) => p.lane).sort()).toEqual([0, 1]);
  });

  it('holds back a lock line below the frontier, and shows it once everything is loaded', () => {
    const lock: LockLine = { hash: 'L', date: 5, subject: 'Lock', file: 'f' };
    const partial = buildCombinedLayout([{ ...A, hasMore: true }, B], [lock], { dotsOnly: false, day: oneDay });
    expect(partial.rows.some((r) => r.kind === 'lock')).toBe(false);
    const full = buildCombinedLayout([A, B], [lock], { dotsOnly: false, day: oneDay });
    expect(keys(full.rows).at(-1)).toBe('lock:L');
  });

  it('draws dots only when filters hide commits', () => {
    const l = buildCombinedLayout([A, B], [], { dotsOnly: true, day: oneDay });
    for (const n of l.topology.nodes.values()) {
      expect(n.parentConnections).toEqual([]);
      expect(n.hasConnectionFromAbove).toBe(false);
    }
    for (const lanes of l.topology.passingLanesByRow.values()) expect(lanes).toEqual([]);
  });

  it('caches topology through the injected function', () => {
    const calls: number[] = [];
    buildCombinedLayout([A, B], [], {
      dotsOnly: false,
      day: oneDay,
      topologyFor: (repo, commits) => {
        calls.push(repo);
        return { nodes: new Map(commits.map((x, i) => [x.hash, { hash: x.hash, lane: 0, colorIndex: 0, parentConnections: [], incomingConnections: [], hasConnectionFromAbove: i > 0 }])), maxLanes: 1, passingLanesByRow: new Map(), commitIndexByHash: new Map() };
      },
    });
    expect(calls).toEqual([0, 1]);
  });
});

describe('findChangeSets', () => {
  const it_ = (key: string, repo: number, email: string, date: number) => ({ key, repo, email, date });
  const W = 15 * 60;

  it('groups one author across repositories within the window', () => {
    const { sets, byKey } = findChangeSets(
      [it_('0:a', 0, 'Manos@x', 1000), it_('1:b', 1, 'manos@x', 1000 + 600), it_('2:c', 2, 'manos@x', 1000 + 850), it_('0:d', 0, 'manos@x', 9000)],
      W,
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ members: ['0:a', '1:b', '2:c'], repos: 3 });
    expect(byKey.get('0:d')).toBeUndefined();
  });

  it('never lets a set span more than the window, however steadily someone commits', () => {
    // a commit every 10 minutes for an hour, alternating two repositories
    const items = Array.from({ length: 7 }, (_, i) => it_(`${i % 2}:${i}`, i % 2, 'm@x', i * 600));
    const { sets } = findChangeSets(items, W);
    for (const s of sets) {
      const dates = s.members.map((k) => Number(k.split(':')[1]) * 600);
      expect(Math.max(...dates) - Math.min(...dates)).toBeLessThanOrEqual(W);
    }
    expect(sets.map((s) => s.members)).toEqual([['0:0', '1:1'], ['0:2', '1:3'], ['0:4', '1:5']]);
  });

  it('needs two repositories and one author', () => {
    expect(findChangeSets([it_('0:a', 0, 'm@x', 1), it_('0:b', 0, 'm@x', 2)], W).sets).toEqual([]);
    expect(findChangeSets([it_('0:a', 0, 'm@x', 1), it_('1:b', 1, 'e@x', 2)], W).sets).toEqual([]);
  });

  it('respects the window', () => {
    expect(findChangeSets([it_('0:a', 0, 'm@x', 0), it_('1:b', 1, 'm@x', W + 1)], W).sets).toEqual([]);
    expect(findChangeSets([it_('0:a', 0, 'm@x', 0), it_('1:b', 1, 'm@x', W)], W).sets).toHaveLength(1);
  });
});

describe('timeRangeQuery', () => {
  const now = new Date(2026, 10, 14, 15, 30); // Saturday 14 Nov 2026, local time
  const s = (d: Date) => Math.floor(d.getTime() / 1000);

  it('today starts at local midnight', () => {
    expect(timeRangeQuery({ kind: 'today' }, now, undefined)).toEqual({ since: s(new Date(2026, 10, 14)) });
  });
  it('this week starts on Monday', () => {
    expect(timeRangeQuery({ kind: 'week' }, now, undefined)).toEqual({ since: s(new Date(2026, 10, 9)) });
    expect(timeRangeQuery({ kind: 'week' }, new Date(2026, 10, 9, 8), undefined)).toEqual({ since: s(new Date(2026, 10, 9)) });
  });
  it('since the last lock, or nothing without one', () => {
    expect(timeRangeQuery({ kind: 'sinceLock' }, now, 12345)).toEqual({ since: 12345 });
    expect(timeRangeQuery({ kind: 'sinceLock' }, now, undefined)).toEqual({});
  });
  it('custom covers whole days', () => {
    expect(timeRangeQuery({ kind: 'custom', from: '2026-11-01', to: '2026-11-03' }, now, undefined)).toEqual({
      since: s(new Date(2026, 10, 1)),
      until: s(new Date(2026, 10, 4)),
    });
    expect(timeRangeQuery({ kind: 'custom', from: 'bad' }, now, undefined)).toEqual({ since: undefined, until: undefined });
  });
  it('all has no limits', () => {
    expect(timeRangeQuery({ kind: 'all' }, now, 1)).toEqual({});
  });
});
