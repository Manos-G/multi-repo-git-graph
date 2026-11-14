# Multi-Repo Git Graph

A Git graph for VS Code workspaces that contain many repositories, for example a ROS 2 workspace with one repository for each package.

Multi-Repo Git Graph is a fork of [Speedy Git](https://github.com/onlineeric/speedy-git-ext) by Eric Cheng. It keeps all Speedy Git features and adds the **Changed Repos** panel.

## Changed Repos panel

The panel has its own icon in the Activity Bar. It shows only the repositories that need your attention:

- Repositories with changed, staged, new or conflicted files.
- Repositories with commits that are not pushed (↑) or not pulled (↓).

Clean repositories are not shown. The status bar shows the number of changed repositories.

The panel looks and works like the Source Control view. For each repository it shows:

- A header with the repository name, the branch, the commits to pull (↓) and push (↑), and an **Open Git Graph** button. Each repository opens in its own graph tab.
- A message box. Press **Ctrl+Enter** to commit. The message is shared with the draft in Source Control.
- The **Commit** button. Its arrow has Commit & Push and Commit & Sync. When there is nothing to commit, the button changes to **Sync Changes** or **Publish Branch**.
- The **Merge Changes**, **Staged Changes** and **Changes** groups with the number of files.
- Buttons that show when you move the pointer over a row: stage, unstage, discard and open the file.
- Click a file to see the diff, the same as in Source Control.
- Right-click a repository, a group or a file for more actions (Pull, Push, Fetch, Open in Terminal and more).

The buttons at the top of the panel fetch, pull and push all repositories, refresh the list, and show all repositories. Fetch All and Pull All work on every repository whose branch has an upstream. Push All works on every repository with commits to push (↑). It does not publish branches that have no upstream; use **Publish Branch** on that repository. All three run four repositories at a time and list the repositories where they failed.

### Repositories inside other folders

The panel uses the repository list of the built-in Git extension. If your repositories are inside other folders or inside another repository, add this to `.vscode/settings.json`:

```json
{
  "git.repositoryScanMaxDepth": 3,
  "git.repositoryScanIgnoredFolders": ["node_modules", "build", "install", "log"]
}
```

### Settings

| Setting | Default | What it does |
|---|---|---|
| `multiRepoGraph.changedRepos.includeUnpushed` | `true` | Show repositories with commits that are not pushed. |
| `multiRepoGraph.changedRepos.includeBehind` | `true` | Show repositories with commits that are not pulled. |
| `multiRepoGraph.changedRepos.includeNoUpstream` | `false` | Show repositories whose branch is not published. |
| `multiRepoGraph.changedRepos.smartCommit` | `ask` | What Commit does when nothing is staged: `ask`, `always` (stage all and commit) or `never`. |
| `multiRepoGraph.changedRepos.confirmDiscard` | `true` | Ask before discarding changes. |
| `multiRepoGraph.changedRepos.showStatusBar` | `true` | Show the number of changed repositories in the status bar. |

## vcstool (.repos) workspaces

For a ROS 2 workspace made with [vcstool](https://github.com/dirk-thomas/vcstool) (`vcs import < ros_ws.repos`), the extension reads the `.repos` file and always shows how the disk differs from it.

- **Finds the file** — every `*.repos` file in the workspace folder and one folder below it, or the files in `multiRepoGraph.vcstool.files`. The paths in the file start in the folder given to `vcs import`; the extension picks it (the file's folder, its `src/`, or `ros_ws/src/` — whichever has most of the entries) and shows it. Change it with the ✏ button or `multiRepoGraph.vcstool.targetFolder`.
- **Opens the repositories** in VS Code's Git support, so every listed repository is in Source Control, in the Changed Repos panel and in the graph lists — no `git.repositoryScanMaxDepth` needed.
- **Drift** — a repository on another branch than the file says, on another commit than a pinned hash (with how many commits ahead or behind), or with another `origin` URL gets a ⚠ line in the panel, even when it has no changed files. The header sums it up: `ros_ws.repos · 26 repos · 2 drift · 1 missing`.
- **Missing and extra** — a listed repository that is not on disk has a **Clone** button (clones the URL and checks out the version). A Git repository in the target folder that the file does not list has an **Add to File** button.
- **Frozen repositories** — entries pinned to a commit hash (third-party libraries such as ruckig) are *frozen*: VS Code's Git support does not open them, so they cost no `git status` and no file watchers. The extension still reads the commit each one is on from its `.git` files (no git process) when the window gets focus and when you press **Check**, and lists them in a collapsed **Frozen** group with a ⚠ when one moved. Setting `multiRepoGraph.vcstool.freeze`: `"pinned"` (default), `"none"`, or a list of names.
- **Lock Versions** writes the exact commit of every repository into the file, like `vcs export --exact`. It fetches first and refuses — naming the repositories — when a commit is not on the remote. Order, comments and quoting stay as they were; a replaced branch is kept as `# locked: <branch>`, so a locked repository is not frozen and **Unlock Versions** can write the branches back. Both then offer to commit only the `.repos` file with a message you can edit, for example "Lock versions for Match 1".
- **Restore Versions** checks out every repository at the version in the file, or in an older commit of the file you pick from its history. It refuses when a repository has uncommitted changes and lists them.
- **Match-Day Check** (☑ button) fetches and checks every repository, frozen ones included: uncommitted files, commits not pushed, unpublished branches, detached HEAD, drift, missing repositories, extra repositories and pinned commits that are not on the remote. It shows a green **Ready** or the problems, each with a button to fix or open it.

### Recommended settings

With a `.repos` file the extension opens the repositories itself, so VS Code's own scan is not needed, and it would also open the frozen ones. The **Apply…** button in the panel writes, after asking:

```json
{
  "git.autoRepositoryDetection": false
}
```

and removes `git.repositoryScanMaxDepth`. Reload the window afterwards.

| Setting | Default | What it does |
|---|---|---|
| `multiRepoGraph.vcstool.files` | `[]` | `.repos` files to read (relative to the workspace folder or absolute). Empty: find them automatically. |
| `multiRepoGraph.vcstool.targetFolder` | `""` | Where the paths in the file start. Empty: automatic. |
| `multiRepoGraph.vcstool.freeze` | `"pinned"` | Which repositories are frozen: `"pinned"`, `"none"` or a list of entry names. |

## Combined graph (All Repositories)

One graph tab with the commits of every repository in one timeline, newest first, grouped by day. Open it with the first button in the Changed Repos panel's title bar, the **Open Combined Graph** command, or the status bar menu (click the `changed` count).

- **One lane per repository**, in the repository's own color, with its name on each row. Branches and merges of a repository are drawn inside its lane band. This version shows each repository's **current branch**.
- **Loads in pages** (200 commits per repository, `multiRepoGraph.combinedGraph.pageSize`) and merges them by **commit date**; scrolling loads more from the repositories that need it.
- **Lock lines**: every commit of a `.repos` file that locked versions is a dashed line across all lanes, labelled with its message, for example "🔒 Lock versions for Match 1".
- **Change sets**: commits by the same author in two or more repositories within 15 minutes (`multiRepoGraph.combinedGraph.changeSetMinutes`) get a **◆ set** tag; click it to select them all.
- **Filters**: which repositories (frozen ones are off by default), a time range (today, this week, since the last lock, custom), an author, and a search in commit messages. Author and search look through the whole history of every repository; while they are on, the graph shows dots only.
- **Details**: click a commit for its files; click a file for the diff. **Open in <repository> graph** opens that repository's own graph tab and selects the commit.

On the test workspace (21 repositories, about 2000 commits each) the first screen shows about 4000 commits in about 0.6 s.

| Setting | Default | What it does |
|---|---|---|
| `multiRepoGraph.combinedGraph.changeSetMinutes` | `15` | Time window of a change set. |
| `multiRepoGraph.combinedGraph.pageSize` | `200` | Commits loaded per repository at a time. |

## Differences from Speedy Git

- All command and setting names start with `multiRepoGraph` instead of `speedyGit`. You can install both extensions at the same time.
- This fork never sends usage statistics (telemetry).
- The "What's new" dialog of Speedy Git does not open automatically.

## License

MIT. The original Speedy Git copyright notice is kept in [LICENSE.md](LICENSE.md).

The panel uses [Codicons](https://github.com/microsoft/vscode-codicons) by Microsoft (icons: CC BY 4.0, code: MIT). See `resources/codicons`.

---

*The rest of this file is the original Speedy Git README. In this fork, read "Speedy Git" as "Multi-Repo Git Graph" and `speedyGit.` settings as `multiRepoGraph.` settings.*

# Speedy Git — Fast Git Graph & History UI for VS Code and Cursor

A performance-first Git graph, history viewer, history-editing tool, and worktrees manager built for developers who want speed, clarity, and real Git workflow power — without the bloat.

![Speedy Git Extension screenshot](./resources/speedy-git-screenshot.png)

**Speedy Git** renders large repositories instantly with virtual scrolling and batch prefetch, so you can browse thousands of commits, review diffs, and run Git operations — all from one clean panel inside VS Code or Cursor.

> If you've been looking for a **fast git graph**, a **lightweight git history viewer**, or a **practical rebase and cherry-pick UI** that doesn't slow you down — Speedy Git is built for exactly that.

## Why Speedy Git?

| What you get | How it works |
|---|---|
| **Instant graph rendering** | Virtual scrolling + batch prefetch keeps large repos responsive — no loading spinners, no lag |
| **Real Git operations** | Merge, rebase, cherry-pick, revert, reset, amend, fixup, drop commit, push, pull, fetch — all from context menus with live command preview |
| **Compare anything to anything** | Two-click A vs B diff for any commit, branch, tag, or your working tree — with PR-style three-dot mode |
| **Search and filter** | Multi-term search across messages, hashes, authors, emails, branches, and tags, then narrow history with branch, author, and date filters — optionally keeping every branch tip visible |
| **Multiple graph tabs** | Open as many graphs as you like, each with its own repository, filters, search, and scroll position |
| **Worktrees** | Run AI coding sessions on different branches at the same time without constantly switching your main checkout |
| **Clean, scannable UI** | Color-coded branch lanes, icon-based local/remote badges, avatars, clickable issue links, and full VS Code theme support |
| **History editing workflow** | Interactive rebase with drag-and-drop reordering (pick, squash, fixup, reword, drop) and autosquash |
| **Works in VS Code and Cursor** | Published on both VS Code Marketplace and Open VSX |

## What's New in v5

### Autolinks for issues, PRs, and tickets
`#123`, `GH-123`, `!123` and `owner/repo#123` link to GitHub or GitLab automatically, and you can add your own rules — such as Jira keys like `ABCD-123` — in the **Autolinks** settings tab (GitLens's `gitlens.autolinks` format, so an existing list can be copied in). Links appear in the Message column, the details panel, and the commit tooltip.

![Speedy Git autolinks in a commit row](./resources/autolinks.png)

### Worktrees for multi-session AI coding
Create, open, reveal, and remove Git worktrees so different AI agents or editor sessions can work on different branches at the same time without switching your main checkout. Choose a nested (`feat/branch1`) or flattened (`feat-branch1`) folder, and optionally copy `.env` files into the new worktree.
![Speedy Git Worktrees screenshot](./resources/047-worktrees.png)

### Faster navigation
- **Double-click a branch badge** to check it out — remote badges create a tracking branch or offer to pull.
- **Go to HEAD** jumps straight to the checked-out commit, loading more history if needed.
- **Go to parent / child commit** from the details panel, including each parent of a merge.
- **Smarter search** — space-separated terms are AND-ed, `"quoted text"` matches literally, and the matching text is boxed inside each row.

## Core Feature Summary
>Right-click menu — there are even more features in other menus and panels!  
>
>![Speedy Git Right-click menu screenshot](./resources/right-click-menu.png)

- Fast commit graph and history browsing with virtual scrolling, color-coded branch lanes, table-style rows, resizable columns, avatars, and clear HEAD/ref labels.
- Powerful search across messages, hashes, authors, emails, branches, and tags, plus filtering by branch, author, and date (with an option to keep badged commits such as branch tips visible), with match navigation for large histories.
- Compare any two refs (commits, branches, tags, `HEAD~3`, or your working tree) with PR-style three-dot diffs.
- Commit details with resizable bottom/right layout, file tree/list views, per-file stats, parent/child navigation, and inline diffs — including stashed untracked files and submodule pointer changes.
- Branch, tag, stash, remote, submodule, worktree, and multi-repo workflows from one panel, including fetch, pull, push, checkout, merge, and remote management.
- History editing tools for interactive rebase, amend, fixup, cherry-pick, revert, reset, and drop commit, with conflict-aware continue/abort flows.
- On-demand GPG and SSH commit signature verification in a dedicated Signature column.
- Live Git command previews in major dialogs, plus personalization for graph colors, date format, ref visibility, avatars, autolinks, toolbar labels, and persisted panel layout.

## How Speedy Git Compares

| | Speedy Git | Heavy all-in-one Git extensions | Basic Git graph viewers |
|---|---|---|---|
| Large repo performance | Virtual scrolling, batch prefetch | Can lag on large histories | Often loads everything at once |
| AI-ready worktrees | Parallel branch worktrees for multi-session AI coding | Varies or requires separate tools | Rare |
| Search, filter, and compare | Built-in search, advanced filters, and A vs B compare | Usually available, often spread across views | Limited |
| History editing | Rebase, cherry-pick, revert, drop, reset — all in-panel | Varies | View-only or minimal |
| Commit signature verification | On-demand GPG and SSH verification | Varies | Rare |
| Live command preview | Every dialog shows the exact git command | Rare | No |
| UI clarity | Merged branch labels, color-coded lanes, avatars | Feature-dense, complex UI | Basic |
| Repo support | Multi-repo switching, multiple graph tabs, submodule navigation, worktree visibility | Varies | Rare |
| Startup overhead | Lightweight, focused graph tabs | Extension suite, multiple views | Lightweight |

## Quick Start

1. Install **Speedy Git** from [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=onlineeric.speedy-git-ext) or [Open VSX](https://open-vsx.org/extension/onlineeric/speedy-git-ext).
2. Open any Git repository in VS Code or Cursor.
3. Launch Speedy Git from the Source Control panel icon, the status bar button, or press `Ctrl+Shift+G` (`Cmd+Shift+G` on Mac). This returns to the graph you were last in; the Source Control icon opens a graph for that specific repository.
4. Use **New Tab** in the toolbar for another graph, and the **Help** button for links, feedback, and the badge legend.

Open Speedy Git from the Source Control panel:
![Speedy Git Icon](resources/source-control-screenshot.png)

Open Speedy Git from the status bar:
![Speedy Git Status Bar](resources/status-bar-screenshot.png)

## Telemetry

Speedy Git collects **anonymous, aggregate-only usage statistics** (feature
usage, standardized error codes, and performance timings) to improve
compatibility, reliability, and product direction. It never collects repository
content, repository names or paths, or anything you type.

Telemetry is sent only when both VS Code's global telemetry setting and
`speedyGit.telemetry.enabled` are enabled. Turning either setting off stops all
collection immediately.

<details>
<summary>What is collected</summary>

- Feature and UI usage from fixed action identifiers, operation outcomes, and
  standardized error codes.
- Performance timings, with commit counts reported only as coarse ranges.
- Editor, operating system, and extension versions; Speedy Git setting choices;
  and VS Code's anonymized machine and session identifiers.

Speedy Git never collects repository or workspace names and paths; remote URLs;
branch, tag, stash, or worktree names; commit hashes, messages, or diffs; author
names, emails, or avatars; Git configuration values; file names or paths; raw
Git output or exception messages; search or filter values; or anything entered
into an input.

The exact event schema is available in [`telemetry.json`](telemetry.json). Every
sent event is also recorded in the **Speedy Git Telemetry** output channel.

</details>

## Issues, Feature Requests & Feedback

- Issues and feature requests: [GitHub Issues](https://github.com/onlineeric/speedy-git-ext/issues)
- Source code: [github.com/onlineeric/speedy-git-ext](https://github.com/onlineeric/speedy-git-ext)
- License: [MIT](LICENSE.md)
