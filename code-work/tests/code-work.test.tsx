import { expect, mock, test } from 'claude-code/testing'

import { CHECK_MODEL, HOLD_REASON, PANEL_COMMAND, gated, onlyWaiting, modelLabel, normalizeModel, noteFor, panelRows, showsDone, showsStatus } from '../hooks/register'

const BAND = {
  plugin: 'code-work',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 },
} as const

// reach: what the knock on Flex Rig's port answers (exit 0 = online). ran: every host command the mod runs.
// The user typing a message in the app (the kit's own submissions carry no origin)
const typed = (text: string) => ({ text, origin: { kind: 'composer' } }) as any

const start = async ($: any, on: any, reach: 'online' | 'offline' = 'online', ran: string[][] = []) => {
  on('command.register', () => ({ value: { command: 'code-work' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    ran.push([...e.argv])
    const knock = e.argv[0] === '/usr/bin/nc'
    return { value: { exitCode: knock && reach === 'offline' ? 1 : 0, stdout: 'Stopped run r1 (was running).\n', stderr: '' } }
  })
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('session.messages', () => ({ value: [] }))   // a new chat: nothing answered yet
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise((r) => setTimeout(r, 20))   // let the first online check land
}

test('a new chat holds its first message until the user picks, then sends it; one click keeps it on the Mac', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  const texts: string[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    texts.push(e.text)
    return { text: e.text, context: e.context }
  })
  const rows = mock.session(on) as any
  on('fs.read', (_: unknown, e: { path: string }) => { if (e.path.endsWith('/.flexrig/config')) return { value: 'FLEXRIG_HOST="user@192.0.2.10"\n' }; throw new Error('no file') })   // the config file names the PC to knock on
  await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'code-work-flex-rig' })).toBeTruthy()
    expect(await ui.find({ key: 'code-work-model' })).toBeTruthy()    // model and effort: two small pickers
    expect(await ui.find({ key: 'code-work-effort' })).toBeTruthy()
    expect(await ui.find({ key: 'code-work-reset' })).toBeFalsy()     // nothing changed: no way back shown
    await ui.unmount()
  }

  // Decided 2026-11-12: the first message waits for a pick, even when the bar already shows Flex Rig.
  const r = await $.prompt.submit(typed('fix the bug'))
  expect((r as { drop?: string }).drop).toBe(HOLD_REASON)
  expect(texts.length).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'code-work-hold' })).toBeTruthy()
  await ui.press({ key: 'code-work-flex-rig' })               // the lit end: a click still counts as the pick
  expect(texts).toEqual(['fix the bug'])
  expect(rows.appended().map((r: any) => JSON.stringify(r.message?.content ?? r)).join(' ')).toContain('Code work: Flex Rig')   // the note, as a hidden row
  expect(await ui.find({ key: 'code-work-hold' })).toBeFalsy()

  await ui.press({ key: 'code-work-mac' })
  expect(await ui.find({ key: 'code-work-model' })).toBeFalsy()   // model + effort only matter for Flex Rig
  await ui.unmount()

  await $.prompt.submit({ text: 'and another' })
  expect(seen.at(-1)?.join(' ')).toContain('Code work: this Mac')
})

test('Flex Rig offline: the bar says so and Claude does the work on the Mac', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text, context: e.context }
  })
  const ran: string[][] = []
  on('fs.read', (_: unknown, e: { path: string }) => { if (e.path.endsWith('/.flexrig/config')) return { value: 'FLEXRIG_HOST="user@192.0.2.10"\n' }; throw new Error('no file') })   // the config file names the PC to knock on
  await start($, on, 'offline', ran)
  expect(ran.some((a) => a[0] === '/usr/bin/nc' && a.includes('22'))).toBe(true)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /work stays on the Mac/ })).toBeTruthy()
  expect(await ui.find({ key: 'code-work-model' })).toBeFalsy()
  await ui.press({ key: 'code-work-flex-rig' })
  await ui.unmount()

  await $.prompt.submit({ text: 'fix it' })
  const n = seen[0]?.join(' ') ?? ''
  expect(n).toContain('offline')
  expect(n).toContain('on the Mac')
  expect(n).not.toContain('flexrig.sh start')
})

