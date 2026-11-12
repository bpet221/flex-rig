// Code work bar: one compact row above the prompt saying where this chat's coding work goes (Flex Rig by
// default, or this Mac), whether Flex Rig can be reached right now, and which model and effort it runs with
// (default: what this chat uses; two small pickers). While Flex Rig works for this chat: one small status
// line with a Stop button. When it's done: Open PR and Merge buttons. The look follows mockup "B · Chips,
// with a way back" (Design canvas, project/RouteB.dc.html).
//
// How the desktop draws it (what the sizes below are fighting): every Button is a 28px "control" pulled
// into a 20px text line with -4px margins, and its hover fill shows that full 28px. A bordered Box gets
// 12px/16px padding of its own unless every side is set. So each pill is a bordered Box with all four
// paddings set, hugging one Button whose own hover fill is turned off (the pill's border lights instead),
// and rows sit 8px apart so nothing pokes into the row above.
//
// It talks to the flex-rig skill's script (~/.claude/skills/flex-rig/flexrig.sh) through small files:
//   ~/.flexrig/chats/<chat>.bar.json     written here: machine, picked model/effort, the chat's own model/effort, online
//   ~/.flexrig/chats/<chat>.status.json  written by `flexrig.sh wait` while Flex Rig works for this chat
//   ~/.flexrig/models.json               written by `flexrig.sh models`: the newest model of each kind
// Every message also carries a short note for Claude with the current choice.
//
// The Flex Rig side panel (pane "flex-rig": /flex-rig-panel, or View on the bar's status line) shows Flex Rig's
// newest tasks and the conversation of one: the task, what its Claude says, each step, the user's messages. While
// the panel is shown it asks `flexrig.sh panel <run> <after>` every few seconds for what is new (one SSH call).
// A box at the bottom sends a message to a task that is still working (`flexrig.sh say`).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, Held, Machine, ModelChoice, Online, Panel, PanelItem, PanelRun, RunStatus } from '../types'

// Per chat. A new chat starts on Flex Rig, following what the chat uses.
const machine = atom({ plugin: 'code-work', key: 'machine' } as const, 'flex-rig' as Machine)
const modelPick = atom({ plugin: 'code-work', key: 'model' } as const, null as string | null)
const effortPick = atom({ plugin: 'code-work', key: 'effort' } as const, null as Effort | null)
const chatModel = atom({ plugin: 'code-work', key: 'chatModel' } as const, null as string | null)
const chatEffort = atom({ plugin: 'code-work', key: 'chatEffort' } as const, null as Effort | null)
const status = atom({ plugin: 'code-work', key: 'status' } as const, null as RunStatus | null)
const models = atom({ plugin: 'code-work', key: 'models' } as const, [] as ModelChoice[])
const online = atom({ plugin: 'code-work', key: 'online' } as const, 'unknown' as Online)
const dismissed = atom({ plugin: 'code-work', key: 'dismissed' } as const, null as string | null)
const confirmStop = atom({ plugin: 'code-work', key: 'confirmStop' } as const, false)
const EMPTY_PANEL: Panel = { run: null, state: null, next: 0, items: [], runs: [], error: null }
const panel = atom({ plugin: 'code-work', key: 'panel' } as const, EMPTY_PANEL)
// A new chat's first message waits until they pick Mac or Flex Rig in the bar.
const chosen = atom({ plugin: 'code-work', key: 'chosen' } as const, false)
const held = atom({ plugin: 'code-work', key: 'held' } as const, null as Held | null)

const EFFORTS: readonly [Effort, string][] = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const
const FAMILY_NAME: Record<string, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
const ACTIVE = ['queued', 'preparing', 'running']
const CLAY = '#D97757', BLUE = '#7AA7D6', GREEN = '#7FB77E', LINE = '#3A3935', MUTED = '#A3A198'
const LINE_HOVER = '#5C5A53'   // a pill's border under the pointer
const CLEAR = '#00000000'      // no fill: switches off the desktop's own 28px button highlight
const TINT = '22'              // the picked end's color at ~13%, as in the mockup
// Box sizes on the desktop: across in characters (1 ≈ 8px), down in half lines (1 = 10px).
const ROW_GAP = 0.8            // 8px between the chips row and the status line
const PILL_Y = 0.3             // 3px above and below the button: 28px pills
const CHIP_Y = 0.2             // 2px: 26px chips (Stop, Open PR, Merge, ↺)
const CHECK_EVERY_MS = 30_000

const isEffort = (v: unknown): v is Effort => typeof v === 'string' && EFFORTS.some(([k]) => k === v)
const effortLabel = (v: string | null | undefined): string => EFFORTS.find(([k]) => k === v)?.[1] ?? 'Default effort'

