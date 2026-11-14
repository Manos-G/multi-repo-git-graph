// PURE: the combined graph's git log arguments and parsing, and which commits of a
// .repos file were locks. The backend runs the commands; these decide what they are.
import type { CombinedCommit, CombinedQuery, LockLine } from '../../shared/combinedGraph.js';
import { COMBINED_LOG_FORMAT } from '../../shared/combinedGraph.js';
import { parseRefs } from '../utils/gitParsers.js';
import { lockedFrom, parseReposFile } from '../vcstool/reposFile.js';

/**
 * `git log` for one page of one repository: the current branch only (HEAD), git's
 * --date-order (commit date, children before parents), fully-qualified decorations.
 * An author or search filter goes to git, so it searches the whole history, not
 * only what is loaded.
 */
export function combinedLogArgs(skip: number, count: number, q: CombinedQuery): string[] {
  const args = ['log', '--date-order', `--format=${COMBINED_LOG_FORMAT}`, '--decorate=full', `--max-count=${count}`];
  if (skip > 0) args.push(`--skip=${skip}`);
  if (q.since !== undefined) args.push(`--since=@${q.since}`);
  if (q.until !== undefined) args.push(`--until=@${q.until}`);
  if (q.author) args.push(`--author=${q.author}`, '--regexp-ignore-case', '--fixed-strings');
  if (q.search) args.push(`--grep=${q.search}`, '--regexp-ignore-case', '--fixed-strings');
  args.push('HEAD', '--');
  return args;
}

export function parseCombinedLog(stdout: string): CombinedCommit[] {
  const out: CombinedCommit[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const f = line.split('\0');
    if (f.length < 8 || !/^[0-9a-f]{40,64}$/.test(f[0])) continue;
    out.push({
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      authorEmail: f[3],
      authorDate: Number(f[4]),
      commitDate: Number(f[5]),
      subject: f[6],
      refs: f[7] ? parseRefs(f[7]) : [],
    });
  }
  return out;
}

/** True when stderr says the repository has no commit yet (HEAD does not resolve). */
export const isEmptyRepoError = (stderr: string) => /does not have any commits yet|unknown revision or path not in the working tree.*HEAD|bad default revision 'HEAD'/i.test(stderr);

export interface FileVersion {
  hash: string;
  date: number;
  subject: string;
  /** The file's text at that commit (undefined when it could not be read). */
  text?: string;
}

/** The pinned versions of the entries that carry the `# locked:` marker, as one comparable string. */
export function lockSignature(text: string | undefined): string {
  if (text === undefined) return '';
  const r = parseReposFile(text);
  if (!r.ok) return '';
  return r.file.entries
    .filter((e) => !!lockedFrom(e))
    .map((e) => `${e.name}=${e.version}`)
    .sort()
    .join('\n');
}

/**
 * Which commits of a .repos file locked versions. `versions` is the file's history, newest first.
 * A commit is a lock when its lock markers are present and changed from the commit before it,
 * or when its message says so ("Lock …") — which also covers a file pinned by hand or by
 * `vcs export --exact`. Unlocks (markers removed) are not lines.
 */
export function findLockLines(versions: readonly FileVersion[], file: string): LockLine[] {
  const lines: LockLine[] = [];
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const sig = lockSignature(v.text);
    const prev = i + 1 < versions.length ? lockSignature(versions[i + 1].text) : '';
    const byMarkers = sig !== '' && sig !== prev;
    const byMessage = /^\s*lock\b/i.test(v.subject);
    if (byMarkers || byMessage) lines.push({ hash: v.hash, date: v.date, subject: v.subject, file });
  }
  return lines;
}
