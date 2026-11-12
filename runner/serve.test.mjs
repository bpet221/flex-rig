// Tests for serve.mjs: starting, listing and stopping the app a Flex Rig task built.
// Run:  node --test runner/serve.test.mjs
// A temp folder stands in for C:\Users\you\.flexrig. The "app" is a tiny node web server written into
// that folder; it also starts one child process, so the tests can see that stop ends the whole tree.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// The runner and its preview servers are written for Windows (process handling, taskkill); these tests only run there.
const WIN_ONLY = { skip: process.platform !== 'win32' && 'Windows only' };

const SERVE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serve.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flexrig-serve-test-'));
const RUN = '20261109-0900-aaaa', OTHER = '20261109-0901-bbbb';
const WORKTREE = path.join(HOME, 'wt', RUN);
const APP = path.join(WORKTREE, 'site');
const runDir = (id = RUN) => path.join(HOME, 'runs', id);
const NODE = process.execPath;   // on Windows this path has a space in it ("Program Files"): the quoting gets tested too

fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(APP, 'server.cjs'), `
const http = require('node:http'), fs = require('node:fs'), { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[3], JSON.stringify({ server: process.pid, child: child.pid }));
console.log('tiny server starting');
http.createServer((req, res) => res.end('hello from the tiny server')).listen(Number(process.argv[2]), '127.0.0.1');
`);
fs.writeFileSync(path.join(APP, 'idle.cjs'), `
require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ server: process.pid }));
console.log('idle: I never listen');
setInterval(() => {}, 1000);
`);

