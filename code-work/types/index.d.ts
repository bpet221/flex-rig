export type Machine = 'flex-rig' | 'mac'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** Whether the Mac can reach Flex Rig right now ('unknown' until the first check answers). */
export type Online = 'unknown' | 'online' | 'offline'

/** One entry of the model menu: the newest of each kind (from ~/.flexrig/models.json). */
export type ModelChoice = { family: string; value: string; label: string }

/** What flexrig.sh wait writes for this chat while Flex Rig works (~/.flexrig/chats/<chat>.status.json). */
export type RunStatus = {
  run: string
  state: string
  title: string
  elapsedMin: number
  steps: number
  model: string | null
  effort: string | null
  pr?: string | null
  updatedAt: string
}

/** One line of a Flex Rig task's conversation, as `flexrig.sh panel` sends it (n = the line in Flex Rig's log). */
export type PanelItem = { n: number; kind: 'task' | 'say' | 'step' | 'user' | 'note' | 'done' | 'error'; text: string }
/** One Flex Rig run in the side panel's list. */
export type PanelRun = { id: string; state: string; repo: string | null; mode: string | null; pr: string | null; task: string; elapsedMin: number }
/** The Flex Rig side panel: the runs, the picked run and its conversation so far (next = the log line to ask from). */
/** A new chat's first message, held until the user picks Mac or Flex Rig (resend false: it had pictures, so they send it again). */
export type Held = { text: string; resend: boolean }
export type Panel = { run: string | null; state: string | null; next: number; items: PanelItem[]; runs: PanelRun[]; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'code-work': {
      machine: Machine
      model: string | null
      effort: Effort | null
      chatModel: string | null
      chatEffort: Effort | null
      status: RunStatus | null
      models: ModelChoice[]
      online: Online
      dismissed: string | null
      confirmStop: boolean
      panel: Panel
      chosen: boolean
      held: Held | null
    }
  }
}