// "claude-opus-5-5[1m]" -> "claude-opus-5-5"; "Opus 5.5" -> "claude-opus-5-5"; aliases stay as they are.
export const normalizeModel = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  const s = raw.trim()
  const id = s.match(/claude-[a-z]+-[0-9a-z-]+/)
  if (id) return id[0].replace(/-$/, '')
  const shown = s.match(/^(fable|opus|sonnet|haiku)\s+([0-9.]+)/i)
  if (shown) return `claude-${shown[1].toLowerCase()}-${shown[2].replace(/\./g, '-')}`
  const alias = s.toLowerCase().match(/^(fable|opus|sonnet|haiku)\b/)
  return alias ? alias[1] : null
}
const familyOf = (m: string | null): string | null => {
  if (!m) return null
  const f = m.match(/^(?:claude-)?(fable|opus|sonnet|haiku)\b/)
  return f ? f[1] : null
}
// What a model value reads as: the menu's label for it, else "Opus 5.5" from an id, else the kind.
export const modelLabel = (m: string | null, list: readonly ModelChoice[]): string => {
  if (!m) return 'Model'
  const hit = list.find((c) => c.value === m)
  if (hit) return hit.label
  const id = m.match(/^claude-([a-z]+)-([0-9]+(?:-[0-9]+)?)(?:-[0-9]{8})?$/)
  if (id) return `${FAMILY_NAME[id[1]] ?? id[1]} ${id[2].replace('-', '.')}`
  const fam = familyOf(m)
  return (fam && list.find((c) => c.family === fam)?.label) || (fam ? FAMILY_NAME[fam] : m)
}
// The menu: one entry per kind, newest only. Until models.json is read, the newest known of each kind
// (so the menu never shows bare kind names).
export const FALLBACK_MODELS: readonly ModelChoice[] = [
  { family: 'fable', value: 'claude-fable-5-2', label: 'Fable 5.2' },
  { family: 'opus', value: 'opus', label: 'Opus 5.5' },
  { family: 'sonnet', value: 'sonnet', label: 'Sonnet 5.5' },
  { family: 'haiku', value: 'haiku', label: 'Haiku 5.5' },
]
const menuModels = (list: readonly ModelChoice[]): ModelChoice[] => (list.length ? [...list] : [...FALLBACK_MODELS])

type Bar = { machine: Machine; model: string | null; effort: Effort | null; chatModel: string | null; chatEffort: Effort | null }
const readBar = async ($: EngineInterface): Promise<Bar> => ({
  machine: await read($, machine), model: await read($, modelPick), effort: await read($, effortPick),
  chatModel: await read($, chatModel), chatEffort: await read($, chatEffort),
})

// The chat's real effort is only known once its first request goes out (turn.step). Until then the bar
// shows the effort chats used last, but Claude's note doesn't name a level it can't be sure of.
let effortSeen = false

// ---------- files shared with flexrig.sh ----------
// The files are a convenience: anything going wrong with them never breaks the bar or a message.
const paths = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const id = (await $.session.id().catch(() => '')) ?? ''
  const chats = `${home}/.flexrig/chats`
  return {
    bar: `${chats}/${id}.bar.json`, status: `${chats}/${id}.status.json`, models: `${home}/.flexrig/models.json`,
    config: `${home}/.flexrig/config`, script: `${home}/.claude/skills/flex-rig/flexrig.sh`, ok: !!home && /^[A-Za-z0-9_-]+$/.test(id),
  }
}
let lastBar = ''
const saveBar = async ($: EngineInterface): Promise<void> => {
  try {
    const p = await paths($)
    if (!p.ok) return
    const text = JSON.stringify({ ...(await readBar($)), online: await read($, online), updatedAt: new Date().toISOString() })
    const same = text.slice(0, text.lastIndexOf('"updatedAt"'))
    if (same === lastBar) return
    await $.fs.write(p.bar, text + '\n')
    lastBar = same
  } catch { /* try again on the next change */ }
}
let lastStatus = '', modelsMtime = -1
// A short log of what went wrong reading the shared files (the store's `diag`), to find faults seen only
// in the app. One line per kind of fault, so it never grows.
const diag = async ($: EngineInterface, step: string, err: unknown): Promise<void> => {
  try {
    const d = ((await $.store.get('diag')) as Record<string, string> | undefined) ?? {}
    d[step] = `${new Date().toISOString()} ${String((err as { message?: string })?.message ?? err).slice(0, 200)}`
    await $.store.set('diag', d)
  } catch { /* nothing to do */ }
}
const refresh = ($: EngineInterface): Promise<void> => refreshFiles($).catch((err) => diag($, 'refresh', err))
const refreshFiles = async ($: EngineInterface): Promise<void> => {
  const p = await paths($)
  if (!p.ok) { await diag($, 'paths', 'no HOME or session id'); return }
  let raw = ''
  try { raw = await $.fs.read(p.status) } catch { raw = '' }   // no file: no run for this chat
  if (raw !== lastStatus) {
    lastStatus = raw
    let s: RunStatus | null = null
    try { s = raw ? (JSON.parse(raw) as RunStatus) : null } catch (err) { s = null; await diag($, 'status', err) }
    await update($, status, () => s)
  }
  // Read the model list when it changed, and every time until it has been read once.
  const have = (await read($, models)).length > 0
  let mtime = -2
  try { mtime = (await $.fs.stat(p.models)).mtimeMs } catch (err) { if (!have) await diag($, 'models-stat', err) }
  if (mtime !== modelsMtime || !have) {
    try {
      const j = JSON.parse(await $.fs.read(p.models)) as { models?: ModelChoice[] }
      const list = (j.models ?? []).filter((m) => m && typeof m.value === 'string' && typeof m.label === 'string' && /^[A-Za-z0-9._-]+$/.test(m.value))
      if (list.length) { await update($, models, () => list); modelsMtime = mtime }
    } catch (err) { await diag($, 'models-read', err) }
  }
}

