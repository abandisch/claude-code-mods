import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'progress-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

test('task list calls become steps in the band', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({
    result: { task: { id: e.subject === 'Check the balance' ? 't1' : 't2', subject: e.subject } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'Check the balance', description: 'x', activeForm: 'Checking the balance' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Upload the photo', description: 'y', activeForm: 'Uploading the photo' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 't1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 't2', status: 'in_progress' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Step 2 of 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Check the balance/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Uploading the photo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /50%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a tool row condenses to one line with a short label', async $ => {
  await $.command.run({ command: 'progress', args: 'quiet' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'progress-band',
      surface,
      component: 'ToolUse',
      requestId: 'call-1',
      props: {
        tool_use_id: 'call-1',
        tool: 'Bash',
        input: { command: 'pnpm test --run', description: 'Run the test suite' },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
        output: { stdout: 'ok', stderr: '' },
      },
    })
    const row = await ui.find({ type: 'Text', text: /Bash/ })
    expect(row?.text).toContain('Run the test suite')
    expect(row?.text).not.toContain('pnpm test')
    await ui.unmount()
  }
})

test("the mod's own steps tool plans and advances the list", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const plan = await $.tool.call({
    tool: 'mcp__progress-band__steps',
    plan: [
      { title: 'Check the balance', activeForm: 'Checking the balance' },
      { title: 'Upload the photo', activeForm: 'Uploading the photo' },
      { title: 'Open the gallery' },
    ],
  })
  expect(plan.deny).toBeUndefined()
  await $.tool.call({ tool: 'mcp__progress-band__steps', step: 1, status: 'in_progress' })
  await $.tool.call({ tool: 'mcp__progress-band__steps', step: 2, status: 'in_progress' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Step 2 of 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Uploading the photo/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /33%/ })).toBeDefined()
  await ui.unmount()
})

const STEPS = 'mcp__progress-band__steps'

const ended = (fields: { answer: string; reason: 'answer' | 'error'; agentId?: string; usage?: { input_tokens: number; output_tokens: number; model: string } }) => ({
  turnId: 't1',
  durationMs: 1000,
  isAborted: false,
  ...fields,
  ...(fields.usage
    ? { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...fields.usage } }
    : {}),
})

test('the steps tool answers with a string', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  await $.tool.call({ tool: STEPS, plan: [{ title: 'Check the balance' }, { title: 'Upload the photo' }] })
  const ran = await $.tool.call({ tool: STEPS, step: 1, status: 'in_progress' })
  expect(typeof ran.result).toBe('string')
  expect(String(ran.result)).toContain('[in_progress]')
})

test('an orchestrate prompt seeds the wave steps', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  const out = await $.skill.prompt({ skill: 'orchestrate', text: 'run a wave' })
  expect(out.text).toBe('run a wave')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Scout the code and facts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Bank the wave and hand off/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 of 9 steps/ })).toBeDefined()
  await ui.unmount()
})

test('agent tokens accumulate across turns', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-4-5' }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.agent.spawn({ prompt: 'look', description: 'Scout mod API surfaces', subagentType: 'Explore' })
  const usage = { input_tokens: 1000, output_tokens: 200, model: 'claude-sonnet-4-5-20250929' }
  await $.turn.complete(ended({ answer: 'Found it.', reason: 'answer', agentId: 'a1', usage }))
  await $.turn.complete(ended({ answer: 'More.', reason: 'answer', agentId: 'a1', usage: { ...usage, input_tokens: 3000, output_tokens: 0 } }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^4\.2k tok$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /scout ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Explore\/sonnet/ })).toBeDefined()
  await ui.unmount()
})

test('an answer ending in a question needs the person', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: [] }))
  await $.tool.call({ tool: STEPS, plan: [{ title: 'Check the balance' }, { title: 'Upload the photo' }] })
  await $.turn.complete(ended({ answer: 'Shall I proceed?\n\n🔊 Shall I proceed, sir?', reason: 'answer' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /asked you something/ })).toBeDefined()
  await ui.unmount()
})

