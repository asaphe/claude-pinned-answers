import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

const SIZING =
  "**Answer:** It's mostly the number of workers, not their size. By the vendor's sizing rule the queue needs about **12 workers**, and we were running **5**. Each worker uses about 40% of its CPU request and half of its memory limit, so none of them was starved for CPU or memory."

function wire(on: On) {
  const opened: { columns?: number; rows?: number }[] = []
  const closed: unknown[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 16, 10, 0) })
  on('command.register', () => ({ value: { command: 'pins' } }))
  on('ui.open', (_, e) => (opened.push(e), { value: { isPlaced: true } }))
  on('ui.close', (_, e) => (closed.push(e), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { opened, closed, clock }
}

const done = (answer: string, turnId: string) =>
  ({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as const

const block = (text: string, uuid: string, agentId?: string) =>
  ({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: `tu-${uuid}`, name: 'Bash', input: {} },
      ],
    },
    door: 'response',
    origin: { kind: 'model', model: 'test-model' },
    uuid,
    ...(agentId ? { agentId } : {}),
  }) as never

test('only the Answer paragraph is pinned, and ack closes the pane', async ($, on) => {
  const { opened, closed } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'should we keep this session open?' } as never)
  await $.turn.complete(done(REPLY, 't1'))

  expect(opened.length).toBe(1)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /keep it open/ }))?.text).toBe('yes, keep it open.')
  expect(await ui.find({ type: 'Text', text: /reason one|ACTION NEEDED/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /ack clears all/ }))?.text).toContain('next prompt clears these in 1m')
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

test('an Answer written mid-turn pins before the turn ends', async ($, on) => {
  const { opened } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Typed while a long turn runs: the engine stamps the running turn's id.
  await $.prompt.submit({ text: 'is the queue healthy?', turnId: 'long', wait: false } as never)
  await $.session.append(block('Checking the workers.', 'r1'))
  expect(opened.length).toBe(0)
  await $.session.append(block('**Answer:** yes, all 5 workers are up.\n\nDetails follow.', 'r2'))
  expect(opened.length).toBe(1)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /workers are up/ }))?.text).toBe('yes, all 5 workers are up.')
  await ui.unmount()

  // A later Answer to the same question in the same turn replaces the pin, and a subagent's never pins.
  await $.session.append(block('**Answer:** no, 42 jobs failed on the client side.', 'r3'))
  await $.session.append(block('**Answer:** from a subagent', 'r4', 'agent-1'))
  // The turn's final text has no Answer line; the pin stays.
  await $.turn.complete(done('Done with the long turn.', 'long'))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const answers = await ui.findAll({ type: 'Text', text: /jobs failed|workers are up|subagent/ })
  expect(answers.map(a => a.text)).toEqual(['no, 42 jobs failed on the client side.'])
  await ui.unmount()
})

test('markdown renders as styles and a long answer is cut at a sentence', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'why did jobs fail?' } as never)
  await $.session.append(block(SIZING, 'r1'))
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const line = await ui.find({ type: 'Text', text: /number of workers/ })
  expect(line?.text).toBe(
    "It's mostly the number of workers, not their size. By the vendor's sizing rule the queue needs about 12 workers, and we were running 5. …",
  )
  const bold = await ui.findAll({ type: 'Text', text: /^(12 workers|5)$/ })
  expect(bold.map(b => b.props.weight)).toEqual(['bold', 'bold'])
  await ui.unmount()

  await $.prompt.submit({ text: 'what changed?' } as never)
  await $.session.append(block('**Answer:** `worker` scaled, see **below**:\n- replicas 5 → 12\n* limits _kept_', 'r2'))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await ui.findAll({ type: 'Text' })
  expect(all.some(t => /\*\*|`/.test(t.text))).toBe(false)
  expect((await ui.find({ type: 'Text', text: /^worker$/ }))?.props.color).toBe('permission')
  expect((await ui.find({ type: 'Text', text: /replicas 5/ }))?.text).toBe('• replicas 5 → 12')
  expect((await ui.find({ type: 'Text', text: /limits/ }))?.text).toBe('• limits _kept_')
  await ui.unmount()
})

test('your next prompt starts a 60s clear; time alone and ack behave as before', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'is it up?' } as never)
  await $.turn.complete(done('**Answer:** yes, it is up.', 't1'))

  // No prompt: the pin never times out.
  await clock.advance(10 * 60_000)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /it is up/ })).toBeDefined()
  await ui.unmount()

  await $.prompt.submit({ text: 'now deploy it' } as never)
  await $.turn.complete(done('Deployed.', 't2'))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /is it up/ }))?.text).toMatch(/· clears \d\d:\d\d$/)
  await ui.unmount()
  await clock.advance(59_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /it is up/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(2_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nothing pinned.')
  await ui.unmount()

  // A pin that lands after the prompt waits for the next one; ack still clears at once.
  await $.prompt.submit({ text: 'what version?' } as never)
  await $.turn.complete(done('**Answer:** v2.4.1.', 't3'))
  await clock.advance(5 * 60_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /v2\.4\.1/ })).toBeDefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'ack' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nothing pinned.')
  await ui.unmount()
})

test('a question the turn did not answer stays armed for the next turn', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'which node is it on?', turnId: 'busy', wait: false } as never)
  await $.turn.complete(done('Finished the earlier task.', 'busy'))
  await $.turn.complete(done('**Answer:** node worker-3.', 'next'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /worker-3/ }))?.text).toBe('node worker-3.')
  await ui.unmount()
})

test('the pane is capped in size and a long answer is cut', async ($, on) => {
  const { opened } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 8; i++) {
    await $.prompt.submit({ text: `question ${i}?` } as never)
    await $.turn.complete(done(`**Answer:** ${'x'.repeat(400)}\nline2\nline3\nline4`, `t${i}`))
  }
  const last = opened[opened.length - 1]
  expect(last?.columns).toBeLessThanOrEqual(72)
  expect(last?.rows).toBeLessThanOrEqual(14)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = (await ui.find({ type: 'Text', text: /^x+/ }))?.text ?? ''
  expect(t.length).toBeLessThanOrEqual(242)
  expect(t.endsWith('…')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /older/ }))?.text).toContain('+3 older')
  await ui.unmount()
})

test('non-questions, machine prompts, unbolded and n/a lines pin nothing', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'build the pane' } as never)
  await $.turn.complete(done(REPLY, 't1'))
  await $.prompt.submit({ text: '<task-notification>did it finish?</task-notification>' } as never)
  await $.turn.complete(done(REPLY, 't2'))
  await $.prompt.submit({ text: 'is it done?' } as never)
  await $.turn.complete(done('**Answer:** n/a', 't3'))
  await $.prompt.submit({ text: 'is it done now?' } as never)
  await $.turn.complete(done('Answering that: it is.', 't4'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nothing pinned.')
  await ui.unmount()
})