// Runs serve.mjs the way a task does. env FLEXRIG_RUN_ID: null = not set.
function serve(args, { cwd = APP, run = RUN } = {}) {
  const env = { ...process.env, FLEXRIG_TEST_HOME: HOME };
  delete env.FLEXRIG_RUN_ID;
  if (run) env.FLEXRIG_RUN_ID = run;
  const t = Date.now();
  const r = spawnSync(NODE, [SERVE, ...args], { cwd, env, encoding: 'utf8', timeout: 150000 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), seconds: (Date.now() - t) / 1000 };
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function gone(pid) {
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !pidAlive(pid);
}
const page = async (port) => { try { return await (await fetch(`http://127.0.0.1:${port}/`)).text(); } catch { return null; } };
const pidFile = (name) => path.join(HOME, `${name}-pids.json`);
const startTiny = (port, name, extra = []) => serve(['start', '--port', String(port), ...(name ? ['--name', name] : []), ...extra, '--', NODE, 'server.cjs', String(port), pidFile(name || 'app')]);

after(() => {
  for (const id of [RUN, OTHER]) {   // whatever a failed test left behind (kept servers only stop by name)
    let names = [];
    try { names = readJson(path.join(runDir(id), 'servers.json')).map((s) => s.name); } catch {}
    for (const n of names) serve(['stop', '--run', id, '--name', n]);
  }
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('start answers on its port and prints the address; list shows it; the same name twice is an error; stop ends the server and its child', WIN_ONLY, async () => {
  const port = await freePort();
  const started = startTiny(port);
  assert.equal(started.code, 0, started.err);
  assert.equal(started.out, `http://localhost:${port}`);
  assert.equal(await page(port), 'hello from the tiny server');

  const [rec, ...more] = readJson(path.join(runDir(), 'servers.json'));
  assert.equal(more.length, 0);
  assert.deepEqual(Object.keys(rec), ['name', 'pid', 'port', 'command', 'cwd', 'startedAt']);
  assert.equal(rec.name, 'app', 'the default name');
  assert.equal(rec.port, port);
  assert.equal(rec.cwd, APP);
  assert.ok(rec.command.includes('server.cjs'));
  assert.ok(pidAlive(rec.pid));
  assert.match(fs.readFileSync(path.join(runDir(), 'servers', 'app.log'), 'utf8'), /tiny server starting/);

  const listed = serve(['list']);
  assert.equal(listed.code, 0);
  assert.match(listed.out, new RegExp(`^app\\s+running\\s+http://localhost:${port}\\s+pid ${rec.pid}`));

  const again = startTiny(await freePort());
  assert.equal(again.code, 1);
  assert.match(again.err, /"app" is already running/);
  assert.equal(await page(port), 'hello from the tiny server', 'the first one is untouched');

  const taken = startTiny(port, 'second');
  assert.equal(taken.code, 1);
  assert.match(taken.err, new RegExp(`already answering on port ${port}`));

  const pids = readJson(pidFile('app'));
  assert.ok(pidAlive(pids.server) && pidAlive(pids.child));
  const stopped = serve(['stop']);
  assert.equal(stopped.code, 0, stopped.out + stopped.err);
  assert.match(stopped.out, /app: stopped/);
  assert.ok(await gone(pids.server), 'the server is gone');
  assert.ok(await gone(pids.child), 'the process the server started is gone too');
  assert.ok(await gone(rec.pid));
  assert.equal(await page(port), null);
  assert.equal(fs.existsSync(path.join(runDir(), 'servers.json')), false, 'nothing left on record');
  assert.equal(serve(['list']).out, 'no servers');
  assert.equal(serve(['stop']).out, 'no servers to stop');
});

test('a command that never listens fails within the wait time and leaves nothing running', WIN_ONLY, async () => {
  const port = await freePort();
  const r = serve(['start', '--port', String(port), '--name', 'idle', '--wait', '3', '--', NODE, 'idle.cjs', pidFile('idle')]);
  assert.equal(r.code, 1);
  assert.ok(r.seconds < 25, `took ${r.seconds} s for a 3 second wait`);
  assert.equal(r.out, '', 'no address printed');
  assert.match(r.err, /did not answer/);
  assert.match(r.err, /nothing after 3 seconds/);
  assert.match(r.err, /idle: I never listen/, 'the end of its log is shown');
  assert.ok(await gone(readJson(pidFile('idle')).server), 'it was stopped');
  assert.equal(fs.existsSync(path.join(runDir(), 'servers.json')), false);
});

test('a command that ends right away fails at once, without sitting out the wait', WIN_ONLY, async () => {
  const r = serve(['start', '--port', String(await freePort()), '--name', 'broken', '--', NODE, 'not-there.cjs']);
  assert.equal(r.code, 1);
  assert.ok(r.seconds < 30, `took ${r.seconds} s`);
  assert.match(r.err, /stopped by itself/);
  assert.match(r.err, /not-there\.cjs/, 'node\'s own error is shown from the log');
  assert.equal(fs.existsSync(path.join(runDir(), 'servers.json')), false);
});

test('two servers: stop --name stops one, stop --run (what the runner does) stops the rest', WIN_ONLY, async () => {
  const a = await freePort(), b = await freePort();
  assert.equal(startTiny(a, 'one').code, 0);
  assert.equal(startTiny(b, 'two').code, 0);
  assert.match(serve(['list']).out, /^one\s+running.*\ntwo\s+running/);

  assert.equal(serve(['stop', '--name', 'nope']).code, 1);
  assert.equal(serve(['stop', '--name', 'one']).code, 0);
  assert.equal(await page(a), null);
  assert.equal(await page(b), 'hello from the tiny server');
  assert.deepEqual(readJson(path.join(runDir(), 'servers.json')).map((s) => s.name), ['two']);

  // The runner: another folder, no FLEXRIG_RUN_ID, the id given with --run.
  const byRunner = serve(['stop', '--run', RUN], { cwd: HOME, run: null });
  assert.equal(byRunner.code, 0, byRunner.err);
  assert.equal(await page(b), null);
  assert.ok(await gone(readJson(pidFile('two')).child));
  assert.equal(serve(['stop', '--run', OTHER], { cwd: HOME, run: null }).out, 'no servers to stop', 'a run that never started a server');
});

test('a record whose process is long gone (or from before a restart) is not running and is never killed', () => {
  const dead = spawnSync(NODE, ['-e', '']).pid;   // a process that has already ended
  fs.mkdirSync(runDir(OTHER), { recursive: true });
  fs.writeFileSync(path.join(runDir(OTHER), 'servers.json'), JSON.stringify([
    { name: 'old', pid: dead, port: 1, command: 'x', cwd: APP, startedAt: new Date().toISOString() },
    { name: 'me', pid: process.pid, port: 2, command: 'x', cwd: APP, startedAt: '2020-01-01T00:00:00.000Z' },   // this test's own pid, "started" years ago
  ]));
  assert.match(serve(['list'], { run: OTHER }).out, /^old\s+stopped.*\nme\s+stopped/);
  const r = serve(['stop'], { run: OTHER });
  assert.equal(r.code, 0);
  assert.match(r.out, /old: was not running\nme: was not running/);
  assert.equal(fs.existsSync(path.join(runDir(OTHER), 'servers.json')), false);
});

test('Windows: a recorded process number that now belongs to another program is left alone', { skip: process.platform !== 'win32' }, async () => {
  const other = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });   // stands in for "some other program"
  try {
    fs.mkdirSync(runDir(OTHER), { recursive: true });
    // Same pid, but the record says the server started a minute after this process really did.
    fs.writeFileSync(path.join(runDir(OTHER), 'servers.json'), JSON.stringify([{ name: 'reused', pid: other.pid, port: 3, command: 'x', cwd: APP, startedAt: new Date(Date.now() + 60000).toISOString() }]));
    assert.match(serve(['list'], { run: OTHER }).out, /^reused\s+stopped/);
    assert.match(serve(['stop'], { run: OTHER }).out, /reused: was not running/);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(pidAlive(other.pid), 'the other program is still running');
    assert.equal(fs.existsSync(path.join(runDir(OTHER), 'servers.json')), false);
  } finally { other.kill(); }
});

test('a kept server (start --keep) survives a plain stop; --name stops it, and so does --expired once its hours are up', WIN_ONLY, async () => {
  const file = path.join(runDir(), 'servers.json');
  const names = () => readJson(file).map((s) => s.name);
  const pastItsTime = () => fs.writeFileSync(file, JSON.stringify(readJson(file).map((s) => (s.keep ? { ...s, expiresAt: new Date(Date.now() - 60000).toISOString() } : s))));
  const p = await freePort(), q = await freePort();
  assert.equal(startTiny(p, 'preview', ['--keep', '4']).code, 0);
  assert.equal(startTiny(q).code, 0);
  const rec = readJson(file).find((s) => s.name === 'preview');
  assert.equal(rec.keep, true);
  const hours = (Date.parse(rec.expiresAt) - Date.now()) / 3600000;
  assert.ok(hours > 3.9 && hours <= 4, `expires in ${hours} hours`);
  assert.equal(readJson(file).find((s) => s.name === 'app').keep, undefined, 'a plain start is not kept');
  assert.match(serve(['list']).out, /^preview\s+running\s+http:\/\/localhost:\d+\s+pid \d+\s+kept until \d{4}-\d\d-\d\d \d\d:\d\d\s/m);
  assert.doesNotMatch(serve(['list']).out, /^app\s.*kept until/m);

  // What the runner does when the task ends: the task's own app goes, the preview stays.
  const plain = serve(['stop', '--run', RUN], { cwd: HOME, run: null });
  assert.equal(plain.code, 0, plain.out + plain.err);
  assert.match(plain.out, /preview: kept until/);
  assert.match(plain.out, /app: stopped/);
  assert.equal(await page(q), null);
  assert.equal(await page(p), 'hello from the tiny server');
  assert.deepEqual(names(), ['preview']);

  // Its hours are not up: --expired leaves it alone too.
  const early = serve(['stop', '--expired']);
  assert.equal(early.code, 0);
  assert.equal(early.out, 'no servers to stop');
  assert.equal(await page(p), 'hello from the tiny server');

  // By name it stops, kept or not.
  const byName = serve(['stop', '--name', 'preview']);
  assert.equal(byName.code, 0, byName.out + byName.err);
  assert.match(byName.out, /preview: stopped/);
  assert.equal(await page(p), null);
  assert.ok(await gone(readJson(pidFile('preview')).child));
  assert.equal(fs.existsSync(file), false);

  // Past its time: --expired stops it and nothing else.
  assert.equal(startTiny(p, 'preview', ['--keep', '0.5']).code, 0);
  assert.equal(startTiny(q).code, 0);
  pastItsTime();
  const late = serve(['stop', '--expired']);
  assert.equal(late.code, 0, late.out + late.err);
  assert.match(late.out, /preview: stopped/);
  assert.doesNotMatch(late.out, /app/);
  assert.equal(await page(p), null);
  assert.equal(await page(q), 'hello from the tiny server', 'a server that is not kept is not touched by --expired');
  assert.deepEqual(names(), ['app']);

  // Past its time, a plain stop takes it as well.
  assert.equal(startTiny(p, 'preview', ['--keep', '4']).code, 0);
  pastItsTime();
  const all = serve(['stop']);
  assert.match(all.out, /app: stopped/);
  assert.match(all.out, /preview: stopped/);
  assert.equal(await page(p), null);
  assert.equal(fs.existsSync(file), false);

  // A kept server that died by itself is cleared from the record by a plain stop.
  fs.writeFileSync(file, JSON.stringify([{ name: 'preview', pid: spawnSync(NODE, ['-e', '']).pid, port: p, command: 'x', cwd: APP, startedAt: new Date().toISOString(), keep: true, expiresAt: new Date(Date.now() + 3600000).toISOString() }]));
  assert.match(serve(['stop']).out, /preview: was not running/);
  assert.equal(fs.existsSync(file), false);

  for (const bad of ['0', '-1', '25', 'soon']) assert.equal(startTiny(p, 'preview', ['--keep', bad]).code, 1, `--keep ${bad}`);
  assert.equal(serve(['stop', '--name', 'preview', '--expired']).code, 1, 'one or the other');
  assert.equal(fs.existsSync(file), false);
});

test('remember writes preview.json and nothing else', WIN_ONLY, () => {
  const r = serve(['remember', '--port', '5173', '--note', 'The new  order page', '--', 'npm', 'run', 'dev']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readJson(path.join(runDir(), 'preview.json')), { command: 'npm run dev', dir: 'site', port: 5173, note: 'The new order page' });
  assert.equal(fs.existsSync(path.join(runDir(), 'servers.json')), false, 'nothing was started');

  const fromRoot = serve(['remember', '--port', '8787', '--dir', 'site', '--', 'npx', 'wrangler', 'dev'], { cwd: WORKTREE });
  assert.equal(fromRoot.code, 0, fromRoot.err);
  assert.deepEqual(readJson(path.join(runDir(), 'preview.json')), { command: 'npx wrangler dev', dir: 'site', port: 8787, note: '' });
  assert.equal(serve(['remember', '--port', '8787', '--', 'npm', 'start'], { cwd: WORKTREE }).code, 0);
  assert.equal(readJson(path.join(runDir(), 'preview.json')).dir, '.');

  const outside = serve(['remember', '--port', '8787', '--dir', path.join('..', '..'), '--', 'npm', 'start'], { cwd: WORKTREE });
  assert.equal(outside.code, 1);
  assert.match(outside.err, /inside the worktree/);
  assert.equal(serve(['remember', '--port', '8787']).code, 1, 'no command');
  assert.equal(serve(['remember', '--', 'npm', 'start']).code, 1, 'no port');
});

test('the run id: FLEXRIG_RUN_ID, else the worktree folder, else a clear error; --run wins', WIN_ONLY, () => {
  assert.equal(serve(['list'], { run: null }).out, 'no servers', 'taken from the folder inside wt\\<id>');
  const lost = serve(['list'], { cwd: HOME, run: null });
  assert.equal(lost.code, 1);
  assert.match(lost.err, /FLEXRIG_RUN_ID is not set/);
  assert.equal(serve(['list', '--run', OTHER], { cwd: HOME, run: null }).code, 0);
  const bad = serve(['list'], { run: 'not-a-run' });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /not a Flex Rig run id/);
  assert.equal(serve(['dance']).code, 2);
});
