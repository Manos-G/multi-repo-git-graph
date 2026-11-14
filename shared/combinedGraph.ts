// The combined graph ("All Repositories"): types shared by the backend
// (src/combinedGraph/) and its webview (webview-ui/src/combined/). Its own small
// protocol, separate from the single-repository graph's messages.ts.
import type { RefInfo } from './types.js';

/** One commit of one repository, as the combined graph loads it. */
export interface CombinedCommit {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  authorDate: number;
  /** Unix seconds. The merge key: git's own --date-order key, so each repository's stream is already in this order. */
  commitDate: number;
  subject: string;
  refs: RefInfo[];
}

export interface CombinedRepo {
  path: string;
  name: string;
  /** Frozen in a .repos file: off by default in the repository filter. */
  frozen: boolean;
}

/** A commit of the .repos file that locked versions: a line across all lanes. */
export interface LockLine {
  hash: string;
  /** Unix seconds (commit date). */
  date: number;
  subject: string;
  file: string;
}

/** What git is asked for, per repository page. */
export interface CombinedQuery {
  /** Unix seconds; only commits at or after it. */
  since?: number;
  /** Unix seconds; only commits before it. */
  until?: number;
  /** Author name or email, as `git log --author` matches it. */
  author?: string;
  /** Commit message text, case-insensitive, as `git log --grep -i -F` matches it. */
  search?: string;
}

export interface CombinedSettings {
  graphColors: string[];
  changeSetMinutes: number;
  pageSize: number;
}

export type CombinedRequest =
  | { type: 'ready' }
  | { type: 'loadPage'; payload: { requestId: number; repo: string; skip: number; count: number; query: CombinedQuery } }
  | { type: 'getDetails'; payload: { repo: string; hash: string } }
  | { type: 'openDiff'; payload: { repo: string; hash: string; parent?: string; file: string; oldFile?: string; status: string } }
  | { type: 'openInRepoGraph'; payload: { repo: string; hash: string } }
  | { type: 'reportTiming'; payload: { firstRenderMs: number; commits: number; repos: number } }
  | { type: 'refresh' };

export interface CombinedDetailsFile {
  path: string;
  oldPath?: string;
  status: string;
  additions?: number;
  deletions?: number;
}

export interface CombinedDetails {
  repo: string;
  hash: string;
  body: string;
  parents: string[];
  files: CombinedDetailsFile[];
}

export type CombinedResponse =
  | { type: 'init'; payload: { repos: CombinedRepo[]; lockLines: LockLine[]; settings: CombinedSettings; openedAt: number } }
  | { type: 'page'; payload: { requestId: number; repo: string; skip: number; commits: CombinedCommit[]; hasMore: boolean; error?: string } }
  | { type: 'details'; payload: CombinedDetails | { repo: string; hash: string; error: string } }
  | { type: 'reset' };

/** `git log` format for the combined graph: LOG_FORMAT plus the commit date (%ct). */
export const COMBINED_LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00%D';
