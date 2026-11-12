// Sets up the test browser for Flex Rig tasks. Runs ON Flex Rig (Windows). Safe to run again.
// The Mac's handoff/install.sh copies this file to C:\Users\you\.flexrig\browser-install.mjs and runs it over SSH:
//   node browser-install.mjs [--dir <folder>] [--no-shortcut]      (both options are only for trying it out elsewhere)
//
// Everything goes in C:\Users\you\.flexrig\browser, outside every repo:
//   1. the Playwright browser tool (npm package @playwright/mcp), pinned to the exact VERSION below
//   2. Playwright's own Chromium ("Chrome for Testing"; Playwright keeps it in %LOCALAPPDATA%\ms-playwright).
//      Never the user's real Chrome or its profile.
//   3. profile\  the browser's saved sign-ins, shared by tasks (one at a time)
//   4. a check that the browser really starts hidden and takes a screenshot; only then ready.json is written.
//      flexrig.mjs gives tasks a browser only when ready.json is there, so a failed set-up = tasks run as before.
//   5. the "Flex Rig browser sign-in" shortcut on the Windows desktop: the same Chromium and profile in a
//      visible window, for the user to sign in to sites over Remote Desktop. (Made again on every run, because
//      Chromium's folder name changes with its version.)
// Nothing here runs in the background or listens on the network.
//
// Upgrade: change VERSION, merge, run the Mac installer again (with no Flex Rig task running).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const VERSION = '0.0.84';   // @playwright/mcp. Picked 2026-11-09: nine days old then, and it pins playwright itself to one exact version.
const SHORTCUT = 'Flex Rig browser sign-in';

const argv = process.argv.slice(2);
const dirAt = argv.indexOf('--dir');
const DIR = path.resolve(dirAt >= 0 && argv[dirAt + 1] ? argv[dirAt + 1] : path.join(os.homedir(), '.flexrig', 'browser'));
const WANT_SHORTCUT = !argv.includes('--no-shortcut');
const PROFILE = path.join(DIR, 'profile');
const READY = path.join(DIR, 'ready.json');
const PKG = path.join(DIR, 'node_modules', '@playwright', 'mcp');
const CLI = path.join(PKG, 'cli.js');

const say = (s) => console.log(`Test browser: ${s}`);
const lastLines = (r) => `${r.stdout || ''}\n${r.stderr || ''}${r.error ? `\n${r.error}` : ''}`.trim().split(/\r?\n/).slice(-8).join('\n');
function fail(step, detail) {
  try { fs.rmSync(READY, { force: true }); } catch {}
  say(`FAILED: could not ${step}. Flex Rig tasks still run, just without a browser.`);
  if (detail) console.log(detail);
  process.exit(1);
}

// The profile will hold live sign-ins: never let it sit inside a git repo.
for (let d = DIR; ; d = path.dirname(d)) {
  if (fs.existsSync(path.join(d, '.git'))) fail(`use ${DIR}: it is inside a git repo (${d})`);
  if (path.dirname(d) === d) break;
}
fs.mkdirSync(DIR, { recursive: true });

// ---------- 1. the browser tool ----------
const installedVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version; } catch { return null; } };
function npm(args) {
  const opts = { cwd: DIR, encoding: 'utf8', windowsHide: true, timeout: 10 * 60000 };
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');   // npm's own script, beside node.exe
  if (fs.existsSync(cli)) return spawnSync(process.execPath, [cli, ...args], opts);
  return spawnSync(`${process.platform === 'win32' ? 'npm.cmd' : 'npm'} ${args.join(' ')}`, { ...opts, shell: true });   // npm.ps1 is blocked; npm.cmd needs a shell
}
const before = installedVersion();
if (before === VERSION && fs.existsSync(CLI)) {
  say(`browser tool @playwright/mcp ${VERSION} is already installed`);
} else {
  try { fs.rmSync(READY, { force: true }); } catch {}   // no browser for tasks while the tool is being replaced
  fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify({
    name: 'flexrig-browser', private: true,
    description: 'Test browser for Flex Rig tasks. Made by browser-install.mjs (flex-rig, runner/). Do not edit.',
    dependencies: { '@playwright/mcp': VERSION },
  }, null, 2) + '\n');
  // --ignore-scripts: nothing from the package runs during install (it needs none; Chromium is fetched in step 2).
  const r = npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']);
  if (r.status !== 0 || installedVersion() !== VERSION || !fs.existsSync(CLI)) fail(`install the browser tool @playwright/mcp ${VERSION} with npm`, lastLines(r));
  say(before ? `browser tool upgraded from ${before} to ${VERSION}` : `browser tool @playwright/mcp ${VERSION} installed`);
}

