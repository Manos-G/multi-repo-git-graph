// The vcstool commands: Check, Lock, Unlock, Restore, Clone, Add to file, target folder,
// recommended settings, and the fixes the match-day check offers. Every write to a file or a
// setting is confirmed first; every git command goes through VcsToolWorkspace (GitExecutor).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readHead, readOriginUrl } from './gitFiles.js';
import { entryNameFor, headCommit, planLock, planUnlock, targetFolderCandidates, type Blocker, type FixAction, type Plan } from './model.js';
import { addEntry, isCommitHash, parseReposFile, setVersions, type ReposEntry } from './reposFile.js';
import { diskReader, NETWORK_ENV, VCS_CFG, type VcsFileState, type VcsToolWorkspace } from './VcsToolWorkspace.js';

export interface VcsCommandDeps {
  workspace: VcsToolWorkspace;
  log: vscode.LogOutputChannel;
  /** Push (or publish) a repository the way the Changed Repos panel does. */
  pushRepo(repoPath: string): Promise<void>;
  /** Opens the match-day check tab. */
  openMatchDay(): void;
}

/** Arguments the panel's buttons pass (file path, entry name or repository path). */
export interface VcsArgs {
  file?: string;
  name?: string;
  path?: string;
}

const short = (h: string) => h.slice(0, 8);
const list = (items: readonly Blocker[]) => items.map((b) => `• ${b.name}: ${b.reason}`).join('\n');

