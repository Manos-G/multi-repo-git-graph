// The combined graph page: toolbar (filters), one virtualized timeline of every
// repository, and a details panel. Lanes are drawn by the normal graph's GraphCell
// from the combined topology built in layout.ts.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Commit } from '@shared/types';
import type { CombinedCommit, CombinedRepo } from '@shared/combinedGraph';
import { GraphCell } from '../components/GraphCell';
import { calculateTopology, type GraphTopology } from '../utils/graphTopology';
import { getColor, resolvePalette } from '../utils/colorUtils';
import {
  ACCENT_COLOR,
  ADDED_COLOR,
  BADGE_SURFACE_COLOR,
  BADGE_TEXT_COLOR,
  BORDER_COLOR,
  DELETED_COLOR,
  ERROR_COLOR,
  FOREGROUND_COLOR,
  MODIFIED_COLOR,
  NEUTRAL_COLOR,
  RENAMED_COLOR,
  WARNING_COLOR,
  tint,
} from '../utils/themeColors';
import { buildCombinedLayout, type Row } from './layout';
import { findChangeSets, type ChangeSet } from './changeSets';
import type { TimeRangeKind } from './timeRange';
import { loadMore, reload, select, send, setEnabled, setRange, setTextFilters, useCombined } from './store';

const ROW_HEIGHT = 28;
const LANE_WIDTH = 16;

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function localDay(seconds: number) {
  const d = new Date(seconds * 1000);
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const label =
    d.toDateString() === today.toDateString() ? `Today — ${dayFormat.format(d)}` : d.toDateString() === yesterday.toDateString() ? `Yesterday — ${dayFormat.format(d)}` : dayFormat.format(d);
  return { key, label };
}

const inputStyle = {
  background: 'var(--vscode-input-background)',
  color: 'var(--vscode-input-foreground)',
  border: '1px solid var(--vscode-input-border, transparent)',
} as const;
const buttonStyle = {
  background: 'var(--vscode-button-secondaryBackground)',
  color: 'var(--vscode-button-secondaryForeground)',
} as const;

// ----- toolbar ------------------------------------------------------------------------

