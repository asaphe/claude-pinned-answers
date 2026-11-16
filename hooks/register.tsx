import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin } from '../types'

const PANE = 'pinned-answers'
const TITLE = '📌 Pinned answers'
const MARK = /^\s*(?:\*\*|__)?answer:(?:\*\*|__)?\s*/im
const QUESTION =
  /\?|^\s*(why|what|how|is|are|can|could|did|does|do|where|when|which|should|would|will)\b/i
const ACK = /^\s*ack(?:$|[\s.,;:!-])/i

const pins = atom({ plugin: 'pinned-answers', key: 'pins' } as const, [], { shape: 'pins-1' })
const question = atom({ plugin: 'pinned-answers', key: 'question' } as const, '')

// The answer from its Answer line to the end of the reply; null when the reply has none or says n/a.
function extract(reply: string): string | null {
  const m = MARK.exec(reply)
  if (!m) return null
  const body = reply.slice(m.index + m[0].length).trim()
  return body && !/^n\/a\b/i.test(body) ? body : null
}

function widest(list: readonly Pin[]): number {
  let w = 24
  for (const p of list)
    for (const line of `${p.question}\n${p.answer}`.split('\n')) w = Math.max(w, line.length + 4)
  return w
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function show($: EngineInterface) {
  const list = await read($, pins)
  if (list.length === 0) return
  const rows = list.reduce((n, p) => n + p.answer.split('\n').length + 3, 1)
  // Sized to the content so lines need no wrapping; the engine caps the dock at 45% of the terminal.
  await $.ui.open({ id: PANE, title: TITLE, columns: widest(list), rows })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pins', description: 'Show pinned answers' })
    void show($)
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
      if (ACK.test(e.text)) {
        await update($, pins, () => [])
        await update($, question, () => '')
        await $.ui.close({ id: PANE })
      } else {
        await update($, question, () => (QUESTION.test(e.text) ? e.text.trim().slice(0, 200) : ''))
      }
    })().catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.isAborted) return done
    const q = await read($, question)
    const answer = q ? extract(e.answer) : null
    if (!answer) return done
    const pin: Pin = { id: e.turnId, at: await $.clock.now(), question: q, answer }
    await update($, pins, list => [pin, ...list.filter(p => p.id !== pin.id)].slice(0, 20))
    await update($, question, () => '')
    await show($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, pins)
    if (list.length === 0) return <Text dimColor>Nothing pinned.</Text>
    return (
      <Box flexDirection="column">
        {list.map((p, i) => (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>
              {clock(p.at)} "{p.question}"
            </Text>
            <Text>{p.answer}</Text>
            <Button
              label={i === 0 ? '✓ seen (s)' : '✓ seen'}
              hotkey={i === 0 ? 's' : undefined}
              onPress={async () => {
                const left = await update($, pins, l => l.filter(x => x.id !== p.id))
                if (left.length === 0) await $.ui.close({ id: PANE })
              }}
            />
          </Box>
        ))}
        <Text dimColor>↑↓ scroll · ack clears all</Text>
      </Box>
    )
  })
}
