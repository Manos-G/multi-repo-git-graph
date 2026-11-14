# Releasing Multi-Repo Git Graph

Releases are made by `.github/workflows/release.yml` when a tag `vX.Y.Z` is pushed. The workflow:

1. installs with pnpm, runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, builds with `pnpm build:prod` and packages **one** `.vsix`;
2. publishes that `.vsix` to the **VS Code Marketplace** with Trusted Publishing (`vsce publish --oidc`, no secret);
3. publishes the same `.vsix` to **Open VSX**: with the `OVSX_PAT` secret while it exists, otherwise with Trusted Publishing (`ovsx publish --trusted-publishing`);
4. creates a **GitHub Release** for the tag with the `.vsix` attached and the tag's `CHANGELOG.md` section as notes.

The workflow refuses a tag that does not match `version` in `package.json`.

Publisher / namespace ID: **`manos-g`** (lowercase, exactly as in `package.json`). It cannot be changed once created.

---

## One-time setup

### 1. VS Code Marketplace

Azure DevOps global personal access tokens are retired on 1 December 2026, so this extension publishes only with Trusted Publishing.

1. **Check the name.** Search the [Marketplace](https://marketplace.visualstudio.com/vscode) for "Multi-Repo Git Graph" and `multi-repo-git-graph`. The display name and the extension name must both be unused.
2. **Create the publisher.** Sign in at <https://marketplace.visualstudio.com/manage> with your Microsoft account, click **Create publisher** and enter:
   - **ID**: `manos-g`
   - **Name**: what users see as the author, for example `Manos-G`
   - optional: description, logo, links to the GitHub repository.
3. **Create the Trusted Publishing policy.** On the same page open the `manos-g` publisher → **Trusted Publishing** → **Create**:
   | Field | Value |
   | --- | --- |
   | Policy name | `Release workflow` |
   | Repository owner | `Manos-G` |
   | Repository | `multi-repo-git-graph` |
   | Workflow | `release.yml` |
   | Environment | *(leave empty)* |

   The repository is public, so there is no 48-hour activation window. The credential that GitHub exchanges is valid for 15 minutes and is never stored.

### 2. Open VSX

Open VSX accepts Trusted Publishing only for an extension that **already has a published version**, so the first release uses an access token. Later releases can drop it.

1. **Eclipse account.** Create one at <https://accounts.eclipse.org/user/register>. In **GitHub Username** enter `Manos-G` (exactly your GitHub login).
2. **Sign in to <https://open-vsx.org>** with GitHub, then open your avatar → **Settings**.
3. **Link the Eclipse account**: **Log in with Eclipse** → authorize.
4. **Sign the Open VSX Publisher Agreement**: **Show Publisher Agreement** → read → **Agree**. Without it, every publish fails.
5. **Create an access token**: Settings → **Access Tokens** → **Generate New Token**, description `GitHub Actions release`. Copy it at once, because it is shown only once.
6. **Create the namespace** (on your computer, the token stays in your shell):
   ```bash
   npx ovsx create-namespace manos-g -p <token>
   ```
7. **Save the token as a repository secret** named `OVSX_PAT`:
   ```bash
   gh secret set OVSX_PAT --repo Manos-G/multi-repo-git-graph
   ```
   (paste the token when asked), or GitHub → repository **Settings → Secrets and variables → Actions → New repository secret**.

#### After the first release: switch Open VSX to Trusted Publishing (recommended)

1. **Claim ownership of the namespace.** Creating a namespace does not make you its verified owner, and Trusted Publishing needs an owner. While signed in to open-vsx.org, open an issue in [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose) asking for ownership of `manos-g` (see the wiki's [Namespace Access](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access) page). Claims are public.
2. **Register the trusted publisher**: open-vsx.org → Settings → **Trusted Publishers** → namespace `manos-g`, provider GitHub Actions:
   | Field | Value |
   | --- | --- |
   | Organization or User name | `Manos-G` |
   | Repository name | `multi-repo-git-graph` |
   | Workflow filename | `release.yml` |
   | Environment name | *(leave empty)* |
3. **Delete the `OVSX_PAT` secret** (`gh secret delete OVSX_PAT --repo Manos-G/multi-repo-git-graph`) and revoke the token on open-vsx.org. A token always wins over OIDC, so the workflow switches to Trusted Publishing only once the secret is gone.

If you prefer to keep the token, skip this. The workflow keeps using `OVSX_PAT`, but remember that Open VSX tokens should be rotated.

### 3. GitHub repository

- **About → Website**: still points to Speedy Git's Marketplace page. Clear it, or set it to the new Marketplace page after the first release:
  ```bash
  gh repo edit Manos-G/multi-repo-git-graph --homepage ""
  ```

---

## Making a release

1. On a branch, set the new version in `package.json` (`"version": "X.Y.Z"`). Follow semver: fix = patch, feature = minor.
2. Add a section at the top of the fork part of `CHANGELOG.md`:
   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD

   ### Added / Changed / Fixed
   - ...
   ```
   The heading must be exactly `## [X.Y.Z]`, because the workflow copies that section into the GitHub Release.
3. Run `pnpm lint && pnpm typecheck && pnpm test` and `pnpm build:prod && npx @vscode/vsce package --no-dependencies`, and try the `.vsix` with `code --install-extension multi-repo-git-graph-X.Y.Z.vsix --force`.
4. Open a pull request, merge it into `main`.
5. Tag the merged commit on `main` and push the tag:
   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
6. Watch the run: `gh run watch --repo Manos-G/multi-repo-git-graph` (or the **Actions** tab).

The first public release is **0.2.0**: after the one-time setup, skip steps 1 and 2 (already done) and push the tag `v0.2.0`.

### If a job fails

- Fix the cause, then use **Re-run failed jobs** on the run. Both publish steps use `--skip-duplicate`, so a store that already has the version is skipped instead of failing.
- A tag that does not match `package.json`: delete the tag (`git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`), fix the version, tag again.
- A version that reached a store cannot be published again with different content. Release a new patch version instead.
