// Probe 3: the exact surface-op key name, and the precise relationship between
// compaction and the system-prompt head node.
//
// probe 1 assumed data.surfaceOp and got 0 nodes; probe 2 showed the same key
// absent. Read keys from the data instead of guessing, then answer:
//   (a) which event carries the head rewrite, and what is the op key called?
//   (b) what surface range does the compaction checkpoint replace?
//   (c) is the system head inside or outside that range?
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = readFileSync(process.argv[2])
const offsets = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
}
let text = ''
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k]
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
}
const events = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

// (a) Which key holds the surface op?
console.log('=== data keys by event type (looking for the surface-op carrier) ===')
const byType = new Map()
for (const e of events) {
  if (e.data === null || typeof e.data !== 'object') continue
  const keys = Object.keys(e.data).sort().join(',')
  if (!byType.has(e.type)) byType.set(e.type, new Set())
  byType.get(e.type).add(keys)
}
for (const [t, sets] of byType) console.log(`${t}\n    ${[...sets].join('\n    ')}`)

console.log('\n=== events whose data mentions surface/replace/intent ===')
for (const e of events) {
  const s = JSON.stringify(e.data ?? {})
  if (!/surface|replace|intent/i.test(s)) continue
  const keys = Object.keys(e.data).filter((k) => /surface|replace|intent/i.test(k))
  console.log(`[seq ${e.seq}] ${e.type}  keys=${JSON.stringify(keys)}`)
}

// (b) The compaction checkpoint message in full shape.
console.log('\n=== user/message events carrying the checkpoint ===')
for (const e of events) {
  if (e.type !== 'user/message') continue
  const s = JSON.stringify(e.data)
  if (!s.includes('compacted-summary')) continue
  console.log(`[seq ${e.seq}] top-level keys: ${JSON.stringify(Object.keys(e))}`)
  console.log(`[seq ${e.seq}] data keys: ${JSON.stringify(Object.keys(e.data))}`)
  console.log(JSON.stringify(e, (k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v), 1).slice(0, 2500))
}

// (c) The system head rewrites: same seq reused, or new seqs?
console.log('\n=== system/message seqs and their neighbours ===')
const sysSeqs = events.filter((e) => e.type === 'system/message').map((e) => e.seq)
for (const s of sysSeqs) {
  const around = events.filter((e) => typeof e.seq === 'number' && e.seq >= s - 2 && e.seq <= s + 2).map((e) => `${e.seq}:${e.type}`)
  console.log(`sys seq ${s}  context: ${around.join('  ')}`)
}
