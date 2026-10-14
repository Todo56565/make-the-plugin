// Full census: every compaction in every workspace session log, with the facts
// needed to audit the record's citations.
//
// Reports per session: log mtime, event count, and for each compaction its
// trigger (sourceCommandId present => manual /compact; absent => automatic),
// shadowed range, and whether a system/message appears after it.
//
// Usage: node census-compactions.mjs <sessionsRoot>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
function decodeAll(path) {
  const buf = readFileSync(path)
  const offs = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
  }
  let text = ''
  for (let k = 0; k < offs.length; k++) {
    text += zstdDecompressSync(buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)).toString('utf8')
  }
  const events = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try { events.push(JSON.parse(t)) } catch { /* preamble */ }
  }
  return events
}

const root = process.argv[2]
const rows = []
for (const dir of readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const log = join(root, dir.name, 'session.v4.jsonl.zstd')
  let st
  try { st = statSync(log) } catch { continue }
  let events
  try { events = decodeAll(log) } catch (e) { rows.push({ id: dir.name, error: String(e.message) }); continue }
  const typeOf = (q) => events.find((e) => e.seq === q)?.type ?? '?'
  const comp = events.filter((e) => typeof e.type === 'string' && e.type.startsWith('compaction/'))
  const sys = events.filter((e) => e.type === 'system/message')
  const starts = comp.filter((e) => e.type === 'compaction/start')
  const summaries = comp.filter((e) => e.type === 'compaction/summary')
  const ends = comp.filter((e) => e.type === 'compaction/end')
  const header = events[0]
  const perStart = starts.map((s, i) => {
    const sum = summaries[i]
    const end = ends[i]
    const after = end === undefined ? [] : sys.filter((e) => e.seq > end.seq)
    const shadowedTypes = sum === undefined ? [] : [...new Set((sum.data.shadowedSeqs ?? []).map(typeOf))]
    return {
      start: s.seq,
      auto: s.data?.sourceCommandId === undefined,
      cmd: s.data?.sourceCommandId,
      range: sum?.data?.shadowedRange,
      n: sum?.data?.shadowedSeqs?.length,
      tokens: sum?.data?.shadowedTokenCount,
      sysInRange: (sum?.data?.shadowedSeqs ?? []).filter((q) => typeOf(q) === 'system/message').length,
      shadowedTypes,
      end: end?.seq,
      sysAfter: after.map((e) => e.seq),
    }
  })
  rows.push({
    id: dir.name,
    mtime: st.mtime.toISOString(),
    bytes: st.size,
    events: events.length,
    seqMax: events.at(-1)?.seq,
    depth: header?.delegationDepth,
    seeded: header?.isSeeded,
    parent: header?.parentSession,
    sysCount: sys.length,
    sysSeqs: sys.map((e) => `${e.seq}(${(e.data?.message?.content?.[0]?.text ?? '').length})`),
    compactions: perStart,
  })
}

rows.sort((a, b) => (a.mtime ?? '').localeCompare(b.mtime ?? ''))
for (const r of rows) {
  if (r.error !== undefined) { console.log(`${r.id}  ERROR ${r.error}`); continue }
  const flags = [r.depth === 1 ? 'sub' : 'top', r.seeded ? 'SEEDED' : '', r.parent ? `parent=${r.parent.slice(0, 18)}` : ''].filter(Boolean).join(' ')
  console.log(`\n${r.id}`)
  console.log(`  mtime=${r.mtime} bytes=${r.bytes} events=${r.events} seqMax=${r.seqMax} ${flags}`)
  console.log(`  system/message x${r.sysCount}: ${r.sysSeqs.join(', ')}`)
  if (r.compactions.length === 0) { console.log('  compactions: none') ; continue }
  for (const c of r.compactions) {
    console.log(`  COMPACTION start=${c.start} ${c.auto ? 'AUTOMATIC (no commandId)' : `manual cmd=${c.cmd}`} end=${c.end}`)
    console.log(`    range=${JSON.stringify(c.range)} n=${c.n} tokens=${c.tokens}`)
    console.log(`    shadowedTypes=${JSON.stringify(c.shadowedTypes)} systemInRange=${c.sysInRange}`)
    console.log(`    system/message AFTER end: ${c.sysAfter.length === 0 ? 'NONE' : JSON.stringify(c.sysAfter)}`)
  }
}
