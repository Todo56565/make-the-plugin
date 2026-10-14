// Probe: does DSH's compaction survive the system-prompt head, and what does
// the replacement anchor look like?
//
// Question under test: after a compaction, is the system message at surface
// node 0 kept verbatim (DSH replace-the-middle) or rebuilt (Codex fresh window)?
//
// Method: multi-frame zstd session log must be split on the magic bytes
// 28 B5 2F FD before decompression; a single zstdDecompressSync call only
// decodes frame 1 and yields a false negative on compaction events.
//
// Usage: node probe-window-head.mjs <session.v4.jsonl.zstd>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function frames(buf) {
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
  }
  const out = []
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      out.push({ frame: k, bytes: end - start, text: zstdDecompressSync(buf.subarray(start, end)).toString('utf8') })
    } catch (e) {
      out.push({ frame: k, bytes: end - start, text: '', error: String(e.message) })
    }
  }
  return out
}

const path = process.argv[2]
if (path === undefined) {
  console.error('usage: node probe-window-head.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}
const raw = readFileSync(path)
const fr = frames(raw)
console.log(`file bytes=${raw.length} frames=${fr.length} decoded=${fr.filter((f) => f.error === undefined).length}`)

const events = []
for (const f of fr) {
  if (f.text === '') continue
  for (const line of f.text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try { events.push({ frame: f.frame, ev: JSON.parse(t) }) } catch { /* non-JSON frame preamble */ }
  }
}
console.log(`parsed events=${events.length}`)

// 1. Compaction anatomy.
const comp = events.filter((e) => typeof e.ev.type === 'string' && e.ev.type.startsWith('compaction/'))
console.log(`\n=== compaction/* events: ${comp.length} ===`)
for (const c of comp) {
  const d = c.ev.data ?? {}
  const s = JSON.stringify({
    type: c.ev.type, seq: c.ev.seq, time: c.ev.time,
    compactionId: d.compactionId, trigger: d.trigger, provider: d.provider, model: d.model,
    shadowedRange: d.shadowedRange, shadowedSeqs: d.shadowedSeqs?.length, shadowedTokenCount: d.shadowedTokenCount,
  })
  console.log(s.length > 300 ? s.slice(0, 300) + '…' : s)
}

// 2. Which surface op accompanies each compaction, and what seq it anchors on.
console.log('\n=== surfaceOp near compaction ===')
for (const e of events) {
  if (e.ev.type !== 'user/message' && e.ev.type !== 'system/message') continue
  const op = e.ev.data?.surfaceOp
  if (op === undefined) continue
  console.log(JSON.stringify({ seq: e.ev.seq, type: e.ev.type, op: op.op, startSeq: op.startSeq, endSeq: op.endSeq, source: e.ev.data?.source?.kind }))
}

// 3. Every system/message event: is the head rewritten, or untouched?
console.log('\n=== system/message events ===')
const sys = events.filter((e) => e.ev.type === 'system/message')
console.log(`count=${sys.length}`)
for (const s of sys) {
  const content = s.ev.data?.message?.content
  const len = Array.isArray(content) ? content.reduce((n, b) => n + (typeof b?.text === 'string' ? b.text.length : 0), 0) : -1
  console.log(JSON.stringify({ seq: s.ev.seq, time: s.ev.time, textLen: len, surfaceOp: s.ev.data?.surfaceOp ?? null, sourceSeqs: s.ev.data?.sourceEventSeqs ?? null }))
}

// 4. Surface reconstruction: replay append/replace to see the final surface,
//    and specifically whether seq 0 is still the original system node.
console.log('\n=== surface replay (append/replace only) ===')
let surface = []
for (const e of events) {
  const op = e.ev.data?.surfaceOp
  if (op === undefined) continue
  const seq = e.ev.seq
  if (op.op === 'append') surface.push(seq)
  else if (op.op === 'replace') {
    const i = surface.indexOf(op.startSeq)
    const j = surface.indexOf(op.endSeq)
    if (i === -1 || j === -1) { surface.push(seq); continue }
    surface = [...surface.slice(0, i), seq, ...surface.slice(j + 1)]
  }
}
const typeOf = (seq) => events.find((e) => e.ev.seq === seq)?.ev.type ?? '?'
console.log(`final surface nodes=${surface.length}`)
console.log(`first 8: ${surface.slice(0, 8).map((s) => `${s}:${typeOf(s)}`).join('  ')}`)
const headSeq = surface[0]
const head = events.find((e) => e.ev.seq === headSeq)
const headText = head?.ev.data?.message?.content?.[0]?.text ?? ''
console.log(`head seq=${headSeq} type=${typeOf(headSeq)} textLen=${headText.length}`)
console.log(`head is system/message: ${typeOf(headSeq) === 'system/message'}`)

// 5. Was any event appended AFTER compaction/end that rewrote the head seq?
const endSeqs = comp.filter((c) => c.ev.type === 'compaction/end').map((c) => c.ev.seq)
console.log(`\n=== post-compaction events that reference the head seq (${headSeq}) ===`)
for (const e of events) {
  const op = e.ev.data?.surfaceOp
  const refsHead = op !== undefined && (op.startSeq === headSeq || op.endSeq === headSeq)
  if (refsHead) console.log(JSON.stringify({ seq: e.ev.seq, type: e.ev.type, op: op.op, startSeq: op.startSeq, endSeq: op.endSeq }))
}
console.log(`compaction/end seqs: ${JSON.stringify(endSeqs)}`)
const afterEnd = events.filter((e) => endSeqs.some((s) => e.ev.seq > s))
console.log(`events after compaction/end: ${afterEnd.length}; types: ${JSON.stringify([...new Set(afterEnd.map((e) => e.ev.type))])}`)
