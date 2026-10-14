// Probe 2: verify the decoder before trusting probe 1's conclusions.
//
// Suspicion: 362 "frames" for a 721 KB file is implausible for a normal zstd
// log, and "surface replay" produced 0 nodes, which means probe 1 read the
// wrong key for surface operations. Verify the frame split by checking that
// decoded output is a contiguous, monotonic JSONL event stream, and align the
// real key names against the compaction-basic source.
//
// Usage: node probe-verify-decode.mjs <session.v4.jsonl.zstd>
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = readFileSync(process.argv[2])

const offsets = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
}
console.log(`candidate magic offsets: ${offsets.length}`)
console.log(`first 10 offsets: ${offsets.slice(0, 10).join(', ')}`)
console.log(`gap sizes (first 10): ${offsets.slice(1, 11).map((o, i) => o - offsets[i]).join(', ')}`)

const parts = []
let ok = 0, bad = 0
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k]
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  try {
    parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    ok++
  } catch { bad++ }
}
const text = parts.join('')
writeFileSync(process.argv[2] + '.decoded.txt', text)
console.log(`frames ok=${ok} bad=${bad} decodedBytes=${text.length} ratio=${(buf.length / text.length).toFixed(3)} (compressed:raw)`)

const lines = text.split('\n').filter((l) => l.trim() !== '')
let parsed = 0, failed = 0
const events = []
for (const line of lines) {
  try { events.push(JSON.parse(line)); parsed++ } catch { failed++ }
}
console.log(`lines=${lines.length} parsed=${parsed} unparsable=${failed}`)

// Contiguity / monotonicity: the log should be a single ordered stream.
const seqs = events.map((e) => e.seq).filter((s) => typeof s === 'number')
let mono = true
for (let i = 1; i < seqs.length; i++) if (seqs[i] <= seqs[i - 1]) { mono = false; console.log(`  non-monotonic at index ${i}: ${seqs[i - 1]} -> ${seqs[i]}`); break }
console.log(`seq range ${seqs[0]}..${seqs.at(-1)} count=${seqs.length} monotonic=${mono} contiguous=${seqs.at(-1) - seqs[0] + 1 === seqs.length}`)

console.log(`\n=== event types (top 20) ===`)
const counts = new Map()
for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`${String(n).padStart(4)}  ${t}`)

// Raw shapes around the compaction, so key names come from data not guesswork.
const idx = events.findIndex((e) => e.type === 'compaction/start')
console.log(`\n=== raw events seq 316..322 (full JSON, trimmed to 900 chars each) ===`)
for (const e of events) {
  if (typeof e.seq !== 'number' || e.seq < 316 || e.seq > 322) continue
  const s = JSON.stringify(e)
  console.log(`\n[seq ${e.seq}] ${e.type}\n${s.length > 900 ? s.slice(0, 900) + '…' : s}`)
}

// Where does surface state actually live? Look at a system/message and its neighbours.
const sys7 = events.find((e) => e.type === 'system/message')
console.log(`\n=== raw first system/message (seq ${sys7?.seq}) ===`)
console.log(JSON.stringify(sys7).slice(0, 1200))
console.log(`\n=== neighbors of that seq ===`)
for (const e of events) {
  if (typeof e.seq !== 'number') continue
  if (e.seq >= sys7.seq - 2 && e.seq <= sys7.seq + 2) console.log(`[${e.seq}] ${e.type}`)
}