// ---------- can the Mac reach Flex Rig? ----------
// A 2-second knock on Flex Rig's SSH port, every 30 seconds. Away from the PC's network (or with the PC off) it
// answers "offline", and Claude does the work on the Mac instead of waiting on a PC it can't reach.
let host = ''
let checking = false
const flexHost = async ($: EngineInterface): Promise<string> => {
  if (host) return host
  try {
    const p = await paths($)
    const src = await $.fs.read(p.config)   // ~/.flexrig/config: FLEXRIG_HOST="user@address"
    const m = src.match(/^FLEXRIG_HOST=["']?(?:[^@"'\s]*@)?([A-Za-z0-9._-]+)["']?/m)
    host = m ? m[1] : ''
  } catch { host = '' }
  return host
}
const checkOnline = async ($: EngineInterface): Promise<void> => {
  if (checking) return
  checking = true
  try {
    const h = await flexHost($)
    if (!h) { if ((await read($, online)) !== 'offline') { await update($, online, () => 'offline'); await saveBar($) }; return }   // no FLEXRIG_HOST in ~/.flexrig/config yet
    const r = await $.process.run(['/usr/bin/nc', '-z', '-G', '2', '-w', '3', h, '22'], { timeoutMs: 6000 })
    const now: Online = r.exitCode === 0 ? 'online' : 'offline'
    if ((await read($, online)) !== now) { await update($, online, () => now); await saveBar($) }
  } catch (err) { await diag($, 'online', err) }   // can't run the check here: leave it as it was
  finally { checking = false }
}

// A status line shows only while Flex Rig is really working for this chat (and the chat is keeping watch).
export const showsStatus = (m: Machine, s: RunStatus | null, nowMs: number): boolean =>
  m === 'flex-rig' && !!s && ACTIVE.includes(s.state) && nowMs - Date.parse(s.updatedAt) < 3 * 60_000
// A finished run with a PR shows Open PR / Merge until it's merged or dismissed (or a day has passed).
export const showsDone = (s: RunStatus | null, gone: string | null, nowMs: number): boolean =>
  !!s && !ACTIVE.includes(s.state) && !!s.pr && /^https:\/\/github\.com\//.test(s.pr) && s.run !== gone && nowMs - Date.parse(s.updatedAt) < 24 * 3600_000

// ---------- what Claude reads beside each message ----------
const MAC_ONLY = 'Only steps that touch the Mac itself stay on the Mac whatever the bar says; do only that step there and say so in one line: running installers that copy into ~/.claude, LaunchAgents, Mac app settings, deploys, secret keys, merging, quick read-only lookups.'
// The user had the bar on Flex Rig and the Mac chat still edited the setup's own sources itself, reading "the Mac's own setup" as covering
// the repo sources of it. Say plainly that repo edits are coding work, wherever the files end up installed.
const REPO_EDITS = "Editing files in any repo is coding work and goes to Flex Rig, including the sources of this Mac setup (the flex-rig rule, the flex-rig skill and flexrig.sh, this code-work mod, repo-sync.sh, the install scripts); the Mac only merges and runs the installer afterwards, and never edits the installed copies in ~/.claude by hand."
export const noteFor = (b: Bar, reach: Online, list: readonly ModelChoice[], effortKnown: boolean): string => {
  if (b.machine === 'mac') {
    return "Code work: this Mac (the user's Code work bar above the prompt). Do this chat's coding work here on the Mac, in a worktree; don't send it to Flex Rig unless the user asks."
  }
  if (reach === 'offline') {
    return [
      "Code work: Flex Rig is picked in the user's Code work bar, but it's offline right now (the Mac can't reach it: not on the PC's network, or the PC is off).",
      'Do this chat\'s coding work on the Mac in a fresh worktree, without trying Flex Rig first, and say so in one line ("Doing this on the Mac: Flex Rig is offline.").',
      MAC_ONLY,
    ].join(' ')
  }
  const m = modelLabel(b.model ?? b.chatModel, list)
  const picked = !!(b.model || b.effort)
  const e = b.effort ? `${effortLabel(b.effort)} effort` : effortKnown && b.chatEffort ? `${effortLabel(b.chatEffort)} effort` : 'the effort this chat uses'
  const from = picked ? 'The user picked this in the bar' : 'what this chat uses'
  return [
    "Code work: Flex Rig (the user's Code work bar above the prompt). Send this chat's coding work (anything that ends in a branch or PR) to Flex Rig with the flex-rig skill: flexrig.sh start --title \"<few words>\" --area <folder> \"<brief>\" (it pushes the user's local edits first).",
    `New Flex Rig work runs on ${m} at ${e} (${from}); the script reads that from the bar, so pass --model/--effort only if the user names others in words.`,
    'While Flex Rig works for this chat, keep this chat working with flexrig.sh wait in the foreground, not run_in_background, so the app shows it working (Bash timeout 600000: 2.5 min per call, no replies in between; call it again right away while it says STILL WORKING); pass the user\'s instructions on at once with flexrig.sh say, answer their questions yourself, and send a message that waits for the end ("after it\'s done: …", or one that arrives once the run is done) with flexrig.sh followup.',
    REPO_EDITS,
    MAC_ONLY,
  ].join(' ')
}
const note = async ($: EngineInterface): Promise<string> =>
  noteFor(await readBar($), await read($, online), await read($, models), effortSeen)

