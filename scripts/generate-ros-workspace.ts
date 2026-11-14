/**
 * Test workspace generator for the vcstool (.repos) features and the combined graph.
 *
 * Creates a copy of the Eurobot ROS 2 layout in ~/repos/test-ros-workspace:
 *
 *   test-ros-workspace/                  main repository (open this folder in VS Code)
 *   ├── ros_ws.repos                     26 entries, `version: jazzy` or a pinned commit
 *   └── ros_ws/
 *       ├── src/<26 repositories>        separate clones, not submodules
 *       └── ros2_info/                   a repository outside the file and outside src/
 *   test-ros-workspace.remotes/<name>.git  local bare remotes (the `url:` of every entry)
 *
 * Test states (see STATES below): uncommitted files, a commit that is not pushed, a remote
 * that is ahead, a repository on another branch than the file, a detached HEAD, a different
 * origin URL, a missing repository, a repository not in the file, hand-pinned (frozen)
 * repositories on and off their pin, and an entry pinned by Lock (`# locked: jazzy`).
 *
 * History is written with `git fast-import` straight into each bare remote, so large histories
 * are quick:  pnpm generate-ros-workspace -- --commits 2000
 *
 * DESTRUCTIVE: deletes and recreates both folders. Asks first unless --yes is given.
 *
 * Usage: pnpm generate-ros-workspace [-- --commits <n>] [--yes] [--out <dir>]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

// ---------------------------------------------------------------------------
// Layout (the real ros_ws.repos, in its order)
// ---------------------------------------------------------------------------

/** Entries pinned to a commit by hand in the real file (frozen by default). */
const PINNED = new Set(['dwpp_controller', 'rapp_controller', 'BehaviorTree.ROS2', 'jsk_visualization', 'ruckig', 'sllidar_ros2']);

const REPOS = [
  'automation_middleman', 'automation_ros2', 'bno055', 'camera_localization_cpp', 'custom_btcpp',
  'custom_costmap_plugins', 'custom_interfaces', 'hmi', 'lidar_object_detection_ros2', 'my_bot',
  'nav2_straightline_planner', 'nav2_tools', 'overwatch', 'overwatch-panel', 'positions',
  'robot_camera', 'table_publisher', 'tuning_tools', 'waveshare_servos', 'dwpp_controller',
  'Enemy_robot', 'rapp_controller', 'BehaviorTree.ROS2', 'jsk_visualization', 'ruckig', 'sllidar_ros2',
] as const;

/** Which repository shows which state. Every name is a real entry. */
const STATES = {
  uncommitted: 'hmi',               // a modified and an untracked file
  unpushed: 'positions',            // one local commit not pushed
  remoteAhead: 'nav2_tools',        // the remote has one commit more (fetched, so it shows as 1↓)
  otherBranch: 'overwatch',         // on feature/new-ui, the file says jazzy
  detached: 'custom_btcpp',         // detached HEAD while the file says jazzy
  otherOrigin: 'Enemy_robot',       // origin points to a fork
  missing: 'tuning_tools',          // listed, remote exists, not cloned (try Clone)
  lockedByLock: 'my_bot',           // `version: <hash>  # locked: jazzy` (open, not frozen)
  pinOff: 'jsk_visualization',      // frozen, but one commit after its pin
  pinQuoted: 'sllidar_ros2',        // pinned with a quoted hash, like the real file
} as const;

/** A repository in the target folder that the file does not list (try Add to File). */
const EXTRA = 'scratch_pkg';
/** A repository outside the file and outside src/ (not reported). */
const OUTSIDE = 'ros2_info';

const AUTHORS = [
  { name: 'Manos G', email: 'manos@example.com' },
  { name: 'Eleni K', email: 'eleni@example.com' },
  { name: 'Nikos P', email: 'nikos@example.com' },
  { name: 'Maria S', email: 'maria@example.com' },
  { name: 'Upstream Dev', email: 'dev@upstream.example.com' },
] as const;

const VERBS = ['Add', 'Fix', 'Tune', 'Refactor', 'Update', 'Clean up', 'Document', 'Speed up'];
const THINGS = ['launch file', 'parameters', 'odometry', 'servo limits', 'path planner', 'BT nodes', 'lidar filter', 'camera calibration', 'HMI layout', 'costmap layer', 'CMake', 'README'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const a = process.argv.slice(2);
  const val = (flag: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    commits: Math.max(3, Number(val('--commits') ?? 12)),
    yes: a.includes('--yes') || a.includes('-y'),
    out: resolve(val('--out') ?? join(homedir(), 'repos', 'test-ros-workspace')),
  };
}

