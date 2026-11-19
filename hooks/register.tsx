import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Pin } from '../types'

const PANE = 'pinned-answers'
const TITLE = '📌 Pinned answers'
// The bold label at a line's start: `**Answer:**`, `**Answer**:`, `__Answer:__`, optionally quoted.
const LABEL = /^[ \t>]*(?:\*\*|__)answer:?(?:\*\*|__):?[ \t]*/i
const MARK = new RegExp(LABEL.source, 'im')
const FENCE = /^\s*(```|~~~)/
// A question word may open any clause: "Relay setup -- what do we need", "report status. what can merge".
const QUESTION =
  /\?|^\s*(is|are|can|could|did|does|should|would|will)\b|^\s*do (we|you|i|they)\b|^\s*(explain|tell me)\b|(?:^|[.!:;]\s+|\n\s*|--+\s*|—\s*)(why|what|how|which|when|where|who|whose|is there|are there|any (?:replies|reply|update|news|idea|reason))\b/i
// Harness-injected prompts (task notifications, other sessions, slash-command echoes) are never the person asking; a prompt that opens with a paste is.
const MACHINE =
  /^\s*(<(?!pasted_content)[a-z-]+|Another Claude session sent a message:|This session is being continued|\/)/i
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
const askedIn = atom({ plugin: 'pinned-answers', key: 'askedIn' } as const, '')
const answered = atom({ plugin: 'pinned-answers', key: 'answered' } as const, '')
// A question typed over a running turn, until that turn reads it (its next tool result or queued_command row) or ends without it.
const waiting = atom({ plugin: 'pinned-answers', key: 'waiting' } as const, '')

let timer: Timer | undefined

// Cut at the last sentence end that fits, else the last word; the pane is for the answer, not the report.
function clip(text: string): string {
  if (text.length <= ANSWER_CHARS) return text
  const head = text.slice(0, ANSWER_CHARS + 1)
  let end = -1
  for (const m of head.matchAll(/[.!?](?=\s)/g)) if ((m.index ?? 0) >= 60) end = (m.index ?? 0) + 1
  if (end < 0) end = head.lastIndexOf(' ') > ANSWER_CHARS / 2 ? head.lastIndexOf(' ') : ANSWER_CHARS
  return text.slice(0, end).trimEnd()
}

// Offset just past the first Answer label outside a code fence, or -1.
function labelEnd(reply: string): number {
  let fenced = false
  let at = 0
  for (const line of reply.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced
    else if (!fenced) {
      const m = LABEL.exec(line)
      if (m) return at + m[0].length
    }
    at += line.length + 1
  }
  return -1
}

// The first Answer paragraph (up to the first blank line), at most 3 lines and one clipped run; null when none or n/a.
export function extract(reply: string): string | null {
  const start = labelEnd(reply)
  if (start < 0) return null
  const para = (reply.slice(start).split(/\n[ \t]*\n/)[0] ?? '').trim()
  if (!para || /^n\/a\b/i.test(para)) return null
  const lines = para.split('\n').map(l => l.trimEnd())
  const joined = lines.slice(0, ANSWER_LINES).join('\n')
  const out = clip(joined)
  return lines.length > ANSWER_LINES || out.length < joined.length ? `${out} …` : out
}

export type Run = { text: string; bold?: true; code?: true }

// One line as styled runs: list markers become bullets, **bold** and `code` become styles, links keep their text.
export function runs(line: string): Run[] {
  const rest = line.replace(/^(\s*)[-*+]\s+/, '$1• ').replace(/^\s*#{1,6}\s+/, '').replace(/^\s*>\s?/, '')
  const out: Run[] = []
  // A mark left unpaired (a cut mid-span) is dropped; `_` and single `*` stay, since names and globs use them.
  const plain = (t: string) => t && out.push({ text: t.replace(/\*\*|`/g, '') })
  let at = 0
  for (const m of rest.matchAll(/\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)\s]+\)/g)) {
    plain(rest.slice(at, m.index))
    if (m[1] !== undefined) out.push({ text: m[1].replace(/`/g, ''), bold: true })
    else if (m[2] !== undefined) out.push({ text: m[2], code: true })
    else out.push({ text: m[3] ?? '' })
    at = (m.index ?? 0) + m[0].length
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

const older = (all: readonly Pin[]) => (all.length > SHOWN ? `+${all.length - SHOWN} older` : '')

const header = (p: Pin) => `${clock(p.at)} "${short(p.question)}"${p.clearAt === undefined ? '' : ` · clears ${clock(p.clearAt)}`}`

async function show($: EngineInterface) {
  const all = await read($, pins)
  const list = all.slice(0, SHOWN)
  if (list.length === 0) return $.ui.close({ id: PANE })
  let w = Math.max(40, older(all).length + 4)
  for (const p of list) {
    w = Math.max(w, header(p).length + 4)
    for (const line of p.answer.split('\n')) w = Math.max(w, width(line) + 4)
  }
  const columns = Math.min(w, MAX_COLUMNS)
  const lines = (n: number) => Math.max(1, Math.ceil(n / (columns - 4)))
  let rows = older(all) ? 1 : -1
  for (const p of list) {
    rows += 2
    for (const line of p.answer.split('\n')) rows += lines(width(line))
  }
  await $.ui.open({ id: PANE, title: TITLE, columns, rows: Math.min(rows, MAX_ROWS), closeOnEscape: true })
}

async function disarm($: EngineInterface) {
  await update($, question, () => '')
  await update($, asked, () => '')
  await update($, askedIn, () => '')
}

// The waiting question becomes the armed one: read mid-turn it stays for the next turn too, else it opens the next turn.
async function deliver($: EngineInterface, midTurn: boolean) {
  const w = await read($, waiting)
  if (!w) return
  const { q, id, turn } = JSON.parse(w) as { q: string; id: string; turn: string }
  await update($, waiting, () => '')
  await update($, question, () => q)
  await update($, asked, () => id)
  await update($, askedIn, () => (midTurn ? turn : ''))
}

// Drops every pin and leaves any armed question armed: 0 can be pressed mid-turn, after the next question was asked.
async function dismiss($: EngineInterface) {
  timer?.cancel()
  await update($, pins, () => [])
  await $.ui.close({ id: PANE })
}

// One timer, for the earliest clear time pending.
async function arm($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  const due = (await read($, pins)).flatMap(p => (p.clearAt === undefined ? [] : [p.clearAt]))
  if (due.length === 0) return
  const wait = Math.max(0, Math.min(...due) - (await $.clock.now()))
  timer = $.clock.after(wait, () => void prune($).catch(() => undefined))
}

// Drops the pins whose clear time has passed; never reopens a pane the person hid.
async function prune($: EngineInterface) {
  const now = await $.clock.now()
  const before = await read($, pins)
  if (before.some(p => p.clearAt !== undefined && p.clearAt <= now)) {
    const left = await update($, pins, l => l.filter(p => p.clearAt === undefined || p.clearAt > now))
    if (left.length === 0) await $.ui.close({ id: PANE })
  }
  await arm($)
}

// Pins the armed question's Answer; a later Answer for it replaces the pin, but never one the person dismissed.
async function pin($: EngineInterface, reply: string): Promise<boolean> {
  const q = await read($, question)
  if (!q) return false
  const answer = extract(reply)
  if (!answer) return false
  const id = (await read($, asked)) || String(await $.clock.now())
  if ((await read($, answered)) === id && !(await read($, pins)).some(p => p.id === id)) return false
  const p: Pin = { id, at: await $.clock.now(), question: q, answer }
  await update($, pins, list => [p, ...list.filter(x => x.id !== id)].slice(0, 20))
  await update($, answered, () => id)
  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pins', description: 'Show pinned answers' })
    void (async () => {
      await prune($)
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
      if (MACHINE.test(e.text)) return
      // Your own prompt starts the clock on what is already pinned; 0 in the band still clears at once.
      const now = await $.clock.now()
      if ((await read($, pins)).some(p => p.clearAt === undefined)) {
        await update($, pins, l => l.map(p => (p.clearAt === undefined ? { ...p, clearAt: now + CLEAR_MS } : p)))
        await arm($)
      }
      if (QUESTION.test(e.text)) {
        const q = e.text.replace(/\s+/g, ' ').trim().slice(0, 120)
        const id = `${now}-${Math.random().toString(36).slice(2, 8)}`
        // Typed over a running turn: that turn's Answer lines are not for it until the turn reads it.
        if (e.turnId !== undefined) await update($, waiting, () => JSON.stringify({ q, id, turn: e.turnId }))
        else {
          await update($, question, () => q)
          await update($, asked, () => id)
          await update($, askedIn, () => '')
        }
      } else if (e.turnId === undefined) {
        // A note typed over a running turn leaves that turn's question armed.
        await disarm($)
      }
    })().catch(() => undefined)
    return next(e)
  })

  // A prompt typed mid-turn rides the request after the next tool result (or its queued_command row): from then the turn has read it.
  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    const taken = e.door === 'tool-result' || (e.message.type === 'attachment' && e.message.name === 'queued_command')
    if (e.agentId === undefined && taken) await deliver($, true).catch(() => undefined)
    return kept
  })

  // Each response block as it is kept: the Answer line pins the moment it is written, mid-turn included.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const kept = await next(e)
    if (e.agentId === undefined && e.message.type === 'assistant') {
      const text = e.message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
      if (MARK.test(text)) void pin($, text).then(added => (added ? show($) : undefined)).catch(() => undefined)
    }
    return kept
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    // Interrupted: a question typed over it runs next as its own turn.
    if (e.isAborted) return (await deliver($, false).catch(() => undefined), done)
    await (async () => {
      const id = await read($, asked)
      const added = id !== '' && (await read($, answered)) !== id ? await pin($, e.answer) : false
      // Answered, or unanswered by a turn it was not typed over: done. One typed over this turn waits for the next.
      if (id && ((await read($, answered)) === id || (await read($, askedIn)) !== e.turnId)) await disarm($)
      // Typed over this turn and never read by it: it opens the next turn.
      if (await read($, waiting)) await deliver($, false)
      if ((await read($, pins)).length === 0) await $.ui.close({ id: PANE })
      else if (added) await show($)
    })().catch(() => undefined)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = await read($, pins)
    if (all.length === 0) return <Text dimColor>Nothing pinned.</Text>
    const list = all.slice(0, SHOWN)
    return (
      <Box flexDirection="column">
        {older(all) ? <Text dimColor>{older(all)}</Text> : null}
        {list.map((p, i) => (
          <Box key={p.id} flexDirection="column" marginTop={i === 0 && !older(all) ? 0 : 1}>
            <Text dimColor wrap="truncate-end">
              {header(p)}
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
                  ) : (
                    r.text
                  ),
                )}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })

  // The survey's shape: a bare 0 typed into an empty prompt presses this; any other key types as usual.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, pins)
    if (all.length === 0 || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        <Text dimColor>{`📌 ${all.length === 1 ? 'Answer pinned' : `${all.length} answers pinned`}   `}</Text>
        <Button key="dismiss" hotkey="0" plain onPress={() => dismiss($)}>
          Dismiss
        </Button>
      </Box>
    )
  })
}