// ---------- drawings: the line between Mac and Flex Rig, the two small icons, the status dot ----------
const LINE_W = 72
const lineSvg = (m: Machine, reach: Online, working: boolean, LINE_W = 72): string => {
  const flex = m === 'flex-rig'
  const off = flex && reach === 'offline'
  const color = flex && !off ? CLAY : LINE
  const dash = off ? ' stroke-dasharray="4 4"' : ''
  const end = LINE_W - 3
  const dots = working
    ? `<circle cx="2" cy="6" r="4" fill="${CLAY}"><animate attributeName="cx" from="2" to="${end}" dur="1.3s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;1;0" dur="1.3s" repeatCount="indefinite"/></circle>` +
      `<circle cx="${end}" cy="6" r="3" fill="${BLUE}"><animate attributeName="cx" from="${end}" to="2" dur="1.3s" begin="0.65s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;1;0" dur="1.3s" begin="0.65s" repeatCount="indefinite"/></circle>`
    : ''
  const arrow = flex && !off && !working ? `<path d="M${end - 4} 2 L${end + 1} 6 L${end - 4} 10" fill="none" stroke="${CLAY}" stroke-width="1.6"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LINE_W}" height="12" viewBox="0 0 ${LINE_W} 12"><line x1="1" y1="6" x2="${end}" y2="6" stroke="${color}" stroke-width="2" stroke-linecap="round"${dash}/>${arrow}${dots}</svg>`
}
// The mockup's laptop and tower (14px). The tower carries Flex Rig's online light: green, or a grey ring.
const iconSvg = (x: Machine, ink: string, reach: Online): string => {
  const shape = x === 'mac'
    ? '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'
    : '<rect x="5" y="3" width="10" height="18" rx="2"/><path d="M8 7h4M10 17h.01"/>'
  const light = x === 'flex-rig' && reach !== 'unknown'
    ? reach === 'online'
      ? `<circle cx="19.5" cy="5" r="3.5" fill="${GREEN}" stroke="none"/>`
      : `<circle cx="19.5" cy="5" r="2.6" fill="none" stroke="${MUTED}" stroke-width="1.6"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round">${shape}${light}</svg>`
}
// The status line's dot, breathing while Flex Rig works.
const DOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="${CLAY}"><animate attributeName="opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite"/></circle></svg>`

// ---------- the Flex Rig side panel ----------
const PANE = 'flex-rig'
const PANEL_EVERY_MS = 4000
const MAX_ITEMS = 400

/** What the panel draws for a conversation: a run of steps is folded to its last three, with a count of the rest. */
export type PanelRow = { key: string; kind: PanelItem['kind'] | 'more'; text: string }
export const panelRows = (items: readonly PanelItem[], keep = 3): PanelRow[] => {
  const rows: Omit<PanelRow, 'key'>[] = []
  for (let i = 0; i < items.length;) {
    const it = items[i]!
    if (it.kind !== 'step') { rows.push({ kind: it.kind, text: it.text }); i++; continue }
    let j = i
    while (j < items.length && items[j]!.kind === 'step') j++
    if (j - i > keep) rows.push({ kind: 'more', text: `${j - i - keep} earlier ${j - i - keep === 1 ? 'step' : 'steps'}` })
    for (const step of items.slice(Math.max(i, j - keep), j)) rows.push({ kind: 'step', text: step.text })
    i = j
  }
  return rows.map((r, n) => ({ ...r, key: `flex-rig-row-${n}` }))
}

type PanelAnswer = { ok?: boolean; error?: string; runs?: PanelRun[]; run?: { id: string; state: string; next: number; reset?: boolean; items: PanelItem[] } | null }
let pulling = false, lastPull = 0
// Asks Flex Rig for the runs and for what is new in one run's conversation. pick: a run to switch to
// (null = let Flex Rig pick: the one that is working, else the newest); left out = stay on the current one.
const pullPanel = async ($: EngineInterface, pick?: string | null): Promise<void> => {
  if (pulling) return
  pulling = true
  try {
    const p = await paths($)
    const cur = await read($, panel)
    const run = pick === undefined ? cur.run : pick
    const after = run && run === cur.run ? cur.next : 0
    const r = await $.process.run(['/bin/bash', p.script, 'panel', ...(run ? [run] : []), String(after)], { timeoutMs: 20_000 }).catch(() => null)
    lastPull = Date.now()
    let j: PanelAnswer | null = null
    try { j = JSON.parse((r?.stdout ?? '').trim().split('\n').pop() ?? '') as PanelAnswer } catch { j = null }
    if (!j || j.ok !== true) {
      if (cur.error === null) await update($, panel, (old) => ({ ...old, error: "Can't reach Flex Rig right now." }))
      return
    }
    const t = j.run ?? null
    const keep = !!t && t.id === cur.run && after > 0 && !t.reset
    const items = t ? [...(keep ? cur.items : []), ...(t.items ?? [])].slice(-MAX_ITEMS) : []
    const next: Panel = { run: t?.id ?? null, state: t?.state ?? null, next: t?.next ?? 0, items, runs: j.runs ?? [], error: null }
    const changed = next.run !== cur.run || next.state !== cur.state || next.next !== cur.next || cur.error !== null
      || items.length !== cur.items.length || JSON.stringify(next.runs) !== JSON.stringify(cur.runs)
    if (changed) await update($, panel, () => next)
  } catch { /* the next tick tries again */ } finally { pulling = false }
}
const openPanel = async ($: EngineInterface, run?: string | null): Promise<void> => {
  await $.ui.open({ id: PANE, title: 'Flex Rig' }).catch(() => undefined)
  void pullPanel($, run)
}
// Every few seconds while the panel is the one shown: often while something works, seldom otherwise.
const tickPanel = async ($: EngineInterface): Promise<void> => {
  try {
    if (!(await $.ui.panes()).some((pane) => pane.id === PANE && pane.isShown)) return
    const cur = await read($, panel)
    const live = ACTIVE.includes(cur.state ?? '') || cur.runs.some((r) => ACTIVE.includes(r.state))
    if (live || Date.now() - lastPull > 30_000) await pullPanel($)
  } catch { /* try again on the next tick */ }
}

const NAME: Record<Machine, string> = { 'flex-rig': 'Flex Rig', mac: 'Mac' }
const pickFrom = (args: string, now: Machine): Machine => {
  const word = args.trim().toLowerCase()
  if (/^(mac|here|local)/.test(word)) return 'mac'
  if (/^(flex|rig|pc|windows)/.test(word)) return 'flex-rig'
  return now === 'mac' ? 'flex-rig' : 'mac'
}

// The pick gate. Only the user's own typing is held (the app's composer, or Remote Control from their phone): a
// session another session starts, a scheduled task or a peer's message arrives with another origin and goes
// straight through, so nothing waits on a pick nobody is there to make. Only before the chat's first answer.
export const HOLD_REASON = "Pick Mac or Flex Rig above the prompt first: your message sends as soon as you pick."
export const RESEND_REASON = "Pick Mac or Flex Rig above the prompt first, then send this again (its pictures can't be kept)."
export const gated = (kind: string): boolean => kind === 'composer' || kind === 'bridge'
// later: from /code-work, whose hook may not submit (it would wait on its own turn); the 5 s tick sends it.
const choose = async ($: EngineInterface, x: Machine, later = false): Promise<void> => {
  await update($, machine, () => x)
  await update($, chosen, () => true)
  await saveBar($)
  if (x === 'flex-rig') void checkOnline($)
  if (!later) await release($)
}
let releasing = false
const release = async ($: EngineInterface): Promise<void> => {
  if (releasing) return
  releasing = true
  try {
    const h = await read($, held)
    if (!h || !(await read($, chosen))) return
    await update($, held, () => null)
    if (!h.resend) return
    // This mod's own prompt.submit hook never sees a message the mod sends, so the note goes in first, as a
    // row Claude reads and the user doesn't see.
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: await note($) }] } }).catch((err) => diag($, 'hold note', err))
    await $.prompt.submit({ text: h.text, asUser: true })
  } catch (err) { await diag($, 'release', err) } finally { releasing = false }
}

// While the Mac only waits on Flex Rig, its checks run on Haiku, not the chat's
// model. A step right after a `flexrig.sh wait` that said STILL WORKING (and nothing new from the user) is
// just "check again", so it goes to Haiku. Everything else stays on the chat's model: writing the brief,
// relaying the user's messages, the final report, the review and the merge.
export const CHECK_MODEL = 'haiku'
const stripReminders = (t: string): string => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
export const onlyWaiting = (msgs: readonly { role: string; text: string; toolUses?: readonly { tool: string; input: Record<string, unknown>; text?: string; result?: unknown }[] }[]): boolean => {
  const last = msgs.at(-1)
  if (!last || last.role !== 'user' || stripReminders(last.text ?? '')) return false   // the user said something: their model
  const asked = [...msgs].reverse().find((m) => m.role === 'assistant')
  const uses = asked?.toolUses ?? []
  return uses.length > 0 && uses.every((u) =>
    /^Bash$/.test(u.tool) && /flexrig\.sh["']?\s+wait\b/.test(String(u.input?.command ?? '')) && /STILL WORKING/.test(String(u.text ?? u.result ?? '')))
}

// The bar's slash commands. Never a name a skill or another plugin already has: Claude Code refuses it.

export const PANEL_COMMAND = 'flex-rig-panel'
const COMMANDS = [
  { name: 'code-work', description: "Where this chat's coding work goes: /code-work flex or /code-work mac (alone, it switches)", argumentHint: 'flex | mac' },
  { name: PANEL_COMMAND, description: "Show Flex Rig's work in a side panel: its tasks and the live conversation of one" },
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Each command on its own, and a refusal only noted: a name Claude Code refuses (the panel's was once
    // /flex-rig, which the flex-rig skill owns) threw out this whole hook, so no timer started: no online
    // light, no "working on" line, no model list. Nothing below may depend on a command.
    for (const c of COMMANDS) await $.command.register(c).catch((err) => diag($, `command /${c.name}`, err))
    const started = await next(e)
    effortSeen = false
    // The timers first: the online light, Flex Rig's progress and the panel all hang on them.
    try {
      $.clock.every(5000, () => { void refresh($); void release($) })   // what `flexrig.sh wait` writes; a held first message
      $.clock.every(CHECK_EVERY_MS, () => { void checkOnline($) })
      $.clock.every(PANEL_EVERY_MS, () => { void tickPanel($) })
    } catch (err) { await diag($, 'timers', err) }
    void checkOnline($)
    try {
      const m = normalizeModel(await $.session.model().catch(() => ''))
      if (m) await update($, chatModel, (old) => old ?? m)
      if (!(await read($, chatEffort))) {   // until the first request shows it: the effort chats used last (bar only)
        const last = await $.store.get('lastChatEffort').catch(() => undefined)
        if (isEffort(last)) await update($, chatEffort, () => last)
      }
      await update($, confirmStop, () => false)
    } catch (err) { await diag($, 'start', err) }
    await refresh($)
    await saveBar($)
    return started
  })

  // The chat's own model and effort, as each request of the main conversation goes out.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const m = normalizeModel(e.model)
      const ef = isEffort(e.effort) ? e.effort : null
      if (ef) effortSeen = true
      void (async () => {
        let changed = false
        if (m && (await read($, chatModel)) !== m) { await update($, chatModel, () => m); changed = true }
        if (ef && (await read($, chatEffort)) !== ef) { await update($, chatEffort, () => ef); await $.store.set('lastChatEffort', ef); changed = true }
        if (changed) await saveBar($)
      })().catch(() => undefined)
      if (e.index > 0) {
        const msgs = await $.session.messages().catch(() => null)
        if (msgs && onlyWaiting(msgs)) return yield* next({ ...e, model: CHECK_MODEL, effort: 'low' })
      }
    }
    return yield* next(e)
  })

  on('command.run', { command: 'code-work' }, async ($, e) => {
    const m = pickFrom(e.args, await read($, machine))
    await choose($, m, true)
    const off = m === 'flex-rig' && (await read($, online)) === 'offline'
    return {
      text: `Code work: ${NAME[m]}. This chat's coding work now goes to ${m === 'mac' ? 'this Mac' : 'Flex Rig'}.${off ? " Flex Rig is offline right now, so it'll run on the Mac until it's back." : ''}`,
      context: [await note($)],
    }
  })

  on('command.run', { command: PANEL_COMMAND }, async ($) => {
    await openPanel($, (await read($, status))?.run)
    return { text: 'Flex Rig panel opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    if (!e.isMeta && gated(e.origin?.kind ?? "") && !(await read($, chosen))) {
      const msgs = await $.session.messages().catch(() => null)
      if (msgs && !msgs.some((x) => x.role === 'assistant')) {
        const resend = !e.attachments?.length
        await update($, held, () => ({ text: e.text, resend }))
        return { drop: resend ? HOLD_REASON : RESEND_REASON }
      }
    }
    await saveBar($).catch(() => undefined)
    return next({ ...e, context: [...(e.context ?? []), await note($)] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const els = $.ui.resolve(e) as unknown as Record<string, any>
    const { Box, Text, Button, Select } = els
    const Svg = els.Svg as any | undefined
    // The terminal counts whole cells and has no hover: there the pills keep a plain one-cell padding.
    const desk = e.surface !== 'terminal'
    const m = await read($, machine)
    const reach = await read($, online)
    const list = menuModels(await read($, models))
    const b = await readBar($)
    const s = await read($, status)
    const now = Date.now()
    const working = showsStatus(m, s, now)
    const done = !working && showsDone(s, await read($, dismissed), now)
    const arming = await read($, confirmStop)
    const flex = m === 'flex-rig'
    const off = flex && reach === 'offline'
    const effort = b.effort ?? b.chatEffort
    // A narrow window: a shorter line, and the pickers wrap to a second row instead of being cut off.
    const cols = (e.props as { bodyColumns?: number }).bodyColumns ?? 999
    const lineW = cols < 70 ? 28 : cols < 90 ? 44 : LINE_W

    const setMachine = (x: Machine) => choose($, x)   // a click on the lit end counts as a pick too
    const waiting = await read($, held)
    const pickModel = async (v: string) => {
      const chat = await read($, chatModel)
      const same = !!chat && (v === chat || familyOf(v) === familyOf(chat))
      await update($, modelPick, () => (same ? null : v))   // the chat's own kind = follow the chat again
      await saveBar($)
    }
    const pickEffort = async (v: Effort | null) => {
      const chat = await read($, chatEffort)
      await update($, effortPick, () => (v === chat ? null : v))   // the chat's own effort = follow the chat again
      await saveBar($)
    }
    const reset = async () => {
      await update($, modelPick, () => null)
      await update($, effortPick, () => null)
      await saveBar($)
    }
    const run = async (argv: string[]) => {
      try { return await $.process.run(argv, { timeoutMs: 30_000 }) } catch { return null }
    }
    const stop = async () => {
      if (!s) return
      if (!(await read($, confirmStop))) { await update($, confirmStop, () => true); return }
      await update($, confirmStop, () => false)
      const p = await paths($)
      const r = await run(['/bin/bash', p.script, 'stop', s.run])
      $.ui.toast(r && r.exitCode === 0 ? (r.stdout.trim().split('\n').pop() || 'Stopped Flex Rig.') : "Couldn't stop Flex Rig from here.")
    }
    const openPr = async () => {
      if (!s?.pr) return
      const r = await run(['/usr/bin/open', s.pr])
      if (!r || r.exitCode !== 0) await $.ui.copy({ text: s.pr, surface: e.surface }).catch(() => undefined)
    }
    const merge = async () => {
      if (!s?.pr) return
      await update($, dismissed, () => s.run)
      void $.prompt.submit({ text: `Merge the Flex Rig PR ${s.pr} (flexrig.sh merge ${s.run}), then deploy if it needs it.` })
    }

    // A pill or chip: a bordered Box hugging one plain Button. All four paddings are set so the desktop adds
    // none of its own; the Button's own hover fill is off and the border lights instead, so nothing is drawn
    // outside the pill. `y` is the room above and below the label (28px pills, 26px chips).
    const pad = (y: number, left = 0) => (desk ? { paddingTop: y, paddingBottom: y, paddingLeft: left, paddingRight: 0 } : { paddingX: 1 })
    const chip = (key: string, label: string, onPress: () => void, o: { y?: number; dim?: boolean } = {}) => (
      <Box key={`${key}-chip`} borderStyle="round" borderColor={LINE} hover={{ borderColor: LINE_HOVER }} flexDirection="row" alignItems="center" {...pad(o.y ?? CHIP_Y)}>
        <Button key={key} label={label} plain dimColor={o.dim ? true : undefined} hover={{ backgroundColor: CLEAR }} onPress={onPress} />
      </Box>
    )

    const end = (x: Machine) => {
      const picked = m === x
      const color = x === 'flex-rig' ? (off ? MUTED : CLAY) : BLUE
      const lit = picked && !(x === 'flex-rig' && off)
      const label = x === 'flex-rig' && reach === 'offline' ? 'Flex Rig · offline' : NAME[x]
      const showDot = !Svg && x === 'flex-rig' && reach !== 'unknown'   // the terminal has no icon to carry the light
      return (
        <Box
          key={`code-work-end-${x}`}
          borderStyle="round"
          borderColor={picked ? color : LINE}
          backgroundColor={desk && lit ? `${color}${TINT}` : undefined}
          hover={{ borderColor: picked ? color : LINE_HOVER }}
          flexDirection="row"
          alignItems="center"
          {...pad(PILL_Y, Svg ? 1 : 0)}
        >
          {Svg ? <Svg key={`code-work-icon-${x}`} source={iconSvg(x, picked ? 'currentColor' : MUTED, reach)} alt={x === 'mac' ? 'Mac' : reach === 'unknown' ? 'Flex Rig' : `Flex Rig ${reach}`} width={14} height={14} /> : null}
          {showDot ? <Text key="code-work-dot" color={reach === 'online' ? GREEN : MUTED}>{reach === 'online' ? '●' : '○'}</Text> : null}
          <Button key={`code-work-${x}`} label={label} plain dimColor={picked ? undefined : true} hover={{ backgroundColor: CLEAR }} onPress={() => void setMachine(x)} />
        </Box>
      )
    }

    // Model and effort: two small pickers (the desktop's own pop-up list, with a check on the current one).
    const modelOptions = list.map((c) => ({ value: c.value, label: c.label }))
    const modelValue = b.model ?? list.find((c) => familyOf(c.value) === familyOf(b.chatModel))?.value
    if (modelValue && !modelOptions.some((o) => o.value === modelValue)) modelOptions.push({ value: modelValue, label: modelLabel(modelValue, list) })
    const effortOptions = [...(effort ? [] : [{ value: 'chat', label: 'Default effort' }]), ...EFFORTS.map(([k, label]) => ({ value: k, label }))]
    const changedDot = <Text size="caption" color={CLAY}>●</Text>
    const pickers = (
      <Box key="code-work-pickers" flexDirection="row" alignItems="center" gap={1} marginLeft={desk ? 0.5 : 0}>
        <Box key="code-work-model-chip" flexDirection="row" alignItems="center" gap={0.5}>
          {b.model ? changedDot : null}
          <Select key="code-work-model" options={modelOptions} value={modelValue} onSelect={(v: string) => void pickModel(v)} />
        </Box>
        <Box key="code-work-effort-chip" flexDirection="row" alignItems="center" gap={0.5}>
          {b.effort ? changedDot : null}
          <Select key="code-work-effort" options={effortOptions} value={effort ?? 'chat'} onSelect={(v: string) => void pickEffort(isEffort(v) ? v : null)} />
        </Box>
        {b.model || b.effort ? chip('code-work-reset', '↺', () => void reset(), { dim: true }) : null}
      </Box>
    )

    const statusText = (text: string, color?: string) => <Text size="caption" color={color} wrap="truncate-end">{text}</Text>
    return (
      <Box flexDirection="column" gap={desk ? ROW_GAP : 0}>
        {below}
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1} rowGap={desk ? ROW_GAP : 0}>
          {end('mac')}
          {Svg ? (
            <Svg key="code-work-line" source={lineSvg(m, reach, working, lineW)} alt={flex ? (off ? 'Flex Rig offline: work stays on the Mac' : 'to Flex Rig') : 'stays on the Mac'} width={lineW} height={12} isInteractive={working ? true : undefined} />
          ) : (
            <Text color={flex && !off ? CLAY : LINE}>{flex && !off ? '─────▶' : off ? '─ ─ ─ ' : '──────'}</Text>
          )}
          {end('flex-rig')}
          {flex && !off ? pickers : null}
          {off ? <Text key="code-work-offline" size="caption" color={MUTED}>work stays on the Mac</Text> : null}
        </Box>
        {waiting ? (
          <Box key="code-work-hold" flexDirection="row" flexWrap="wrap" alignItems="center" gap={1} paddingLeft={desk ? 0.5 : 1}>
            <Text size="caption" color={CLAY}>●</Text>
            {statusText(waiting.resend ? 'Where should this chat\'s coding work go? Pick Mac or Flex Rig: your message sends then.' : 'Where should this chat\'s coding work go? Pick Mac or Flex Rig, then send your message again.', CLAY)}
          </Box>
        ) : null}
        {working && s ? (
          <Box key="code-work-status" flexDirection="row" flexWrap="wrap" alignItems="center" gap={1} paddingLeft={desk ? 0.5 : 1}>
            {Svg ? <Svg key="code-work-status-dot" source={DOT_SVG} alt="working" width={8} height={8} isInteractive /> : <Text color={CLAY}>●</Text>}
            {statusText(s.title ? `Flex Rig is working on: ${s.title}` : 'Flex Rig is working')}
            <Text size="caption" color={MUTED} tabular>
              {`· ${s.elapsedMin} min · step ${s.steps}${s.model ? ` · ${modelLabel(normalizeModel(s.model), list)}` : ''}${s.effort ? ` · ${effortLabel(s.effort)}` : ''}`}
            </Text>
            {chip('code-work-view', 'View', () => void openPanel($, s.run))}
            {chip('code-work-stop', arming ? 'Stop it? Yes' : 'Stop', () => void stop())}
            {arming ? chip('code-work-stop-cancel', 'No', () => void update($, confirmStop, () => false), { dim: true }) : null}
          </Box>
        ) : null}
        {done && s ? (
          <Box key="code-work-done" flexDirection="row" flexWrap="wrap" alignItems="center" gap={1} paddingLeft={desk ? 0.5 : 1}>
            <Text size="caption" color={GREEN}>✓</Text>
            {statusText(s.title ? `Flex Rig finished: ${s.title}` : 'Flex Rig finished')}
            {chip('code-work-view-done', 'View', () => void openPanel($, s.run))}
            {chip('code-work-open-pr', 'Open PR', () => void openPr())}
            {chip('code-work-merge', 'Merge', () => void merge())}
            <Box key="code-work-dismiss-box" flexDirection="row">
              <Button key="code-work-dismiss" label="×" plain dimColor hover={{ backgroundColor: CLEAR }} onPress={() => void update($, dismissed, () => s.run)} />
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })

  // The Flex Rig side panel: the newest tasks (click one to read it), the picked task's conversation, and a
  // box to message it while it works. The pane's body scrolls by itself.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Record<string, any>
    const { Box, Text, Button, Input } = els
    const Markdown = els.Markdown as any | undefined
    const desk = e.surface !== 'terminal'
    const pn = await read($, panel)
    const s = await read($, status)
    const live = ACTIVE.includes(pn.state ?? '')
    const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
    const titleOf = (r: PanelRun) => short((s && s.run === r.id && s.title ? s.title : r.task) || r.id, 64)
    const mark = (st: string) => (ACTIVE.includes(st) ? '●' : st === 'done' ? '✓' : st === 'failed' ? '✕' : '■')
    const markColor = (st: string) => (ACTIVE.includes(st) ? CLAY : st === 'done' ? GREEN : MUTED)
    const runs = [...pn.runs.filter((r) => ACTIVE.includes(r.state)), ...pn.runs.filter((r) => !ACTIVE.includes(r.state))].slice(0, 6)
    const send = async (text: string) => {
      const t = text.trim()
      if (!t || !pn.run) return
      const p = await paths($)
      const r = await $.process.run(['/bin/bash', p.script, 'say', pn.run, t], { timeoutMs: 30_000 }).catch(() => null)
      const said = (r?.stdout.trim().split('\n').pop() || r?.stderr.trim().split('\n').pop() || '').trim()
      $.ui.toast(r && r.exitCode === 0 ? 'Sent to Flex Rig.' : said || "Couldn't send it to Flex Rig.")
      void pullPanel($)
    }
    const line = (row: PanelRow) => {
      switch (row.kind) {
        case 'task':
          return (
            <Box key={row.key} flexDirection="column">
              <Text size="caption" color={BLUE}>Task</Text>
              <Text>{short(row.text, 900)}</Text>
            </Box>
          )
        case 'say': return Markdown ? <Markdown key={row.key} text={row.text} /> : <Text key={row.key}>{row.text}</Text>
        case 'step': return <Text key={row.key} size="caption" color={MUTED} wrap="truncate-end">{`› ${row.text}`}</Text>
        case 'more': return <Text key={row.key} size="caption" color={MUTED}>{`… ${row.text}`}</Text>
        case 'user': return <Text key={row.key} color={BLUE}>{`You: ${row.text}`}</Text>
        case 'done': return <Text key={row.key} color={GREEN}>✓ Finished</Text>
        case 'error': return <Text key={row.key} color={CLAY}>{`✕ ${row.text}`}</Text>
        default: return <Text key={row.key} size="caption" color={MUTED}>{row.text}</Text>
      }
    }
    return (
      <Box flexDirection="column" gap={desk ? 1.2 : 1}>
        {pn.error ? <Text key="flex-rig-error" size="caption" color={MUTED}>{pn.error}</Text> : null}
        <Box key="flex-rig-runs" flexDirection="column">
          {runs.length === 0 && !pn.error ? <Text key="flex-rig-none" size="caption" color={MUTED}>{lastPull ? 'No Flex Rig tasks yet.' : 'Asking Flex Rig…'}</Text> : null}
          {runs.map((r) => (
            <Box key={`flex-rig-run-${r.id}`} flexDirection="row" alignItems="center" gap={1}>
              <Text color={markColor(r.state)}>{mark(r.state)}</Text>
              <Button key={`flex-rig-pick-${r.id}`} label={titleOf(r)} plain dimColor={r.id === pn.run ? undefined : true} hover={{ backgroundColor: CLEAR }} onPress={() => void pullPanel($, r.id)} />
              <Text size="caption" color={MUTED} tabular>{ACTIVE.includes(r.state) ? `${r.elapsedMin} min` : r.state}</Text>
            </Box>
          ))}
        </Box>
        <Box key="flex-rig-talk" flexDirection="column" gap={desk ? 0.8 : 0}>
          {panelRows(pn.items).map(line)}
        </Box>
        {live ? (
          <Input key="flex-rig-say" placeholder="Message Flex Rig while it works" submitLabel="Send" onSubmit={(v: string) => void send(v)} />
        ) : pn.run ? (
          <Text key="flex-rig-over" size="caption" color={MUTED}>This task is over. Send a follow-up from the chat.</Text>
        ) : null}
      </Box>
    )
  })
}
