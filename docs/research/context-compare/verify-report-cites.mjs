// Verify three load-bearing citations from the verification report, independently.
//
//  A. Node-0 protection: a surface replace may target the system head only via a
//     system/message over exactly that node.
//  B. Fork children rewrite the inherited ancestor head before their own first
//     request -- NB the report claims this is ROUTE-DEPENDENT: observed on the
//     cc/pi-ai route, but NOT on an in-history route.
//  C. The in-history live sample exists in another workspace with a different
//     systemPromptUpdate declaration.
//
// Read-only. Usage: node verify-report-cites.mjs <sessionsRoot...>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

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

console.log('=== C. workspaces and routes ===')
const roots = process.argv.slice(2)
let forkChecked = 0
for (const root of roots) {
  const wsName = root.split(/[\\/]/).filter(Boolean).pop()
  const sessions = []
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const log = join(root, d.name, 'session.v4.jsonl.zstd')
    try { statSync(log) } catch { continue }
    sessions.push({ id: d.name, log })
  }
  console.log(`\n-- ${wsName}: ${sessions.length} sessions --`)
  for (const s of sessions) {
    let ev
    try { ev = decode(s.log) } catch { continue }
    const h = ev[0]
    const ctxs = ev.filter((e) => e.type === 'request/context')
    const modes = [...new Set(ctxs.map((e) => e.data.systemPromptUpdate ?? '(unset)'))]
    const seeded = h.isSeeded === true
    const parent = h.parentSession
    const seedMarkers = ev.filter((e) => e.type === 'session/end-seed')
    const inherited = seedMarkers.some((e) => e.data?.inherited === true)
    if (modes.some((m) => m !== '(unset)') || (parent !== undefined)) {
      const sys = ev.filter((e) => e.type === 'system/message')
      console.log(`  ${s.id}`)
      console.log(`     depth=${h.delegationDepth} isSeeded=${seeded} parent=${parent ? parent.slice(0, 20) : '-'} inheritedMarker=${inherited} routeModes=${JSON.stringify(modes)}`)
      if (parent !== undefined) {
        forkChecked++
        // The child's OWN first step is after the last seed boundary; rewrites
        // before that are the inherited ancestor events, not the child's work.
        const seedSeqs = seedMarkers.map((e) => e.seq)
        const boundary = seedSeqs.length === 0 ? 0 : Math.max(...seedSeqs)
        const own = ev.filter((e) => e.seq > boundary)
        const ownSys = own.filter((e) => e.type === 'system/message')
        const ownRewrite = ownSys.find((e) => typeof e.surfaceOp === 'object')
        const ownStep = own.find((e) => e.type === 'step/start')
        const ownReq = own.find((e) => e.type === 'request/header')
        const ownAsst = own.find((e) => e.type === 'assistant/message')
        const r = (e) => (e === undefined ? 'none' : e.seq)
        console.log(`     seedBoundary=${boundary}  childOwn: step=${r(ownStep)} rewrite=${r(ownRewrite)} req=${r(ownReq)} asst=${r(ownAsst)}`)
        if (ownRewrite !== undefined) {
          console.log(`     >>> child rewrite before its first request: ${ownReq !== undefined && ownRewrite.seq < ownReq.seq}`)
        }
        console.log(`     all system/message: ${sys.map((e) => `${e.seq}${e.surfaceOp === 'append' ? '[append]' : '[replace@' + e.surfaceOp.startSeq + ']'}`).join(' ')}`)
      }
    }
  }
}
console.log(`\nfork children inspected: ${forkChecked}`)
