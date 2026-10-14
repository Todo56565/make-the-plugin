// Dump the system/message surface ops around a compaction, to test whether the
// auto-compaction path re-renders the system prompt the same way the manual
// /compact path does.
//
// Usage: node probe-auto-compact-system.mjs <session.v4.jsonl.zstd> <fromSeq> [toSeq]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [logPath, fromArg, toArg] = process.argv.slice(2)
if (!logPath) { console.error('usage: node probe-auto-compact-system.mjs <log> <fromSeq> [toSeq]'); process.exit(2) }
const from = Number(fromArg ?? 0)
const to = toArg === undefined ? Infinity : Number(toArg)

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = readFileSync(logPath)
const frames = []
let i = 0
while (i < buf.length) {
  const at = buf.indexOf(MAGIC, i)
  if (at === -1) break
  const next = buf.indexOf(MAGIC, at + 4)
  const end = next === -1 ? buf.length : next
  frames.push(buf.subarray(at, end))
  i = end
}
let text = ''
for (const f of frames) { try { text += zstdDecompressSync(f).toString('utf8') } catch { } }

const events = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  try { events.push(JSON.parse(line)) } catch { }
}

console.log(`frames=${frames.length}  events=${events.length}  seq range=${events[0]?.seq}..${events.at(-1)?.seq}`)
console.log(`\n=== all events with seq in [${from}, ${to === Infinity ? 'end' : to}] that are system/message or carry a surfaceOp ===`)
for (const ev of events) {
  const seq = ev.seq
  if (seq < from || seq > to) continue
  const type = ev.type ?? ev.kind
  const isSystem = type === 'system/message'
  const op = ev.surfaceOp
  if (!isSystem && !op) continue
  let detail = ''
  if (op) {
    detail = ` surfaceOp=${JSON.stringify(op)}`
    if (op.startSeq !== undefined) {
      const target = events.find((e) => e.seq === op.startSeq)
      detail += `  target[${op.startSeq}].type=${target ? (target.type ?? target.kind) : '?'}`
    }
  }
  const d = ev.data ?? ev
  const txt = typeof d.text === 'string'
    ? d.text
    : (typeof d.content === 'string' ? d.content : (d.message?.content?.[0]?.text ?? ''))
  if (typeof d.text === 'string' || typeof d.content === 'string' || d.message?.content?.[0]?.text !== undefined) detail += ` textLen=${txt.length}`
  console.log(`  seq=${seq} ${type}${detail}`)
}

console.log(`\n=== every system/message text length, whole session ===`)
for (const ev of events) {
  const type = ev.type ?? ev.kind
  if (type !== 'system/message') continue
  const d = ev.data ?? ev
  const txt = typeof d.text === 'string'
    ? d.text
    : (typeof d.content === 'string' ? d.content : (d.message?.content?.[0]?.text ?? ''))
  const op = ev.surfaceOp && typeof ev.surfaceOp === 'object' ? ` op=${ev.surfaceOp.op}@${ev.surfaceOp.startSeq}` : ` op=${ev.surfaceOp}`
  console.log(`  seq=${ev.seq} len=${txt.length}${op} head=${JSON.stringify(txt.slice(0, 60))}`)
}
