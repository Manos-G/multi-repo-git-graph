// PURE: the combined graph's rows and lanes.
//
// Each repository's history is laid out on its own with the normal graph's
// calculateTopology, then shifted into the repository's band of lanes and recolored
// with the repository's color. The bands are merged into one GraphTopology keyed by
// `<repo>:<hash>`, so the normal GraphCell draws a combined row unchanged: lines of
// repository A run straight through the rows of repository B as "passing" lanes.
//
// Rows are merged newest first by commit date. Only rows newer than the FRONTIER are
// shown: the newest "last loaded commit" among repositories that still have more. Below
// it, a repository that has not loaded far enough could still have commits that belong
// in between, so they wait for its next page (`bottleneck` names who must load).
import type { Commit } from '@shared/types';
import type { CombinedCommit, LockLine } from '@shared/combinedGraph';
import { calculateTopology, type CommitNode, type GraphTopology } from '../utils/graphTopology';

export interface RepoStream {
  /** Position in the repository list: band order and color index. */
  repo: number;
  commits: readonly CombinedCommit[];
  hasMore: boolean;
}

export type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'lock'; key: string; lock: LockLine }
  | { kind: 'commit'; key: string; repo: number; commit: CombinedCommit };

export interface Band {
  repo: number;
  offset: number;
  width: number;
}

export interface CombinedLayout {
  rows: Row[];
  topology: GraphTopology;
  /** Commits in GraphCell's shape (hash = row key, parents as keys), by row key. */
  graphCommits: Map<string, Commit>;
  bands: Band[];
  totalLanes: number;
  /** Commit-date cut (Unix seconds); undefined when everything loaded is shown. */
  frontier?: number;
  /** Repositories whose next page moves the frontier. */
  bottleneck: number[];
}

export interface LayoutOptions {
  /** Draw dots only (an author/search filter hides commits, so lines would claim parents that are not shown). */
  dotsOnly: boolean;
  /** Day of a Unix-seconds time, as a key and a label (local time in the app, injectable for tests). */
  day: (seconds: number) => { key: string; label: string };
  /** Topology per repository, cached by the caller (calculateTopology is the expensive step). */
  topologyFor?: (repo: number, commits: Commit[]) => GraphTopology;
}

export const commitKey = (repo: number, hash: string) => `${repo}:${hash}`;

/** A repository's commits in GraphCell/topology shape, keyed so two repositories can never collide. */
export function toGraphCommits(repo: number, commits: readonly CombinedCommit[], dotsOnly: boolean): Commit[] {
  return commits.map((c) => ({
    hash: commitKey(repo, c.hash),
    abbreviatedHash: c.hash.slice(0, 7),
    parents: dotsOnly ? [] : c.parents.map((p) => commitKey(repo, p)),
    author: c.author,
    authorEmail: c.authorEmail,
    authorDate: c.authorDate,
    subject: c.subject,
    refs: c.refs,
  }));
}

type Lane = { lane: number; colorIndex: number; isDotted?: boolean };

/** Lanes of one repository that are drawn across the gap above its local row `k` (lines still on their way down). */
function gapLanes(topology: GraphTopology, ids: readonly string[], k: number): number[] {
  if (k <= 0 || k >= ids.length) return [];
  const lanes = new Set<number>();
  for (const p of topology.passingLanesByRow.get(k) ?? []) lanes.add(p.lane);
  const node = topology.nodes.get(ids[k]);
  if (node) {
    for (const inc of node.incomingConnections) lanes.add(inc.fromLane);
    if (node.hasConnectionFromAbove) lanes.add(node.lane);
  }
  return [...lanes];
}

function shiftNode(node: CommitNode, key: string, offset: number, color: number, dotsOnly: boolean): CommitNode {
  return {
    hash: key,
    lane: node.lane + offset,
    colorIndex: color,
    parentConnections: dotsOnly
      ? []
      : node.parentConnections.map((c) => ({ ...c, fromLane: c.fromLane + offset, toLane: c.toLane + offset, colorIndex: color, isDotted: false })),
    incomingConnections: dotsOnly ? [] : node.incomingConnections.map((c) => ({ fromLane: c.fromLane + offset, colorIndex: color })),
    hasConnectionFromAbove: dotsOnly ? false : node.hasConnectionFromAbove,
  };
}