/** Runs `fn` on every item, `limit` at a time. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function registerVcstoolCommands(context: vscode.ExtensionContext, deps: VcsCommandDeps): void {
  const { workspace: ws, log } = deps;
  const reg = (id: string, fn: (args?: VcsArgs) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`${VCS_CFG}.${id}`, fn));

  // ----- helpers -------------------------------------------------------------

  const pickFile = async (args?: VcsArgs): Promise<VcsFileState | undefined> => {
    await ws.refresh();
    if (args?.file) return ws.files.find((f) => f.filePath === args.file);
    const files = ws.files.filter((f) => !f.error);
    if (files.length === 0) {
      void vscode.window.showInformationMessage('No vcstool .repos file was found in this workspace. Set "multiRepoGraph.vcstool.files" to name one.');
      return undefined;
    }
    if (files.length === 1) return files[0];
    const pick = await vscode.window.showQuickPick(
      files.map((f) => ({ label: f.fileName, description: vscode.workspace.asRelativePath(f.filePath), file: f })),
      { title: 'Which .repos file?' },
    );
    return pick?.file;
  };

  /** Write the file, unless it has unsaved edits in an editor (those would be lost or conflict). */
  const writeFile = async (file: VcsFileState, text: string): Promise<boolean> => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file.filePath);
    if (open?.isDirty) {
      void vscode.window.showWarningMessage(`${file.fileName} has unsaved changes in an editor. Save or revert them first.`);
      return false;
    }
    try {
      fs.writeFileSync(file.filePath, text, 'utf8');
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`Cannot write ${file.fileName}: ${e}`);
      return false;
    }
  };

  /** Offer to commit only the .repos file in its repository, with a message the user can edit. */
  const offerCommit = async (file: VcsFileState, defaultMessage: string, selectFrom: number) => {
    if (!file.mainRepo) return;
    const message = await vscode.window.showInputBox({
      title: `Commit ${file.fileName}`,
      prompt: `Commit only ${file.fileName} in ${path.basename(file.mainRepo)}. Press Escape to leave it uncommitted.`,
      value: defaultMessage,
      valueSelection: [selectFrom, defaultMessage.length],
    });
    if (!message?.trim()) return;
    const rel = path.relative(file.mainRepo, file.filePath);
    const add = await ws.gitOrError(file.mainRepo, ['add', '--', rel]);
    const commit = add.ok ? await ws.gitOrError(file.mainRepo, ['commit', '-m', message, '--', rel]) : add;
    if (!commit.ok) void vscode.window.showErrorMessage(`Commit failed: ${commit.error.split('\n')[0]}`);
    else void vscode.window.showInformationMessage(`Committed ${file.fileName}: "${message}"`);
  };

  /** Fetch every existing git entry (4 at a time); returns the names whose fetch failed. */
  const fetchAll = async (file: VcsFileState, progress: vscode.Progress<{ message?: string }>): Promise<Set<string>> => {
    const targets = file.entries.filter((e) => e.facts.exists && e.facts.head.kind !== 'notGit' && (e.entry.type ?? 'git') === 'git');
    const failed = new Set<string>();
    let done = 0;
    await pool(targets, 4, async (e) => {
      const r = await ws.gitOrError(e.path, ['fetch', '--quiet'], NETWORK_ENV);
      if (!r.ok) failed.add(e.entry.name);
      progress.report({ message: `Fetching ${++done}/${targets.length}` });
    });
    return failed;
  };

  const lockInputs = (file: VcsFileState) =>
    file.entries.map((e) => ({ entry: e.entry, exists: e.facts.exists, head: readHead(e.path, diskReader) }));

  const showBlocked = (what: string, file: VcsFileState, plan: Plan) =>
    vscode.window.showErrorMessage(`Cannot ${what} ${file.fileName}`, {
      modal: true,
      detail: `These repositories block it:\n${list(plan.blockers)}`,
    });

  // ----- Check ------------------------------------------------------------------

  reg('check', () =>
    vscode.window.withProgress({ location: { viewId: 'multiRepoGraph.changedRepos' }, title: 'Checking .repos files' }, () => ws.check()),
  );

  // ----- Lock / Unlock ------------------------------------------------------------

  reg('lockVersions', async (args) => {
    const file = await pickFile(args);
    if (!file?.parsed) return;
    const plan = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Lock versions in ${file.fileName}`, cancellable: false },
      async (progress) => {
        const failedFetch = await fetchAll(file, progress);
        progress.report({ message: 'Checking that every commit is on its remote' });
        const inputs = await pool(lockInputs(file), 6, async (i) => {
          const commit = headCommit(i.head);
          const p = path.resolve(file.targetFolder, i.entry.name);
          if (!i.exists || !commit || (i.entry.type ?? 'git') !== 'git') return i;
          if (failedFetch.has(i.entry.name)) return { ...i, onRemote: undefined };
          return { ...i, onRemote: await ws.onRemote(p, commit) };
        });
        return planLock(inputs);
      },
    );
    if (plan.blockers.length > 0) return void showBlocked('lock', file, plan);
    const changes = [...plan.edits].filter(([name, edit]) => file.parsed!.entries.find((e) => e.name === name)?.version !== edit.version);
    const ok = await vscode.window.showWarningMessage(
      `Lock ${changes.length} version${changes.length === 1 ? '' : 's'} in ${file.fileName}?`,
      {
        modal: true,
        detail:
          'Each repository gets the exact commit it is on (like "vcs export --exact"). A branch that is replaced is kept in a "# locked: <branch>" comment, so Unlock can write it back.' +
          (plan.skipped.length ? `\n\nLeft as they are:\n${list(plan.skipped)}` : ''),
      },
      'Lock',
    );
    if (ok !== 'Lock') return;
    if (!(await writeFile(file, setVersions(file.parsed, plan.edits)))) return;
    await ws.refresh();
    await offerCommit(file, 'Lock versions for ', 'Lock versions for '.length);
  });

  reg('unlockVersions', async (args) => {
    const file = await pickFile(args);
    if (!file?.parsed) return;
    const plan = planUnlock(lockInputs(file));
    if (plan.edits.size === 0) {
      void vscode.window.showInformationMessage(`${file.fileName} has no versions locked by Lock (no "# locked:" comments). Hand-written pins are left alone.`);
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Unlock ${plan.edits.size} version${plan.edits.size === 1 ? '' : 's'} in ${file.fileName}?`,
      {
        modal: true,
        detail:
          'Each locked repository gets the branch it is on now. Hand-written pins (third-party libraries) stay pinned.' +
          (plan.skipped.length ? `\n\n${list(plan.skipped)}` : ''),
      },
      'Unlock',
    );
    if (ok !== 'Unlock') return;
    if (!(await writeFile(file, setVersions(file.parsed, plan.edits)))) return;
    await ws.refresh();
    await offerCommit(file, 'Unlock versions', 0);
  });

  // ----- Restore -------------------------------------------------------------------

  reg('restoreVersions', async (args) => {
    const file = await pickFile(args);
    if (!file?.parsed) return;

    // Which version of the file: the current one, or one from its history.
    type Pick = vscode.QuickPickItem & { hash?: string };
    const items: Pick[] = [{ label: '$(file) Current file', description: 'the versions in the file on disk' }];
    if (file.mainRepo) {
      const rel = path.relative(file.mainRepo, file.filePath);
      const out = await ws.git_(file.mainRepo, ['log', '-n', '50', '--format=%H%x00%h%x00%ad%x00%s', '--date=short', '--', rel]);
      for (const line of (out ?? '').split('\n').filter(Boolean)) {
        const [hash, abbrev, date, subject] = line.split('\0');
        items.push({ label: `$(git-commit) ${subject}`, description: `${abbrev} · ${date}`, hash });
      }
    }
    const pick = await vscode.window.showQuickPick(items, { title: `Restore the versions of ${file.fileName} from…` });
    if (!pick) return;

    let entries: ReposEntry[] = file.parsed.entries;
    if (pick.hash && file.mainRepo) {
      const rel = path.relative(file.mainRepo, file.filePath).split(path.sep).join('/');
      const text = await ws.git_(file.mainRepo, ['show', `${pick.hash}:${rel}`]);
      const parsed = text === undefined ? undefined : parseReposFile(text);
      if (!parsed?.ok) {
        void vscode.window.showErrorMessage(`Cannot read ${file.fileName} at ${short(pick.hash)}${parsed && !parsed.ok ? `: ${parsed.error}` : ''}`);
        return;
      }
      entries = parsed.file.entries;
    }

    const targets = entries
      .filter((e) => (e.type ?? 'git') === 'git' && e.version)
      .map((e) => ({ entry: e, path: path.resolve(file.targetFolder, e.name) }));
    const missing = targets.filter((t) => !fs.existsSync(t.path));
    const present = targets.filter((t) => fs.existsSync(t.path));
    const todo = present.filter((t) => {
      const head = readHead(t.path, diskReader);
      const v = t.entry.version!;
      if (isCommitHash(v)) return !(headCommit(head) ?? '').toLowerCase().startsWith(v.toLowerCase());
      return !(head.kind === 'branch' && head.branch === v);
    });
    if (todo.length === 0) {
      void vscode.window.showInformationMessage(`Every repository is already at its version${missing.length ? ` (${missing.length} missing — use Clone)` : ''}.`);
      return;
    }

    const dirty = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking for uncommitted changes' }, () =>
      pool(todo, 6, async (t) => ({ t, n: await ws.countChanges(t.path) })),
    );
    const blocked = dirty.filter((d) => d.n === undefined || d.n > 0);
    if (blocked.length > 0) {
      void vscode.window.showErrorMessage('Cannot restore: some repositories have uncommitted changes', {
        modal: true,
        detail: `Commit, stash or discard these first:\n${blocked.map((b) => `• ${b.t.entry.name}: ${b.n === undefined ? 'git status failed' : `${b.n} uncommitted file${b.n === 1 ? '' : 's'}`}`).join('\n')}`,
      });
      return;
    }

    const ok = await vscode.window.showWarningMessage(
      `Check out ${todo.length} repositor${todo.length === 1 ? 'y' : 'ies'} at the versions in ${file.fileName}${pick.hash ? ` (${pick.description})` : ''}?`,
      {
        modal: true,
        detail:
          todo.map((t) => `• ${t.entry.name} → ${isCommitHash(t.entry.version) ? short(t.entry.version!) : t.entry.version}`).join('\n') +
          (missing.length ? `\n\nMissing (use Clone): ${missing.map((m) => m.entry.name).join(', ')}` : ''),
      },
      'Check Out',
    );
    if (ok !== 'Check Out') return;

    const failures: Blocker[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restoring versions' }, (progress) =>
      pool(todo, 4, async (t) => {
        const err = await checkoutVersion(t.path, t.entry.version!);
        if (err) failures.push({ name: t.entry.name, reason: err });
        progress.report({ message: t.entry.name });
      }),
    );
    await ws.check();
    if (failures.length) void vscode.window.showErrorMessage(`Restore: ${failures.length} failed`, { modal: true, detail: list(failures) });
    else void vscode.window.showInformationMessage(`Restored ${todo.length} repositor${todo.length === 1 ? 'y' : 'ies'}.`);
  });

  /** Check out a branch, tag or commit; fetch and try again when it is not known locally. Returns an error or undefined. */
  async function checkoutVersion(p: string, version: string): Promise<string | undefined> {
    const args = isCommitHash(version) ? ['checkout', '--detach', version] : ['checkout', version];
    let r = await ws.gitOrError(p, args);
    if (!r.ok) {
      await ws.gitOrError(p, ['fetch', '--quiet'], NETWORK_ENV);
      r = await ws.gitOrError(p, args);
    }
    return r.ok ? undefined : r.error.split('\n')[0];
  }

  // ----- Clone / Add to file -----------------------------------------------------------

  const findEntry = (args?: VcsArgs) => {
    const file = ws.files.find((f) => f.filePath === args?.file) ?? ws.files.find((f) => f.entries.some((e) => e.entry.name === args?.name));
    const e = file?.entries.find((x) => x.entry.name === args?.name);
    return file && e ? { file, e } : undefined;
  };

  reg('cloneMissing', async (args) => {
    const found = findEntry(args);
    if (!found) return;
    const { e } = found;
    if (!e.entry.url) return void vscode.window.showErrorMessage(`${e.entry.name} has no url in ${found.file.fileName}.`);
    if (fs.existsSync(e.path)) return void vscode.window.showWarningMessage(`${e.path} already exists.`);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cloning ${e.entry.name}` }, async () => {
      fs.mkdirSync(path.dirname(e.path), { recursive: true });
      const clone = await ws.gitOrError(path.dirname(e.path), ['clone', e.entry.url!, e.path], NETWORK_ENV);
      if (!clone.ok) return void vscode.window.showErrorMessage(`Clone of ${e.entry.name} failed: ${clone.error.split('\n')[0]}`);
      const v = e.entry.version;
      const err = v ? await checkoutVersion(e.path, v) : undefined;
      if (err) void vscode.window.showWarningMessage(`${e.entry.name} was cloned, but checking out ${v} failed: ${err}`);
    });
    await ws.check();
  });

  reg('addToFile', async (args) => {
    const file = ws.files.find((f) => f.filePath === args?.file) ?? (await pickFile());
    if (!file?.parsed || !args?.path) return;
    let url = readOriginUrl(args.path, diskReader);
    if (!url) {
      url = await vscode.window.showInputBox({ title: `URL of ${path.basename(args.path)}`, prompt: 'The repository has no "origin" remote. Enter its URL.' });
      if (!url) return;
    }
    const head = readHead(args.path, diskReader);
    const version = head.kind === 'branch' ? head.branch : head.kind === 'detached' ? head.commit : undefined;
    const name = entryNameFor(file.targetFolder, args.path);
    if (await writeFile(file, addEntry(file.parsed, { name, type: 'git', url, version }))) {
      void vscode.window.showInformationMessage(`Added ${name} to ${file.fileName}${version ? ` at ${isCommitHash(version) ? short(version) : version}` : ''}.`);
      await ws.refresh();
    }
  });

  // ----- Target folder / settings ---------------------------------------------------------

  reg('chooseTargetFolder', async (args) => {
    const file = await pickFile(args);
    if (!file?.parsed) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const names = file.parsed.entries.map((e) => e.name);
    const count = (dir: string) => names.filter((n) => fs.existsSync(path.join(dir, n))).length;
    type Pick = vscode.QuickPickItem & { value?: string; browse?: boolean };
    const seen = new Set<string>();
    const items: Pick[] = [{ label: '$(sparkle) Automatic', description: 'the folder where most entries exist', value: '' }];
    for (const c of [...targetFolderCandidates(file.filePath, root), file.targetFolder]) {
      const abs = path.resolve(c);
      if (seen.has(abs)) continue;
      seen.add(abs);
      items.push({ label: vscode.workspace.asRelativePath(abs), description: `${count(abs)} of ${names.length} entries exist`, value: abs });
    }
    items.push({ label: '$(folder-opened) Choose Folder…', browse: true });
    const pick = await vscode.window.showQuickPick(items, { title: `Where do the paths in ${file.fileName} start?`, placeHolder: `Now: ${vscode.workspace.asRelativePath(file.targetFolder)}${file.targetAuto ? ' (automatic)' : ''}` });
    if (!pick) return;
    let value = pick.value;
    if (pick.browse) {
      const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(file.targetFolder) });
      if (!uri?.[0]) return;
      value = uri[0].fsPath;
    }
    const setting = value && root && !path.relative(root, value).startsWith('..') ? path.relative(root, value) || '.' : value;
    await vscode.workspace.getConfiguration(VCS_CFG).update('targetFolder', setting || undefined, vscode.ConfigurationTarget.Workspace);
  });

  reg('writeRecommendedSettings', async () => {
    const git = vscode.workspace.getConfiguration('git');
    const detection = git.inspect('autoRepositoryDetection');
    const depth = git.inspect<number>('repositoryScanMaxDepth');
    const changes: string[] = [];
    if (detection?.workspaceValue !== false) changes.push('"git.autoRepositoryDetection": false — VS Code stops opening repositories on its own; this extension opens the main repository and every listed, non-frozen one.');
    if (depth?.workspaceValue !== undefined) changes.push(`remove "git.repositoryScanMaxDepth": ${depth.workspaceValue} — not needed any more.`);
    if (changes.length === 0) {
      void vscode.window.showInformationMessage('The workspace already has the recommended settings.');
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      'Write the recommended Git settings to this workspace?',
      { modal: true, detail: `${changes.map((c) => `• ${c}`).join('\n')}\n\nFrozen repositories that VS Code already opened close after a window reload.` },
      'Write Settings',
    );
    if (ok !== 'Write Settings') return;
    if (detection?.workspaceValue !== false) await git.update('autoRepositoryDetection', false, vscode.ConfigurationTarget.Workspace);
    if (depth?.workspaceValue !== undefined) await git.update('repositoryScanMaxDepth', undefined, vscode.ConfigurationTarget.Workspace);
    const reload = await vscode.window.showInformationMessage('Settings written. Reload the window to close the frozen repositories in Source Control.', 'Reload Window');
    if (reload) void vscode.commands.executeCommand('workbench.action.reloadWindow');
  });

  reg('openFile', async (args) => {
    const file = await pickFile(args);
    if (file) await vscode.window.showTextDocument(vscode.Uri.file(file.filePath));
  });

  reg('matchDayCheck', () => deps.openMatchDay());

  // ----- Fixes (panel rows and the match-day check) ------------------------------------------

  reg('fix', async (args?: VcsArgs & { action?: FixAction }) => {
    if (!args?.action) return;
    const p = args.path;
    switch (args.action) {
      case 'clone':
        return vscode.commands.executeCommand(`${VCS_CFG}.cloneMissing`, args);
      case 'addToFile':
        return vscode.commands.executeCommand(`${VCS_CFG}.addToFile`, args);
      case 'openScm':
        return vscode.commands.executeCommand('workbench.view.scm');
      case 'reveal':
        return p && vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(p));
      case 'openTerminal':
        return p && vscode.window.createTerminal({ name: path.basename(p), cwd: p }).show();
      case 'push':
        return p && deps.pushRepo(p);
      case 'checkout': {
        const found = findEntry(args);
        if (!found?.e.entry.version) return;
        const n = await ws.countChanges(found.e.path);
        if (n === undefined || n > 0) {
          void vscode.window.showErrorMessage(`${found.e.entry.name} has uncommitted changes. Commit, stash or discard them first.`);
          return;
        }
        const err = await checkoutVersion(found.e.path, found.e.entry.version);
        if (err) void vscode.window.showErrorMessage(`Check out failed in ${found.e.entry.name}: ${err}`);
        await ws.check();
        return;
      }
    }
  });

  log.info('vcstool: commands registered');
}