function RepoFilter({ repos }: { repos: CombinedRepo[] }) {
  const enabled = useCombined((s) => s.enabled);
  const palette = resolvePalette(useCombined((s) => s.settings.graphColors));
  const [open, setOpen] = useState(false);
  // The checkboxes edit a draft, copied when the list opens and applied when it closes.
  const [draft, setDraft] = useState<Set<string>>(enabled);
  const apply = () => {
    setOpen(false);
    if (draft.size !== enabled.size || [...draft].some((p) => !enabled.has(p))) setEnabled(new Set(draft));
  };
  const toggle = (p: string) => {
    const d = new Set(draft);
    if (d.has(p)) d.delete(p);
    else d.add(p);
    setDraft(d);
  };
  return (
    <div className="relative">
      <button className="px-2 py-0.5 rounded-sm" style={buttonStyle} onClick={() => {
          if (open) return apply();
          setDraft(new Set(enabled));
          setOpen(true);
        }} title="Which repositories to show">
        Repositories ({enabled.size}/{repos.length}) ▾
      </button>
      {open && (
        <div
          className="absolute z-20 mt-1 p-2 rounded shadow-lg max-h-[70vh] overflow-auto min-w-[260px]"
          style={{ background: 'var(--vscode-editorWidget-background)', border: `1px solid ${BORDER_COLOR}` }}
        >
          <div className="flex gap-2 mb-2">
            <button className="px-2 rounded-sm" style={buttonStyle} onClick={() => setDraft(new Set(repos.filter((r) => !r.frozen).map((r) => r.path)))}>
              Default
            </button>
            <button className="px-2 rounded-sm" style={buttonStyle} onClick={() => setDraft(new Set(repos.map((r) => r.path)))}>
              All
            </button>
            <button className="px-2 rounded-sm" style={buttonStyle} onClick={() => setDraft(new Set())}>
              None
            </button>
          </div>
          {repos.map((r, i) => (
            <label key={r.path} className="flex items-center gap-2 py-0.5 cursor-pointer" title={r.path}>
              <input type="checkbox" checked={draft.has(r.path)} onChange={() => toggle(r.path)} />
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: getColor(i, palette) }} />
              <span>{r.name}</span>
              {r.frozen && <span style={{ color: NEUTRAL_COLOR }}>frozen</span>}
            </label>
          ))}
          <div className="flex justify-end mt-2">
            <button
              className="px-3 py-0.5 rounded-sm"
              style={{ background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }}
              onClick={apply}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toolbar({ status }: { status: string }) {
  const repos = useCombined((s) => s.repos);
  const range = useCombined((s) => s.range);
  const hasLock = useCombined((s) => s.lockLines.length > 0);
  const [author, setAuthor] = useState(useCombined.getState().author);
  const [search, setSearch] = useState(useCombined.getState().search);
  const authors = useAuthors();
  useEffect(() => {
    const t = setTimeout(() => setTextFilters(author, search), 400);
    return () => clearTimeout(t);
  }, [author, search]);

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${BORDER_COLOR}` }}>
      <span className="font-semibold mr-2">All Repositories</span>
      <RepoFilter repos={repos} />
      <select
        className="px-1 py-0.5"
        style={inputStyle}
        value={range.kind}
        onChange={(e) => setRange({ ...range, kind: e.target.value as TimeRangeKind })}
        title="Time range"
      >
        <option value="all">All time</option>
        <option value="today">Today</option>
        <option value="week">This week</option>
        <option value="sinceLock" disabled={!hasLock}>
          Since the last lock
        </option>
        <option value="custom">Custom…</option>
      </select>
      {range.kind === 'custom' && (
        <>
          <input type="date" className="px-1" style={inputStyle} value={range.from ?? ''} onChange={(e) => setRange({ ...range, from: e.target.value })} title="From" />
          <span>–</span>
          <input type="date" className="px-1" style={inputStyle} value={range.to ?? ''} onChange={(e) => setRange({ ...range, to: e.target.value })} title="To" />
        </>
      )}
      <input className="px-2 py-0.5 w-40" style={inputStyle} placeholder="Author" list="combined-authors" value={author} onChange={(e) => setAuthor(e.target.value)} title="Author name or email (searches the full history)" />
      <datalist id="combined-authors">
        {authors.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <input className="px-2 py-0.5 w-56" style={inputStyle} placeholder="Search commit messages" value={search} onChange={(e) => setSearch(e.target.value)} title="Finds commit messages in every repository (searches the full history)" />
      <button className="px-2 py-0.5 rounded-sm" style={buttonStyle} onClick={() => send({ type: 'refresh' })} title="Reload repositories, lock lines and commits">
        ⟳ Refresh
      </button>
      <span className="ml-auto" style={{ color: NEUTRAL_COLOR }}>
        {status}
      </span>
    </div>
  );
}

function useAuthors(): string[] {
  const streams = useCombined((s) => s.streams);
  return useMemo(() => {
    const set = new Set<string>();
    for (const st of streams.values()) for (const c of st.commits) set.add(c.author);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [streams]);
}

// ----- rows ------------------------------------------------------------------------------

/** The lanes crossing a day or lock row (no commit of its own). */
function GapCell({ lanes, width, palette }: { lanes: { lane: number; colorIndex: number }[]; width: number; palette: readonly string[] }) {
  return (
    <svg width={width} height={ROW_HEIGHT} className="flex-shrink-0">
      {lanes.map((l) => (
        <line key={l.lane} x1={LANE_WIDTH / 2 + l.lane * LANE_WIDTH} y1={0} x2={LANE_WIDTH / 2 + l.lane * LANE_WIDTH} y2={ROW_HEIGHT} style={{ stroke: getColor(l.colorIndex, palette) }} strokeWidth={2} />
      ))}
    </svg>
  );
}

interface RowProps {
  row: Row;
  index: number;
  topology: GraphTopology;
  graphCommit?: Commit;
  graphWidth: number;
  palette: readonly string[];
  repo?: CombinedRepo;
  selected: boolean;
  inSelectedSet: boolean;
  changeSet?: ChangeSet;
}

const CommitRow = memo(function CommitRow({ row, index, topology, graphCommit, graphWidth, palette, repo, selected, inSelectedSet, changeSet }: RowProps) {
  if (row.kind === 'day') {
    return (
      <div className="flex items-center h-full" style={{ background: tint(NEUTRAL_COLOR, 8) }}>
        <GapCell lanes={topology.passingLanesByRow.get(index) ?? []} width={graphWidth} palette={palette} />
        <span className="px-2 font-semibold" style={{ color: FOREGROUND_COLOR }}>
          {row.label}
        </span>
      </div>
    );
  }
  if (row.kind === 'lock') {
    return (
      <div className="flex items-center h-full" style={{ borderTop: `2px dashed ${WARNING_COLOR}`, borderBottom: `2px dashed ${WARNING_COLOR}`, background: tint(WARNING_COLOR, 10) }} title={`${row.lock.file} · ${row.lock.hash.slice(0, 8)} · ${fullFormat.format(new Date(row.lock.date * 1000))}`}>
        <GapCell lanes={topology.passingLanesByRow.get(index) ?? []} width={graphWidth} palette={palette} />
        <span className="px-2 font-semibold" style={{ color: WARNING_COLOR }}>
          🔒 {row.lock.subject}
        </span>
        <span style={{ color: NEUTRAL_COLOR }}>{timeFormat.format(new Date(row.lock.date * 1000))}</span>
      </div>
    );
  }
  const c: CombinedCommit = row.commit;
  const color = getColor(row.repo, palette);
  const refs = c.refs.filter((r) => r.type === 'branch' || r.type === 'head' || r.type === 'tag');
  return (
    <div
      className="flex items-center h-full cursor-pointer"
      style={{
        background: selected ? 'var(--vscode-list-activeSelectionBackground)' : inSelectedSet ? 'var(--vscode-list-inactiveSelectionBackground)' : undefined,
        color: selected ? 'var(--vscode-list-activeSelectionForeground)' : undefined,
      }}
      onClick={() => select(row.key, repo?.path, c.hash)}
    >
      {graphCommit && <GraphCell commit={graphCommit} commits={EMPTY} index={index} topology={topology} width={graphWidth} height={ROW_HEIGHT} graphColors={palette} />}
      <span className="w-40 flex-shrink-0 truncate px-2 font-semibold" style={{ color }} title={repo?.path}>
        {repo?.name}
      </span>
      <span className="flex-1 min-w-0 truncate flex items-center gap-1.5 pr-2">
        {refs.map((r) => (
          <span key={`${r.type}:${r.name}`} className="px-1 rounded-sm text-[11px] flex-shrink-0" style={{ border: `1px solid ${color}`, color }}>
            {r.type === 'tag' ? `🏷 ${r.name}` : r.name}
          </span>
        ))}
        {changeSet && (
          <button
            className="px-1 rounded-sm text-[11px] flex-shrink-0"
            style={{ background: BADGE_SURFACE_COLOR, color: BADGE_TEXT_COLOR }}
            title={`Change set: ${changeSet.members.length} commits in ${changeSet.repos} repositories by this author. Click to select them all.`}
            onClick={(e) => {
              e.stopPropagation();
              select(row.key, repo?.path, c.hash, changeSet.members);
            }}
          >
            ◆ set {changeSet.repos}
          </button>
        )}
        <span className="truncate" title={c.subject}>
          {c.subject}
        </span>
      </span>
      <span className="w-36 flex-shrink-0 truncate px-2" style={{ color: selected ? undefined : NEUTRAL_COLOR }} title={c.authorEmail}>
        {c.author}
      </span>
      <span className="w-20 flex-shrink-0 px-1 whitespace-nowrap" style={{ color: selected ? undefined : NEUTRAL_COLOR }} title={fullFormat.format(new Date(c.commitDate * 1000))}>
        {timeFormat.format(new Date(c.commitDate * 1000))}
      </span>
      <span className="w-20 flex-shrink-0 px-2 font-mono" style={{ color: selected ? undefined : NEUTRAL_COLOR }}>
        {c.hash.slice(0, 7)}
      </span>
    </div>
  );
});
const EMPTY: Commit[] = [];

// ----- details -----------------------------------------------------------------------------

const STATUS: Record<string, { letter: string; color: string }> = {
  added: { letter: 'A', color: ADDED_COLOR },
  modified: { letter: 'M', color: MODIFIED_COLOR },
  deleted: { letter: 'D', color: DELETED_COLOR },
  renamed: { letter: 'R', color: RENAMED_COLOR },
  copied: { letter: 'C', color: ADDED_COLOR },
};

function Details({ rows, repos, palette }: { rows: Row[]; repos: CombinedRepo[]; palette: readonly string[] }) {
  const selectedKey = useCombined((s) => s.selectedKey);
  const selectedSet = useCombined((s) => s.selectedSet);
  const details = useCombined((s) => s.details);
  const row = rows.find((r) => r.key === selectedKey);
  if (!row || row.kind !== 'commit') return null;
  const repo = repos[row.repo];
  const c = row.commit;
  const color = getColor(row.repo, palette);
  const setRows = selectedSet ? rows.filter((r): r is Extract<Row, { kind: 'commit' }> => r.kind === 'commit' && selectedSet.includes(r.key)) : [];
  return (
    <div className="w-[380px] flex-shrink-0 overflow-auto p-3 flex flex-col gap-2" style={{ borderLeft: `1px solid ${BORDER_COLOR}` }}>
      <div className="flex items-center gap-2">
        <span className="font-semibold" style={{ color }}>
          {repo?.name}
        </span>
        <span className="font-mono" style={{ color: NEUTRAL_COLOR }}>
          {c.hash.slice(0, 10)}
        </span>
        <button className="ml-auto px-1 rounded-sm" style={buttonStyle} onClick={() => select(undefined)} title="Close">
          ✕
        </button>
      </div>
      <div className="font-semibold">{c.subject}</div>
      <div style={{ color: NEUTRAL_COLOR }}>
        {c.author} &lt;{c.authorEmail}&gt;
        <br />
        authored {fullFormat.format(new Date(c.authorDate * 1000))}
        {c.commitDate !== c.authorDate && <> · committed {fullFormat.format(new Date(c.commitDate * 1000))}</>}
      </div>
      <button
        className="self-start px-2 py-0.5 rounded-sm"
        style={{ background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }}
        onClick={() => repo && send({ type: 'openInRepoGraph', payload: { repo: repo.path, hash: c.hash } })}
      >
        Open in {repo?.name} graph
      </button>
      {setRows.length > 1 && (
        <div className="p-2 rounded" style={{ background: tint(ACCENT_COLOR, 10) }}>
          <div className="font-semibold mb-1">Change set · {setRows.length} commits</div>
          {setRows.map((r) => (
            <div key={r.key} className="truncate cursor-pointer hover:underline" onClick={() => select(r.key, repos[r.repo]?.path, r.commit.hash, selectedSet)} title={r.commit.subject}>
              <span style={{ color: getColor(r.repo, palette) }}>{repos[r.repo]?.name}</span> {r.commit.subject}
            </div>
          ))}
        </div>
      )}
      {!details && <div style={{ color: NEUTRAL_COLOR }}>Loading files…</div>}
      {details && 'error' in details && <div style={{ color: ERROR_COLOR }}>{details.error}</div>}
      {details && !('error' in details) && (
        <>
          {details.body.trim() && <pre className="whitespace-pre-wrap text-[12px]" style={{ color: FOREGROUND_COLOR, fontFamily: 'inherit' }}>{details.body.trim()}</pre>}
          <div className="font-semibold mt-1">
            {details.files.length} file{details.files.length === 1 ? '' : 's'}
          </div>
          {details.files.map((f) => {
            const st = STATUS[f.status] ?? { letter: '?', color: NEUTRAL_COLOR };
            return (
              <div
                key={f.path}
                className="flex items-center gap-2 cursor-pointer hover:underline"
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                onClick={() => send({ type: 'openDiff', payload: { repo: details.repo, hash: details.hash, parent: details.parents[0], file: f.path, oldFile: f.oldPath, status: f.status } })}
              >
                <span className="w-4 font-semibold" style={{ color: st.color }}>
                  {st.letter}
                </span>
                <span className="truncate">{f.path}</span>
                {(f.additions !== undefined || f.deletions !== undefined) && (
                  <span className="ml-auto flex-shrink-0">
                    <span style={{ color: ADDED_COLOR }}>+{f.additions ?? 0}</span> <span style={{ color: DELETED_COLOR }}>−{f.deletions ?? 0}</span>
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ----- app ------------------------------------------------------------------------------------

export function CombinedApp() {
  const repos = useCombined((s) => s.repos);
  const streams = useCombined((s) => s.streams);
  const lockLines = useCombined((s) => s.lockLines);
  const settings = useCombined((s) => s.settings);
  const enabled = useCombined((s) => s.enabled);
  const initialized = useCombined((s) => s.initialized);
  const filtered = useCombined((s) => !!(s.author.trim() || s.search.trim()));
  const selectedKey = useCombined((s) => s.selectedKey);
  const selectedSet = useCombined((s) => s.selectedSet);
  const palette = resolvePalette(settings.graphColors);
  const repoIndex = useMemo(() => new Map(repos.map((r, i) => [r.path, i])), [repos]);

  // calculateTopology is the expensive step: once per repository per loaded page.
  const topoCache = useRef(new Map<number, { commits: readonly CombinedCommit[]; topology: GraphTopology }>());
  const layout = useMemo(() => {
    const list = [...streams].map(([p, st]) => ({ repo: repoIndex.get(p) ?? 0, commits: st.commits, hasMore: st.hasMore }));
    const lockShown = enabled.size > 0 ? lockLines : [];
    return buildCombinedLayout(list, lockShown, {
      dotsOnly: filtered,
      day: localDay,
      topologyFor: (repo, gc) => {
        const st = list.find((x) => x.repo === repo)!;
        const cached = topoCache.current.get(repo);
        if (cached && cached.commits === st.commits) return cached.topology;
        const topology = calculateTopology(gc);
        topoCache.current.set(repo, { commits: st.commits, topology });
        return topology;
      },
    });
  }, [streams, lockLines, filtered, repoIndex, enabled]);

  const changeSets = useMemo(() => {
    const items = layout.rows.flatMap((r) => (r.kind === 'commit' ? [{ key: r.key, repo: r.repo, email: r.commit.authorEmail, date: r.commit.commitDate }] : []));
    return findChangeSets(items, settings.changeSetMinutes * 60).byKey;
  }, [layout, settings.changeSetMinutes]);

  const graphWidth = Math.max(LANE_WIDTH, layout.totalLanes * LANE_WIDTH);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: layout.rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_HEIGHT, overscan: 30 });
  const items = virtualizer.getVirtualItems();

  // Load more when the end of the list is near, and keep filling until a screen's worth exists.
  const bottleneck = useMemo(() => layout.bottleneck.map((i) => repos[i]?.path).filter((p): p is string => !!p), [layout.bottleneck, repos]);
  const lastIndex = items.length ? items[items.length - 1].index : 0;
  useEffect(() => {
    if (bottleneck.length && lastIndex >= layout.rows.length - 40) loadMore(bottleneck);
  }, [bottleneck, lastIndex, layout.rows.length]);

  // First-screen timing, reported once to the extension's log: every repository's first page
  // has arrived and commits are on screen (measured after the browser painted them).
  const reported = useRef(false);
  const firstPagesDone = streams.size > 0 && [...streams.values()].every((s) => s.commits.length > 0 || !s.hasMore);
  const shownCommits = layout.graphCommits.size;
  useEffect(() => {
    if (reported.current || !firstPagesDone || shownCommits === 0) return;
    reported.current = true;
    const openedAt = useCombined.getState().openedAt;
    requestAnimationFrame(() => send({ type: 'reportTiming', payload: { firstRenderMs: Date.now() - openedAt, commits: shownCommits, repos: streams.size } }));
  }, [firstPagesDone, shownCommits, streams.size]);

  const loading = [...streams.values()].filter((s) => s.loading).length;
  const errors = [...streams].filter(([, s]) => s.error).map(([p]) => repos[repoIndex.get(p) ?? 0]?.name);
  const commitRows = layout.rows.filter((r) => r.kind === 'commit').length;
  const status = !initialized
    ? 'Loading repositories…'
    : `${commitRows} commits · ${streams.size} repositories${loading ? ` · loading ${loading}…` : ''}${errors.length ? ` · failed: ${errors.join(', ')}` : ''}${filtered ? ' · filtered (lines hidden)' : ''}`;

  return (
    <div className="flex flex-col h-screen" style={{ color: FOREGROUND_COLOR }}>
      <Toolbar status={status} />
      <div className="flex flex-1 min-h-0">
        <div ref={parentRef} className="flex-1 overflow-auto">
          {initialized && streams.size === 0 && <div className="p-4" style={{ color: NEUTRAL_COLOR }}>No repository is selected. Choose some under “Repositories”.</div>}
          {initialized && streams.size > 0 && loading === 0 && layout.rows.length === 0 && (
            <div className="p-4" style={{ color: NEUTRAL_COLOR }}>
              No commits match. <button className="underline" onClick={() => reload()}>Reload</button>
            </div>
          )}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: graphWidth + 600 }}>
            {items.map((v) => {
              const row = layout.rows[v.index];
              const repoIdx = row.kind === 'commit' ? row.repo : -1;
              return (
                <div key={row.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}>
                  <CommitRow
                    row={row}
                    index={v.index}
                    topology={layout.topology}
                    graphCommit={layout.graphCommits.get(row.key)}
                    graphWidth={graphWidth}
                    palette={palette}
                    repo={repoIdx >= 0 ? repos[repoIdx] : undefined}
                    selected={row.key === selectedKey}
                    inSelectedSet={!!selectedSet?.includes(row.key)}
                    changeSet={changeSets.get(row.key)}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <Details rows={layout.rows} repos={repos} palette={palette} />
      </div>
    </div>
  );
}