test('model and effort are two pickers; the way back clears both', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('fs.read', (_: unknown, e: { path: string }) => { if (e.path.endsWith('/.flexrig/config')) return { value: 'FLEXRIG_HOST="user@192.0.2.10"\n' }; throw new Error('no file') })   // the config file names the PC to knock on
  await start($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'code-work-flex-rig' })   // the pick a new chat asks for
  expect(await ui.find({ key: 'code-work-reset' })).toBeFalsy()
  const dot = async (chip: string) => ((await ui.find({ key: chip }))?.text ?? '').includes('●')   // the small clay dot
  await ui.select({ key: 'code-work-effort', value: 'max' })
  expect(await dot('code-work-effort-chip')).toBe(true)
  expect(await dot('code-work-model-chip')).toBe(false)
  await ui.select({ key: 'code-work-model', value: 'sonnet' })
  expect(await dot('code-work-model-chip')).toBe(true)
  expect(await ui.find({ key: 'code-work-reset' })).toBeTruthy()
  await $.prompt.submit({ text: 'go' })
  expect(seen[0]?.join(' ')).toContain('at Max effort')
  expect(seen[0]?.join(' ')).toContain('The user picked this in the bar')

  await ui.press({ key: 'code-work-reset' })
  expect(await ui.find({ key: 'code-work-reset' })).toBeFalsy()
  expect(await dot('code-work-effort-chip')).toBe(false)
  await ui.unmount()
  await $.prompt.submit({ text: 'again' })
  expect(seen[1]?.join(' ')).not.toContain('The user picked this in the bar')
})

test('/code-work switches and names where the work goes', async ($, on) => {
  await start($, on)
  const toMac = await $.command.run({ command: 'code-work', args: 'mac' })
  expect(toMac.text).toContain('this Mac')
  const flip = await $.command.run({ command: 'code-work', args: '' })
  expect(flip.text).toContain('Flex Rig')
})

test("the note doesn't name an effort before the chat's own is known (the first-message mix-up)", () => {
  const b = { machine: 'flex-rig' as const, model: null, effort: null, chatModel: 'claude-opus-5-5', chatEffort: 'max' as const }
  expect(noteFor(b, 'online', [], false)).toContain('at the effort this chat uses')
  expect(noteFor(b, 'online', [], false)).not.toContain('Max')
  expect(noteFor(b, 'online', [], true)).toContain('at Max effort')
  expect(noteFor({ ...b, effort: 'low' }, 'online', [], false)).toContain('at Low effort')
  expect(noteFor(b, 'unknown', [], true)).toContain('flexrig.sh start')   // not checked yet: Flex Rig as usual
})

test("the Flex Rig note: repo edits of the Mac setup's own sources go to Flex Rig too", () => {
  const b = { machine: 'flex-rig' as const, model: null, effort: null, chatModel: 'claude-opus-5-5', chatEffort: 'max' as const }
  const n = noteFor(b, 'online', [], true)
  expect(n).toContain('Editing files in any repo is coding work and goes to Flex Rig')
  expect(n).toContain("including the sources of this Mac setup")
  for (const src of ['flex-rig rule', 'flexrig.sh', 'code-work mod', 'repo-sync.sh', 'install scripts']) expect(n).toContain(src)
  expect(n).toContain('running installers that copy into ~/.claude')   // what stays on the Mac: steps on the Mac itself
  expect(n).not.toContain("the Mac's own settings, ~/.claude")          // the old wording that read as "edits to the setup's sources stay here"
  // the Mac's note doesn't send anything to Flex Rig
  expect(noteFor({ ...b, machine: 'mac' }, 'online', [], true)).not.toContain('goes to Flex Rig')
})

test('the Flex Rig note: wait in the foreground, 2.5 minutes per call, not in the background', () => {
  const b = { machine: 'flex-rig' as const, model: null, effort: null, chatModel: 'claude-opus-5-5', chatEffort: 'max' as const }
  const n = noteFor(b, 'online', [], true)
  expect(n).toContain('flexrig.sh wait in the foreground')
  expect(n).toContain('Bash timeout 600000')
  expect(n).toContain('2.5 min per call')
  expect(n).toContain('STILL WORKING')
  expect(n).not.toContain('--until-done')
  expect(n).not.toContain('end your turn')
})

