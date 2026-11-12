// Flex Rig: run the app a task built, so the task can check it in its hidden test browser.
// Installed to C:\Users\you\.flexrig\serve.mjs (beside flexrig.mjs). Plain node, no dependencies.
//   node serve.mjs start --port <n> [--name <label>] [--wait <seconds>] [--keep <hours>] -- <command and its arguments>
//       starts the command in the background from the current folder, waits until the port answers,
//       prints http://localhost:<n>. Output goes to runs\<run id>\servers\<name>.log.
//       --keep <hours>: a preview for the user. It outlives the task: a plain "stop" leaves it alone until its hours are up.
//   node serve.mjs list                      this run's servers
//   node serve.mjs stop [--name <label>]     stop one, or all of this run's servers (the whole process tree).
//                                            Without a name, kept servers whose hours are not up yet stay.
//   node serve.mjs stop --expired            stop only kept servers whose hours are up
//   node serve.mjs remember --port <n> [--dir <folder inside the worktree>] [--note "<one line>"] -- <command>
//       only notes how to start the app, in runs\<run id>\preview.json (flexrig.mjs preview-start reads it)
// The run id comes from --run <id>, else FLEXRIG_RUN_ID (set by flexrig.mjs), else the current folder
// when it is inside .flexrig\wt\<id>. flexrig.mjs runs "stop --run <id>" whenever a task ends.
// Servers are for this PC only (localhost): nothing here opens the firewall or installs anything.
// Tests: node --test serve.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const BASE = process.env.FLEXRIG_TEST_HOME || path.join(os.homedir(), '.flexrig');   // same folder flexrig.mjs uses
const RUNS = path.join(BASE, 'runs');
const WT = path.join(BASE, 'wt');
const USAGE = 'usage: node serve.mjs start --port <n> [--name <label>] [--wait <seconds>] [--keep <hours>] -- <command>  |  list  |  stop [--name <label> | --expired]  |  remember --port <n> [--dir <folder>] [--note "<one line>"] -- <command>';

const validId = (id) => /^[0-9]{8}-[0-9]{4}-[0-9a-f]{4}$/.test(id || '');
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); };
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => process.stdout.write(s + '\n');
const quote = (a) => (/^[A-Za-z0-9_.\/\\:=@+,-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
const serversFile = (id) => path.join(RUNS, id, 'servers.json');
const loadServers = (id) => { const s = readJson(serversFile(id), []); return Array.isArray(s) ? s : []; };
const saveServers = (id, list) => { if (list.length) writeJson(serversFile(id), list); else fs.rmSync(serversFile(id), { force: true }); };
// Kept servers (start --keep): previews that outlive the task, until their hours are up.
const expired = (s) => !(Date.parse(s.expiresAt) > Date.now());
const kept = (s) => s.keep === true && !expired(s);
const two = (n) => String(n).padStart(2, '0');
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '?' : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };   // this PC's clock

// Options come before "--", the app's own command after it.
function parse(argv) {
  const cut = argv.indexOf('--');
  const head = cut < 0 ? argv : argv.slice(0, cut);
  const opts = {};
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '--expired') { opts.expired = true; continue; }
    const m = head[i].match(/^--(port|name|wait|run|dir|note|keep)$/);
    if (!m || i + 1 >= head.length) throw new Error(`don't understand "${head[i]}"\n${USAGE}`);
    opts[m[1]] = head[++i];
  }
  return { opts, command: cut < 0 ? [] : argv.slice(cut + 1) };
}

function runId(opts) {
  const rel = path.relative(WT, process.cwd());
  const fromFolder = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : null;
  const id = opts.run || process.env.FLEXRIG_RUN_ID || fromFolder;
  if (!id) throw new Error(`can't tell which Flex Rig run this is: FLEXRIG_RUN_ID is not set and this folder is not inside ${WT}. Run it from the task's worktree, or pass --run <id>.`);
  if (!validId(id)) throw new Error(`"${id}" is not a Flex Rig run id (they look like 20261109-1845-abaa)`);
  return id;
}

function portOf(opts) {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('give the port the app listens on: --port <number>');
  return port;
}

