import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentState, Step, View } from '../types'

const steps = atom({ plugin: 'progress-band', key: 'steps' } as const, [])
const agents = atom({ plugin: 'progress-band', key: 'agents' } as const, [])
const turn = atom({ plugin: 'progress-band', key: 'turn' } as const, null)
const VIEW0: View = { isHidden: false, isCondensed: true, isCollapsed: false }
const view = atom({ plugin: 'progress-band', key: 'view' } as const, VIEW0)

// Keep the roster short: live agents plus the most recent finished ones.
const MAX_AGENTS = 12
// How often the band redraws while a turn runs (elapsed time, agent status).
const TICK_MS = 2000

const STEPS_TOOL = 'mcp__progress-band__steps'
const COLLAPSE_MS = 20_000
const MAX_STEPS = 50
const LABEL_MAX = 120
// At most one toast and speech per alert kind in this window.
const ALERT_MS = 10_000
// A live agent the engine stops listing for this long is taken as finished.
const MISSING_MS = 10_000

const WAVE: ReadonlyArray<readonly [string, string]> = [
  ['Scout the code and facts', 'Scouting the code and facts'],
  ["Get the owner's rulings", "Getting the owner's rulings"],
  ['Brief the implementer', 'Briefing the implementer'],
  ['Re-verify the implementation', 'Re-verifying the implementation'],
  ['Run the review gate', 'Running the review gate'],
  ['Adjudicate the findings', 'Adjudicating the findings'],
  ['Batch-fix the findings', 'Batch-fixing the findings'],
  ['Finders re-verify the fixes', 'Finders re-verifying the fixes'],
  ['Bank the wave and hand off', 'Banking the wave and handing off'],
]

type Role = 'scout' | 'reviewer' | 'implementer' | 'fixer' | 'scribe' | 'agent'

const ROLE_ORDER: readonly Role[] = ['scout', 'implementer', 'reviewer', 'fixer', 'scribe', 'agent']

const ROLE_LABEL: Record<Role, readonly [string, string]> = {
  scout: ['Scouting', 'scouts'],
  reviewer: ['Review gate', 'reviewers'],
  implementer: ['Implementing', 'implementers'],
  fixer: ['Fixing', 'fixers'],
  scribe: ['Scribing', 'scribes'],
  agent: ['Agents', 'agents'],
}

// Row and spinner hooks redraw every tick: they read these, not the atoms. Undefined until hydrated after a load.
let viewCache: View | undefined
let stepsCache: Step[] | undefined
let hydrating: Promise<void> | null = null
let ticker: { cancel: () => void } | null = null
let collapseTimer: { cancel: () => void } | null = null
// The turn's end work runs once, when the turn is over and no agent is live.
let isSettled = false
// Bumped by each turn.start; a settle begun under an older value is stale.
let turnGen = 0
// The answer last sent to the classifier, by its turn's endedAt.
let classifiedAt: number | undefined
const lastAlertAt: Record<'fail' | 'ask', number> = { fail: -Infinity, ask: -Infinity }

const NUDGE = `## Progress panel
The person sees a live progress panel instead of tool output. It is built from the step list you keep with the ${STEPS_TOOL} tool, so for any request that takes more than two or three steps:
- Before starting, call it with \`plan\`: one entry per step, in order. Titles are short, plain, user-facing phrases ("Check the credit balance"), not implementation detail; activeForm is the present-continuous form ("Checking the credit balance").
- Right before you start a step call it with \`step\` (its 1-based number) and \`status: "in_progress"\`; right after, \`status: "completed"\`. One step in progress at a time, in order.
- Use \`add\` when the plan grows. Never leave a finished step in_progress.
A one-step request needs no step list. If TaskCreate/TaskUpdate are offered you may use those instead; the panel reads both.`

const STEPS_SCHEMA = {
  type: 'object',
  properties: {
    plan: {
      type: 'array',
      description: 'Replace the step list with these steps, all pending, in order.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, user-facing step title' },
          activeForm: { type: 'string', description: 'Present-continuous form shown while working' },
        },
        required: ['title'],
      },
    },
    step: { type: 'integer', minimum: 1, description: '1-based number of the step to update' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
    add: {
      type: 'object',
      description: 'Append one step to the list',
      properties: {
        title: { type: 'string' },
        activeForm: { type: 'string' },
      },
      required: ['title'],
    },
  },
}

type Dict = Record<string, unknown>

const asDict = (value: unknown): Dict =>
  typeof value === 'object' && value !== null ? (value as Dict) : {}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const tail = (path: string): string => path.split('/').filter(Boolean).slice(-2).join('/')

const clip = (text: string, width: number): string => {
  const one = text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (width <= 1) return one.slice(0, Math.max(0, width))
  return one.length > width ? `${one.slice(0, width - 1)}…` : one
}

const fit = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : clip(text, LABEL_MAX)

