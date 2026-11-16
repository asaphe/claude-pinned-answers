import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pinned-answers',
  component: 'Pane',
  requestId: 'pinned-answers',
  props: {
    title: '📌 Pinned answers',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const REPLY = [
  'Some lead-in.',
  '**Answer:** yes, keep it open.',
  '',
  '## Details',
  '- reason one',
  '',
  '## 🔴 ACTION NEEDED: restart the pods?',
].join('\n')

function wire(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const opened: { columns?: number; rows?: number }[] = []
  const closed: unknown[] = []
  on('command.register', () => ({ value: { command: 'pins' } }))
  on('ui.open', (_, e) => (opened.push(e), { value: { isPlaced: true } }))
  on('ui.close', (_, e) => (closed.push(e), { value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { opened, closed }
}

const done = (answer: string, turnId: string) =>
  ({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as const

test('only the Answer paragraph is pinned, and ack closes the pane', async ($, on) => {
  const { opened, closed } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'should we keep this session open?' } as never)
  await $.turn.complete(done(REPLY, 't1'))

  expect(opened.length).toBe(1)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /keep it open/ }))?.text).toBe('yes, keep it open.')
  expect(await ui.find({ type: 'Text', text: /reason one|ACTION NEEDED/ })).toBeUndefined()
  await ui.unmount()

  await $.prompt.submit({ text: 'ack' } as never)
  expect(closed.length).toBeGreaterThan(0)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nothing pinned.')
  await ui.unmount()

  // The ack turn's own completion reopens nothing.
  await $.turn.complete(done('ok, cleared', 't2'))
  expect(opened.length).toBe(1)
})

test('the pane is capped in size and a long answer is cut', async ($, on) => {
  const { opened } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 8; i++) {
    await $.prompt.submit({ text: `question ${i}?` } as never)
    await $.turn.complete(done(`**Answer:** ${'x'.repeat(400)}\nline2\nline3\nline4`, `t${i}`))
  }
  const last = opened[opened.length - 1]
  expect(last.columns).toBeLessThanOrEqual(72)
  expect(last.rows).toBeLessThanOrEqual(14)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = (await ui.find({ type: 'Text', text: /^x+/ }))?.text ?? ''
  expect(t.length).toBeLessThanOrEqual(281)
  expect(t.endsWith('…')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /older/ }))?.text).toContain('+3 older')
  await ui.unmount()
})

test('non-questions, machine prompts and n/a pin nothing', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'build the pane' } as never)
  await $.turn.complete(done(REPLY, 't1'))
  await $.prompt.submit({ text: '<task-notification>did it finish?</task-notification>' } as never)
  await $.turn.complete(done(REPLY, 't2'))
  await $.prompt.submit({ text: 'is it done?' } as never)
  await $.turn.complete(done('**Answer:** n/a', 't3'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nothing pinned.')
  await ui.unmount()
})