export function buildCombinedLayout(streams: readonly RepoStream[], lockLines: readonly LockLine[], opts: LayoutOptions): CombinedLayout {
  const topologyFor = opts.topologyFor ?? ((_r: number, c: Commit[]) => calculateTopology(c));

  // 1. Frontier: newest last-loaded commit among repositories that still have more.
  let frontier: number | undefined;
  let blocked = false;
  for (const s of streams) {
    if (!s.hasMore) continue;
    if (s.commits.length === 0) {
      blocked = true; // still loading its first page: nothing can be placed safely yet
      continue;
    }
    const last = s.commits[s.commits.length - 1].commitDate;
    if (frontier === undefined || last > frontier) frontier = last;
  }
  const bottleneck = blocked
    ? streams.filter((s) => s.hasMore && s.commits.length === 0).map((s) => s.repo)
    : streams.filter((s) => s.hasMore && s.commits.length > 0 && s.commits[s.commits.length - 1].commitDate === frontier).map((s) => s.repo);

  // 2. Per-repository topology and bands.
  const per = streams.map((s) => {
    const gc = toGraphCommits(s.repo, s.commits, opts.dotsOnly);
    const topology = opts.dotsOnly || gc.length === 0 ? undefined : topologyFor(s.repo, gc);
    return { s, gc, ids: gc.map((c) => c.hash), topology };
  });
  const bands: Band[] = [];
  let offset = 0;
  for (const p of [...per].sort((a, b) => a.s.repo - b.s.repo)) {
    const width = Math.max(1, p.topology?.maxLanes ?? 1);
    bands.push({ repo: p.s.repo, offset, width });
    offset += width;
  }
  const bandOf = new Map(bands.map((b) => [b.repo, b]));

  // 3. Merge newest first, stopping at the frontier; day headers and lock lines in between.
  const rows: Row[] = [];
  const graphCommits = new Map<string, Commit>();
  const nodes = new Map<string, CommitNode>();
  const passingLanesByRow = new Map<number, Lane[]>();
  const commitIndexByHash = new Map<string, number>();
  const next = per.map(() => 0);
  const locks = [...lockLines].sort((a, b) => b.date - a.date);
  let lockIdx = 0;
  let currentDay: string | undefined;

  /** Every repository's lines that cross the current gap, except `skip`'s. */
  const crossing = (skip: number): Lane[] => {
    if (opts.dotsOnly) return [];
    const out: Lane[] = [];
    per.forEach((p, i) => {
      if (i === skip || !p.topology) return;
      const band = bandOf.get(p.s.repo)!;
      for (const lane of gapLanes(p.topology, p.ids, next[i])) out.push({ lane: lane + band.offset, colorIndex: p.s.repo });
    });
    return out;
  };
  const dayRow = (seconds: number) => {
    const d = opts.day(seconds);
    if (d.key === currentDay) return;
    currentDay = d.key;
    passingLanesByRow.set(rows.length, crossing(-1));
    rows.push({ kind: 'day', key: `day:${d.key}`, label: d.label });
  };
  const lockRow = (lock: LockLine) => {
    dayRow(lock.date);
    passingLanesByRow.set(rows.length, crossing(-1));
    rows.push({ kind: 'lock', key: `lock:${lock.hash}`, lock });
  };

  for (;;) {
    let pick = -1;
    per.forEach((p, i) => {
      if (next[i] >= p.s.commits.length) return;
      if (pick < 0) return void (pick = i);
      const a = p.s.commits[next[i]].commitDate;
      const b = per[pick].s.commits[next[pick]].commitDate;
      if (a > b || (a === b && p.s.repo < per[pick].s.repo)) pick = i;
    });
    if (pick < 0) break;
    const p = per[pick];
    const c = p.s.commits[next[pick]];
    if (blocked || (frontier !== undefined && c.commitDate < frontier)) break;

    while (lockIdx < locks.length && locks[lockIdx].date > c.commitDate) lockRow(locks[lockIdx++]);
    dayRow(c.commitDate);

    const band = bandOf.get(p.s.repo)!;
    const key = p.ids[next[pick]];
    const rowIndex = rows.length;
    const own: Lane[] = [];
    if (p.topology) {
      for (const pl of p.topology.passingLanesByRow.get(next[pick]) ?? []) own.push({ lane: pl.lane + band.offset, colorIndex: p.s.repo });
      nodes.set(key, shiftNode(p.topology.nodes.get(key)!, key, band.offset, p.s.repo, false));
    } else {
      nodes.set(key, { hash: key, lane: band.offset, colorIndex: p.s.repo, parentConnections: [], incomingConnections: [], hasConnectionFromAbove: false });
    }
    passingLanesByRow.set(rowIndex, [...own, ...crossing(pick)]);
    commitIndexByHash.set(key, rowIndex);
    graphCommits.set(key, p.gc[next[pick]]);
    rows.push({ kind: 'commit', key, repo: p.s.repo, commit: c });
    next[pick]++;
  }
  // Lock lines below the last shown commit appear only once nothing more can come before them.
  const exhausted = !blocked && frontier === undefined;
  if (exhausted) while (lockIdx < locks.length) lockRow(locks[lockIdx++]);
  else while (lockIdx < locks.length && frontier !== undefined && locks[lockIdx].date >= frontier) lockRow(locks[lockIdx++]);

  return {
    rows,
    topology: { nodes, maxLanes: offset, passingLanesByRow, commitIndexByHash },
    graphCommits,
    bands,
    totalLanes: offset,
    frontier: exhausted ? undefined : frontier,
    bottleneck,
  };
}
