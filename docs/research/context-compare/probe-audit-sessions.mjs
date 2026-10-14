// Audit probe: for each session log, report compaction events and then decide
// the question the record asserts an answer to --
//
//   does the system prompt survive compaction, and is it re-rendered after?
//
// Two independent criteria, deliberately separated so a null result on one does
// not silently pass the other:
//   (1) compaction range must contain NO system/message node
//   (2) a system/message must be rewritten (or first appear) after compaction/end,
//       with a top-level surfaceOp replace targeting the previous live head
//
// Surface ops live at the EVENT TOP LEVEL (event.surfaceOp), not under data.
//
// Usage: node probe-audit-sessions.mjs <log1.zstd> [log2.zstd ...]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function decodeAll(path) {
  const buf = readFileSync(path)
  const offs = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
  }
  let text = ''
  let bad = 0
  for (let k = 0; k < offs.length; k++) {
    const start = offs[k]
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8') } catch { bad++ }
  }
  const events = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try { events.push(JSON.parse(t)) } catch { /* preamble */ }
  }
  return { buf, frames: offs.length, bad, events }
}

const typeOf = (events, seq) => events.find((e) => e.seq === seq)?.type ?? '?'

// Replay append/replace to get the live surface, returning snapshots by drive seq.
function replay(events, watch) {
  const snaps = new Map()
  let surface = []
  for (const e of events) {
    if (e.surfaceOp === undefined) continue
    if (e.surfaceOp === 'append') surface.push(e.seq)
    else {
      const i = surface.indexOf(e.surfaceOp.startSeq)
      const j = surface.indexOf(e.surfaceOp.endSeq)
      if (i === -1 || j === -1) { surface.push(e.seq); continue }
      surface = [...surface.slice(0, i), e.seq, ...surface.slice(j + 1)]
    }
    if (watch.has(e.seq)) snaps.set(e.seq, [...surface])
  }
  return { surface, snaps }
}

for (const path of process.argv.slice(2)) {
  const { buf, frames, bad, events } = decodeAll(path)
  const name = path.split(/[\\/]/).slice(-2)[0]
  const seqs = events.map((e) => e.seq).filter((n) => typeof n === 'number')
  console.log(`\n${'='.repeat(78)}\n${name}\n  bytes=${buf.length} frames=${frames} badFrames=${bad} events=${events.length} seq ${seqs[0]}..${seqs.at(-1)}`)

  const comp = events.filter((e) => typeof e.type === 'string' && e.type.startsWith('compaction/'))
  const starts = comp.filter((e) => e.type === 'compaction/start')
  console.log(`  compaction/* = ${comp.length}  (start=${starts.length} summary=${comp.filter((e) => e.type === 'compaction/summary').length} end=${comp.filter((e) => e.type === 'compaction/end').length})`)
  for (const s of starts) {
    const d = s.data ?? {}
    console.log(`    start seq=${s.seq} sourceCommandId=${d.sourceCommandId ?? '(none => automatic)'} turn=${JSON.stringify(d.turn)}`)
  }

  const summaries = comp.filter((e) => e.type === 'compaction/summary')
  for (const s of summaries) {
    const d = s.data
    const shadowedTypes = [...new Set((d.shadowedSeqs ?? []).map((q) => typeOf(events, q)))]
    const sysInRange = (d.shadowedSeqs ?? []).filter((q) => typeOf(events, q) === 'system/message')
    console.log(`    summary seq=${s.seq} range=${JSON.stringify(d.shadowedRange)} n=${d.shadowedSeqs?.length} tokens=${d.shadowedTokenCount}`)
    console.log(`      shadowed types = ${JSON.stringify(shadowedTypes)}`)
    console.log(`      >>> CRITERION 1  system/message inside range: ${sysInRange.length === 0 ? 'NONE (system prompt outside compaction)' : `FOUND ${JSON.stringify(sysInRange)} <<< ASSERTION FAILS`}`)
  }

  // Criterion 2: system rewrites after each compaction/end.
  const sysEvents = events.filter((e) => e.type === 'system/message')
  console.log(`  system/message events = ${sysEvents.length}`)
  for (const e of sysEvents) {
    const text = e.data?.message?.content?.[0]?.text ?? ''
    const op = e.surfaceOp === 'append' ? 'append' : JSON.stringify(e.surfaceOp)
    console.log(`    seq=${e.seq} len=${text.length} surfaceOp=${op}`)
  }
  for (const end of comp.filter((e) => e.type === 'compaction/end')) {
    const after = sysEvents.filter((e) => e.seq > end.seq)
    const next = after[0]
    if (next === undefined) {
      console.log(`    >>> CRITERION 2  after compaction/end seq=${end.seq}: NO system/message yet (log may end mid-turn)`)
    } else {
      const op = next.surfaceOp
      const target = typeof op === 'object' ? `${op.startSeq}..${op.endSeq}` : String(op)
      console.log(`    >>> CRITERION 2  after compaction/end seq=${end.seq}: system/message seq=${next.seq} surfaceOp=${JSON.stringify(op)} target=${target}`)
    }
  }

  // Live surface + final head.
  const { surface } = replay(events, new Set())
  const head = surface[0]
  const liveSys = surface.filter((q) => typeOf(events, q) === 'system/message')
  console.log(`  final surface nodes=${surface.length} head=${head}:${typeOf(events, head)} liveSystem=[${liveSys.join(',')}]`)

  // Provenance: fork/seed markers that explain a short log.
  const seed = events.find((e) => e.type === 'session/end-seed')
  const header = events[0]
  console.log(`  header: delegationDepth=${header?.delegationDepth} isSeeded=${header?.isSeeded} parent=${header?.parentSession ?? '(none)'}`)
  console.log(`  session/end-seed: ${seed === undefined ? 'none' : `seq=${seed.seq}`}`)
}
