// The combined graph's state and loading. Per repository: the commits loaded so far and
// whether git has more. Pages are requested 6 at a time; a filter change starts a new
// generation, and answers from an older generation are dropped.
import { create } from 'zustand';
import type { CombinedCommit, CombinedDetails, CombinedQuery, CombinedRepo, CombinedRequest, CombinedResponse, CombinedSettings, LockLine } from '@shared/combinedGraph';
import { timeRangeQuery, type TimeRange } from './timeRange';

interface VsCodeApi {
  postMessage(message: CombinedRequest): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
export const send = (m: CombinedRequest) => vscode.postMessage(m);

export interface Stream {
  commits: CombinedCommit[];
  hasMore: boolean;
  loading: boolean;
  error?: string;
}

interface Persisted {
  enabled?: string[];
  range?: TimeRange;
}

export interface CombinedState {
  repos: CombinedRepo[];
  lockLines: LockLine[];
  settings: CombinedSettings;
  openedAt: number;
  /** Repository paths shown. */
  enabled: Set<string>;
  range: TimeRange;
  author: string;
  search: string;
  streams: Map<string, Stream>;
  generation: number;
  selectedKey?: string;
  /** Keys selected together through a change-set tag. */
  selectedSet?: string[];
  details?: CombinedDetails | { repo: string; hash: string; error: string };
  initialized: boolean;
}

const persisted = (vscode.getState() as Persisted | undefined) ?? {};

export const useCombined = create<CombinedState>(() => ({
  repos: [],
  lockLines: [],
  settings: { graphColors: [], changeSetMinutes: 15, pageSize: 200 },
  openedAt: Date.now(),
  enabled: new Set(),
  range: persisted.range ?? { kind: 'all' },
  author: '',
  search: '',
  streams: new Map(),
  generation: 0,
  initialized: false,
}));

const save = () => {
  const s = useCombined.getState();
  vscode.setState({ enabled: [...s.enabled], range: s.range } satisfies Persisted);
};

// ----- requests ------------------------------------------------------------------

const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const queue: { repo: string; skip: number; generation: number }[] = [];
let nextRequestId = 1;
const requests = new Map<number, { repo: string; generation: number }>();

function query(): CombinedQuery {
  const s = useCombined.getState();
  const lastLock = s.lockLines[0]?.date;
  const q: CombinedQuery = { ...timeRangeQuery(s.range, new Date(), lastLock) };
  if (s.author.trim()) q.author = s.author.trim();
  if (s.search.trim()) q.search = s.search.trim();
  return q;
}

function pump() {
  const s = useCombined.getState();
  while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    const job = queue.shift()!;
    if (job.generation !== s.generation) continue;
    const requestId = nextRequestId++;
    requests.set(requestId, { repo: job.repo, generation: job.generation });
    inFlight++;
    send({ type: 'loadPage', payload: { requestId, repo: job.repo, skip: job.skip, count: s.settings.pageSize, query: query() } });
  }
}

function requestPage(repo: string) {
  const s = useCombined.getState();
  const st = s.streams.get(repo);
  if (!st || st.loading || !st.hasMore) return;
  queue.push({ repo, skip: st.commits.length, generation: s.generation });
  const streams = new Map(s.streams);
  streams.set(repo, { ...st, loading: true });
  useCombined.setState({ streams });
  pump();
}

/** Start over: every enabled repository from its first page (after a filter change or a refresh). */
export function reload() {
  const s = useCombined.getState();
  const generation = s.generation + 1;
  queue.length = 0;
  const streams = new Map<string, Stream>();
  for (const r of s.repos) if (s.enabled.has(r.path)) streams.set(r.path, { commits: [], hasMore: true, loading: true });
  useCombined.setState({ streams, generation, selectedKey: undefined, selectedSet: undefined, details: undefined });
  for (const repo of streams.keys()) queue.push({ repo, skip: 0, generation });
  pump();
}

/** Load the next page of the repositories that hold the list back. */
export function loadMore(bottleneck: readonly string[]) {
  for (const repo of bottleneck) {
    const st = useCombined.getState().streams.get(repo);
    if (st && st.hasMore && !st.loading) requestPage(repo);
  }
}

// ----- answers ------------------------------------------------------------------------

export function handleMessage(m: CombinedResponse) {
  switch (m.type) {
    case 'init': {
      const { repos, lockLines, settings, openedAt } = m.payload;
      const known = new Set(repos.map((r) => r.path));
      const saved = persisted.enabled?.filter((p) => known.has(p));
      const enabled = new Set(saved && saved.length > 0 ? saved : repos.filter((r) => !r.frozen).map((r) => r.path));
      useCombined.setState({ repos, lockLines, settings, openedAt, enabled, initialized: true });
      reload();
      return;
    }
    case 'reset':
      useCombined.setState({ initialized: false, streams: new Map() });
      return;
    case 'page': {
      const { requestId, repo, commits, hasMore, error } = m.payload;
      const req = requests.get(requestId);
      requests.delete(requestId);
      if (req) inFlight = Math.max(0, inFlight - 1);
      const s = useCombined.getState();
      if (req && req.generation === s.generation) {
        const st = s.streams.get(repo);
        if (st) {
          const streams = new Map(s.streams);
          streams.set(repo, { commits: st.commits.concat(commits), hasMore, loading: false, error });
          useCombined.setState({ streams });
        }
      }
      pump();
      return;
    }
    case 'details': {
      const s = useCombined.getState();
      const sel = s.selectedKey;
      if (sel && sel.endsWith(`:${m.payload.hash}`)) useCombined.setState({ details: m.payload });
      return;
    }
  }
}

// ----- filters ------------------------------------------------------------------------

export function setEnabled(enabled: Set<string>) {
  useCombined.setState({ enabled });
  save();
  reload();
}

export function setRange(range: TimeRange) {
  useCombined.setState({ range });
  save();
  reload();
}

export function setTextFilters(author: string, search: string) {
  const s = useCombined.getState();
  if (s.author === author && s.search === search) return;
  useCombined.setState({ author, search });
  reload();
}

export function select(key: string | undefined, repo?: string, hash?: string, set?: string[]) {
  useCombined.setState({ selectedKey: key, selectedSet: set, details: undefined });
  if (key && repo && hash) send({ type: 'getDetails', payload: { repo, hash } });
}