test('a statement the classifier calls a statement reads as done', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const asked: string[] = []
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.classify', (_$, e) => {
    asked.push(e.text)
    return { value: 'statement' }
  })
  on('agent.list', () => ({ value: [] }))
  await $.tool.call({ tool: STEPS, plan: [{ title: 'Check the balance' }] })
  await $.tool.call({ tool: STEPS, step: 1, status: 'completed' })
  await $.turn.complete(ended({ answer: 'Done.', reason: 'answer' }))
  await clock.settle()
  expect(asked).toEqual(['Done.'])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  expect(await ui.find({ type: 'Text', text: /Done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeUndefined()
  await ui.unmount()
})

test('the band collapses after 20 s idle and Show expands it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.classify', () => ({ value: 'statement' }))
  on('agent.list', () => ({ value: [] }))
  await $.tool.call({ tool: STEPS, plan: [{ title: 'Check the balance' }] })
  await $.tool.call({ tool: STEPS, step: 1, status: 'completed' })
  await $.turn.complete(ended({ answer: 'All set.', reason: 'answer' }))
  await clock.advance(20_001)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  expect(await ui.find({ type: 'Text', text: /Check the balance/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'expand' })).toBeDefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /Check the balance/ })).toBeDefined()
  await ui.unmount()
})

test('a failed agent is toasted and spoken', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const spoken: string[] = []
  const toasts: string[] = []
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-opus-4-5' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('audio.speak', (_$, e) => {
    spoken.push(e.text)
    return { value: { via: 'system' as const } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.agent.spawn({ prompt: 'build', description: 'Implement the band', subagentType: 'general-purpose' })
  await $.turn.complete(ended({ answer: '', reason: 'error', agentId: 'a1' }))

  expect(spoken).toEqual(['Sir, an agent has failed.'])
  expect(toasts).toEqual(['Agent failed: Implement the band'])
})

test('a live background agent keeps the band working after the turn ends', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag1' }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.classify', () => ({ value: 'statement' }))
  await $.tool.call({ tool: STEPS, plan: [{ title: 'Check the balance' }, { title: 'Upload the photo' }] })
  await $.agent.spawn({ prompt: 'build', description: 'Implement the band', subagentType: 'general-purpose' })
  await $.turn.complete(ended({ answer: 'Started an implementer.', reason: 'answer' }))

  const idle = { ...BAND, surface: 'terminal' as const, props: { ...BAND.props, isWorking: false } }
  let ui = await $.ui.mount(idle)
  expect(await ui.find({ type: 'Text', text: 'Implementing: 0 of 1 implementers done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeUndefined()
  await ui.unmount()

  await $.turn.complete(ended({ answer: 'Found it.', reason: 'answer', agentId: 'ag1' }))
  ui = await $.ui.mount(idle)
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
  await ui.unmount()
})

test('agent type and model fit their column at 100 columns', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const spawned = [
    { agentId: 'g1', model: 'claude-opus-5-5', type: 'general-purpose' },
    { agentId: 'e1', model: 'claude-sonnet-5-5', type: 'Explore' },
    { agentId: 'c1', model: 'claude-haiku-4-5', type: 'claude-code-guide' },
  ]
  on('agent.spawn', (_$, e) => {
    const s = spawned.find(x => x.type === e.subagentType)
    return { agentId: s?.agentId ?? 'x', model: s?.model ?? '' }
  })
  for (const s of spawned) {
    await $.agent.spawn({ prompt: 'go', description: `Run ${s.type}`, subagentType: s.type })
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (const kind of ['general/opus', 'Explore/sonnet', 'guide/haiku']) {
    expect((await ui.find({ type: 'Text', text: kind }))?.text).toBe(kind)
  }
  await ui.unmount()
})

const idleBand = (props: Partial<typeof BAND.props> = {}) => ({
  ...BAND,
  surface: 'terminal' as const,
  props: { ...BAND.props, isWorking: false, ...props },
})

/** Rows the band takes: its border plus each child row and its top margin. */
const rowsOf = (root: { children?: unknown[] }): number =>
  2 +
  (root.children ?? []).reduce<number>((n, child) => {
    if (typeof child !== 'object' || child === null) return n
    const margin = Number((child as { props?: { marginTop?: number } }).props?.marginTop ?? 0)
    return n + 1 + margin
  }, 0)

test('a reply the classifier calls a question needs the person', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.classify', () => ({ value: 'question' }))
  on('agent.list', () => ({ value: [] }))
  await $.tool.call({ tool: STEPS, plan: [{ title: 'Check the balance' }] })
  await $.tool.call({ tool: STEPS, step: 1, status: 'completed' })
  await $.turn.complete(ended({ answer: 'Want me to carry on with the upload.', reason: 'answer' }))
  await clock.settle()

  const ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Claude asked you something' })).toBeDefined()
  await ui.unmount()
})

