// Read-only, false-positive-safe scan for real pruning and spill notices.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
// The real marker is surrounded by brackets; a quoted constant in a tool result
// reads `"[... tool result middle pruned ...]"`, so require no quote adjacency.
const PRUNE = '[... tool result middle pruned ...]'
const OMITTED = /\(Omitted \d+ bytes\./
const TRUNCATED = /\[output truncated; full output: /

function load(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  const chunks = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { chunks.push(zstdDecompressSync(buf.subarray(starts[k], end))) } catch { /* torn */ }
  }
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const summary = { prune: 0, omit: 0, truncated: 0, compaction: 0, sessions: 0 }
for (const ws of readdirSync(root)) {
  const wsDir = root + '/' + ws
  if (!statSync(wsDir).isDirectory()) continue
  for (const sid of readdirSync(wsDir)) {
    const file = wsDir + '/' + sid + '/session.v4.jsonl.zstd'
    try { if (!statSync(file).isFile()) continue } catch { continue }
    const events = load(file)
    summary.sessions++
    let p = 0; let o = 0; let t = 0; let c = 0
    for (const e of events) {
      if (e.type === 'compaction/summary') c++
      if (e.type !== 'tool/result') continue
      const text = (e.data?.message?.content ?? []).map(b => b.text ?? '').join('')
      // Exclude self-quoted source text: a real marker replaces a middle span,
      // so the enclosing text is long and the marker is not inside quotes.
      if (text.includes(PRUNE) && !text.includes('"' + PRUNE + '"')) p++
      if (OMITTED.test(text)) o++
      if (TRUNCATED.test(text)) t++
    }
    summary.prune += p; summary.omit += o; summary.truncated += t; summary.compaction += c
    if (p + o + t + c > 0) console.log([ws + '/' + sid, 'prune=' + p, 'spill=' + o, 'subprocessTruncated=' + t, 'compaction=' + c].join(' | '))
  }
}
console.log('\nTOTALS sessions=' + summary.sessions + ' pruneMarkers=' + summary.prune + ' spillNotices=' + summary.omit + ' subprocessTruncations=' + summary.truncated + ' compactionSummaries=' + summary.compaction)