test('model names; the status line only while Flex Rig works; PR buttons once it finishes', () => {
  expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  expect(normalizeModel('Opus 5.5')).toBe('claude-opus-5-5')
  expect(normalizeModel('sonnet')).toBe('sonnet')
  expect(modelLabel('claude-haiku-5-5', [])).toBe('Haiku 5.5')
  expect(modelLabel('opus', [{ family: 'opus', value: 'opus', label: 'Opus 5.5' }])).toBe('Opus 5.5')

  const now = Date.parse('2026-11-09T12:00:00Z')
  const s = { run: 'r', state: 'running', title: 't', elapsedMin: 3, steps: 8, model: null, effort: null, updatedAt: '2026-11-09T11:59:30Z' }
  expect(showsStatus('flex-rig', s, now)).toBe(true)
  expect(showsStatus('mac', s, now)).toBe(false)
  expect(showsStatus('flex-rig', { ...s, state: 'done' }, now)).toBe(false)
  expect(showsStatus('flex-rig', { ...s, updatedAt: '2026-11-09T11:50:00Z' }, now)).toBe(false)

  const d = { ...s, state: 'done', pr: 'https://github.com/example-user/my-repo/pull/200' }
  expect(showsDone(d, null, now)).toBe(true)
  expect(showsDone(d, 'r', now)).toBe(false)                         // merged or dismissed
  expect(showsDone({ ...d, pr: null }, null, now)).toBe(false)       // no PR: nothing to open
  expect(showsDone({ ...d, state: 'running' }, null, now)).toBe(false)
  expect(showsDone({ ...d, updatedAt: '2026-11-07T11:00:00Z' }, null, now)).toBe(false)   // old
})

test('while Flex Rig works: Stop asks once, then stops the run', async ($, on) => {
  const ran: string[][] = []
  const asked: string[] = []
  on('prompt.submit', (_, e) => { asked.push(e.text); return { text: e.text, context: e.context } })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path.endsWith('.status.json') }))
  let state = 'running'
  on('fs.read', (_: unknown, e: { path: string }) => ({
    value: e.path.endsWith('.status.json')
      ? JSON.stringify({ run: '20261109-1500-abcd', state, title: 'fix the save button', elapsedMin: 2, steps: 5, model: 'claude-opus-5-5', effort: 'high', pr: 'https://github.com/example-user/my-repo/pull/200', updatedAt: new Date().toISOString() })
      : 'FLEXRIG_HOST="user@192.0.2.10"\n',
  }))
  await start($, on, 'online', ran)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'code-work-stop' })).toBeTruthy()
  await ui.press({ key: 'code-work-stop' })                      // first press only asks
  expect(ran.some((a) => a.includes('stop'))).toBe(false)
  expect(await ui.find({ key: 'code-work-stop-cancel' })).toBeTruthy()
  await ui.press({ key: 'code-work-stop' })
  expect(ran.some((a) => a.includes('stop') && a.includes('20261109-1500-abcd'))).toBe(true)
  await ui.unmount()
})

test('when Flex Rig finishes with a PR: Open PR and Merge show; Merge asks Claude to merge and hides the line', async ($, on) => {
  const asked: string[] = []
  on('prompt.submit', (_, e) => { asked.push(e.text); return { text: e.text, context: e.context } })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path.endsWith('.status.json') }))
  on('fs.read', (_: unknown, e: { path: string }) => ({
    value: e.path.endsWith('.status.json')
      ? JSON.stringify({ run: '20261109-1500-abcd', state: 'done', title: 'fix the save button', elapsedMin: 9, steps: 30, model: null, effort: null, pr: 'https://github.com/example-user/my-repo/pull/200', updatedAt: new Date().toISOString() })
      : 'FLEXRIG_HOST="user@192.0.2.10"\n',
  }))
  await start($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'code-work-stop' })).toBeFalsy()
  expect(await ui.find({ key: 'code-work-open-pr' })).toBeTruthy()
  await ui.press({ key: 'code-work-merge' })
  await new Promise((r) => setTimeout(r, 20))
  expect(asked.some((t) => t.includes('flexrig.sh merge 20261109-1500-abcd'))).toBe(true)
  expect(await ui.find({ key: 'code-work-merge' })).toBeFalsy()
  await ui.unmount()
})

// Walks a drawn tree: every element, with the elements above it.
const walk = (node: any, up: any[] = [], out: { el: any; up: any[] }[] = []) => {
  if (!node || typeof node !== 'object') return out
  out.push({ el: node, up })
  for (const c of node.children ?? []) walk(c, [...up, node], out)
  return out
}

