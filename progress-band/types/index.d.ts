export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type Step = {
  id: string
  title: string
  activeForm?: string
  status: StepStatus
}

export type AgentState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'

export type AgentRow = {
  id: string
  description: string
  type: string
  model?: string
  status: AgentState
  startedAt: number
  endedAt?: number
  missingSince?: number
  calls: number
  tokens: number
  /** The turn whose steps are being counted into `tokens` as they land. */
  turnId?: string
  /** What that turn's steps have added so far; its end tops up the rest. */
  turnTokens?: number
  modelId?: string
  activity?: string
  lastText?: string
}

export type Turn = {
  startedAt: number
  endedAt?: number
  isWorking: boolean
  reason?: string
  calls: number
  isAsking?: boolean
  needsReply?: boolean
  lastTool?: string
  finalText?: string
}

export type View = {
  isHidden: boolean
  isCondensed: boolean
  isCollapsed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'progress-band': {
      steps: Step[]
      agents: AgentRow[]
      turn: Turn | null
      view: View
    }
  }
}