/** Mask credentials a label might carry. */
const redact = (text: string): string =>
  text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\/\s:@]+:[^@\s]+@/gi, '$1•••@')
    .replace(/((?:^|\s)(?:-u|-p|--user|--password|--passwd)\s*)(?:"[^"]*"|'[^']*'|\S+)/g, '$1•••')
    .replace(/((?:proxy-)?authorization\s*[=:]\s*["']?)(?:[A-Za-z]+\s+)?[^\s"']+/gi, '$1•••')
    .replace(/((?:set-)?cookie\s*[=:]\s*["']?)[^"']+/gi, '$1•••')
    .replace(/Bearer\s+\S+/g, 'Bearer •••')
    .replace(
      /\b([A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Za-z_]*)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=•••',
    )
    .replace(/(--?(?:token|password|secret|api-?key|key)[= ])\S+/g, '$1•••')

/** Scheme, host and path only: no userinfo, query or fragment. */
const bareUrl = (raw: string | undefined): string => {
  if (raw === undefined) return ''
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return ''
  }
}

const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest === 0 ? `${m}m` : `${m}m ${rest}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const bar = (ratio: number, width: number): string => {
  if (width <= 0) return ''
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** One short, human label for a tool call, from its input; unknown tools get none. */
const labelOf = (tool: string, input: unknown): string => redact(rawLabel(tool, asDict(input)))

const rawLabel = (tool: string, i: Dict): string => {
  switch (tool) {
    case 'Bash':
      return str(i.description) ?? redact(str(i.command) ?? '').split('\n')[0]?.slice(0, 60) ?? ''
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return str(i.file_path) ? tail(String(i.file_path)) : ''
    case 'Grep':
    case 'Glob':
      return str(i.pattern) ?? ''
    case 'Agent':
      return str(i.description) ?? str(i.subagent_type) ?? ''
    case 'Skill':
      return `/${str(i.skill) ?? ''}`
    case 'WebFetch':
      return bareUrl(str(i.url))
    case 'WebSearch':
      return str(i.query) ?? ''
    case 'TaskCreate':
      return str(i.subject) ?? ''
    case 'TaskUpdate':
      return [str(i.status), str(i.subject)].filter(Boolean).join(' · ')
    case 'TodoWrite':
      return 'updated the task list'
    case STEPS_TOOL: {
      if (Array.isArray(i.plan)) return `planned ${i.plan.length} steps`
      if (i.add !== undefined) return `added ${str(asDict(i.add).title) ?? 'a step'}`
      if (i.step !== undefined) return `step ${String(i.step)} ${str(i.status) ?? ''}`.trim()
      return ''
    }
    case 'AskUserQuestion':
      return 'asked you a question'
    case 'SendMessage':
      return str(i.to) ? `to ${String(i.to)}` : ''
    default:
      return ''
  }
}

// Fits the 9-cell tokens column: one decimal below 100k, none from there to 1M.
const tokensOf = (n: number): string =>
  n < 1000
    ? `${n} tok`
    : n < 99_950
      ? `${(n / 1000).toFixed(1)}k tok`
      : n < 999_500
        ? `${Math.round(n / 1000)}k tok`
        : `${(n / 1_000_000).toFixed(1)}M tok`

const shortType = (type: string): string =>
  type === 'general-purpose'
    ? 'general'
    : type === 'claude-code-guide'
      ? 'guide'
      : type === 'statusline-setup'
        ? 'statusline'
        : type

/** The tool call as one `Tool: label` line; reserved envelope keys are not the tool's input. */
const activityOf = (tool: string, e: unknown): string => {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...input } = asDict(e)
  const label = labelOf(tool, input)
  return clip(label ? `${tool}: ${label}` : tool, LABEL_MAX)
}

const firstLine = (text: string): string | undefined => {
  const line = text.split('\n').find(l => l.trim().length > 0)
  return line === undefined ? undefined : clip(line, 120)
}

/** The answer's last line ends in a question mark, the TTS `🔊` line aside. */
const endsInQuestion = (text: string): boolean => {
  const lines = text.trimEnd().split('\n')
  if (lines[lines.length - 1]?.trimStart().startsWith('🔊')) lines.pop()
  const last = [...lines].reverse().find(l => l.trim().length > 0)
  return last?.trimEnd().endsWith('?') ?? false
}

const isStepStatus = (value: unknown): value is Step['status'] =>
  value === 'pending' || value === 'in_progress' || value === 'completed'

const stateOfReason = (reason: string): AgentState =>
  reason === 'answer' ? 'completed' : reason === 'aborted' ? 'killed' : 'failed'

const isLive = (status: AgentState): boolean =>
  status === 'pending' || status === 'running' || status === 'waiting' || status === 'idle'

const agentWord = (status: AgentState): string => {
  switch (status) {
    case 'pending':
      return 'Queued'
    case 'running':
      return 'Working'
    case 'waiting':
      return 'Waiting'
    case 'idle':
      return 'Idle'
    case 'completed':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'killed':
      return 'Stopped'
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'Progress panel: toggle it, or hide, show, quiet, verbose, clear or agents',
      argumentHint: '[hide|show|quiet|verbose|clear|agents]',
    })
    await $.tool.register({
      name: 'steps',
      description:
        'Keep the progress panel the person sees: plan the steps of a multi-step request, then mark each in_progress and completed as you go.',
      inputSchema: STEPS_SCHEMA,
      isDeferred: false,
    })
    await hydrate($)

    return next(e)
  })

  on('tool.call', { tool: STEPS_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { result: 'The progress panel belongs to the main conversation.' }
    }

    const input = asDict(e)
    let isCapped = false
    const list = await setSteps($, cur => {
      let out = cur
      isCapped = false
      if (Array.isArray(input.plan)) {
        isCapped = input.plan.length > MAX_STEPS
        out = input.plan.slice(0, MAX_STEPS).map((raw, i) => {
          const p = asDict(raw)
          return {
            id: `step-${i + 1}`,
            title: clip(str(p.title) ?? `Step ${i + 1}`, LABEL_MAX),
            activeForm: fit(str(p.activeForm)),
            status: 'pending' as const,
          }
        })
      }
      if (input.add !== undefined && out.length >= MAX_STEPS) {
        isCapped = true
      } else if (input.add !== undefined) {
        const p = asDict(input.add)
        out = [
          ...out,
          {
            id: `step-${out.length + 1}`,
            title: clip(str(p.title) ?? `Step ${out.length + 1}`, LABEL_MAX),
            activeForm: fit(str(p.activeForm)),
            status: 'pending' as const,
          },
        ]
      }
      const index = typeof input.step === 'number' ? Math.floor(input.step) - 1 : -1
      const status = str(input.status)
      if (index >= 0 && index < out.length && isStepStatus(status)) {
        out = out.map((s, i) =>
          i === index
            ? { ...s, status }
            : status === 'in_progress' && s.status === 'in_progress'
              ? { ...s, status: 'completed' as const }
              : s,
        )
      }
      return out
    })

    return {
      result: [
        'Steps:',
        ...list.map((s, i) => `${i + 1}. [${s.status}] ${s.title}`),
        ...(isCapped ? [`The panel keeps at most ${MAX_STEPS} steps; the rest were not added.`] : []),
      ].join('\n'),
    }
  }).catch(() => ({ result: 'The progress panel could not record that.' }))

  on('skill.prompt', { skill: 'orchestrate' }, async ($, e, next) => {
    const out = await next(e)
    const list = await read($, steps)
    if (list.every(s => s.status === 'completed')) {
      await setSteps($, () =>
        WAVE.map(([title, activeForm], i) => ({
          id: `step-${i + 1}`,
          title,
          activeForm,
          status: 'pending' as const,
        })),
      )
    }
    return out
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'progress' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const v = await read($, view)
    switch (arg) {
      case 'hide':
      case 'show':
        await setView($, cur => ({
          ...cur,
          isHidden: arg === 'hide',
          isCollapsed: arg === 'show' ? false : cur.isCollapsed,
        }))
        return { text: `Progress panel ${arg === 'hide' ? 'hidden' : 'shown'}.` }
      case 'quiet':
      case 'verbose':
        await setView($, cur => ({ ...cur, isCondensed: arg === 'quiet' }))
        $.ui.invalidate('ui.render')
        return {
          text:
            arg === 'quiet'
              ? 'Tool rows condensed to one line each.'
              : 'Tool rows drawn in full again.',
        }
      case 'clear':
        await setSteps($, () => [])
        await update($, agents, () => [])
        return { text: 'Progress panel cleared.' }
      case 'agents':
        await $.ui.open({ id: 'progress-agents', title: 'Agents', closeOnEscape: true })
        return { text: 'Agents pane opened.' }
      case '':
        await setView($, cur => ({ ...cur, isHidden: !cur.isHidden }))
        return { text: `Progress panel ${v.isHidden ? 'shown' : 'hidden'}.` }
      default:
        return { text: 'Usage: /progress [hide|show|quiet|verbose|clear|agents]' }
    }
  })

  // Ask the model to keep a task list, so the panel has steps to show.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(STEPS_TOOL)) return composed

    return {
      sections: [
        ...composed.sections,
        { id: 'progress-band:tasks', text: NUDGE, scope: 'session' as const },
      ],
    }
  })

  on('turn.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      // Written first: a settle racing this hook must read the new turn as working.
      await update($, turn, () => ({ startedAt: now, isWorking: true, calls: 0 }))
      const list = await read($, steps)
      // A list that finished last turn belongs to the last request.
      if (list.length > 0 && list.every(s => s.status === 'completed')) {
        await setSteps($, () => [])
      }
      // Finished agents belong to the last request; live ones carry over.
      await update($, agents, cur => cur.filter(a => isLive(a.status)))
      await setView($, v => ({ ...v, isCollapsed: false }))
      collapseTimer?.cancel()
      collapseTimer = null
      turnGen += 1
      isSettled = false
      startTicker($)
    } catch {
      // The turn runs whether or not the band could record it.
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      if (e.agentId !== undefined) {
        const id = e.agentId
        const usage = e.usage
        const lastText = firstLine(e.answer)
        const list = await update($, agents, cur =>
          cur.map(a =>
            a.id === id
              ? {
                  ...a,
                  status: stateOfReason(e.reason),
                  endedAt: now,
                  tokens: (a.tokens ?? 0) + (usage ? usage.input_tokens + usage.output_tokens : 0),
                  modelId: usage?.model ?? a.modelId,
                  lastText: lastText ?? a.lastText,
                }
              : a,
          ),
        )
        if (e.reason === 'error') {
          const description = list.find(a => a.id === id)?.description ?? id
          notify($, 'fail', `Agent failed: ${clip(redact(description), 60)}`, 'Sir, an agent has failed.', now)
        }
        await settleIfIdle($)
      } else {
        await update($, turn, cur => ({
          startedAt: cur?.startedAt ?? now,
          calls: cur?.calls ?? 0,
          isWorking: false,
          isAsking: false,
          endedAt: now,
          reason: e.reason,
          finalText: e.answer.slice(-4000),
        }))
        await refreshAgents($)
        await settleIfIdle($)
      }
    } catch {
      // The turn ends whether or not the band could record it.
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId === undefined) return started

    const id = started.agentId
    const now = await $.clock.now()
    await update($, agents, list => {
      const known = list.find(a => a.id === id)
      const row: AgentRow = {
        calls: 0,
        tokens: 0,
        ...known,
        id,
        description: e.description,
        type: e.subagentType,
        model: started.model,
        status: 'running',
        startedAt: known?.startedAt ?? now,
        endedAt: undefined,
        missingSince: undefined,
      }
      return trimAgents([...list.filter(a => a.id !== id), row])
    })
    if (isSettled) {
      turnGen += 1
      isSettled = false
      startTicker($)
    }

    return started
  }).catch(($, e, next) => next(e))

  // Every tool call: count it for its loop (the turn's, or a subagent's).
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      void recordAgentCall($, e.agentId, activityOf(e.tool, e)).catch(() => {})
    } else {
      const isTracked = e.tool !== STEPS_TOOL && e.tool !== 'AskUserQuestion' && e.tool !== 'Skill'
      const lastTool = isTracked ? activityOf(e.tool, e) : undefined
      void update($, turn, cur =>
        cur
          ? lastTool === undefined || lastTool === cur.lastTool
            ? { ...cur, calls: cur.calls + 1 }
            : { ...cur, calls: cur.calls + 1, lastTool }
          : cur,
      ).catch(() => {})
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, turn, cur => (cur ? { ...cur, isAsking: true } : cur))
    notify($, 'ask', 'Claude has a question for you', 'Sir, Claude has a question for you.', await $.clock.now())
    try {
      return await next(e)
    } finally {
      await update($, turn, cur => (cur ? { ...cur, isAsking: false } : cur))
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran

    const task = asDict(asDict(ran.result).task)
    const id = str(task.id)
    if (id === undefined) return ran

    const step: Step = {
      id,
      title: clip(str(task.subject) ?? e.subject, LABEL_MAX),
      activeForm: fit(e.activeForm),
      status: 'pending',
    }
    await setSteps($, list => {
      const rest = list.filter(s => s.id !== id)
      return rest.length >= MAX_STEPS ? list : [...rest, step]
    })

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran
    if (asDict(ran.result).success === false) return ran

    const id = e.taskId
    await setSteps($, list => {
      if (e.status === 'deleted') return list.filter(s => s.id !== id)
      const known = list.find(s => s.id === id)
      if (known === undefined && list.length >= MAX_STEPS) return list
      const base: Step = known ?? { id, title: `Task ${id}`, status: 'pending' }
      const changed: Step = {
        ...base,
        title: fit(e.subject) ?? base.title,
        activeForm: fit(e.activeForm) ?? base.activeForm,
        status: e.status ?? base.status,
      }
      return known ? list.map(s => (s.id === id ? changed : s)) : [...list, changed]
    })

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran

    const list: Step[] = e.todos.slice(0, MAX_STEPS).map((t, i) => ({
      id: `todo-${i}`,
      title: clip(t.content, LABEL_MAX),
      activeForm: fit(t.activeForm),
      status: t.status,
    }))
    await setSteps($, () => list)

    return ran
  }).catch(($, e, next) => next(e))

  // The spinner says which step Claude is on.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (stepsCache === undefined) {
      void hydrate($)
      return next(e)
    }
    const list = stepsCache
    const working = list.find(s => s.status === 'in_progress')
    if (working === undefined || e.props.message !== null) return next(e)

    return next({
      ...e,
      props: { ...e.props, message: working.activeForm ?? working.title },
    })
  })

  // Tool rows: one quiet line each; errors keep the engine's full row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    if (e.props.tool === STEPS_TOOL) return <Box />
    if (viewCache === undefined) {
      void hydrate($)
      return next(e)
    }
    if (!viewCache.isCondensed || e.props.isErrored) return next(e)

    const p = e.props
    const label = labelOf(p.tool, p.input)
    const mark = p.isInterrupted ? '⊘' : p.isRunning ? '…' : '✓'
    const markColor = p.isInterrupted ? 'warning' : p.isRunning ? 'claude' : 'success'

    return (
      <Box flexDirection="row" gap={1}>
        <Text color={markColor}>{mark}</Text>
        <Text dimColor wrap="truncate-end">
          {p.tool}
          {label ? `: ${label}` : ''}
          {p.isInterrupted ? ' (interrupted)' : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e)
    if (e.props.tool === STEPS_TOOL) return <Box />
    if (viewCache === undefined) {
      void hydrate($)
      return next(e)
    }
    if (!viewCache.isCondensed || e.props.isErrored) return next(e)

    return <Box />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [v, list, roster, t, now] = await Promise.all([
      read($, view),
      read($, steps),
      read($, agents),
      read($, turn),
      $.clock.now(),
    ])
    viewCache = v
    stepsCache = list
    if (ticker === null && (t?.isWorking || roster.some(a => isLive(a.status)))) {
      isSettled = false
      startTicker($)
    }

    const hasSteps = list.length > 0
    const hasAgents = roster.length > 0
    if (v.isHidden || e.props.hasSurvey || (!hasSteps && !hasAgents)) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns - 2)
    const working = list.find(s => s.status === 'in_progress')
    const done = list.filter(s => s.status === 'completed').length
    const total = list.length
    const ratio = total === 0 ? 0 : done / total
    const liveAgents = roster.filter(a => isLive(a.status)).length
    const isTurnOver = !e.props.isWorking && !(t?.isWorking ?? false)
    const isWorking = !isTurnOver || liveAgents > 0
    const since = t ? (isWorking ? now : (t.endedAt ?? now)) - t.startedAt : 0

    const left = total - done
    const summary = [
      hasSteps ? `${total} step${total === 1 ? '' : 's'}` : '',
      hasAgents ? `${roster.length} agent${roster.length === 1 ? '' : 's'}` : '',
      t && t.calls > 0 ? `${t.calls} tool call${t.calls === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    let badge: string
    let badgeColor: string
    let message: string
    if (t?.isAsking) {
      badge = '‖ Needs you'
      badgeColor = 'warning'
      message = 'Claude is asking you a question'
    } else if (isWorking) {
      badge = working ? '▶ Working' : '▶ Thinking'
      badgeColor = 'claude'
      message =
        (t ? waveMessage(roster, t.startedAt) : undefined) ??
        (isTurnOver
          ? `Waiting for ${liveAgents} agent${liveAgents === 1 ? '' : 's'}`
          : working
            ? (working.activeForm ?? working.title)
            : 'Working out the next step')
    } else if (t?.reason === 'error') {
      badge = '✗ Failed'
      badgeColor = 'error'
      message = 'The turn ended on an error'
    } else if (t?.reason === 'aborted') {
      badge = '⊘ Stopped'
      badgeColor = 'warning'
      message = 'You interrupted the turn'
    } else if (t?.needsReply) {
      badge = '‖ Needs you'
      badgeColor = 'warning'
      message = 'Claude asked you something'
    } else if (hasSteps && left > 0) {
      badge = '‖ Needs you'
      badgeColor = 'warning'
      message = `Stopped with ${left} step${left === 1 ? '' : 's'} left; reply to continue`
    } else {
      badge = hasSteps ? '✔ All done' : '✔ Done'
      badgeColor = 'success'
      message = summary || 'Finished'
    }
    const clock = t ? (isWorking ? elapsed(since) : `took ${elapsed(since)}`) : ''
    const headRoom = width - 2 - badge.length - 2 - clock.length - 3

    if (v.isCollapsed && !isWorking) {
      return (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={badgeColor} inverse bold>
              {` ${badge} `}
            </Text>
            <Text bold wrap="truncate-end">
              {clip(message, Math.max(4, headRoom - 9))}
            </Text>
            <Box flexGrow={1} />
            {width < 45 ? null : <Text dimColor>{clock}</Text>}
            <Button
              key="expand"
              hotkey="s"
              label="Show"
              onPress={() => {
                void setView($, cur => ({ ...cur, isCollapsed: false }))
              }}
            />
          </Box>
        </Box>
      )
    }

    // Border 2, header 1, progress line; the agents header carries a one-row margin under steps.
    const chromeRows = 3 + (hasSteps ? 1 : 0) + (hasAgents ? (hasSteps ? 2 : 1) : 0)
    const guaranteedSteps = hasSteps ? 1 : 0
    const wantedAgents = Math.min(roster.length, MAX_AGENTS)
    // The activity line goes first when the band is short of rows.
    const showActivity =
      isWorking &&
      working !== undefined &&
      t?.lastTool !== undefined &&
      chromeRows + 1 + guaranteedSteps + wantedAgents <= e.props.maxRows
    const fixedRows = chromeRows + (showActivity ? 1 : 0)
    const agentRoom = Math.max(0, e.props.maxRows - fixedRows - guaranteedSteps)
    const shownAgents = Math.min(roster.length, MAX_AGENTS, agentRoom)
    const isAgentsCut = shownAgents < roster.length
    const stepRoom = Math.max(1, e.props.maxRows - (fixedRows + shownAgents))
    let shown: Step[] = list
    let folded = 0
    let tailHidden = 0
    if (list.length > stepRoom) {
      const nowIndex = list.findIndex(s => s.status === 'in_progress')
      const firstOpen = Math.max(
        0,
        list.findIndex(s => s.status !== 'completed'),
      )
      const anchor = nowIndex >= 0 ? nowIndex : firstOpen
      if (stepRoom === 1) {
        shown = list.slice(anchor, anchor + 1)
      } else {
        const keepFrom = Math.max(0, Math.min(anchor, list.length - stepRoom + 1))
        folded = keepFrom
        let room = stepRoom - (folded > 0 ? 1 : 0)
        if (keepFrom + room < list.length) room -= 1
        // No room for both notes: the tail note stays, the fold note goes.
        if (room < 1) {
          room = 1
          folded = 0
        }
        shown = list.slice(keepFrom, keepFrom + room)
        tailHidden = list.length - (keepFrom + shown.length)
      }
    }

    const wordWidth = 8
    const barWidth = Math.max(6, Math.min(20, Math.floor(width / 4)))
    const titleWidth = Math.max(8, width - 2 - barWidth - wordWidth - 6)

    const firstPending = list.findIndex(x => x.status === 'pending')
    const stepRow = (s: Step, index: number) => {
      const isDone = s.status === 'completed'
      const isNow = s.status === 'in_progress'
      const mark = isDone ? '✔' : isNow ? '‖' : '○'
      const word = isDone
        ? 'Done'
        : isNow
          ? 'Working'
          : index === firstPending
            ? 'Next'
            : 'Up next'
      const fill = isDone ? 1 : isNow ? 0.5 : 0
      const color = isDone ? 'success' : isNow ? 'claude' : 'subtle'

      return (
        <Box key={s.id} flexDirection="row" gap={1} height={1} overflow="hidden">
          <Box width={1}>
            <Text color={color}>{mark}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Text bold={isNow} dimColor={!isNow && !isDone} wrap="truncate-end">
              {clip(s.title, titleWidth)}
            </Text>
          </Box>
          <Box width={barWidth}>
            <Text color={color} dimColor={!isDone && !isNow}>
              {bar(fill, barWidth)}
            </Text>
          </Box>
          <Box width={wordWidth}>
            <Text color={color} dimColor={!isNow && !isDone}>
              {word}
            </Text>
          </Box>
        </Box>
      )
    }

    const agentRows = sortAgents(roster).slice(0, isAgentsCut ? Math.max(0, shownAgents - 1) : shownAgents)
    const live = liveAgents
    const tokenTotal = roster.reduce((n, a) => n + (a.tokens ?? 0), 0)
    const showKind = width >= 70
    const showTime = width >= 50
    const agentTitleWidth = Math.max(
      8,
      width - 2 - 8 - 9 - 8 - (showKind ? 20 + 9 : 0) - (showTime ? 7 : 0),
    )

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={badgeColor} inverse bold>
            {` ${badge} `}
          </Text>
          <Text bold wrap="truncate-end">
            {clip(message, Math.max(4, headRoom))}
          </Text>
          <Box flexGrow={1} />
          <Text dimColor>{clock}</Text>
        </Box>
        {hasSteps && (
          <Box flexDirection="row" gap={1}>
            <Text dimColor wrap="truncate-end">
              {working ? `Step ${list.indexOf(working) + 1} of ${total}` : `${done} of ${total} steps`}
            </Text>
            <Text color={done === total ? 'success' : 'claude'}>{bar(ratio, Math.max(6, width - 18 - 6 - 6))}</Text>
            <Text color={done === total ? 'success' : 'claude'} bold>
              {`${Math.round(ratio * 100)}%`.padStart(4)}
            </Text>
          </Box>
        )}
        {folded > 0 && (
          <Text dimColor wrap="truncate-end">
            {`  ${folded} earlier step${folded === 1 ? '' : 's'}`}
          </Text>
        )}
        {shown.flatMap(s =>
          showActivity && s === working
            ? [
                stepRow(s, list.indexOf(s)),
                <Text key={`${s.id}:activity`} dimColor wrap="truncate-end">
                  {`   ↳ ${clip(t?.lastTool ?? '', width - 7)}`}
                </Text>,
              ]
            : [stepRow(s, list.indexOf(s))],
        )}
        {tailHidden > 0 && (
          <Text dimColor wrap="truncate-end">
            {`  +${tailHidden} more step${tailHidden === 1 ? '' : 's'}`}
          </Text>
        )}
        {hasAgents && (
          <Box flexDirection="row" gap={1} marginTop={hasSteps ? 1 : 0}>
            <Text bold>Agents</Text>
            <Text dimColor wrap="truncate-end">
              {live > 0 ? `${live} running · ${roster.length - live} finished` : `${roster.length} finished`}
              {tokenTotal > 0 ? ` · ${tokensOf(tokenTotal)}` : ''}
            </Text>
          </Box>
        )}
        {agentRows.map(a => {
          const alive = isLive(a.status)
          const color =
            a.status === 'failed' || a.status === 'killed'
              ? 'error'
              : alive
                ? 'claude'
                : 'success'
          const mark = alive ? '‖' : a.status === 'completed' ? '✔' : '✗'
          const model = a.modelId ?? a.model
          const kind = clip(`${shortType(a.type)}${model ? `/${shortModel(model)}` : ''}`, 20)
          const time = elapsed((a.endedAt ?? now) - a.startedAt)
          const role = roleOf(a)
          const prefix = role === 'agent' || agentTitleWidth < 24 ? '' : `${role} · `

          return (
            <Box key={a.id} flexDirection="row" gap={1} height={1} overflow="hidden">
              <Box width={1}>
                <Text color={color}>{mark}</Text>
              </Box>
              <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
                {prefix ? <Text dimColor>{prefix}</Text> : null}
                <Text bold={alive} dimColor={!alive} wrap="truncate-end">
                  {clip(a.description, Math.max(4, agentTitleWidth - prefix.length))}
                </Text>
              </Box>
              {showKind ? (
                <Box width={20}>
                  <Text dimColor>{kind}</Text>
                </Box>
              ) : null}
              <Box width={8}>
                <Text color={color} dimColor={!alive}>
                  {agentWord(a.status)}
                </Text>
              </Box>
              {showTime ? (
                <Box width={7}>
                  <Text dimColor>{time}</Text>
                </Box>
              ) : null}
              <Box width={9}>
                <Text dimColor>{tokensOf(a.tokens ?? 0)}</Text>
              </Box>
              {showKind ? (
                <Box width={9}>
                  <Text dimColor>{`${a.calls} call${a.calls === 1 ? '' : 's'}`}</Text>
                </Box>
              ) : null}
            </Box>
          )
        })}
        {isAgentsCut && shownAgents > 0 && (
          <Text dimColor wrap="truncate-end">
            {`  +${roster.length - agentRows.length} more · /progress agents`}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'progress-agents' }, async ($, e) => {
    const roster = await read($, agents)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(10, e.props.bodyColumns)
    if (roster.length === 0) return <Text dimColor>No agents yet.</Text>

    return (
      <Box flexDirection="column">
        {sortAgents(roster).map((a, i) => {
          const role = roleOf(a)
          const head = role === 'agent' ? a.description : `${role} · ${a.description}`
          const model = a.modelId ?? a.model
          const fullKind = [a.type, model].filter(Boolean).join(' · ')
          const kind =
            fullKind.length <= width ? fullKind : [a.type, model ? shortModel(model) : ''].filter(Boolean).join(' · ')
          const meta = [
            agentWord(a.status),
            elapsed((a.endedAt ?? now) - a.startedAt),
            `${a.calls} call${a.calls === 1 ? '' : 's'}`,
            tokensOf(a.tokens ?? 0),
          ].join(' · ')

          return (
            <Box key={a.id} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
              <Text bold wrap="truncate-end">
                {clip(head, width)}
              </Text>
              <Text dimColor wrap="truncate-end">
                {clip(kind, width)}
              </Text>
              <Text dimColor wrap="truncate-end">
                {clip(meta, width)}
              </Text>
              {a.activity ? (
                <Text dimColor wrap="truncate-end">
                  {clip(`↳ ${a.activity}`, width)}
                </Text>
              ) : null}
              {a.lastText ? (
                <Text dimColor wrap="truncate-end">
                  {clip(`“${a.lastText}”`, width)}
                </Text>
              ) : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}

/** Write the view and keep the render cache in step. */
async function setView($: EngineInterface, fn: (v: View) => View) {
  viewCache = await update($, view, fn)
  return viewCache
}

/** Write the steps and keep the render cache in step. */
async function setSteps($: EngineInterface, fn: (list: Step[]) => Step[]) {
  stepsCache = await update($, steps, fn)
  return stepsCache
}

/** Fill the render caches from the atoms, once per load. */
async function hydrate($: EngineInterface) {
  hydrating ??= Promise.all([read($, view), read($, steps)]).then(
    ([v, list]) => {
      viewCache ??= v
      stepsCache ??= list
      $.ui.invalidate('ui.render')
    },
    () => {
      hydrating = null
    },
  )
  return hydrating
}

function startTicker($: EngineInterface) {
  stopTicker()
  ticker = $.clock.every(TICK_MS, () => {
    void tick($)
  })
}

function stopTicker() {
  ticker?.cancel()
  ticker = null
}

/** Toast and speak, at most once per kind per ALERT_MS. */
function notify($: EngineInterface, kind: 'fail' | 'ask', toast: string, speech: string, now: number) {
  if (now - lastAlertAt[kind] < ALERT_MS) return
  lastAlertAt[kind] = now
  $.ui.toast(toast)
  void $.audio.speak(speech).catch(() => {})
}

/** One tool call by a subagent; a call from an agent with no row yet adds one. */
async function recordAgentCall($: EngineInterface, id: string, activity: string) {
  const now = await $.clock.now()
  await update($, agents, list =>
    list.some(a => a.id === id)
      ? list.map(a =>
          a.id !== id
            ? a
            : isLive(a.status)
              ? { ...a, calls: a.calls + 1, activity }
              : // A resumed agent fires no agent.spawn: its first tool call revives the row.
                { ...a, calls: a.calls + 1, activity, status: 'running', endedAt: undefined, missingSince: undefined },
        )
      : trimAgents([
          ...list,
          { id, description: id, type: 'agent', status: 'running', startedAt: now, calls: 1, tokens: 0, activity },
        ]),
  )
}

async function tick($: EngineInterface) {
  await refreshAgents($)
  $.ui.invalidate('ui.render')
  await settleIfIdle($)
}

async function settleIfIdle($: EngineInterface) {
  if (isSettled) return
  // Claimed before the first await, so concurrent callers never settle twice.
  isSettled = true
  const gen = turnGen
  let isIdle = false
  try {
    const [t, roster] = await Promise.all([read($, turn), read($, agents)])
    isIdle = t !== null && !t.isWorking && !roster.some(a => isLive(a.status)) && gen === turnGen
  } finally {
    if (!isIdle) isSettled = false
  }
  if (isIdle) await settle($, gen)
}

/** The turn and its agents are done: stop the clock, arm the collapse, look for a question. */
async function settle($: EngineInterface, gen: number) {
  if (gen !== turnGen) return
  stopTicker()
  collapseTimer?.cancel()
  collapseTimer = $.clock.after(COLLAPSE_MS, () => {
    void setView($, v => ({ ...v, isCollapsed: true }))
  })
  const t = await read($, turn)
  if (gen !== turnGen || t?.reason !== 'answer' || t.endedAt === undefined) return
  const endedAt = t.endedAt
  const text = t.finalText ?? ''
  if (endsInQuestion(text)) {
    await update($, turn, cur => (cur?.endedAt === endedAt ? { ...cur, needsReply: true } : cur))
  } else if (text.trim().length > 0) {
    void classifyReply($, text, endedAt)
  }
}

/** Ask the small classifier whether a finished answer asks the person something. */
async function classifyReply($: EngineInterface, text: string, endedAt: number) {
  if (classifiedAt === endedAt) return
  classifiedAt = endedAt
  let kind: string | undefined
  try {
    kind = await $.model.classify(text.slice(-2000), ['question', 'statement'])
  } catch {
    kind = 'statement'
  }
  if (kind !== 'question') return
  await update($, turn, cur => (cur?.endedAt === endedAt ? { ...cur, needsReply: true } : cur))
}

function roleOf(row: AgentRow): Role {
  const d = row.description
  if (/\b(scout|research|investigat)/i.test(d)) return 'scout'
  if (/\breview/i.test(d)) return 'reviewer'
  if (/\b(implement|build)/i.test(d)) return 'implementer'
  if (/\bfix/i.test(d)) return 'fixer'
  if (/\bscribe|dictat/i.test(d)) return 'scribe'
  const tier = shortModel(row.modelId ?? row.model ?? '')
  if (row.type === 'Explore' && tier === 'sonnet') return 'scout'
  if (row.type === 'general-purpose' && tier === 'opus') return 'implementer'
  if (tier === 'haiku') return 'scribe'
  return 'agent'
}

const sortAgents = (list: AgentRow[]): AgentRow[] =>
  [...list].sort(
    (a, b) =>
      Number(isLive(b.status)) - Number(isLive(a.status)) ||
      ROLE_ORDER.indexOf(roleOf(a)) - ROLE_ORDER.indexOf(roleOf(b)) ||
      b.startedAt - a.startedAt,
  )

/** `Scouting: 2 of 5 scouts done`, for the role with the most live agents started since `since`. */
const waveMessage = (roster: AgentRow[], since: number): string | undefined => {
  const wave = roster.filter(a => a.startedAt >= since)
  let top: Role | undefined
  let most = 0
  for (const role of ROLE_ORDER) {
    const n = wave.filter(a => isLive(a.status) && roleOf(a) === role).length
    if (n > most) {
      top = role
      most = n
    }
  }
  if (top === undefined) return undefined
  const mine = wave.filter(a => roleOf(a) === top)
  const finished = mine.filter(a => !isLive(a.status)).length
  const [label, plural] = ROLE_LABEL[top]
  return `${label}: ${finished} of ${mine.length} ${plural} done`
}

/** Pull live statuses from the engine's roster into ours; writes only on a change. */
async function refreshAgents($: EngineInterface) {
  const snapshotAt = await $.clock.now()
  const known = await $.agent.list()
  const now = await $.clock.now()
  const current = await read($, agents)
  if (sameAgents(current, reconcileAgents(current, known, snapshotAt, now))) return
  await update($, agents, list => reconcileAgents(list, known, snapshotAt, now))
}

const reconcileAgents = (
  list: AgentRow[],
  known: readonly AgentInfo[],
  snapshotAt: number,
  now: number,
): AgentRow[] => {
  const byId = new Map(list.map(a => [a.id, a] as const))
  for (const info of known) {
    const cur = byId.get(info.id)
    if (cur) {
      const isRevived = isLive(info.status) && !isLive(cur.status)
      // Ended while the list was in flight: the list is the stale side.
      if (isRevived && cur.endedAt !== undefined && cur.endedAt >= snapshotAt) continue
      const ended = isRevived ? undefined : !isLive(info.status) && isLive(cur.status) ? now : cur.endedAt
      byId.set(info.id, { ...cur, status: info.status, endedAt: ended, missingSince: undefined })
    } else if (isLive(info.status)) {
      byId.set(info.id, {
        id: info.id,
        description: info.description || info.name || info.type,
        type: info.type,
        status: info.status,
        startedAt: now,
        calls: 0,
        tokens: 0,
      })
    }
  }
  const listed = new Set(known.map(info => info.id))
  for (const a of list) {
    if (listed.has(a.id) || !isLive(a.status)) continue
    const since = a.missingSince ?? now
    byId.set(
      a.id,
      now - since > MISSING_MS
        ? { ...a, status: 'completed', endedAt: now, missingSince: undefined }
        : { ...a, missingSince: since },
    )
  }
  return trimAgents([...byId.values()])
}

const sameAgents = (a: AgentRow[], b: AgentRow[]): boolean =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.id === b[i]?.id &&
      x.status === b[i]?.status &&
      x.endedAt === b[i]?.endedAt &&
      x.missingSince === b[i]?.missingSince,
  )

const trimAgents = (list: AgentRow[]): AgentRow[] => {
  const live = list.filter(a => isLive(a.status))
  const finished = list
    .filter(a => !isLive(a.status))
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  return [...live, ...finished.slice(0, Math.max(0, MAX_AGENTS - live.length))]
}

const shortModel = (model: string): string => {
  const m = model.toLowerCase()
  for (const name of ['haiku', 'sonnet', 'opus', 'fable', 'mythos']) {
    if (m.includes(name)) return name
  }
  return clip(model, 10)
}