test('a classifier answer that lands after the next turn starts is dropped', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('agent.list', () => ({ value: [] }))
  on('model.classify', async (_$, e) => {
    if (e.text === 'All set.') return { value: 'statement' }
    await clock.sleep(5000)
    return { value: 'question' }
  })
  await $.tool.call({ tool: STEPS, plan: [{ title: 'Check the balance' }] })
  await $.tool.call({ tool: STEPS, step: 1, status: 'completed' })
  await $.turn.complete(ended({ answer: 'Want me to carry on with the upload.', reason: 'answer' }))
  await clock.advance(1000)
  await $.turn.start({ text: 'next', turnId: 't2' })
  await $.tool.call({ tool: STEPS, plan: [{ title: 'Upload the photo' }] })
  await $.tool.call({ tool: STEPS, step: 1, status: 'completed' })
  await $.turn.complete(ended({ answer: 'All set.', reason: 'answer' }))
  await clock.advance(5000)

  const ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeUndefined()
  await ui.unmount()
})

test('a speech line ending in a question does not count as asking', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const asked: string[] = []
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.classify', (_$, e) => {
    asked.push(e.text)
    return { value: 'statement' }
  })
  on('agent.list', () => ({ value: [] }))
  await $.tool.call({ tool: STEPS, plan: [{ title: 'Check the balance' }] })
  await $.tool.call({ tool: STEPS, step: 1, status: 'completed' })
  await $.turn.complete(ended({ answer: 'Done.\n🔊 Anything else, sir?', reason: 'answer' }))
  await clock.settle()
  expect(asked).toEqual(['Done.\n🔊 Anything else, sir?'])

  const ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeUndefined()
  await ui.unmount()
})

test('the wave header counts finished scouts', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const ids = ['s1', 's2']
  on('agent.spawn', () => ({ agentId: ids.shift() ?? 'x', model: 'claude-sonnet-5-5' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: [] }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({ prompt: 'a', description: 'Scout the hooks', subagentType: 'Explore' })
  await $.agent.spawn({ prompt: 'b', description: 'Scout the types', subagentType: 'Explore' })
  await $.turn.complete(ended({ answer: 'Found it.', reason: 'answer', agentId: 's1' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Scouting: 1 of 2 scouts done' })).toBeDefined()
  await ui.unmount()
})

const stepped = (fields: { agentId: string; turnId?: string; index?: number }) => ({
  turnId: 't1',
  index: 0,
  model: 'claude-opus-5-5',
  messageCount: 3,
  ...fields,
})

const stepResult = (fields: { turnId: string; index: number; tokens: number }) => ({
  turnId: fields.turnId,
  index: fields.index,
  answer: '',
  toolUses: [],
  stopReason: 'tool_use' as const,
  usage: {
    input_tokens: fields.tokens,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model: 'claude-opus-5-5',
  },
})

test('a running agent shows tokens as each step lands', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('turn.step', async function* (_$, e) {
    return stepResult({ turnId: e.turnId, index: e.index, tokens: e.index === 0 ? 1500 : 2500 })
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.agent.spawn({ prompt: 'build', description: 'Build the export mock', subagentType: 'general-purpose' })

  for (const index of [0, 1]) {
    const stream = $.turn.step(stepped({ agentId: 'a1', index }))
    for await (const _chunk of stream) {
      // drain
    }
    await stream.result
  }

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^4\.0k tok$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Working/ })).toBeDefined()
  await ui.unmount()

  // The turn's end reports the same requests summed: nothing is counted twice.
  const usage = { input_tokens: 4000, output_tokens: 0, model: 'claude-opus-5-5' }
  await $.turn.complete(ended({ answer: 'Built.', reason: 'answer', agentId: 'a1', usage }))
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^4\.0k tok$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5\.0k tok$/ })).toBeUndefined()
  await ui.unmount()
})

