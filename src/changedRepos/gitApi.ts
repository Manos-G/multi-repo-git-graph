// Types for the parts of VS Code's built-in Git extension API (vscode.git, version 1)
// that the Changed Repos panel uses. Source of the full API:
// https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
import type * as vscode from 'vscode';

/** Values of the Git extension's `Status` enum. Plain constants, because esbuild does not inline `const enum`. */
export const GitStatus = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18,
} as const;

export interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: number;
}

export interface GitBranch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { readonly remote: string; readonly name: string };
  readonly ahead?: number;
  readonly behind?: number;
}

export interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly mergeChanges: GitChange[];
  readonly indexChanges: GitChange[];
  readonly workingTreeChanges: GitChange[];
  /** The repository's remotes (name and URLs as in .git/config). */
  readonly remotes?: readonly { readonly name: string; readonly fetchUrl?: string; readonly pushUrl?: string }[];
  /** Only filled when "git.untrackedChanges" is "separate". */
  readonly untrackedChanges?: GitChange[];
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  readonly state: GitRepositoryState;
  status(): Promise<void>;
  add(paths: string[]): Promise<void>;
  /** Unstages the paths (resets them in the index). */
  revert(paths: string[]): Promise<void>;
  /** Discards working tree changes. Deletes untracked files. */
  clean(paths: string[]): Promise<void>;
  commit(message: string, opts?: { all?: boolean | 'tracked' }): Promise<void>;
  fetch(options?: { remote?: string; prune?: boolean; all?: boolean }): Promise<void>;
  pull(unshallow?: boolean): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

export interface GitApi {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  /** Opens a repository in VS Code's Git support (Source Control, decorations, watchers). VS Code 1.74+. */
  openRepository?(root: vscode.Uri): Promise<GitRepository | null>;
}
