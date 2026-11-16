import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin } from '../types'

const PANE = 'pinned-answers'
const TITLE = '📌 Pinned answers'
const MARK = /^[\s>]*(?:\*\*|__)?answer:?(?:\*\*|__)?:?\s*/im
const QUESTION =
  /\?|^\s*(why|what|how|is|are|can|could|did|does|where|when|which|should|would|will)\b|^\s*do (we|you|i|they)\b/i
// Harness-injected prompts (task notifications, other sessions, slash-command echoes) are never the person asking.
const MACHINE =
  /^\s*(<[a-z-]+|Another Claude session sent a message:|This session is being continued|\/)/i
const ACK = /^\s*ack(?:$|[\s.,;:!-])/i
const MAX_COLUMNS = 72
const MAX_ROWS = 14
const SHOWN = 5
const ANSWER_LINES = 3
const ANSWER_CHARS = 280

const pins = atom({ plugin: 'pinned-answers', key: 'pins' } as const, [], { shape: 'pins-1' })
const question = atom({ plugin: 'pinned-answers', key: 'question' } as const, '')

// The Answer paragraph only (up to the first blank line), capped; null when the reply has none or says n/a.
export function extract(reply: string): string | null {
  const m = MARK.exec(reply)
  if (!m) return null
  const para = reply.slice(m.index + m[0].length).split(/\n\s*\n/)[0].trim()
  if (!para || /^n\/a\b/i.test(para)) return null
  const lines = para.split('\n')
  let out = lines.slice(0, ANSWER_LINES).join('\n')
  let cut = lines.length > ANSWER_LINES
  if (out.length > ANSWER_CHARS) [out, cut] = [out.slice(0, ANSWER_CHARS), true]
  return cut ? `${out.trimEnd()}…` : out
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function show($: EngineInterface) {
  const list = (await read($, pins)).slice(0, SHOWN)
  if (list.length === 0) return $.ui.close({ id: PANE })
  let w = 24
  let rows = 1
  for (const p of list) {
    for (const line of `${p.question}\n${p.answer}`.split('\n')) w = Math.max(w, line.length + 4)
    rows += p.answer.split('\n').length + 3
  }
  await $.ui.open({
    id: PANE,
    title: TITLE,
    columns: Math.min(w, MAX_COLUMNS),
    rows: Math.min(rows, MAX_ROWS),
    closeOnEscape: true,
  })
}

async function clear($: EngineInterface) {
  await update($, pins, () => [])
  await update($, question, () => '')
  await $.ui.close({ id: PANE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pins', description: 'Show pinned answers' })
    void show($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'pins' }, async $ => {
    const list = await read($, pins)
    if (list.length === 0) return { text: 'Nothing pinned.' }
    await show($)
    return { text: `${list.length} pinned answer(s) shown.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    // Never hold a prompt back on this mod's own failure.
    await (async () => {
      if (ACK.test(e.text)) return clear($)
      if (MACHINE.test(e.text)) return
      await update($, question, () => (QUESTION.test(e.text) ? e.text.trim().slice(0, 120) : ''))
    })().catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.isAborted) return done
    await (async () => {
      const q = await read($, question)
      const answer = q ? extract(e.answer) : null
      if (answer) {
        const pin: Pin = { id: e.turnId, at: await $.clock.now(), question: q, answer }
        await update($, pins, list => [pin, ...list.filter(p => p.id !== pin.id)].slice(0, 20))
      }
      await update($, question, () => '')
      // Also closes a pane an earlier ack left open.
      await show($)
    })().catch(() => undefined)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, pins)
    if (all.length === 0) return <Text dimColor>Nothing pinned.</Text>
    const list = all.slice(0, SHOWN)
    return (
      <Box flexDirection="column">
        {list.map((p, i) => (
          <Box key={p.id} flexDirection="column" marginBottom={1}>
            <Text dimColor>
              {clock(p.at)} "{p.question}"
            </Text>
            <Text>{p.answer}</Text>
            <Button
              key={`seen-${p.id}`}
              label={i === 0 ? '✓ seen (s)' : '✓ seen'}
              hotkey={i === 0 ? 's' : undefined}
              onPress={async () => {
                const left = await update($, pins, l => l.filter(x => x.id !== p.id))
                if (left.length === 0) await $.ui.close({ id: PANE })
              }}
            />
          </Box>
        ))}
        <Text dimColor>
          {all.length > SHOWN ? `+${all.length - SHOWN} older · ` : ''}ack clears all · esc hides
        </Text>
      </Box>
    )
  })
}
