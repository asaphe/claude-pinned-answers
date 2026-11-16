import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin } from '../types'

const PANE = 'pinned-answers'
const TITLE = '📌 Pinned answers'
// The bold label on its own line: `**Answer:**`, `**Answer**:`, `__Answer:__`, optionally quoted.
const MARK = /^[ \t>]*(?:\*\*|__)answer:?(?:\*\*|__):?[ \t]*/im
const MARKS = new RegExp(MARK.source, 'gim')
const QUESTION =
  /\?|^\s*(why|what|how|is|are|can|could|did|does|where|when|which|should|would|will)\b|^\s*do (we|you|i|they)\b/i
// Harness-injected prompts (task notifications, other sessions, slash-command echoes) are never the person asking.
const MACHINE =
  /^\s*(<[a-z-]+|Another Claude session sent a message:|This session is being continued|\/)/i
const ACK = /^\s*ack(?:$|[\s.,;:!-])/i
const CLEAR_MS = 60_000
const MAX_COLUMNS = 72
const MAX_ROWS = 14
const SHOWN = 5
const ANSWER_LINES = 3
const ANSWER_CHARS = 240
const QUESTION_CHARS = 60

const pins = atom({ plugin: 'pinned-answers', key: 'pins' } as const, [], { shape: 'pins-1' })
const question = atom({ plugin: 'pinned-answers', key: 'question' } as const, '')
const asked = atom({ plugin: 'pinned-answers', key: 'asked' } as const, '')

// Cut at the last sentence end that fits, else the last word; the pane is for the answer, not the report.
function clip(text: string): string {
  if (text.length <= ANSWER_CHARS) return text
  const head = text.slice(0, ANSWER_CHARS + 1)
  let end = -1
  for (const m of head.matchAll(/[.!?](?=\s)/g)) if ((m.index ?? 0) >= 60) end = (m.index ?? 0) + 1
  if (end < 0) end = head.lastIndexOf(' ') > ANSWER_CHARS / 2 ? head.lastIndexOf(' ') : ANSWER_CHARS
  return text.slice(0, end).trimEnd()
}

// The last Answer paragraph (up to the first blank line), at most 3 lines and one clipped run; null when none or n/a.
export function extract(reply: string): string | null {
  let m: RegExpExecArray | undefined
  for (const x of reply.matchAll(MARKS)) m = x
  if (!m) return null
  const para = (reply.slice(m.index + m[0].length).split(/\n[ \t]*\n/)[0] ?? '').trim()
  if (!para || /^n\/a\b/i.test(para)) return null
  const lines = para.split('\n').map(l => l.trimEnd())
  const joined = lines.slice(0, ANSWER_LINES).join('\n')
  const out = clip(joined)
  return lines.length > ANSWER_LINES || out.length < joined.length ? `${out} …` : out
}

export type Run = { text: string; bold?: true; italic?: true; code?: true }