test('desktop look: compact pills, no button highlight outside its pill (the overlap), small status text', async ($, on) => {
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path.endsWith('.status.json') }))
  on('fs.read', (_: unknown, e: { path: string }) => ({
    value: e.path.endsWith('.status.json')
      ? JSON.stringify({ run: 'r1', state: 'running', title: 'fix the save button', elapsedMin: 3, steps: 8, model: 'claude-opus-5-5', effort: 'medium', pr: null, updatedAt: new Date().toISOString() })
      : 'FLEXRIG_HOST="user@192.0.2.10"\n',
  }))
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = walk(await ui.drawn())

  const buttons = all.filter((n) => n.el.type === 'Button')
  expect(buttons.length).toBeGreaterThan(2)
  for (const { el, up } of buttons) {
    // The desktop's own 28px hover fill is off on every button...
    expect(el.hover?.backgroundColor).toBe('#00000000')
    // ...and it sits in a keyed Box (so the hover applies) with no padding left to the desktop.
    const box = up.at(-1)
    expect(typeof box?.props?.key).toBe('string')
    if (box?.props?.borderStyle) {
      for (const side of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) expect(typeof box.props[side]).toBe('number')
    }
  }
  // The picked end is tinted with its own color; the status line is small text.
  const flexEnd = all.find((n) => n.el.props?.key === 'code-work-end-flex-rig')?.el
  expect(flexEnd?.props?.borderColor).toBe('#D97757')
  expect(flexEnd?.props?.backgroundColor).toBe('#D9775722')
  const status = all.find((n) => n.el.props?.key === 'code-work-status')?.el
  const texts = walk(status).filter((n) => n.el.type === 'Text')
  expect(texts.length).toBeGreaterThan(1)
  for (const { el } of texts) expect(el.props?.size).toBe('caption')
  await ui.unmount()

  // The terminal keeps whole-cell padding and no icons.
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const t = walk(await term.drawn())
  expect(t.find((n) => n.el.props?.key === 'code-work-end-mac')?.el.props?.paddingX).toBe(1)
  expect(t.some((n) => n.el.type === 'Svg')).toBe(false)
  await term.unmount()
})

// ---------- the Flex Rig side panel ----------
const PANE = {
  plugin: 'code-work',
  component: 'Pane',
  requestId: 'flex-rig',
  props: { title: 'Flex Rig', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the panel folds a long run of steps to its last three and says how many came before', () => {
  const step = (n: number) => ({ n, kind: 'step' as const, text: `step ${n}` })
  const rows = panelRows([{ n: 1, kind: 'task', text: 'Fix it' }, step(2), step(3), step(4), step(5), step(6), { n: 7, kind: 'say', text: 'Done.' }, step(8)])
  expect(rows.map((r) => [r.kind, r.text])).toEqual([
    ['task', 'Fix it'], ['more', '2 earlier steps'], ['step', 'step 4'], ['step', 'step 5'], ['step', 'step 6'], ['say', 'Done.'], ['step', 'step 8'],
  ])
  expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  expect(panelRows([step(1), step(2), step(3), step(4)]).map((r) => r.text)).toEqual(['1 earlier step', 'step 2', 'step 3', 'step 4'])
})

