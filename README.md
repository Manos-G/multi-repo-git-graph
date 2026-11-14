# Multi-Repo Git Graph

A Git graph for VS Code workspaces that contain many repositories, for example a ROS 2 workspace with one repository for each package.

Multi-Repo Git Graph is a fork of [Speedy Git](https://github.com/onlineeric/speedy-git-ext) by Eric Cheng. It keeps all Speedy Git graph features and adds the **Changed Repos** panel, **vcstool (`.repos`) support** and a **combined graph** of all repositories.

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

## Graph features (from Speedy Git)

Each repository's graph tab is the full graph of [Speedy Git](https://github.com/onlineeric/speedy-git-ext) by Eric Cheng, which this extension is built on. Thank you, Eric.

- **Fast graph and history** for large repositories: virtual scrolling, batch prefetch, color-coded branch lanes, resizable columns, avatars, and clear HEAD and ref badges.
- **Search and filter**: space-separated terms are AND-ed, `"quoted text"` matches literally; filter by branch, author and date, optionally keeping branch tips visible.
- **Compare** any two refs (commits, branches, tags, `HEAD~3` or the working tree), including PR-style three-dot diffs.
- **Commit details** in a bottom or right panel: file tree or list, per-file stats, parent and child navigation, inline diffs, stashed untracked files and submodule pointer changes.
- **Git operations** from context menus with a live preview of the git command: checkout (double-click a branch badge), merge, rebase, interactive rebase with drag and drop (pick, squash, fixup, reword, drop), cherry-pick, revert, reset, amend, fixup, drop commit, push, pull and fetch, with conflict-aware continue and abort.
- **Branches, tags, stashes, remotes, submodules and worktrees** managed from the graph, plus several graph tabs at once, each with its own repository, filters and scroll position.
- **Autolinks**: `#123`, `GH-123`, `!123` and `owner/repo#123` link to GitHub or GitLab, and custom rules (for example Jira keys like `ABCD-123`) can be added in the **Autolinks** settings tab.
- **GPG and SSH signature verification** on demand in a Signature column.
- **Go to HEAD** and **Go to parent / child commit**, loading more history when needed.

## Quick start

1. Install **Multi-Repo Git Graph** from the VS Code Marketplace or Open VSX.
2. Open a folder or workspace with one or more Git repositories.
3. Click the **Multi-Repo Git Graph** icon in the Activity Bar for the **Changed Repos** panel. With a vcstool `.repos` file, the listed repositories are found and opened for you.
4. Open a repository's graph with its **Git Graph** button in the panel, the icon in the Source Control title bar, the status bar, or `Ctrl+Shift+G` (`Cmd+Shift+G` on Mac). Open every repository at once with **Open Combined Graph**.

## Privacy

Multi-Repo Git Graph **does not collect or send any usage data (telemetry)**. Everything else runs on your computer with your own `git`. It contacts other services only for:

- **Your Git remotes**, when you fetch, pull, push or clone.
- **Author avatars** in the graph (on by default). Pictures are loaded from Gravatar, using an MD5 hash of the author's email. For a repository whose remote is on GitHub, the extension also asks GitHub's API who wrote a commit (`api.github.com/repos/<owner>/<repo>/commits/<hash>`) and loads the picture from GitHub. Turn this off with `"multiRepoGraph.avatars.enabled": false`; the graph then shows initials.

## Issues, feature requests and feedback

- Issues and feature requests: [GitHub Issues](https://github.com/Manos-G/multi-repo-git-graph/issues)
- Source code: [github.com/Manos-G/multi-repo-git-graph](https://github.com/Manos-G/multi-repo-git-graph)
- Original project: [Speedy Git](https://github.com/onlineeric/speedy-git-ext) by Eric Cheng
- License: [MIT](LICENSE.md)
