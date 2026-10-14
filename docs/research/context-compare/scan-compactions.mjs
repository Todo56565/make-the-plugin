// Scan session logs for compaction events and report trigger / shadowed range.
//
// The log is multi-frame zstd (magic 28 B5 2F FD); node:zlib decodes only the
// FIRST frame, so split on the magic and inflate each frame independently.
//
// Usage: node scan-compactions.mjs <sessionsRoot>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
if (!root) { console.error('usage: node scan-compactions.mjs <sessionsRoot>'); process.exit(2) }
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeAll(buf) {
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
  let out = ''
  for (const f of frames) {
    try { out += zstdDecompressSync(f).toString('utf8') } catch { /* trailing partial frame during a live write */ }
  }
  return out.split('\n')
}

const sessions = []
for (const dirent of readdirSync(root, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue
  const p = join(root, dirent.name, 'session.v4.jsonl.zstd')
  try {
    const st = statSync(p)
    sessions.push({ dir: dirent.name, path: p, bytes: st.size, mtime: st.mtime })
  } catch { }
}
sessions.sort((a, b) => b.mtime - a.mtime)

for (const s of sessions) {
  const lines = decodeAll(readFileSync(s.path))
  const hits = []
  for (const line of lines) {
    if (!line.includes('compaction/')) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    const t = ev.type ?? ev.kind
    if (!String(t).startsWith('compaction/')) continue
    const d = ev.data ?? ev
    hits.push({
      seq: ev.seq,
      type: t,
      trigger: d.trigger ?? d.source?.trigger,
      commandId: d.sourceCommandId ?? d.source?.commandId,
      shadowed: d.shadowedRange ?? d.range,
      nodes: d.shadowedNodeCount ?? d.nodeCount,
      tokens: d.shadowedTokens ?? d.tokens,
      summaryTokens: d.usage?.totalTokens,
      model: d.model ?? d.route?.model,
      ts: ev.time ?? ev.ts ?? ev.timestamp,
    })
  }
  if (hits.length === 0) continue
  console.log(`\n=== ${s.dir}  ${s.bytes} B  mtime=${s.mtime.toISOString()} ===`)
  for (const h of hits) {
    console.log(`  seq=${h.seq} ${h.type}` +
      (h.trigger ? ` trigger=${h.trigger}` : '') +
      (h.commandId ? ` commandId=${h.commandId}` : '') +
      (h.shadowed ? ` shadowed=${JSON.stringify(h.shadowed)}` : '') +
      (h.nodes !== undefined ? ` nodes=${h.nodes}` : '') +
      (h.tokens !== undefined ? ` tokens=${h.tokens}` : '') +
      (h.summaryTokens !== undefined ? ` summaryTotalTokens=${h.summaryTokens}` : '') +
      (h.model ? ` model=${h.model}` : '') +
      (h.ts ? ` t=${h.ts}` : ''))
  }
}