test('the Flex Rig panel: View opens it, it shows the tasks and the conversation, adds what is new, switches task, and messages a working task', async ($, on) => {
  const RUN = '20261109-1500-abcd', OLD = '20261109-1400-ffff'
  const ran: string[][] = []
  const opened: string[] = []
  const runs = [
    { id: RUN, state: 'running', repo: 'my-repo', mode: 'work', pr: null, task: 'Fix the save button.', elapsedMin: 3 },
    { id: OLD, state: 'done', repo: 'my-repo', mode: 'work', pr: null, task: 'Add a search box.', elapsedMin: 9 },
  ]
  let more = false
  on('ui.open', (_: unknown, e: { id: string }) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('command.register', () => ({ value: { command: 'code-work' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path.endsWith('.status.json') }))
  on('fs.read', (_: unknown, e: { path: string }) => ({
    value: e.path.endsWith('.status.json')
      ? JSON.stringify({ run: RUN, state: 'running', title: 'fixing the save button', elapsedMin: 3, steps: 5, model: 'claude-opus-5-5', effort: 'high', pr: null, updatedAt: new Date().toISOString() })
      : 'FLEXRIG_HOST="user@192.0.2.10"\n',
  }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    ran.push([...e.argv])
    if (e.argv[2] !== 'panel') return { value: { exitCode: 0, stdout: 'Sent to Flex Rig (run x): it reads it at its next step.\n', stderr: '' } }
    const id = e.argv.length === 5 ? e.argv[3] : RUN
    const after = Number(e.argv.at(-1))
    const first = [{ n: 2, kind: 'task', text: 'Fix the save button.' }, { n: 4, kind: 'say', text: 'I will read the page first.' }, { n: 4, kind: 'step', text: 'Read order.js' }]
    const run = id === OLD
      ? { id: OLD, state: 'done', next: 9, reset: false, items: [{ n: 0, kind: 'task', text: 'Add a search box.' }, { n: 8, kind: 'say', text: 'The search box is in.' }, { n: 9, kind: 'done', text: 'Finished.' }] }
      : after === 0
        ? { id: RUN, state: 'running', next: 4, reset: false, items: first }
        : { id: RUN, state: 'running', next: more ? 6 : 4, reset: false, items: more && after < 6 ? [{ n: 6, kind: 'user', text: 'also the cancel button' }] : [] }
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, runs, run }) + '\n', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise((r) => setTimeout(r, 20))

  // The bar's status line has a View button: it opens the panel on this chat's run.
  const bar = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await bar.press({ key: 'code-work-view' })
  await new Promise((r) => setTimeout(r, 20))
  expect(opened).toEqual(['flex-rig'])
  expect(ran.some((a) => a[2] === 'panel' && a[3] === RUN && a[4] === '0')).toBe(true)
  await bar.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Both tasks are listed; this chat's run carries the chat's own title.
  expect(await ui.find({ key: `flex-rig-pick-${RUN}` })).toBeTruthy()
  expect(await ui.find({ key: `flex-rig-pick-${OLD}` })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Fix the save button\./ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /› Read order\.js/ })).toBeTruthy()
  // It is still working, so there is a box to message it. Sending runs `flexrig.sh say <run> <text>`.
  await ui.input({ key: 'flex-rig-say', text: 'also the cancel button' })
  await new Promise((r) => setTimeout(r, 20))
  expect(ran.some((a) => a[2] === 'say' && a[3] === RUN && a[4] === 'also the cancel button')).toBe(true)
  // What is new is asked for from the last line on, and added below.
  more = true
  await ui.press({ key: `flex-rig-pick-${RUN}` })
  await new Promise((r) => setTimeout(r, 20))
  expect(ran.some((a) => a[2] === 'panel' && a[3] === RUN && a[4] === '4')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /You: also the cancel button/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /› Read order\.js/ })).toBeTruthy()
  // Another task: its own conversation, and no message box once it is over.
  await ui.press({ key: `flex-rig-pick-${OLD}` })
  await new Promise((r) => setTimeout(r, 20))
  expect(await ui.find({ type: 'Text', text: /Add a search box\./ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✓ Finished/ })).toBeTruthy()
  expect(await ui.find({ key: 'flex-rig-say' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /This task is over/ })).toBeTruthy()
  await ui.unmount()

  // The terminal draws it too.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /Add a search box\./ })).toBeTruthy()
  await term.unmount()
})

