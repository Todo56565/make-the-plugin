// Dump the raw shape of selected events, to locate where a message's text
// actually lives. Earlier probes assumed data.text; this prints every key and
// the longest string found anywhere in the event so the field can be identified
// instead of guessed.
//
// Usage: node probe-event-shape.mjs <session.v4.jsonl.zstd> <seq[,seq...]>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [logPath, seqArg] = process.argv.slice(2)
if (!logPath || !seqArg) { console.error('usage: node probe-event-shape.mjs <log> <seq,seq,...>'); process.exit(2) }
const wanted = new Set(seqArg.split(',').map((s) => Number(s.trim())))

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

for (const ev of events) {
  if (!wanted.has(ev.seq)) continue
  console.log(`\n############ seq=${ev.seq} ############`)
  console.log('top-level keys: ' + Object.keys(ev).join(', '))
  console.log('type/kind: ' + (ev.type ?? ev.kind))
  if (ev.surfaceOp !== undefined) console.log('surfaceOp: ' + JSON.stringify(ev.surfaceOp))
  // Walk the whole event and report every string longer than 40 chars.
  const found = []
  const walk = (node, path) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') { if (node.length > 40) found.push([path, node.length, node.slice(0, 70)]); return }
    if (typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach((v, idx) => walk(v, `${path}[${idx}]`)); return }
    for (const [k, v] of Object.entries(node)) walk(v, path === '' ? k : `${path}.${k}`)
  }
  walk(ev, '')
  found.sort((a, b) => b[1] - a[1])
  console.log(`strings >40 chars (${found.length}), longest first:`)
  for (const [p, len, head] of found.slice(0, 6)) console.log(`   ${len.toString().padStart(7)}  ${p}  "${head}..."`)
}