// Does anything give an HTTP answer on this port? Any status counts. 127.0.0.1 first; ::1 too, because
// some dev servers only listen on the IPv6 side of "localhost".
function answersOn(host, port, ms) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', agent: false, timeout: ms }, (res) => { res.destroy(); resolve(true); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}
const answers = async (port, ms = 2000) => (await answersOn('127.0.0.1', port, ms)) || answersOn('::1', port, ms);

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// When a Windows process started (null = can't tell, or it's gone). Used to make sure a recorded pid is
// still the server we started and not some other program that got the same number later.
function bornAt(pid) {
  if (!WIN) return null;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const t = Date.parse((r.stdout || '').trim());
  return Number.isNaN(t) ? null : t;
}

function alive(s) {
  const started = Date.parse(s.startedAt);
  if (!Number.isInteger(s.pid) || !(started > Date.now() - os.uptime() * 1000)) return false;   // from before this PC last started
  if (!pidAlive(s.pid)) return false;
  const born = bornAt(s.pid);
  return born === null || Math.abs(born - started) < 10000;
}

// Ends the process and everything it started. True when it's gone.
function killTree(pid) {
  if (WIN) {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 30000 });
    for (let i = 0; i < 25 && pidAlive(pid); i++) pause(200);
    return !pidAlive(pid);
  }
  const group = (sig) => { try { process.kill(-pid, sig); return true; } catch { return false; } };   // the app runs in its own process group
  group('SIGTERM');
  for (let i = 0; i < 15 && group(0); i++) pause(200);
  if (group(0)) group('SIGKILL');
  for (let i = 0; i < 15 && group(0); i++) pause(200);
  return !group(0);
}

function lastLines(file, n) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-n); } catch { return []; }
}

async function start(opts, command) {
  const id = runId(opts);
  const port = portOf(opts);
  const name = opts.name || 'app';
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name) || name.startsWith('.')) throw new Error('--name: letters, numbers, dot, dash and underscore only');
  const wait = opts.wait === undefined ? 60 : Number(opts.wait);
  if (!(wait > 0 && wait <= 600)) throw new Error('--wait: seconds, from 1 to 600');
  const keep = opts.keep === undefined ? null : Number(opts.keep);
  if (keep !== null && !(keep > 0 && keep <= 24)) throw new Error('--keep: hours, more than 0 and up to 24');
  if (!command.length) throw new Error(`no command to start: put it after "--", for example: node serve.mjs start --port ${port} -- npm.cmd run dev`);

  const old = loadServers(id).find((s) => s.name === name);
  if (old && alive(old)) throw new Error(`"${name}" is already running (pid ${old.pid}, http://localhost:${old.port}). Stop it first (node serve.mjs stop --name ${name}) or give this one another --name.`);
  if (await answers(port)) throw new Error(`something is already answering on port ${port}. Stop it or pick another port.`);

  const logFile = path.join(RUNS, id, 'servers', `${name}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'w');
  // The background half is this same file in "_run" mode (see the end): a node process of its own that
  // runs the command. It is what gets recorded and stopped, and everything it starts hangs under it.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_run', ...command], { cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  let ended = null;
  child.on('error', (e) => { ended = `could not start it: ${e.message}`; });
  child.on('exit', (code) => { ended = ended || `it stopped by itself (exit code ${code})`; });
  if (!child.pid) { await sleep(50); throw new Error(`${ended || 'could not start it'}: ${command.join(' ')}`); }

  const born = bornAt(child.pid);
  const rec = { name, pid: child.pid, port, command: command.map(quote).join(' '), cwd: process.cwd(), startedAt: new Date(born || Date.now()).toISOString() };
  if (keep !== null) Object.assign(rec, { keep: true, expiresAt: new Date(Date.now() + keep * 3600000).toISOString() });
  saveServers(id, [...loadServers(id).filter((s) => s.name !== name), rec]);

  const until = Date.now() + wait * 1000;
  let up = false;
  while (!up && ended === null && Date.now() < until) {
    up = await answers(port, Math.max(500, Math.min(5000, until - Date.now())));
    if (!up) await sleep(300);
  }
  if (up) {
    child.unref();
    say(`http://localhost:${port}`);
    return 0;
  }

  const gone = killTree(child.pid);
  if (gone) saveServers(id, loadServers(id).filter((s) => !(s.name === name && s.pid === child.pid)));
  const tail = lastLines(logFile, 20);
  console.error(`"${name}" did not answer on http://127.0.0.1:${port}: ${ended || `nothing after ${wait} seconds`}.`);
  console.error(tail.length ? `Last lines of ${logFile}:\n${tail.join('\n')}` : `It printed nothing (log: ${logFile}).`);
  console.error(gone ? 'It has been stopped.' : `Could not stop pid ${child.pid}: run "node serve.mjs stop".`);
  return 1;
}

