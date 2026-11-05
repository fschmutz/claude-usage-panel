import { expect, mock, test } from 'claude-code/testing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubEnv(on: any) {
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/Users/me/claude-usage-panel' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '' } }))
}

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()

const HINT = (columns: number, hint = '? for shortcuts') =>
  ({
    plugin: 'usage-footer',
    component: 'PromptHint',
    requestId: 'hint',
    viewport: { columns, rows: 40 },
    props: { hint, isDraft: false, isWorking: false },
  }) as const

const MODES = (columns: number, modes: string[] = []) =>
  ({
    plugin: 'usage-footer',
    component: 'SessionMode',
    requestId: 'modes',
    viewport: { columns, rows: 40 },
    props: { modes },
  }) as const

test('the footer is a live HUD that narrows with the terminal', async ($, on) => {
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine hint line</Text>
  })
  mock.store(on)
  stubEnv(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: Date.now(),
      context: { tokens: 124_000, window: 200_000, percent: 62 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: inHours(3.1) },
        { kind: 'seven_day', percentUsed: 41, resetsAt: inHours(50) },
      ],
      cost: { usd: 3.42 },
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const wide = await $.ui.mount({ ...HINT(180), surface: 'terminal' })
  expect((await wide.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.text).toBe('Opus 5.5')
  expect((await wide.find({ type: 'Text', text: /claude-usage-panel/ }))?.text).toContain('claude-usage-panel')
  expect((await wide.find({ type: 'Text', text: /⎇ main/ }))?.text).toContain('main')
  expect(await wide.find({ type: 'Text', text: /engine hint line|for shortcuts/ })).toBeUndefined()
  expect(await wide.find({ type: 'Text', text: /^week $/ })).toBeUndefined()
  await wide.unmount()

  const right = await $.ui.mount({ ...MODES(180, ['focus']), surface: 'terminal' })
  expect((await right.find({ type: 'Text', text: /^focus$/ }))?.text).toBe('focus')
  expect((await right.find({ type: 'Text', text: /^ 62%$/ }))?.text).toBe(' 62%')
  expect((await right.find({ type: 'Text', text: /^session $/ }))?.text).toBe('session ')
  expect((await right.find({ type: 'Text', text: /^week $/ }))?.text).toBe('week ')
  expect((await right.find({ type: 'Text', text: /\$3\.42/ }))?.text).toContain('$3.42')
  await right.unmount()

  const narrow = await $.ui.mount({ ...HINT(60), surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /claude-usage-panel/ })).toBeUndefined()
  expect((await narrow.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.text).toBe('Opus 5.5')
  await narrow.unmount()
  const narrowRight = await $.ui.mount({ ...MODES(90), surface: 'terminal' })
  expect((await narrowRight.find({ type: 'Text', text: /^ 23%$/ }))?.text).toBe(' 23%')
  expect(await narrowRight.find({ type: 'Text', text: /\$3\.42/ })).toBeUndefined()
  await narrowRight.unmount()
})

test('a plan without a 5h window shows no session meter', async ($, on) => {
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine hint line</Text>
  })
  mock.store(on)
  stubEnv(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: Date.now(),
      context: { tokens: 12_000, window: 200_000, percent: 6 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 7, resetsAt: inHours(134) }],
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...MODES(180), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^week $/ }))?.text).toBe('week ')
  expect(await ui.find({ type: 'Text', text: /session/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /–/ })).toBeUndefined()
  await ui.unmount()
})

test('the engine line is recast as pills: mode, agents, unknown pieces kept', async ($, on) => {
  mock.store(on)
  stubEnv(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: Date.now(),
      context: { tokens: 12_000, window: 200_000, percent: 6 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 7, resetsAt: inHours(134) }],
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const hint = '⏵⏵ auto mode on (shift+tab to cycle) · ← 5 agents · ctrl+t to hide tasks'
  const ui = await $.ui.mount({ ...HINT(200, hint), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^⏵⏵ auto$/ }))?.text).toBe('⏵⏵ auto')
  expect((await ui.find({ type: 'Text', text: /^5 agents ←$/ }))?.text).toBe('5 agents ←')
  expect((await ui.find({ type: 'Text', text: /^ctrl\+t to hide tasks$/ }))?.text).toBe('ctrl+t to hide tasks')
  expect(await ui.find({ type: 'Text', text: /shift\+tab/ })).toBeUndefined()
  await ui.unmount()

  const narrow = await $.ui.mount({ ...HINT(50, hint), surface: 'terminal' })
  expect((await narrow.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.text).toBe('Opus 5.5')
  await narrow.unmount()
})

test('a window crossing 90% raises a toast', async ($, on) => {
  const toasts: string[] = []
  mock.store(on)
  stubEnv(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: Date.now(),
      context: { tokens: 12_000, window: 200_000, percent: 6 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 92, resetsAt: inHours(50) }],
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(toasts).toEqual(['Weekly limit at 92%'])
  const ui = await $.ui.mount({ ...MODES(180), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^ 92%$/ }))?.text).toBe(' 92%')
  await ui.unmount()
})
