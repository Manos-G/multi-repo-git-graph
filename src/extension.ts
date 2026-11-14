import * as vscode from 'vscode';
import { ExtensionController } from './ExtensionController.js';
import { GitShowContentProvider } from './GitShowContentProvider.js';
import { createTelemetryService } from './services/TelemetryService.js';
import { registerChangedReposView } from './changedRepos/ChangedReposView.js';

let controller: ExtensionController | undefined;

export function activate(context: vscode.ExtensionContext) {
  const activationStart = performance.now();
  const log = vscode.window.createOutputChannel('Multi-Repo Git Graph', { log: true });
  context.subscriptions.push(log);

  log.info('Extension activated');

  // Fork: telemetry is always off. An empty connection string gives the no-op
  // service, so no usage data is ever sent, whatever the build environment has.
  const telemetry = createTelemetryService(context, '');
  context.subscriptions.push(telemetry);

  controller = new ExtensionController(context, log, telemetry, activationStart);

  // Fork: Source Control style panel that lists only the repositories with changes.
  // Its Git Graph button opens each repository in its own graph tab.
  void registerChangedReposView(context, {
    openGraph: (repoRoot) => controller?.openForRepo({ rootUri: repoRoot } as vscode.SourceControl),
    log,
  }).catch((err) => log.error(`Changed Repos panel failed to start: ${err}`));

  // Registered once, for the window — never per panel. A `git-show:` document
  // names its own repository in the URI, so it keeps resolving correctly after
  // the graph that opened it switched repo or closed.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      'git-show',
      new GitShowContentProvider((repoPath) => controller!.resolveDiffService(repoPath)),
    ),
  );

  // The optional argument is the status bar item's trigger; the controller
  // re-validates it against the closed catalog.
  const showGraphCommand = vscode.commands.registerCommand('multiRepoGraph.showGraph', (trigger?: unknown) => {
    controller?.showGraph(trigger);
  });

  const openNewGraphTabCommand = vscode.commands.registerCommand('multiRepoGraph.openNewGraphTab', () => {
    controller?.openNewGraphTab('commandPalette');
  });

  const openForRepoCommand = vscode.commands.registerCommand(
    'multiRepoGraph.openForRepo',
    (sourceControl: vscode.SourceControl) => {
      controller?.openForRepo(sourceControl);
    }
  );

  context.subscriptions.push(showGraphCommand, openNewGraphTabCommand, openForRepoCommand);
  context.subscriptions.push({
    dispose: () => {
      controller?.dispose();
      controller = undefined;
    },
  });
}

export function deactivate() {
  controller?.dispose();
  controller = undefined;
}
