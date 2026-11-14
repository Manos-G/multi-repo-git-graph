// The match-day check: one editor tab that checks every repository of every .repos file,
// frozen ones included, and shows a green "Ready" or the problems with a fix button each.
// This is the only place that runs `git status` on frozen repositories.
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { computeDrift, headCommit, isFrozen, matchDayProblems, normalizeFreeze, parseStatusV2, type MatchDayInput, type Problem, type RepoFacts } from './model.js';
import { isCommitHash } from './reposFile.js';
import { NETWORK_ENV, VCS_CFG, type VcsToolWorkspace } from './VcsToolWorkspace.js';

interface FileResult {
  file: string;
  fileName: string;
  repos: number;
  problems: Problem[];
  error?: string;
}

interface CheckResult {
  checkedAt: number;
  durationMs: number;
  fetched: boolean;
  fetchFailed: string[];
  files: FileResult[];
}

async function pool<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await fn(items[i]);
    }),
  );
}

export class MatchDayPanel {
  private static current: MatchDayPanel | undefined;
  private running = false;

  static show(context: vscode.ExtensionContext, ws: VcsToolWorkspace): void {
    if (MatchDayPanel.current) {
      MatchDayPanel.current.panel.reveal();
      void MatchDayPanel.current.run(true);
      return;
    }
    MatchDayPanel.current = new MatchDayPanel(context, ws);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly ws: VcsToolWorkspace,
  ) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'resources');
    this.panel = vscode.window.createWebviewPanel('multiRepoGraph.matchDay', 'Match-Day Check', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [media],
      retainContextWhenHidden: true,
    });
    this.panel.iconPath = new vscode.ThemeIcon('checklist');
    this.panel.webview.html = this.html(media);
    this.panel.onDidDispose(() => (MatchDayPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage(async (m: { type: string; action?: string; file?: string; name?: string; path?: string; fetch?: boolean }) => {
      if (m.type === 'ready') return this.run(true);
      if (m.type === 'rerun') return this.run(m.fetch !== false);
      if (m.type === 'fix') {
        await vscode.commands.executeCommand(`${VCS_CFG}.fix`, { action: m.action, file: m.file, name: m.name, path: m.path });
        return this.run(false);
      }
      if (m.type === 'openFile' && m.file) return void vscode.window.showTextDocument(vscode.Uri.file(m.file));
    });
  }

  private html(media: vscode.Uri): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}"><link rel="stylesheet" href="${uri('vcstool', 'matchday.css')}">
</head><body><div id="root"></div><script nonce="${nonce}" src="${uri('vcstool', 'matchday.js')}"></script></body></html>`;
  }

  /** Check everything. `fetch` first makes "not pushed" and "not on the remote" exact; a re-check after a fix skips it. */
  async run(fetch: boolean): Promise<void> {
    if (this.running) return;
    this.running = true;
    void this.panel.webview.postMessage({ type: 'running', fetch });
    try {
      const result = await this.check(fetch);
      void this.panel.webview.postMessage({ type: 'result', result });
    } catch (e) {
      void this.panel.webview.postMessage({ type: 'failed', error: String(e) });
    } finally {
      this.running = false;
    }
  }

  private async check(fetch: boolean): Promise<CheckResult> {
    const started = Date.now();
    await this.ws.refresh();
    const freeze = normalizeFreeze(vscode.workspace.getConfiguration(VCS_CFG).get('freeze', 'pinned'));
    const fetchFailed: string[] = [];
    const files: FileResult[] = [];

    for (const f of this.ws.files) {
      if (!f.parsed) {
        files.push({ file: f.filePath, fileName: f.fileName, repos: 0, problems: [], error: f.error });
        continue;
      }
      const repos = f.entries.filter((e) => e.facts.exists && e.facts.head.kind !== 'notGit' && (e.entry.type ?? 'git') === 'git');
      if (fetch) {
        await pool(repos, 4, async (e) => {
          if (!(await this.ws.gitOrError(e.path, ['fetch', '--quiet'], NETWORK_ENV)).ok) fetchFailed.push(e.entry.name);
        });
      }
      const inputs: MatchDayInput[] = [];
      await pool(f.entries, 6, async (e) => {
        const facts: RepoFacts = { ...this.ws.factsFromFiles(e.path) };
        let pinnedOnRemote: boolean | undefined;
        if (facts.exists && facts.head.kind !== 'notGit') {
          const status = await this.ws.git_(e.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
          if (status !== undefined) Object.assign(facts, parseStatusV2(status));
          if (e.frozen) this.ws.frozenChanges.set(e.path, facts.changes ?? 0);
          const commit = headCommit(facts.head);
          const v = e.entry.version?.trim();
          if (commit && v && isCommitHash(v)) {
            if (!commit.startsWith(v.toLowerCase())) {
              const rl = await this.ws.git_(e.path, ['rev-list', '--left-right', '--count', `${v}...${commit}`]);
              const m = rl && /^(\d+)\s+(\d+)/.exec(rl);
              if (m) facts.pinned = { behind: Number(m[1]), ahead: Number(m[2]) };
            }
            pinnedOnRemote = await this.ws.onRemote(e.path, v);
          }
          if (facts.head.kind === 'detached' && v && !isCommitHash(v)) {
            facts.versionCommit = (await this.ws.git_(e.path, ['rev-parse', '--verify', '--quiet', `${v}^{commit}`]))?.trim() || undefined;
          }
        }
        inputs.push({ entry: e.entry, path: e.path, frozen: isFrozen(e.entry, freeze), facts, drift: computeDrift(e.entry, facts), pinnedOnRemote });
      });
      const order = new Map(f.entries.map((e, i) => [e.entry.name, i]));
      inputs.sort((a, b) => order.get(a.entry.name)! - order.get(b.entry.name)!);
      files.push({ file: f.filePath, fileName: f.fileName, repos: f.entries.length, problems: matchDayProblems(inputs, f.extras, f.fileName) });
    }
    // The frozen group in the panel now knows about uncommitted files too.
    this.ws.scheduleRefresh(0);
    return { checkedAt: Date.now(), durationMs: Date.now() - started, fetched: fetch, fetchFailed: fetchFailed.sort(), files };
  }
}