test('the agents header totals the roster tokens', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const ids = ['a1', 'a2']
  on('agent.spawn', () => ({ agentId: ids.shift() ?? 'x', model: 'claude-sonnet-5-5' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: [] }))
  await $.agent.spawn({ prompt: 'a', description: 'Look at hooks', subagentType: 'Explore' })
  await $.agent.spawn({ prompt: 'b', description: 'Look at types', subagentType: 'Explore' })
  const usage = { input_tokens: 1000, output_tokens: 0, model: 'claude-sonnet-5-5' }
  await $.turn.complete(ended({ answer: 'A.', reason: 'answer', agentId: 'a1', usage }))
  await $.turn.complete(ended({ answer: 'B.', reason: 'answer', agentId: 'a2', usage: { ...usage, input_tokens: 2000 } }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '2 finished · 3.0k tok' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1.0k tok' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2.0k tok' })).toBeDefined()
  await ui.unmount()
})

test('the active step names its latest tool call', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: STEPS, plan: [{ title: 'List the files' }] })
  await $.tool.call({ tool: STEPS, step: 1, status: 'in_progress' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /↳ Bash: List files/ })).toBeDefined()
  await ui.unmount()
})

test('/progress agents opens the pane, which shows each agent in full', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5-20260901' }))
  await $.agent.spawn({ prompt: 'look', description: 'Look at the hooks', subagentType: 'Explore' })
  await $.command.run({ command: 'progress', args: 'agents' })
  expect(opened).toEqual(['progress-agents'])

  const ui = await $.ui.mount({
    plugin: 'progress-band',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'progress-agents',
    props: { bodyColumns: 80 },
  })
  expect(await ui.find({ type: 'Text', text: 'Look at the hooks' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Explore · claude-sonnet-5-5-20260901' })).toBeDefined()
  await ui.unmount()
})

test('/progress with an unknown word answers with its usage', async $ => {
  const out = await $.command.run({ command: 'progress', args: 'sideways' })
  expect(out.text).toBe('Usage: /progress [hide|show|quiet|verbose|clear|agents]')
})

test('narrow bands drop the kind, calls and then the time columns', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ agentId: 'e1', model: 'claude-sonnet-5-5' }))
  await $.agent.spawn({ prompt: 'look', description: 'Look at the hooks', subagentType: 'Explore' })

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 60 } })
  expect(await ui.find({ type: 'Text', text: /Explore\/sonnet/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /calls?$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^0s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
  await ui.unmount()

  ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 40 } })
  expect(await ui.find({ type: 'Text', text: /^0s$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
  await ui.unmount()
})

test('the steps tool draws no transcript rows, and verbose passes rows through', async ($, on) => {
  const passed: string[] = []
  on('ui.render', { component: 'ToolUse' }, (_$, e) => {
    passed.push(e.props.tool)
    return { type: 'Text' as const, children: ['engine row'] }
  })
  const rows = (tool: string, input: Record<string, unknown>) => ({
    plugin: 'progress-band',
    surface: 'terminal' as const,
    requestId: 'call-1',
    props: {
      tool_use_id: 'call-1',
      tool,
      input,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: 'ok',
    },
  })
  for (const component of ['ToolUse', 'ToolResult'] as const) {
    const ui = await $.ui.mount({ ...rows(STEPS, { step: 1, status: 'completed' }), component } as never)
    expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
    await ui.unmount()
  }

  await $.command.run({ command: 'progress', args: 'verbose' })
  const ui = await $.ui.mount({ ...rows('Bash', { command: 'ls', description: 'List files' }), component: 'ToolUse' } as never)
  expect(passed).toEqual(['Bash'])
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓' })).toBeUndefined()
  await ui.unmount()
})

test('AskUserQuestion is toasted and spoken', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const spoken: string[] = []
  const toasts: string[] = []
  on('audio.speak', (_$, e) => {
    spoken.push(e.text)
    return { value: { via: 'system' as const } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: 'Yes' }))
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Proceed?', header: 'Go', options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }], multiSelect: false }],
  } as never)

  expect(toasts).toEqual(['Claude has a question for you'])
  expect(spoken).toEqual(['Sir, Claude has a question for you.'])
})

test('an agent the engine lists as completed lets the band settle', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'Look at the hooks', type: 'Explore', status: 'completed' as const }],
  }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.classify', () => ({ value: 'statement' }))
  await $.agent.spawn({ prompt: 'look', description: 'Look at the hooks', subagentType: 'Explore' })
  await $.turn.complete(ended({ answer: 'All set.', reason: 'answer' }))

  const ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: /Working/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Done/ })).toBeDefined()
  await ui.unmount()
})

