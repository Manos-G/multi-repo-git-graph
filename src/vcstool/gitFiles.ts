// PURE (fs injected): read a repository's state straight from its .git files,
// without starting git. Used for frozen repositories, which VS Code's Git
// support does not open, so checking them costs a few small file reads.
import * as path from 'path';

/** The file reads this module needs. `readFile` returns undefined for a missing/unreadable file. */
export interface FileReader {
  readFile(p: string): string | undefined;
}

export type HeadState =
  | { kind: 'notGit' }
  | { kind: 'branch'; branch: string; commit?: string }
  | { kind: 'detached'; commit: string };

export interface GitDirs {
  /** The repository's own git dir (HEAD lives here). */
  gitDir: string;
  /** Where refs, packed-refs and config live (differs for a linked worktree). */
  commonDir: string;
}

/** Resolve `<repo>/.git`: a folder, or a `gitdir: <path>` file (worktree, submodule, separate git dir). */
export function resolveGitDirs(repoPath: string, fs: FileReader): GitDirs | undefined {
  const dotGit = path.join(repoPath, '.git');
  const asFile = fs.readFile(dotGit);
  let gitDir: string;
  if (asFile !== undefined) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(asFile);
    if (!m) return undefined;
    gitDir = path.resolve(repoPath, m[1]);
  } else if (fs.readFile(path.join(dotGit, 'HEAD')) !== undefined) {
    gitDir = dotGit;
  } else {
    return undefined;
  }
  const common = fs.readFile(path.join(gitDir, 'commondir'));
  const commonDir = common ? path.resolve(gitDir, common.trim()) : gitDir;
  return { gitDir, commonDir };
}

/** `packed-refs` → map of full ref name → commit. Peeled lines (`^…`) are skipped. */
export function parsePackedRefs(text: string | undefined): Map<string, string> {
  const refs = new Map<string, string>();
  if (!text) return refs;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40,64}) (refs\/\S+)$/.exec(line);
    if (m) refs.set(m[2], m[1]);
  }
  return refs;
}

export function resolveRef(dirs: GitDirs, ref: string, fs: FileReader): string | undefined {
  for (let depth = 0; depth < 5; depth++) {
    const loose = fs.readFile(path.join(dirs.commonDir, ref)) ?? fs.readFile(path.join(dirs.gitDir, ref));
    if (loose !== undefined) {
      const v = loose.trim();
      const sym = /^ref:\s*(\S+)$/.exec(v);
      if (sym) {
        ref = sym[1];
        continue;
      }
      return /^[0-9a-f]{40,64}$/.test(v) ? v : undefined;
    }
    return parsePackedRefs(fs.readFile(path.join(dirs.commonDir, 'packed-refs'))).get(ref);
  }
  return undefined;
}

/** What the repository has checked out: a branch (with its commit, if it has one yet) or a detached commit. */
export function readHead(repoPath: string, fs: FileReader): HeadState {
  const dirs = resolveGitDirs(repoPath, fs);
  if (!dirs) return { kind: 'notGit' };
  const head = fs.readFile(path.join(dirs.gitDir, 'HEAD'))?.trim();
  if (!head) return { kind: 'notGit' };
  const sym = /^ref:\s*(\S+)$/.exec(head);
  if (sym) {
    const ref = sym[1];
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    return { kind: 'branch', branch, commit: resolveRef(dirs, ref, fs) };
  }
  if (/^[0-9a-f]{40,64}$/.test(head)) return { kind: 'detached', commit: head };
  return { kind: 'notGit' };
}

/** The `url` of `[remote "<name>"]` in a git config file. */
export function parseRemoteUrl(configText: string | undefined, remote = 'origin'): string | undefined {
  if (!configText) return undefined;
  let inSection = false;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const m = /^\[\s*remote\s+"([^"]*)"\s*\]$/.exec(line);
      inSection = !!m && m[1] === remote;
      continue;
    }
    if (!inSection) continue;
    const kv = /^url\s*=\s*(.*?)\s*$/.exec(line);
    if (kv) return kv[1].replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

export function readOriginUrl(repoPath: string, fs: FileReader): string | undefined {
  const dirs = resolveGitDirs(repoPath, fs);
  return dirs ? parseRemoteUrl(fs.readFile(path.join(dirs.commonDir, 'config'))) : undefined;
}

/** Walk up from a folder to the repository that contains it (the folder with `.git`). */
export function findRepoRoot(start: string, fs: FileReader): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (resolveGitDirs(dir, fs)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