// One line of the answer as styled runs: list markers become bullets, markdown marks become styles.
export function runs(line: string): Run[] {
  const rest = line.replace(/^(\s*)[-*+]\s+/, '$1• ').replace(/^\s*#{1,6}\s+/, '').replace(/^\s*>\s?/, '')
  const out: Run[] = []
  const plain = (t: string) => t && out.push({ text: t.replace(/\*\*|__|`/g, '') })
  const token = /(\*\*|__)(.+?)\1|`([^`]+)`|\[([^\]]+)\]\([^)\s]+\)|(?<![\w*])\*(?![\s*])([^*]+?)\*(?![\w*])/g
  let at = 0
  for (const m of rest.matchAll(token)) {
    plain(rest.slice(at, m.index))
    if (m[2] !== undefined) out.push({ text: m[2].replace(/`/g, ''), bold: true })
    else if (m[3] !== undefined) out.push({ text: m[3], code: true })
    else if (m[4] !== undefined) out.push({ text: m[4] })
    else out.push({ text: m[5] ?? '', italic: true })
    at = m.index + m[0].length
  }
  plain(rest.slice(at))
  return out.filter(r => r.text)
}

const width = (line: string) => runs(line).reduce((n, r) => n + r.text.length, 0)

function short(q: string): string {
  return q.length > QUESTION_CHARS ? `${q.slice(0, QUESTION_CHARS - 1).trimEnd()}…` : q
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function show($: EngineInterface) {
  const list = (await read($, pins)).slice(0, SHOWN)
  if (list.length === 0) return $.ui.close({ id: PANE })
  let w = 40
  for (const p of list) {
    w = Math.max(w, short(p.question).length + 18)
    for (const line of p.answer.split('\n')) w = Math.max(w, width(line) + 4)
  }
  const columns = Math.min(w, MAX_COLUMNS)
  let rows = 2
  for (const p of list) {
    for (const line of p.answer.split('\n')) rows += Math.max(1, Math.ceil(width(line) / (columns - 4)))
    rows += 3
  }
  await $.ui.open({ id: PANE, title: TITLE, columns, rows: Math.min(rows, MAX_ROWS), closeOnEscape: true })
}

async function clear($: EngineInterface) {
  await update($, pins, () => [])
  await update($, question, () => '')
  await update($, asked, () => '')
  await $.ui.close({ id: PANE })
}

// Drops the pins whose clear time has passed, then re-seats or closes the pane.
async function prune($: EngineInterface) {
  const now = await $.clock.now()
  const before = await read($, pins)
  if (!before.some(p => p.clearAt !== undefined && p.clearAt <= now)) return
  await update($, pins, l => l.filter(p => p.clearAt === undefined || p.clearAt > now))
  await show($)
}

function schedule($: EngineInterface, ms: number) {
  $.clock.after(Math.max(0, ms), () => void prune($).catch(() => undefined))
}

// Pins the turn's newest Answer line for the armed question; a later Answer for the same question replaces it.
async function pin($: EngineInterface, reply: string): Promise<boolean> {
  const q = await read($, question)
  if (!q) return false
  const answer = extract(reply)
  if (!answer) return false
  const id = (await read($, asked)) || String(await $.clock.now())
  const p: Pin = { id, at: await $.clock.now(), question: q, answer }
  await update($, pins, list => [p, ...list.filter(x => x.id !== id)].slice(0, 20))
  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pins', description: 'Show pinned answers' })
    void (async () => {
      await prune($)
      const now = await $.clock.now()
      const due = (await read($, pins)).flatMap(p => (p.clearAt === undefined ? [] : [p.clearAt]))
      if (due.length) schedule($, Math.min(...due) - now)
      await show($)
    })().catch(() => undefined)
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
      // Your own prompt starts the clock on what is already pinned; ack still clears at once.
      const now = await $.clock.now()
      const list = await update($, pins, l => l.map(p => (p.clearAt === undefined ? { ...p, clearAt: now + CLEAR_MS } : p)))
      if (list.length) schedule($, CLEAR_MS)
      const isQ = QUESTION.test(e.text)
      await update($, question, () => (isQ ? e.text.replace(/\s+/g, ' ').trim().slice(0, 120) : ''))
      await update($, asked, () => (isQ ? `${now}-${Math.random().toString(36).slice(2, 8)}` : ''))
    })().catch(() => undefined)
    return next(e)
  })

  // Each response block as it is kept: the Answer line pins the moment it is written, mid-turn included.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const kept = await next(e)
    if (e.agentId !== undefined || e.message.type !== 'assistant') return kept
    const text = e.message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
    if (MARK.test(text) && (await pin($, text).catch(() => false))) await show($).catch(() => undefined)
    return kept
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.isAborted) return done
    await (async () => {
      await pin($, e.answer)
      const id = await read($, asked)
      // A question answered this turn is done; an unanswered one stays armed for the turn that reads it.
      if (id && (await read($, pins)).some(p => p.id === id)) {
        await update($, question, () => '')
        await update($, asked, () => '')
      }
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
        <Text dimColor>
          {all.length > SHOWN ? `+${all.length - SHOWN} older · ` : ''}ack clears all · your next prompt clears these in 1m
        </Text>
        {list.map((p, i) => (
          <Box key={p.id} flexDirection="column" marginTop={1}>
            <Text dimColor wrap="truncate-end">
              {clock(p.at)} "{short(p.question)}"{p.clearAt === undefined ? '' : ` · clears ${clock(p.clearAt)}`}
            </Text>
            {p.answer.split('\n').map((line, j) => (
              <Text key={`a-${p.id}-${j}`} wrap="wrap">
                {runs(line).map((r, k) =>
                  r.code ? (
                    <Text key={`r${k}`} color="permission">
                      {r.text}
                    </Text>
                  ) : r.bold ? (
                    <Text key={`r${k}`} weight="bold">
                      {r.text}
                    </Text>
                  ) : r.italic ? (
                    <Text key={`r${k}`} italic>
                      {r.text}
                    </Text>
                  ) : (
                    r.text
                  ),
                )}
              </Text>
            ))}
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
      </Box>
    )
  })
}