test('a live agent missing from the engine list for over 10 s is completed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.classify', () => ({ value: 'statement' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({ prompt: 'look', description: 'Look at the hooks', subagentType: 'Explore' })
  await $.turn.complete(ended({ answer: 'Started it.', reason: 'answer' }))

  let ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
  await ui.unmount()

  await clock.advance(12_000)
  ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Done' })).toBeDefined()
  await ui.unmount()
})

test('two agent failures within 10 s are spoken once', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  const spoken: string[] = []
  const ids = ['f1', 'f2']
  on('agent.spawn', () => ({ agentId: ids.shift() ?? 'x', model: 'claude-opus-5-5' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('audio.speak', (_$, e) => {
    spoken.push(e.text)
    return { value: { via: 'system' as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.agent.spawn({ prompt: 'a', description: 'Fix one', subagentType: 'general-purpose' })
  await $.agent.spawn({ prompt: 'b', description: 'Fix two', subagentType: 'general-purpose' })
  await $.turn.complete(ended({ answer: '', reason: 'error', agentId: 'f1' }))
  await clock.advance(3000)
  await $.turn.complete(ended({ answer: '', reason: 'error', agentId: 'f2' }))

  expect(spoken).toEqual(['Sir, an agent has failed.'])
})

const bashLabel = async ($: Parameters<Parameters<typeof test>[1]>[0], command: string) => {
  const ui = await $.ui.mount({
    plugin: 'progress-band',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'call-1',
    props: { tool_use_id: 'call-1', tool: 'Bash', input: { command }, isRunning: false, isErrored: false, isInterrupted: false, output: 'ok' },
  } as never)
  const text = (await ui.find({ type: 'Text', text: /^Bash/ }))?.text
  await ui.unmount()
  return text
}

test('auth headers and cookies are masked whole', async $ => {
  await $.command.run({ command: 'progress', args: 'quiet' })
  expect(await bashLabel($, 'curl -H "Authorization: Basic dXNlcjpwdw==" https://h/x')).toBe(
    'Bash: curl -H "Authorization=••• https://h/x',
  )
  expect(await bashLabel($, 'curl -H "Authorization: token ghp_abc123" https://h/x')).toBe(
    'Bash: curl -H "Authorization=••• https://h/x',
  )
  expect(await bashLabel($, 'curl -H "Cookie: sid=abc123" https://h/x')).toBe('Bash: curl -H "Cookie: •••" https://h/x')
})

test('tool labels drop secrets, queries and unknown inputs', async $ => {
  await $.command.run({ command: 'progress', args: 'quiet' })
  const label = async (tool: string, input: Record<string, unknown>) => {
    const ui = await $.ui.mount({
      plugin: 'progress-band',
      surface: 'terminal',
      component: 'ToolUse',
      requestId: 'call-1',
      props: { tool_use_id: 'call-1', tool, input, isRunning: false, isErrored: false, isInterrupted: false, output: 'ok' },
    } as never)
    const text = (await ui.find({ type: 'Text', text: new RegExp(`^${tool}`) }))?.text
    await ui.unmount()
    return text
  }
  expect(await label('Bash', { command: 'curl -H "Authorization: Bearer abc123" https://x' })).toBe('Bash: curl -H "Authorization=••• https://x')
  expect(await label('Bash', { command: 'curl -u user:pass https://h/x' })).toBe('Bash: curl -u ••• https://h/x')
  expect(await label('Bash', { command: 'psql postgres://user:pw@db.example.com/app' })).toBe(
    'Bash: psql postgres://•••@db.example.com/app',
  )
  expect(await label('Bash', { command: 'export KEY="abc def"' })).toBe('Bash: export KEY=•••')
  expect(await label('Bash', { command: 'API_KEY=sk-live-1 deploy --token t0k' })).toBe('Bash: API_KEY=••• deploy --token •••')
  expect(await label('WebFetch', { url: 'https://user:pw@example.com/a/b?key=s3cret' })).toBe('WebFetch: https://example.com/a/b')
  expect(await label('mcp__x__y', { secret: 'hunter2' })).toBe('mcp__x__y')
})

test('a short band stays within its rows', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let n = 0
  on('agent.spawn', () => ({ agentId: `a${++n}`, model: 'claude-sonnet-5-5' }))
  await $.tool.call({ tool: STEPS, plan: Array.from({ length: 9 }, (_, i) => ({ title: `Step number ${i + 1}` })) })
  await $.tool.call({ tool: STEPS, step: 5, status: 'in_progress' })
  for (let i = 0; i < 12; i++) {
    await $.agent.spawn({ prompt: 'go', description: `Look at part ${i + 1}`, subagentType: 'Explore' })
  }

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 8 } })
  expect(rowsOf((await ui.drawn()) as never)).toBeLessThanOrEqual(8)
  expect(await ui.find({ type: 'Text', text: 'Step number 5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+12 more · \/progress agents/ })).toBeDefined()
  await ui.unmount()

  ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 20 } })
  expect(rowsOf((await ui.drawn()) as never)).toBeLessThanOrEqual(20)
  expect(await ui.findAll({ type: 'Text', text: /^Look at part/ })).toHaveLength(12)
  expect(await ui.find({ type: 'Text', text: 'Step number 5' })).toBeDefined()
  await ui.unmount()
})

test('before the caches hydrate, tool rows pass through, then condense', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const passed: string[] = []
  on('ui.render', { component: 'ToolUse' }, (_$, e) => {
    passed.push(e.props.tool)
    return { type: 'Text' as const, children: ['engine row'] }
  })
  const bash = {
    plugin: 'progress-band',
    surface: 'terminal' as const,
    component: 'ToolUse' as const,
    requestId: 'call-1',
    props: {
      tool_use_id: 'call-1',
      tool: 'Bash',
      input: { command: 'ls', description: 'List files' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: 'ok',
    },
  }
  let ui = await $.ui.mount(bash as never)
  expect(passed).toEqual(['Bash'])
  await ui.unmount()
  await clock.settle()

  ui = await $.ui.mount(bash as never)
  expect(passed).toEqual(['Bash'])
  expect((await ui.find({ type: 'Text', text: /^Bash/ }))?.text).toBe('Bash: List files')
  await ui.unmount()
})

test('drawing the band restarts the clock for a live agent after a settle', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let listed: { id: string; description: string; type: string; status: 'running' | 'completed' }[] = []
  on('agent.list', () => ({ value: listed }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.classify', () => ({ value: 'statement' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  await $.turn.complete(ended({ answer: 'All set.', reason: 'answer' }))
  await $.tool.call({ tool: 'Read', file_path: '/a/b/c.ts', agentId: 'x1' } as never)
  await clock.settle()
  listed = [{ id: 'x1', description: 'x1', type: 'agent', status: 'running' }]

  let ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
  await ui.unmount()

  listed = [{ id: 'x1', description: 'x1', type: 'agent', status: 'completed' }]
  await clock.advance(2000)
  ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: / ✔ Done / })).toBeDefined()
  await ui.unmount()
})

test('folded steps read as earlier steps, and a tail cut is still counted', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  await $.tool.call({ tool: STEPS, plan: Array.from({ length: 8 }, (_, i) => ({ title: `Step number ${i + 1}` })) })
  await $.tool.call({ tool: STEPS, step: 1, status: 'completed' })
  await $.tool.call({ tool: STEPS, step: 2, status: 'completed' })
  await $.tool.call({ tool: STEPS, step: 4, status: 'in_progress' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 8 } })
  expect(rowsOf((await ui.drawn()) as never)).toBeLessThanOrEqual(8)
  expect(await ui.find({ type: 'Text', text: '3 earlier steps' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Step number 4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+3 more steps' })).toBeDefined()
  await ui.unmount()
})

test('a tool call from a finished agent revives its row', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.classify', () => ({ value: 'statement' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  await $.agent.spawn({ prompt: 'look', description: 'Look at the hooks', subagentType: 'Explore' })
  await $.turn.complete(ended({ answer: 'Found it.', reason: 'answer', agentId: 'a1' }))
  await $.turn.complete(ended({ answer: 'All set.', reason: 'answer' }))

  let ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'Read', file_path: '/a/b/c.ts', agentId: 'a1' } as never)
  await clock.settle()
  ui = await $.ui.mount(idleBand())
  expect(await ui.find({ type: 'Text', text: ' ▶ Thinking ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 running · 0 finished' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
  await ui.unmount()
})
