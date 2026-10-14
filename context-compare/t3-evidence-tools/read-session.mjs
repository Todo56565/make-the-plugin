// Read-only inspection of one DSH session artifact (concatenated zstd frames -> JSONL).
// Usage: node read-session.mjs <session.v4.jsonl.zstd> [maxEvents]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const maxEvents = Number(process.argv[3] ?? 0)
const buf = readFileSync(file)

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
}
const chunks = []
let ok = 0
let failed = 0
for (let k = 0; k < starts.length; k++) {
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length
  try {
    chunks.push(zstdDecompressSync(buf.subarray(starts[k], end)))
    ok++
  } catch {
    failed++
  }
}
const text = Buffer.concat(chunks).toString('utf8')
const lines = text.split('\n').filter(l => l.trim() !== '')
const events = []
for (const l of lines) {
  try { events.push(JSON.parse(l)) } catch { /* skip torn line */ }
}

const counts = new Map()
for (const e of events) counts.set(e.type ?? '?', (counts.get(e.type ?? '?') ?? 0) + 1)
console.log('file          : ' + file)
console.log('bytes         : ' + buf.length)
console.log('frames ok/fail: ' + ok + '/' + failed)
console.log('jsonl records : ' + lines.length + ' (parsed ' + events.length + ')')
console.log('record types  : ' + [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => t + '=' + n).join(', '))
for (const e of events.slice(0, maxEvents)) console.log(JSON.stringify(e).slice(0, 400))
