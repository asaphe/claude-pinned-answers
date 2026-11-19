import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Pin } from '../types'

const PANE = 'pinned-answers'
const TITLE = '📌 Pinned answers'
// The bold label at a line's start: `**Answer:**`, `**Answer**:`, `__Answer:__`, optionally quoted.
const LABEL = /^[ \t>]*(?:\*\*|__)answer:?(?:\*\*|__):?[ \t]*/i
const MARK = new RegExp(LABEL.source, 'im')
const FENCE = /^\s*(```|~~~)/
// A question mark that is not optional chaining (`cfg?.region`) or a URL query (`?ref=`); "status??" and "ready?..." count.
const MARK_Q = /\?(?![\w=&])(?!\.\w)/
const OPENER =
  /^\s*(?:(?:is|are|can|could|did|does|should|would|will)\b|do (?:we|you|i|they)\b|(?:explain|tell me)\s+(?:why|what|how|which|where|who|whether|if|about|this|that|it|the difference)\b)/i
// A clause opening like a question ("Relay setup -- what do we need"), not "when done, push" or a SQL `WHERE` line.
const CLAUSE =
  /(?:^|[.!:;]\s+|\n\s*|--+\s*|—\s*)(?:why\b|(?:what|how|which|when|where|who|whose)(?:'s|\s+(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|about|many|much|long|often|else))\b|is there\b|are there\b|any (?:replies|reply|update|news|idea|reason)\b)/i
// What the person typed around a paste: the paste is material, not the question.
const unpasted = (text: string) => text.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ')
const prose = (text: string) => text.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
// Line breaks are kept: a question may open its own line ("deployed\nwhy is it slow").
const isQuestion = (raw: string) => {
  const text = raw.replace(/[ \t]+/g, ' ').trim()
  return MARK_Q.test(text) || OPENER.test(text) || CLAUSE.test(text)
}
// The person's own Enter (terminal, Remote Control, or an SDK host such as an IDE); never a notification, peer or schedule.
const PERSON = new Set(['composer', 'bridge', 'sdk'])
const norm = (text: string) => text.replace(/\s+/g, ' ').trim()
const KEY_CHARS = 200
const CLEAR_MS = 60_000
const MAX_COLUMNS = 72
const MAX_ROWS = 14
const SHOWN = 5
const ANSWER_LINES = 3
const ANSWER_CHARS = 240
const QUESTION_CHARS = 60

const pins = atom({ plugin: 'pinned-answers', key: 'pins' } as const, [], { shape: 'pins-1' })
// The questions this turn has read, in order; each takes the next Answer written after it.
const armed = atom({ plugin: 'pinned-answers', key: 'armed' } as const, '')
// Questions typed over a running turn, each until the model reads it: its queued_command row, or a later turn opening with it.
const waiting = atom({ plugin: 'pinned-answers', key: 'waiting' } as const, '')

type Waiting = { q: string; id: string; keys: string[]; turn: string }
type Armed = { q: string; id: string; done?: true }

let timer: Timer | undefined
// Each Answer pinned this turn, by the question it went to: the final message repeating one is not the next question's.
const said = new Map<string, string>()
// Answers dismissed during this turn: one the turn repeats under a question read later is not its answer.
const gone = new Set<string>()
// The last few rows and turn prompts read: a hook's rewrite can land after the text it rewrote was carried.
const carried: string[] = []
// Pins in the order their blocks arrived, so the turn's end reads them settled.
let chain: Promise<unknown> = Promise.resolve()
const serial = <T,>(f: () => Promise<T>): Promise<T> => {
  const run = chain.then(f, f)
  chain = run.catch(() => undefined)
  return run
}

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

function parse<T>(v: string): T[] {
  try {
    const x: unknown = JSON.parse(v || '[]')
    return Array.isArray(x) ? (x as T[]) : []
  } catch {
    return []
  }
}

const armedList = async ($: EngineInterface) => parse<Armed>(await read($, armed))

async function setArmed($: EngineInterface, fn: (l: Armed[]) => Armed[]) {
  const next = fn(await armedList($)).slice(-5)
  await update($, armed, () => (next.length ? JSON.stringify(next) : ''))
}

const disarm = ($: EngineInterface) => setArmed($, () => [])

const waitList = async ($: EngineInterface) => parse<Waiting>(await read($, waiting))

async function setWaiting($: EngineInterface, fn: (l: Waiting[]) => Waiting[]) {
  const next = fn(await waitList($)).slice(-5)
  await update($, waiting, () => (next.length ? JSON.stringify(next) : ''))
}

// Delivers every waiting question whose text the row or turn prompt carries; a shorter one inside a longer one's text is that one.
async function deliver($: EngineInterface, raw: string, remember = true) {
  const text = norm(raw)
  if (!text) return
  if (remember) carried.splice(0, carried.length, ...[...carried, text].slice(-3))
  const key = (w: Waiting) => w.keys.map(k => k.slice(0, KEY_CHARS)).find(k => text.includes(k))
  const hit = (await waitList($)).filter(w => key(w) !== undefined)
  const own = hit.filter(w => {
    const k = key(w) ?? ''
    let rest = text
    for (const o of hit) {
      const ok = key(o) ?? ''
      if (o !== w && ok.length > k.length && ok.includes(k)) rest = rest.split(ok).join(' ')
    }
    return rest.includes(k)
  })
  if (own.length === 0) return
  await setWaiting($, l => l.filter(w => !own.some(h => h.id === w.id)))
  await setArmed($, l => [...l.filter(x => !own.some(h => h.id === x.id)), ...own.map(w => ({ q: w.q, id: w.id }))])
}

// Drops every pin and leaves any armed question armed: 0 can be pressed mid-turn, after the next question was asked.
async function dismiss($: EngineInterface) {
  timer?.cancel()
  for (const p of await read($, pins)) gone.add(p.answer)
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

// The first armed question still waiting takes the Answer, else a later one revises the newest pin; the final message only fills a wait.
async function pin($: EngineInterface, reply: string, final = false): Promise<boolean> {
  const list = await armedList($)
  const answer = extract(reply)
  if (list.length === 0 || !answer) return false
  const open = list.find(x => !x.done)
  const t = open ?? list[list.length - 1]
  if (!t || (final && !open)) return false
  if (t.done && !(await read($, pins)).some(p => p.id === t.id)) return false
  if (!t.done && gone.has(answer)) return false
  if (final && (said.get(answer) ?? t.id) !== t.id) return false
  const p: Pin = { id: t.id, at: await $.clock.now(), question: t.q, answer }
  await update($, pins, l => [p, ...l.filter(x => x.id !== t.id)].slice(0, 20))
  await setArmed($, l => l.map(x => (x.id === t.id ? { ...x, done: true } : x)))
  said.set(answer, t.id)
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
    if (e.command || e.isMeta || !PERSON.has(e.origin?.kind ?? '')) return next(e)
    // Never hold a prompt back on this mod's own failure.
    const asking = await (async () => {
      // Your own prompt starts the clock on what is already pinned; 0 in the band still clears at once.
      const now = await $.clock.now()
      if ((await read($, pins)).some(p => p.clearAt === undefined)) {
        await update($, pins, l => l.map(p => (p.clearAt === undefined ? { ...p, clearAt: now + CLEAR_MS } : p)))
        await arm($)
      }
      const own = unpasted(e.text)
      if (!isQuestion(prose(own))) return undefined
      const id = `${now}-${Math.random().toString(36).slice(2, 8)}`
      const w: Waiting = { q: norm(own).slice(0, 120), id, keys: [norm(e.text)], turn: e.turnId ?? '' }
      // Typed over a running turn: listed before `next`, since the turn can end and the next one open with it before `next` returns.
      if (e.turnId !== undefined) await setWaiting($, l => [...l, w])
      else await setWaiting($, l => l.filter(x => !x.keys.includes(w.keys[0] ?? '')))
      return w
    })().catch(() => undefined)
    const r = await next(e)
    await (async () => {
      const entered = 'drop' in r ? undefined : norm(r.text)
      if (e.turnId !== undefined) {
        // A prompt a hook dropped never reaches the model; one a hook rewrote reaches it as rewritten.
        if (asking && entered === undefined) await setWaiting($, l => l.filter(x => x.id !== asking.id))
        else if (asking && entered !== undefined && !asking.keys.includes(entered)) {
          await setWaiting($, l => l.map(x => (x.id === asking.id ? { ...x, keys: [...x.keys, entered] } : x)))
          for (const c of [...carried]) await deliver($, c, false)
        }
        // A note typed over a running turn leaves that turn's question armed.
        return
      }
      if (entered === undefined) return
      if (asking) await setArmed($, () => [{ q: asking.q, id: asking.id }])
      else await disarm($)
    })().catch(() => undefined)
    return r
  })

  // A prompt typed mid-turn reaches the model as a queued_command row carrying its text: from then the turn has read it.
  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    if (e.agentId === undefined && e.message.type === 'attachment' && e.message.name === 'queued_command') {
      const text = e.message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
      await deliver($, text).catch(() => undefined)
    }
    return kept
  })

  // One the turn never read runs next as a turn of its own, opening with its text.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined) gone.clear()
    if (e.agentId === undefined) await deliver($, e.text).catch(() => undefined)
    return started
  })

  // Each response block as it is kept: the Answer line pins the moment it is written, mid-turn included.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const kept = await next(e)
    if (e.agentId === undefined && e.message.type === 'assistant') {
      const text = e.message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
      if (MARK.test(text)) void serial(() => pin($, text)).then(added => (added ? show($) : undefined)).catch(() => undefined)
    }
    return kept
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    await serial(async () => {
      const added = !e.isAborted && (await pin($, e.answer, true))
      // A question the turn read is done when it ends, answered or not, interrupted or not.
      await disarm($)
      said.clear()
      gone.clear()
      // One typed over this turn and never read by it waits for the next turn; an older one the next turn did not open with is stale.
      await setWaiting($, l => l.filter(w => w.turn === e.turnId))
      if ((await read($, pins)).length === 0) await $.ui.close({ id: PANE })
      else if (added) await show($)
    }).catch(() => undefined)
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
