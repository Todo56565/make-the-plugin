// Probe 4 (decisive): reconstruct the session surface across the compaction and
// report whether the live system-prompt node survives it.
//
// Surface ops live at the EVENT TOP LEVEL (event.surfaceOp), not under data.
//   append  -> push seq
//   replace -> splice [startSeq..endSeq] down to this event's seq
// The live system prompt is the latest system/message node still on the surface.
//
// Usage: node probe-surface-replay.mjs <session.v4.jsonl.zstd>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = readFileSync(process.argv[2])
const offs = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i)
}
let text = ''
for (let k = 0; k < offs.length; k++) {
  text += zstdDecompressSync(buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)).toString('utf8')
}
const ev = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
const at = new Map(ev.map((e) => [e.seq, e]))
const typeOf = (s) => at.get(s)?.type ?? '?'
const ops = ev.filter((e) => e.surfaceOp !== undefined)

// Full replay with a snapshot at each compaction-related seq.
const watch = new Set([317, 319, 320, 321, 322, 326])
let surface = []
const snapshots = new Map()
for (const e of ops) {
  if (e.surfaceOp === 'append') surface.push(e.seq)
  else {
    const i = surface.indexOf(e.surfaceOp.startSeq)
    const j = surface.indexOf(e.surfaceOp.endSeq)
    if (i === -1 || j === -1) { console.log(`  !! replace at seq ${e.seq} targets non-surface range ${e.surfaceOp.startSeq}..${e.surfaceOp.endSeq}`); surface.push(e.seq); continue }
    surface = [...surface.slice(0, i), e.seq, ...surface.slice(j + 1)]
  }
  if (watch.has(e.seq)) snapshots.set(e.seq, [...surface])
}

const sysAlive = (s) => s.filter((q) => typeOf(q) === 'system/message')
console.log(`=== surface snapshots ===`)
for (const [s, snap] of [...snapshots].sort((a, b) => a[0] - b[0])) {
  const sys = sysAlive(snap)
  console.log(`after seq ${s} (${typeOf(s)}): nodes=${snap.length}  live system nodes=[${sys.join(',')}]  head=${snap[0]}:${typeOf(snap[0])}`)
}

console.log(`\n=== final surface ===`)
console.log(`nodes=${surface.length}`)
console.log(`first 12: ${surface.slice(0, 12).map((s) => `${s}:${typeOf(s)}`).join('  ')}`)
console.log(`last 6:   ${surface.slice(-6).map((s) => `${s}:${typeOf(s)}`).join('  ')}`)
const liveSys = sysAlive(surface)
console.log(`live system nodes: [${liveSys.join(',')}]`)
const headSys = liveSys.at(-1)
const headText = at.get(headSys)?.data?.message?.content?.[0]?.text ?? ''
console.log(`live system prompt seq=${headSys} textLen=${headText.length}`)
console.log(`head-of-surface is system: ${typeOf(surface[0]) === 'system/message'}`)

// Did the compaction checkpoint replace a range containing the live system node?
console.log(`\n=== compaction checkpoint op ===`)
const ck = ev.find((e) => e.type === 'user/message' && JSON.stringify(e.data).includes('compacted-summary'))
console.log(JSON.stringify({ seq: ck.seq, surfaceOp: ck.surfaceOp, sourceEventSeqs: ck.sourceEventSeqs?.slice(0, 5).concat(['…']) }))
const r = ck.surfaceOp
const contained = Array.isArray(r) ? false : (() => {
  const pre = snapshots.get(321) ?? []
  return { startSeq: r.startSeq, endSeq: r.endSeq, liveSystemBefore: sysAlive(pre) }
})()
console.log(JSON.stringify(contained))

// The summary's own claim about what it shadowed.
const summ = ev.find((e) => e.type === 'compaction/summary')
console.log(`\nsummary event claims shadowedRange=${JSON.stringify(summ.data.shadowedRange)} shadowedSeqs=${summ.data.shadowedSeqs.length} tokens=${summ.data.shadowedTokenCount}`)
const inRange = summ.data.shadowedSeqs.includes(headSys)
console.log(`live system seq ${headSys} inside summary.shadowedSeqs: ${inRange}`)
for (const s of summ.data.shadowedSeqs) if (typeOf(s) === 'system/message') console.log(`  shadowed list contains system/message seq ${s}`)
console.log(`shadowed types: ${JSON.stringify([...new Set(summ.data.shadowedSeqs.map(typeOf))])}`)

// Was the live system prompt re-rendered AFTER compaction, and did its text change?
console.log(`\n=== system prompt text versions ===`)
for (const e of ev.filter((x) => x.type === 'system/message')) {
  const t = e.data?.message?.content?.[0]?.text ?? ''
  console.log(`seq ${e.seq} len=${t.length} op=${e.surfaceOp === 'append' ? 'append' : JSON.stringify(e.surfaceOp)}`)
}
const before = at.get(213)?.data?.message?.content?.[0]?.text ?? ''
const after = at.get(326)?.data?.message?.content?.[0]?.text ?? ''
let d = -1
for (let i = 0; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) { d = i; break }
console.log(`\nfirst differing char index between seq213 and seq326: ${d}`)
if (d >= 0) {
  console.log(`  before: …${JSON.stringify(before.slice(Math.max(0, d - 60), d + 60))}`)
  console.log(`  after:  …${JSON.stringify(after.slice(Math.max(0, d - 60), d + 60))}`)
}