/** Deterministic pseudo-random numbers, so two runs make the same histories. */
class Rand {
  constructor(private s: number) {}
  next() {
    this.s = (this.s * 1103515245 + 12345) & 0x7fffffff;
    return this.s / 0x7fffffff;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
}

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Commit with a fixed author/date (local commits made after the history). */
function commitAt(cwd: string, message: string, when: number, author = AUTHORS[0]) {
  const date = `${when} +0000`;
  execFileSync('git', ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '-am', message], {
    cwd,
    env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: 'ignore',
  });
}

// ---------------------------------------------------------------------------
// History through git fast-import
// ---------------------------------------------------------------------------

/**
 * Writes `count` commits on `jazzy` into a bare repository: one file changed per commit, a
 * short-lived feature branch merged back every 25 commits, dates spread over the last weeks
 * (newest about 1 hour ago) so the combined graph has interleaved timelines.
 */
function writeHistory(bare: string, name: string, count: number, rand: Rand, now: number) {
  const chunks: string[] = [];
  const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  const span = Math.max(count, 30) * 3600 * 4; // ~4 h per commit on average
  let t = now - span;
  let mark = 0;
  let prev = 0;
  for (let i = 1; i <= count; i++) {
    t += Math.floor(rand.next() * 8 * 3600) + 60;
    if (t > now - 3600) t = now - 3600 - (count - i) * 60;
    const author = rand.pick(AUTHORS);
    const sig = `${author.name} <${author.email}> ${t} +0000`;
    const message = i === 1 ? `Initial ${name} package` : `${rand.pick(VERBS)} ${rand.pick(THINGS)} in ${name}`;
    const file = i === 1 ? 'package.xml' : rand.pick(['src/node.cpp', 'launch/bringup.launch.py', 'config/params.yaml', 'README.md']);
    const body =
      i === 1
        ? `<?xml version="1.0"?>\n<package format="3">\n  <name>${name}</name>\n  <version>0.1.0</version>\n</package>\n`
        : `// ${name} revision ${i}\n// ${message}\n`;

    if (i > 2 && i % 25 === 0) {
      // feature branch from prev, then a merge commit on jazzy
      const side = ++mark;
      chunks.push(`commit refs/heads/feature/f${i}\nmark :${side}\nauthor ${sig}\ncommitter ${sig}\n${data(`Work on ${rand.pick(THINGS)}`)}from :${prev}\nM 100644 inline feature/f${i}.txt\n${data(`feature ${i}\n`)}`);
      const merge = ++mark;
      const msig = `${author.name} <${author.email}> ${t + 30} +0000`;
      chunks.push(`commit refs/heads/jazzy\nmark :${merge}\nauthor ${msig}\ncommitter ${msig}\n${data(`Merge branch 'feature/f${i}' into jazzy`)}from :${prev}\nmerge :${side}\n`);
      // a merged branch is deleted, as people do; `reset` without `from` leaves the ref unwritten
      chunks.push(`reset refs/heads/feature/f${i}\n\n`);
      prev = merge;
      continue;
    }
    const m = ++mark;
    chunks.push(`commit refs/heads/jazzy\nmark :${m}\nauthor ${sig}\ncommitter ${sig}\n${data(message)}${prev ? `from :${prev}\n` : ''}M 100644 inline ${file}\n${data(body)}`);
    prev = m;
  }
  const r = spawnSync('git', ['fast-import', '--quiet'], { cwd: bare, env: ENV, input: chunks.join('') });
  if (r.status !== 0) throw new Error(`fast-import failed in ${bare}: ${r.stderr}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { commits, yes, out } = parseArgs();
  const remotes = `${out}.remotes`;
  if ((existsSync(out) || existsSync(remotes)) && !yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`This deletes and recreates\n  ${out}\n  ${remotes}\nContinue? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Nothing changed.');
      return;
    }
  }
  rmSync(out, { recursive: true, force: true });
  rmSync(remotes, { recursive: true, force: true });
  mkdirSync(remotes, { recursive: true });

  const started = Date.now();
  const now = Math.floor(Date.now() / 1000);
  const src = join(out, 'ros_ws', 'src');
  mkdirSync(src, { recursive: true });

  // 1. Bare remotes with history, clones in ros_ws/src.
  const all = [...REPOS, EXTRA, OUTSIDE];
  all.forEach((name, idx) => {
    const bare = join(remotes, `${name}.git`);
    git(remotes, 'init', '-q', '--bare', '-b', 'jazzy', bare);
    writeHistory(bare, name, commits, new Rand(1000 + idx * 7919), now);
    if (name === STATES.missing) return; // listed but never cloned
    const dest = name === OUTSIDE ? join(out, 'ros_ws', OUTSIDE) : join(src, name);
    git(out, 'clone', '-q', bare, dest);
    git(dest, 'config', 'user.name', AUTHORS[0].name);
    git(dest, 'config', 'user.email', AUTHORS[0].email);
  });

  // 2. Versions for the file: jazzy, or a pinned commit (the commit before the tip).
  const versions = new Map<string, { version: string; comment?: string; quoted?: boolean }>();
  for (const name of REPOS) {
    const bare = join(remotes, `${name}.git`);
    if (PINNED.has(name)) versions.set(name, { version: git(bare, 'rev-parse', 'jazzy~1'), quoted: name === STATES.pinQuoted });
    else versions.set(name, { version: 'jazzy' });
  }
  versions.set(STATES.lockedByLock, { version: git(join(remotes, `${STATES.lockedByLock}.git`), 'rev-parse', 'jazzy'), comment: 'locked: jazzy' });

  // 3. Pinned repositories are checked out at their pin (detached), like `vcs import` does.
  for (const name of PINNED) {
    const dir = join(src, name);
    const pin = versions.get(name)!.version;
    git(dir, 'checkout', '-q', '--detach', name === STATES.pinOff ? 'jazzy' : pin); // pinOff: one commit after its pin
  }

  // 4. The other test states.
  const at = (s: number) => now - s;
  writeFileSync(join(src, STATES.uncommitted, 'README.md'), '// edited, not committed\n');
  writeFileSync(join(src, STATES.uncommitted, 'notes.txt'), 'new file\n');

  appendFileSync(join(src, STATES.unpushed, 'README.md'), '// local change\n');
  git(join(src, STATES.unpushed), 'add', '-A');
  commitAt(join(src, STATES.unpushed), 'Tune start positions for Match 1 (not pushed)', at(600));

  {
    const tmp = join(remotes, '_tmp_clone');
    git(remotes, 'clone', '-q', join(remotes, `${STATES.remoteAhead}.git`), tmp);
    appendFileSync(join(tmp, 'README.md'), '// pushed by a teammate\n');
    git(tmp, 'add', '-A');
    commitAt(tmp, 'Teammate: update nav2 tools', at(900), AUTHORS[1]);
    git(tmp, 'push', '-q', 'origin', 'jazzy');
    rmSync(tmp, { recursive: true, force: true });
    git(join(src, STATES.remoteAhead), 'fetch', '-q');
  }

  git(join(src, STATES.otherBranch), 'checkout', '-q', '-b', 'feature/new-ui');
  git(join(src, STATES.detached), 'checkout', '-q', '--detach', 'HEAD~1');
  // origin points to a fork (a real remote, so fetch still works there)
  const fork = join(remotes, 'forks', `${STATES.otherOrigin}.git`);
  git(remotes, 'clone', '-q', '--bare', join(remotes, `${STATES.otherOrigin}.git`), fork);
  git(join(src, STATES.otherOrigin), 'remote', 'set-url', 'origin', fork);

  // 5. The main repository: ros_ws.repos, a .gitignore for the clones, two commits (the second is a lock).
  /** The file text; before the lock, the Lock-pinned entry still says jazzy. */
  const file = (locked: boolean) => {
    const lines = ['repositories:'];
    for (const name of REPOS) {
      const v = locked || name !== STATES.lockedByLock ? versions.get(name)! : { version: 'jazzy' };
      lines.push(`  ${name}:`, '    type: git', `    url: ${join(remotes, `${name}.git`)}`);
      lines.push(`    version: ${'quoted' in v && v.quoted ? `'${v.version}'` : v.version}${'comment' in v && v.comment ? `  # ${v.comment}` : ''}`);
    }
    return lines.join('\n') + '\n';
  };
  git(out, 'init', '-q', '-b', 'main');
  git(out, 'config', 'user.name', AUTHORS[0].name);
  git(out, 'config', 'user.email', AUTHORS[0].email);
  writeFileSync(join(out, '.gitignore'), 'ros_ws/src/\nros_ws/ros2_info/\nros_ws/build/\nros_ws/install/\nros_ws/log/\n');
  writeFileSync(join(out, 'README.md'), '# Test ROS 2 workspace\n\nGenerated by scripts/generate-ros-workspace.ts.\n');
  writeFileSync(join(out, 'ros_ws.repos'), file(false));
  git(out, 'add', '-A');
  commitAt(out, 'Add ros_ws.repos', at(14 * 86400));
  writeFileSync(join(out, 'ros_ws.repos'), file(true));
  commitAt(out, 'Lock versions for Practice Match', at(2 * 86400));

  // 6. The repository the file does not list, in the target folder.
  git(join(src, EXTRA), 'checkout', '-q', 'jazzy');

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Created ${out}`);
  console.log(`  ${REPOS.length} listed repositories (${PINNED.size} pinned, 1 missing), ${EXTRA} not in the file, ${OUTSIDE} outside src/`);
  console.log(`  ${commits} commits per repository · remotes in ${remotes} · ${secs} s`);
  console.log('Test states:');
  for (const [state, name] of Object.entries(STATES)) console.log(`  ${state.padEnd(13)} ${name}`);
  console.log(`  ${'notInFile'.padEnd(13)} ${EXTRA}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