test('the Flex Rig panel draws before anything is loaded, and says so when Flex Rig cannot be reached', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: PANEL_COMMAND } }))
  on('command.run', (_: unknown, e: any) => ({ text: String(e?.command ?? '') }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('process.run', (_: unknown, e: { argv: string[] }) => ({
    value: e.argv[2] === 'panel' ? { exitCode: 1, stdout: '{"ok":false,"error":"Flex Rig not reachable"}\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise((r) => setTimeout(r, 20))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Nothing loaded yet: a quiet line, no crash.
  expect(await ui.find({ type: 'Text', text: /Asking Flex Rig/ })).toBeTruthy()
  await ui.unmount()
  // /flex-rig-panel opens the panel and asks Flex Rig, which does not answer: the panel says so.
  await $.command.run({ command: PANEL_COMMAND, args: '' })
  await new Promise((r) => setTimeout(r, 20))
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /Can't reach Flex Rig/ })).toBeTruthy()
  await after.unmount()
})

test("a command Claude Code refuses never stops the online light or Flex Rig's progress (Nov 12)", async ($, on) => {
  // In the app, /flex-rig was refused (the flex-rig skill owns it) and that threw out the whole start:
  // no knock on Flex Rig, no reading of what `flexrig.sh wait` writes.
  expect(PANEL_COMMAND).not.toBe('flex-rig')
  on('command.register', (_: unknown, e: { name: string }) => { throw new Error(`"/${e.name}" refused: it is the user's /${e.name}`) })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  const ran: string[][] = []
  on('process.run', (_: unknown, e: { argv: string[] }) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('/.flexrig/config')) return { value: 'FLEXRIG_HOST="user@192.0.2.10"\n' }
    if (!e.path.endsWith('.status.json')) throw new Error('no file')
    return { value: JSON.stringify({ run: 'r1', state: 'running', title: 'fix the save button', elapsedMin: 2, steps: 5, model: null, effort: null, pr: null, updatedAt: new Date().toISOString() }) }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise((r) => setTimeout(r, 20))
  expect(ran.some((a) => a[0] === '/usr/bin/nc')).toBe(true)                 // the knock still ran
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'code-work-stop' })).toBeTruthy()              // the "working on" line shows
  const icon = JSON.stringify(await ui.drawn())
  expect(icon).toContain('#7FB77E')                                          // the green online light
  await ui.unmount()
})

test("only the user's own typing waits for the pick: sessions started by other sessions, peers and schedules go straight through", () => {
  expect(gated('composer')).toBe(true)   // typed in the app
  expect(gated('bridge')).toBe(true)     // Remote Control from their phone
  for (const k of ['sdk', 'peer', 'peer-send-message', 'task-notification', 'scheduled-trigger', 'plugin']) expect(gated(k)).toBe(false)
})

test('/code-work also counts as the pick and sends the held message', async ($, on) => {
  const texts: string[] = []
  on('prompt.submit', (_, e) => { texts.push(e.text); return { text: e.text, context: e.context } })
  const clock = mock.clock(on)
  await start($, on)
  await $.prompt.submit(typed('first thing'))
  expect(texts.length).toBe(0)
  await $.command.run({ command: 'code-work', args: 'mac' })
  expect(texts.length).toBe(0)   // a command's hook can't send; the bar's next 5-second tick does
  await clock.advance(5000)
  expect(texts).toEqual(['first thing'])
  await $.prompt.submit(typed('second thing'))
  expect(texts).toEqual(['first thing', 'second thing'])
})

test('while the Mac only waits on Flex Rig, its checks go to Haiku; anything else stays on the chat model (Nov 12)', () => {
  const wait = (text: string, cmd = '~/.claude/skills/flex-rig/flexrig.sh wait 20261112-1754-5125') =>
    ({ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: cmd }, text }] })
  const results = (text = '') => ({ role: 'user', text })
  const still = 'Flex Rig run x: running, 3 min, 20 steps\nSTILL WORKING (run x): call flexrig.sh wait x again'
  expect(CHECK_MODEL).toBe('haiku')
  expect(onlyWaiting([results('go'), wait(still), results()])).toBe(true)
  expect(onlyWaiting([results('go'), wait(still), results('<system-reminder>note</system-reminder>')])).toBe(true)
  expect(onlyWaiting([results('go'), wait('Flex Rig run x DONE after 9 min. PR: https://github.com/a/b/pull/1'), results()])).toBe(false)   // the report: chat model
  expect(onlyWaiting([results('go'), wait(still), results('Message from the user: use the blue one')])).toBe(false)                     // the user spoke
  expect(onlyWaiting([results('go'), wait(still, 'flexrig.sh start --title x "brief"'), results()])).toBe(false)                     // the brief
  expect(onlyWaiting([results('go'), { role: 'assistant', text: '', toolUses: [] }])).toBe(false)
})

test('FLEXRIG_NAME in the config relabels the remote machine in the bar, the notes to Claude and the panel', async ($, on) => {
  on('command.register', () => ({ value: { command: 'code-work' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_: unknown, e: { path: string }) => { if (e.path.endsWith('/.flexrig/config')) return { value: 'FLEXRIG_HOST="u@192.0.2.10"\nFLEXRIG_NAME="Desk PC"\n' }; throw new Error('no file') })
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => { seen.push(e.context); return { text: e.text, context: e.context } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise((r) => setTimeout(r, 20))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'code-work-flex-rig' })).toBeTruthy()
  await ui.unmount()
  const flip = await $.command.run({ command: 'code-work', args: 'mac' })
  const back = await $.command.run({ command: 'code-work', args: 'flex' })
  expect(flip.text).toContain('this Mac')
  expect(back.text).toContain('Desk PC')
  expect(back.text).not.toContain('Flex Rig')
  await $.prompt.submit({ text: 'fix it' })
  const n = seen[seen.length - 1]?.join(' ') ?? ''
  expect(n).toContain('Desk PC')
  expect(n).not.toContain('Flex Rig')
})
