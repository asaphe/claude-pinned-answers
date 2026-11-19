import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'pinned-answers',
  component: 'Pane',
  requestId: 'pinned-answers',
  surface: 'terminal',
  props: { title: '📌 Pinned answers', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const BAND = {
  plugin: 'pinned-answers',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

function wire(on: On, core?: (e: { text: string }) => unknown) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 16, 10, 0) })
  on('command.register', () => ({ value: { command: 'pins' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => (core ? core(e) : { text: e.text }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { clock }
}

const me = { origin: { kind: 'composer' } } as const
const done = (answer: string, turnId: string) => ({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as const
const block = (text: string, uuid: string) =>
  ({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid }) as never
const result = (uuid: string) =>
  ({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${uuid}`, content: 'ok' }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid,
  }) as never
const queued = (text: string, uuid: string) =>
  ({
    message: {
      type: 'attachment',
      name: 'queued_command',
      role: 'user',
      isMeta: true,
      content: [{ type: 'text', text: `<system-reminder>\nThe user sent a new message while you were working:\n${text}\n</system-reminder>` }],
    },
    door: 'delivery',
    origin: { kind: 'composer' },
    uuid,
  }) as never

async function texts($: any): Promise<string[]> {
  const ui = await $.ui.mount(PANE)
  const all = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  await ui.unmount()
  return all
}
// Each pin as `question => answer`, newest first.
async function pinned($: any): Promise<string[]> {
  const all = await texts($)
  const out: string[] = []
  for (let i = 0; i < all.length; i++) {
    const m = /^\d\d:\d\d "(.*)"(?: · clears \d\d:\d\d)?$/.exec(all[i] ?? '')
    if (m) out.push(`${m[1]} => ${all[i + 1] ?? ''}`)
  }
  return out
}

test('a tool result alone never delivers a question typed over the turn', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'is the queue healthy?' } as never)
  await $.turn.start({ text: 'is the queue healthy?', turnId: 't1' })
  await $.prompt.submit({ ...me, text: 'why is it slow', turnId: 't1', wait: false } as never)
  await $.session.append(result('r0'))
  await $.session.append(block('**Answer:** yes, healthy.', 'r1'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** yes, healthy.', 't1'))
  expect(await pinned($)).toEqual(['is the queue healthy? => yes, healthy.'])
  // The engine runs the held prompt as its own turn.
  await $.turn.start({ text: 'why is it slow', turnId: 't2' })
  await $.session.append(block('**Answer:** the disk is full.', 'r2'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** the disk is full.', 't2'))
  expect(await pinned($)).toEqual(['why is it slow => the disk is full.', 'is the queue healthy? => yes, healthy.'])
})

test('a mid-turn note with a clause-start word leaves the running question armed', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'is the queue healthy?' } as never)
  await $.prompt.submit({ ...me, text: 'also check the logs. when done, push the fix', turnId: 't1', wait: false } as never)
  await $.session.append(result('r0'))
  await $.session.append(queued('also check the logs. when done, push the fix', 'q0'))
  await $.session.append(block('**Answer:** yes, healthy.', 'r1'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** yes, healthy.', 't1'))
  expect(await pinned($)).toEqual(['is the queue healthy? => yes, healthy.'])
})

test('a question read mid-turn and left unanswered is done when that turn ends', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'deploy the fix' } as never)
  await $.prompt.submit({ ...me, text: 'which node is it on?', turnId: 't1', wait: false } as never)
  await $.session.append(result('r0'))
  await $.session.append(queued('which node is it on?', 'q0'))
  await $.session.append(block('Noted, I will check the node after the deploy.', 'r1'))
  await clock.settle()
  await $.turn.complete(done('Deployed.', 't1'))
  await $.prompt.submit({ text: '<task-notification>backup job finished</task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.turn.start({ text: '<task-notification>backup job finished</task-notification>', turnId: 't2' })
  await $.session.append(block('**Answer:** the backup finished cleanly.', 'r2'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** the backup finished cleanly.', 't2'))
  expect(await pinned($)).toEqual([])
})

test('an interrupted turn disarms its own question', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'why did the deploy fail?' } as never)
  await $.turn.complete({ ...done('', 't1'), isAborted: true, reason: 'aborted' } as never)
  await $.prompt.submit({ text: '<task-notification>backup done</task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.session.append(block('**Answer:** the backup finished.', 'r2'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** the backup finished.', 't2'))
  expect(await pinned($)).toEqual([])
})

test('two questions over one turn each keep their own answer', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'deploy the fix' } as never)
  await $.prompt.submit({ ...me, text: 'is A up?', turnId: 't1', wait: false } as never)
  await $.session.append(result('r0'))
  await $.session.append(queued('is A up?', 'q0'))
  await $.prompt.submit({ ...me, text: 'is B up?', turnId: 't1', wait: false } as never)
  await $.session.append(block('**Answer:** A is up.', 'r1'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** A is up.', 't1'))
  await $.turn.start({ text: 'is B up?', turnId: 't2' })
  await $.session.append(block('**Answer:** B is up.', 'r2'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** B is up.', 't2'))
  expect(await pinned($)).toEqual(['is B up? => B is up.', 'is A up? => A is up.'])
})

test('two questions read in one drain take the Answers in order, and a repeat fills neither', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'deploy the fix' } as never)
  await $.prompt.submit({ ...me, text: 'is A up?', turnId: 't1', wait: false } as never)
  await $.prompt.submit({ ...me, text: 'is B up?', turnId: 't1', wait: false } as never)
  await $.session.append(result('r0'))
  await $.session.append(queued('is A up?', 'q0'))
  await $.session.append(queued('is B up?', 'q1'))
  await $.session.append(block('**Answer:** both are up.', 'r1'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** both are up.', 't1'))
  expect(await pinned($)).toEqual(['is A up? => both are up.'])
})

test('a mid-turn question a hook drops is never armed', async ($, on) => {
  const { clock } = wire(on, e => (e.text.startsWith('blocked') ? { drop: 'blocked by a UserPromptSubmit hook' } : { text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'is the queue healthy?' } as never)
  await $.prompt.submit({ ...me, text: 'blocked: what is the token?', turnId: 't1', wait: false } as never)
  await $.session.append(result('r0'))
  await $.session.append(block('**Answer:** yes, healthy.', 'r1'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** yes, healthy.', 't1'))
  await $.turn.start({ text: 'blocked: what is the token?', turnId: 't2' })
  await $.turn.complete(done('**Answer:** leaked.', 't2'))
  expect(await pinned($)).toEqual(['is the queue healthy? => yes, healthy.'])
})

test('an idle question a hook drops is never armed', async ($, on) => {
  wire(on, e => (e.text.startsWith('blocked') ? { drop: 'blocked' } : { text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'blocked: why is it down?' } as never)
  await $.prompt.submit({ text: '<task-notification>x</task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.turn.complete(done('**Answer:** for the notification.', 't1'))
  expect(await pinned($)).toEqual([])
})

test('a question a hook rewrote is delivered by its rewritten text', async ($, on) => {
  const { clock } = wire(on, e => ({ text: `${e.text} [screened]` }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'deploy the fix' } as never)
  await $.prompt.submit({ ...me, text: 'is it live?', turnId: 't1', wait: false } as never)
  await $.session.append(result('r0'))
  await $.session.append(queued('is it live? [screened]', 'q0'))
  await $.session.append(block('**Answer:** yes.', 'r1'))
  await clock.settle()
  expect(await pinned($)).toEqual(['is it live? => yes.'])
})

test('a dismissed Answer repeated after the next question is read does not come back under it', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'is the queue healthy?' } as never)
  await $.session.append(block('**Answer:** yes, healthy.', 'r1'))
  await clock.settle()
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'dismiss' })
  await band.unmount()
  await $.prompt.submit({ ...me, text: 'and the workers?', turnId: 't1', wait: false } as never)
  await $.session.append(result('r2'))
  await $.session.append(queued('and the workers?', 'q2'))
  await $.session.append(block('**Answer:** yes, healthy.\n\nWorkers: 5 of 5 up.', 'r3'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** yes, healthy.\n\nWorkers: 5 of 5 up.', 't1'))
  expect(await pinned($)).toEqual([])
})

test('a question entered as its turn ends opens the next turn, and leaks nowhere after', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'deploy the fix' } as never)
  await $.turn.complete(done('Deployed.', 't1'))
  await $.prompt.submit({ ...me, text: 'is it live?', turnId: 't1', wait: false } as never)
  await $.turn.start({ text: 'is it live?', turnId: 't2' })
  await $.session.append(block('**Answer:** yes, live since 10:02.', 'r2'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** yes, live since 10:02.', 't2'))
  expect(await pinned($)).toEqual(['is it live? => yes, live since 10:02.'])
  await $.prompt.submit({ text: '<task-notification>backup done</task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.turn.start({ text: '<task-notification>backup done</task-notification>', turnId: 't3' })
  await $.turn.complete(done('**Answer:** the backup finished.', 't3'))
  expect((await pinned($)).map(p => p.split(' => ')[0])).toEqual(['is it live?'])
})

test('only the person asks: notifications, peers, schedules and channels never arm; an SDK host does', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const kinds = ['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'channel', 'coordinator', 'observer', 'unclassified']
  for (const [i, kind] of kinds.entries()) {
    await $.prompt.submit({ text: `why did job ${i} fail?`, origin: { kind, ...(kind === 'channel' ? { server: 's' } : {}) } } as never)
    await $.turn.complete(done(`**Answer:** machine ${i}.`, `m${i}`))
  }
  expect(await pinned($)).toEqual([])
  await $.prompt.submit({ text: 'why did it fail?', origin: { kind: 'bridge' } } as never)
  await $.turn.complete(done('**Answer:** from the phone.', 'b1'))
  await $.prompt.submit({ text: 'why did CI fail?', origin: { kind: 'sdk' } } as never)
  await $.turn.complete(done('**Answer:** from the IDE.', 's1'))
  expect(await pinned($)).toEqual(['why did CI fail? => from the IDE.', 'why did it fail? => from the phone.'])
})

test('instructions that merely contain a question word do not arm', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const notes = [
    'also run the linter. when it passes, push',
    'keep going — what matters is the tests',
    'note: where possible reuse the helper',
    'proceed\nwhen done open the PR',
    'Explain the change in the PR body',
    'tell me when CI is green',
    'run this query\nSELECT id FROM users\nWHERE active = 1',
    'read docs: how-it-works.md and summarize',
    'Ship it. Who reviews is up to the team',
    'merge it -- which branch does not matter',
    '<pasted_content id="p1">Traceback\n  File "a.py", line 3\n    x = y if a else b</pasted_content id="p1"> fix this',
    '<pasted_content id="p2">const v = cfg?.region ?? "us"</pasted_content id="p2"> refactor this',
    'use `a ?? b` and cfg?.region here',
    'open https://example.com/x?ref=main and fix it',
  ]
  for (const [i, q] of notes.entries()) {
    await $.prompt.submit({ ...me, text: q } as never)
    await $.turn.complete(done(`**Answer:** note ${i}.`, `n${i}`))
  }
  expect(await pinned($)).toEqual([])
})

test('questions in every shape arm', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const asks = [
    'is it up',
    'do we need a migration',
    'tell me why it failed',
    'explain the difference between the two',
    'deployed. why is it slow',
    'Relay setup -- what do we need to do',
    "status. what's left",
    'ok. how many pods are running',
    'any update',
    'it works?',
    '<pasted_content id="p3">error: 401</pasted_content id="p3"> why does this fail?',
  ]
  for (const [i, q] of asks.entries()) {
    await $.prompt.submit({ ...me, text: q } as never)
    await $.turn.complete(done(`**Answer:** ask ${i}.`, `a${i}`))
  }
  const got = (await texts($)).filter(t => /^ask \d+\.$/.test(t))
  // The pane shows the 5 newest; the rest are counted.
  expect(got).toEqual(['ask 10.', 'ask 9.', 'ask 8.', 'ask 7.', 'ask 6.'])
  expect((await texts($)).find(t => /older/.test(t))).toBe('+6 older')
  expect((await pinned($))[0]).toBe('why does this fail? => ask 10.')
  // Code is ignored when telling a question, but kept in its header.
  await $.prompt.submit({ ...me, text: 'is `FOO` set?' } as never)
  await $.turn.complete(done('**Answer:** yes.', 'c1'))
  expect((await pinned($))[0]).toBe('is `FOO` set? => yes.')
})

test('a question queued behind a turn of any length is still delivered', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'run the migration' } as never)
  await $.prompt.submit({ ...me, text: 'how long will it take?', turnId: 't1', wait: false } as never)
  await clock.advance(3 * 60 * 60_000)
  await $.session.append(result('r0'))
  await $.session.append(queued('how long will it take?', 'q0'))
  await $.session.append(block('**Answer:** about an hour more.', 'r1'))
  await clock.settle()
  expect(await pinned($)).toEqual(['how long will it take? => about an hour more.'])
})

test('two questions read in one drain each keep their own answer', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'deploy the fix' } as never)
  await $.prompt.submit({ ...me, text: 'is A up?', turnId: 't1', wait: false } as never)
  await $.prompt.submit({ ...me, text: 'is B up?', turnId: 't1', wait: false } as never)
  await $.session.append(result('r0'))
  await $.session.append(queued('is A up?', 'q0'))
  await $.session.append(queued('is B up?', 'q1'))
  await $.session.append(block('**Answer:** A is up.', 'r1'))
  await clock.settle()
  await $.session.append(block('**Answer:** B is up.', 'r2'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** B is up.', 't1'))
  expect(await pinned($)).toEqual(['is B up? => B is up.', 'is A up? => A is up.'])
})

test('a question read mid-turn pins an Answer equal to the one before it', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'is the queue healthy?' } as never)
  await $.session.append(block('**Answer:** Yes.', 'r1'))
  await clock.settle()
  await $.prompt.submit({ ...me, text: 'is the deploy done?', turnId: 't1', wait: false } as never)
  await $.session.append(result('r2'))
  await $.session.append(queued('is the deploy done?', 'q2'))
  await $.session.append(block('**Answer:** Yes.', 'r3'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** Yes.', 't1'))
  expect(await pinned($)).toEqual(['is the deploy done? => Yes.', 'is the queue healthy? => Yes.'])
})

test('a question on its own line arms', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'deployed\nwhy is it slow' } as never)
  await $.turn.complete(done('**Answer:** the disk.', 't1'))
  expect(await pinned($)).toEqual(['deployed why is it slow => the disk.'])
})

test('a stale waiting question is not delivered by a later, longer one', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'deploy the fix' } as never)
  await $.prompt.submit({ ...me, text: 'why?', turnId: 't1', wait: false } as never)
  await $.turn.complete({ ...done('', 't1'), isAborted: true, reason: 'aborted' } as never)
  // Esc pulled the queued prompt back into the input; the person edits it and sends it idle.
  await $.prompt.submit({ ...me, text: 'retry the deploy' } as never)
  await $.turn.start({ text: 'retry the deploy', turnId: 't2' })
  await $.prompt.submit({ ...me, text: 'why? check the logs too', turnId: 't2', wait: false } as never)
  await $.session.append(result('r0'))
  await $.session.append(queued('why? check the logs too', 'q0'))
  await $.session.append(block('**Answer:** the logs show a timeout.', 'r1'))
  await clock.settle()
  expect(await pinned($)).toEqual(['why? check the logs too => the logs show a timeout.'])
})

test('a rewritten question whose turn opens before next() returns is still delivered', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  const { clock } = wire(on, async e => (e.text.includes('tok_') ? (await gate, { text: e.text.replace(/tok_\w+/, '[masked]') }) : { text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'deploy the fix' } as never)
  await $.turn.complete(done('Deployed.', 't1'))
  const sent = $.prompt.submit({ ...me, text: 'is tok_abc valid?', turnId: 't1', wait: false } as never)
  await clock.settle()
  await $.turn.start({ text: 'is [masked] valid?', turnId: 't2' })
  release()
  await sent
  await $.session.append(block('**Answer:** yes, still valid.', 'r1'))
  await clock.settle()
  await $.turn.complete(done('**Answer:** yes, still valid.', 't2'))
  expect((await pinned($))[0]).toBe('is tok_abc valid? => yes, still valid.')
})

test('an Answer in the last block is pinned when turn.complete follows at once', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'is it up?' } as never)
  await $.session.append(block('**Answer:** yes, up.\n\nDetails.', 'r1'))
  await $.turn.complete(done('Done.', 't1'))
  expect(await pinned($)).toEqual(['is it up? => yes, up.'])
})

test('doubled and trailing question marks arm', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const [i, q] of ['status??', 'deployed?...'].entries()) {
    await $.prompt.submit({ ...me, text: q } as never)
    await $.turn.complete(done(`**Answer:** m${i}.`, `m${i}`))
  }
  expect((await pinned($)).length).toBe(2)
})

test('an Answer dismissed in one turn does not block the same Answer to a later question', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ ...me, text: 'is it up?' } as never)
  await $.turn.complete(done('**Answer:** yes.', 't1'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'dismiss' })
  await band.unmount()
  await $.prompt.submit({ ...me, text: 'is the database up?' } as never)
  await $.turn.start({ text: 'is the database up?', turnId: 't2' })
  await $.session.append(block('**Answer:** yes.', 'r2'))
  await clock.settle()
  expect(await pinned($)).toEqual(['is the database up? => yes.'])
})
