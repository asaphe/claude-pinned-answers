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

const REPLY = 'Some lead-in.\n**Answer:** yes, keep it open.\n- reason one\n- reason two'

test('a question answered with an Answer line is pinned in full, and ack clears it', async ($, on) => {
  const opened: unknown[] = []
  on('command.register', () => ({ value: { command: 'pins' } }))
  on('ui.open', (_, e) => (opened.push(e), { value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'should we keep this session open?' } as never)
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(opened.length).toBe(1)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /keep it open/ }))?.text).toContain('reason two')
  expect((await ui.find({ type: 'Text', text: /should we keep/ }))?.text).toContain('should we keep this session open?')
  await ui.unmount()

  await $.prompt.submit({ text: 'ack' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nothing pinned.')
  await ui.unmount()
})

test('a non-question or an n/a answer pins nothing', async ($, on) => {
  on('command.register', () => ({ value: { command: 'pins' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'build the pane' } as never)
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.prompt.submit({ text: 'is it done?' } as never)
  await $.turn.complete({ answer: '**Answer:** n/a', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nothing pinned.')
  await ui.unmount()
})