function list(opts) {
  const servers = loadServers(runId(opts));
  if (!servers.length) say('no servers');
  for (const s of servers) say(`${s.name}  ${alive(s) ? 'running' : 'stopped'}  http://localhost:${s.port}  pid ${s.pid}${s.keep === true ? `  kept until ${when(s.expiresAt)}` : ''}  ${s.command}`);
  return 0;
}

// No name: everything of this run except kept servers whose hours are not up (the runner calls it like
// this when a task ends). --name: that one, kept or not. --expired: only kept servers whose hours are up.
function stop(opts) {
  const id = runId(opts);
  if (opts.name && opts.expired) throw new Error('give --name or --expired, not both');
  const servers = loadServers(id);
  const picked = opts.name ? servers.filter((s) => s.name === opts.name) : opts.expired ? servers.filter((s) => s.keep === true && expired(s)) : servers;
  if (opts.name && !picked.length) throw new Error(`no server named "${opts.name}" in this run`);
  if (!picked.length) { say('no servers to stop'); return 0; }
  const stuck = [], left = [];
  for (const s of picked) {
    if (!alive(s)) say(`${s.name}: was not running`);
    else if (!opts.name && kept(s)) { say(`${s.name}: kept until ${when(s.expiresAt)} (stop it with: stop --name ${s.name})`); left.push(s); }
    else if (killTree(s.pid)) say(`${s.name}: stopped (pid ${s.pid})`);
    else { say(`${s.name}: could not stop pid ${s.pid}`); stuck.push(s); }
  }
  const gone = picked.filter((p) => !stuck.includes(p) && !left.includes(p));
  saveServers(id, loadServers(id).filter((s) => !gone.some((p) => p.name === s.name && p.pid === s.pid)));
  return stuck.length ? 1 : 0;
}

function remember(opts, command) {
  const id = runId(opts);
  const port = portOf(opts);
  if (!command.length) throw new Error('no command to remember: put it after "--"');
  const rel = path.relative(WT, process.cwd());
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const root = readJson(path.join(RUNS, id, 'job.json'))?.worktree || (inside ? path.join(WT, rel.split(path.sep)[0]) : process.cwd());
  const folder = path.resolve(process.cwd(), opts.dir || '.');
  const dir = path.relative(root, folder);
  if (dir.startsWith('..') || path.isAbsolute(dir)) throw new Error(`--dir has to be a folder inside the worktree (${root})`);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`no such folder: ${folder}`);
  const preview = { command: command.map(quote).join(' '), dir: dir.split(path.sep).join('/') || '.', port, note: String(opts.note || '').replace(/\s+/g, ' ').trim().slice(0, 300) };
  fs.mkdirSync(path.join(RUNS, id), { recursive: true });
  writeJson(path.join(RUNS, id, 'preview.json'), preview);
  say(`remembered: "${preview.command}" in ${preview.dir} on port ${port}`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === '_run') {
  // Internal, started by "start": run the app's command with its output in the log, and end when it ends.
  // On Windows through a shell, because npm and npx are .cmd files. (A shell started straight from "start"
  // would have no console of its own, and then Windows sends the app's output to a new console, not the log.)
  const app = WIN ? spawn(rest.map(quote).join(' '), { shell: true, stdio: 'inherit', windowsHide: true }) : spawn(rest[0], rest.slice(1), { stdio: 'inherit' });
  app.on('error', (e) => { console.error(`could not start it: ${e.message}`); process.exit(1); });
  app.on('exit', (c) => process.exit(c ?? 1));
} else {
  let code = 1;
  try {
    const { opts, command } = parse(rest);
    if (cmd === 'start') code = await start(opts, command);
    else if (cmd === 'stop') code = stop(opts);
    else if (cmd === 'list') code = list(opts);
    else if (cmd === 'remember') code = remember(opts, command);
    else { console.error(USAGE); code = 2; }
  } catch (e) {
    console.error(String(e.message || e));
  }
  // Let the printed lines get out, then end (the started app must not keep this command waiting).
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}
