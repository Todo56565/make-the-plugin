// Read-only: complete session event vocabulary across every real session log.
// Usage: node event-vocabulary.mjs <sessionsRoot>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
const M = [0x28, 0xb5, 0x2f, 0xfd]
const counts = new Map()
let sessions = 0
let records = 0

for (const ws of readdirSync(root)) {
  const d = root + '\\' + ws
  if (!statSync(d).isDirectory()) continue
  for (const sid of readdirSync(d)) {
    const f = d + '\\' + sid + '\\session.v4.jsonl.zstd'
    try { if (!statSync(f).isFile()) continue } catch { continue }
    const buf = readFileSync(f)
    const starts = []
    for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) starts.push(i)
    const chunks = []
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1] : buf.length
      try { chunks.push(zstdDecompressSync(buf.subarray(starts[k], end))) } catch { /* torn */ }
    }
    sessions++
    for (const l of Buffer.concat(chunks).toString('utf8').split('\n')) {
      if (l.trim() === '') continue
      records++
      try { const e = JSON.parse(l); counts.set(e.type, (counts.get(e.type) ?? 0) + 1) } catch { /* torn */ }
    }
  }
}
console.log('sessions=' + sessions + ' records=' + records + ' distinctTypes=' + counts.size)
for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(7) + '  ' + t)
const noteish = [...counts.keys()].filter(t => /note|memor|feedback/i.test(t))
console.log('\nnote/memory/feedback event types: ' + (noteish.length === 0 ? '(none)' : noteish.join(', ')))
