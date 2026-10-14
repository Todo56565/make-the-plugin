// Which sessions existed before the threshold override, and how much pressure
// did they carry? This decides whether the observed automatic compactions can be
// credited to the override at all.
//
// Key timing fact used here: the profile patch override was first inserted at
// 2026-10-12T11:59:34.168Z (2026-10-12 19:59:34 +08:00).
//
// Usage: node probe-pressure-timeline.mjs <sessionsRoot> <projcacheDir>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const OVERRIDE_AT = Date.parse('2026-10-12T11:59:34.168Z')
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function decode(path) {
  const buf = readFileSync(path)
  const offs = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
  }
  let text = ''
  for (let k = 0; k < offs.length; k++) {
    text += zstdDecompressSync(buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)).toString('utf8')
  }
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
}

const [root, cacheDir] = process.argv.slice(2)

// Pressure from the projection cache.
const pressure = new Map()
for (const f of readdirSync(cacheDir)) {
  if (!f.endsWith('.json')) continue
  try {
    const j = JSON.parse(readFileSync(join(cacheDir, f), 'utf8'))
    const cp = (j.record.rows ?? j.record.rowStates)?.contextPressure
    if (cp !== undefined) pressure.set(f.replace(/\.json$/, ''), { pressure: cp.val.pressureTokens, surface: cp.val.surfaceTokens, window: cp.val.contextWindow })
  } catch { /* ignore */ }
}

const rows = []
for (const dir of readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const log = join(root, dir.name, 'session.v4.jsonl.zstd')
  let st
  try { st = statSync(log) } catch { continue }
  let events
  try { events = decode(log) } catch { continue }
  const times = events.map((e) => e.time).filter((t) => typeof t === 'number')
  const first = times[0]
  const last = times.at(-1)
  const header = events[0]
  const seed = events.find((e) => e.type === 'session/end-seed')
  const comps = events.filter((e) => e.type === 'compaction/start')
  rows.push({
    id: dir.name,
    logMtime: st.mtime.toISOString(),
    first,
    last,
    spanMin: (last - first) / 60000,
    depth: header?.delegationDepth,
    seeded: header?.isSeeded,
    seedAt: seed?.time,
    comps: comps.map((c) => ({ seq: c.seq, auto: c.data?.sourceCommandId === undefined, cmd: c.data?.sourceCommandId })),
    pressure: pressure.get(dir.name),
  })
}

const fmt = (t) => (typeof t === 'number' ? new Date(t).toISOString() : '(none)')
console.log(`override first inserted at ${new Date(OVERRIDE_AT).toISOString()}  (local 19:59:34 +08:00)\n`)
rows.sort((a, b) => (a.logMtime ?? '').localeCompare(b.logMtime ?? ''))
for (const r of rows) {
  const flags = [r.depth === 1 ? 'SUB' : 'TOP', r.seeded ? 'seeded' : '', r.seedAt !== undefined ? 'has-end-seed' : ''].filter(Boolean).join(' ')
  console.log(`${r.id}`)
  console.log(`  log mtime=${r.logMtime}  span=${r.spanMin.toFixed(1)}min  ${flags}`)
  console.log(`  first event at ${fmt(r.first)}   last event at ${fmt(r.last)}`)
  console.log(`  compression: ${r.comps.length === 0 ? 'none' : r.comps.map((c) => `seq${c.seq}${c.auto ? '[AUTO]' : '[manual]'}`).join(' ')}`)
  console.log(`  pressure: ${r.pressure === undefined ? '(no cache row)' : `pressureTokens=${r.pressure.pressure} surfaceTokens=${r.pressure.surface} window=${r.pressure.window}`}`)
}