// ---------- 2. Playwright's own Chromium ----------
const { chromium } = createRequire(CLI)('playwright-core');   // the exact playwright the tool uses
const chromeExe = () => { try { return chromium.executablePath(); } catch { return ''; } };
if (!fs.existsSync(chromeExe())) say('downloading Playwright\'s Chromium (a few hundred MB, can take a few minutes)...');
const dl = spawnSync(process.execPath, [CLI, 'install-browser', 'chromium'], { cwd: DIR, encoding: 'utf8', windowsHide: true, timeout: 30 * 60000 });
const exe = chromeExe();
if (dl.status !== 0 || !fs.existsSync(exe)) fail('download Playwright\'s Chromium', lastLines(dl));

// ---------- 3. profile folder ----------
fs.mkdirSync(PROFILE, { recursive: true });

// ---------- 4. does it really work here? ----------
// Same browser the tool starts (hidden), on a throwaway profile: the shared profile is never opened here.
// The very first start after a download can be slow or drop its first screenshot, so it gets three tries.
async function check() {
  const browser = await chromium.launch({ channel: 'chrome-for-testing', headless: true, timeout: 120000 });
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Flex Rig test browser</h1>');
    const png = await page.screenshot({ timeout: 30000 });
    if (png.length < 500) throw new Error('the screenshot came back empty');
    return browser.version();
  } finally { await browser.close().catch(() => {}); }
}
let chromeVersion = null, problem = null;
for (let n = 1; n <= 3 && !chromeVersion; n++) {
  try { chromeVersion = await check(); } catch (e) {
    problem = String(e?.message || e).split(/\r?\n/).slice(0, 6).join('\n');
    say(`check ${n} of 3 did not pass (${problem.split('\n')[0]})`);
  }
}
if (!chromeVersion) fail('start the hidden browser and take a screenshot', problem);
fs.writeFileSync(READY, JSON.stringify({ version: VERSION, chromium: chromeVersion, exe, checkedAt: new Date().toISOString() }, null, 1) + '\n');
say(`ready. Hidden Chromium ${chromeVersion} starts and takes screenshots. Folder: ${DIR}`);

// ---------- 5. sign-in shortcut on the desktop ----------
// Plain Chromium (no automation switches) on the shared profile, in a visible window.
function makeShortcut() {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    '$desktop = [Environment]::GetFolderPath("Desktop")',   // asks Windows where the desktop is (it can live in OneDrive)
    'if (-not $desktop) { throw "Windows gave no desktop folder for this account" }',
    '$file = Join-Path $desktop ($env:FLEXRIG_LNK_NAME + ".lnk")',
    '$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($file)',
    '$lnk.TargetPath = $env:FLEXRIG_LNK_TARGET',
    '$lnk.Arguments = $env:FLEXRIG_LNK_ARGS',
    '$lnk.WorkingDirectory = Split-Path -Parent $env:FLEXRIG_LNK_TARGET',
    '$lnk.Description = $env:FLEXRIG_LNK_NOTE',
    '$lnk.Save()',
    'Write-Output $file',
  ].join('\n');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: {
      ...process.env,
      FLEXRIG_LNK_NAME: SHORTCUT,
      FLEXRIG_LNK_TARGET: exe,
      FLEXRIG_LNK_ARGS: `--user-data-dir="${PROFILE}" --no-first-run --no-default-browser-check`,
      FLEXRIG_LNK_NOTE: 'Flex Rig test browser. Sign in to the sites tasks need, then close this window so tasks can use the sign-ins.',
    },
  });
}
if (!WANT_SHORTCUT) {
  say('shortcut skipped (--no-shortcut)');
} else if (process.platform !== 'win32') {
  say('shortcut skipped (not Windows)');
} else {
  const r = makeShortcut();
  const file = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
  if (r.status !== 0 || !file.toLowerCase().endsWith('.lnk') || !fs.existsSync(file)) {
    say(`the browser is ready for tasks, but the "${SHORTCUT}" desktop shortcut could NOT be made:`);
    console.log(lastLines(r));
    process.exit(2);
  }
  say(`sign-in shortcut: ${file}`);
}
