// Read-only: classify every compaction transaction by trigger (manual vs automatic).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
const M = [0x28, 0xb5, 0x2f, 0xfd]

function load(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) starts.push(i)
  const chunks = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { chunks.push(zstdDecompressSync(buf.subarray(starts[k], end))) } catch { /* torn */ }
  }
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

let manual = 0; let auto = 0; let failed = 0; let shadowedTokens = 0; let shadowedNodes = 0
const rows = []
for (const ws of readdirSync(root)) {
  const wsDir = root + '/' + ws
  if (!statSync(wsDir).isDirectory()) continue
  for (const sid of readdirSync(wsDir)) {
    const file = wsDir + '/' + sid + '/session.v4.jsonl.zstd'
    try { if (!statSync(file).isFile()) continue } catch { continue }
    let m = 0; let a = 0; let f = 0
    for (const e of load(file)) {
      if (e.type === 'compaction/summary') {
        if (e.data?.sourceCommandId !== undefined) m++; else a++
        shadowedTokens += e.data?.shadowedTokenCount ?? 0
        shadowedNodes += e.data?.shadowedSeqs?.length ?? 0
      }
      if (e.type === 'compaction/end' && e.data?.error !== undefined) f++
    }
    manual += m; auto += a; failed += f
    if (m + a + f > 0) rows.push([ws + '/' + sid, 'manual=' + m, 'automatic=' + a, 'failed=' + f].join(' | '))
  }
}
console.log(rows.join('\n'))
console.log('\nTOTALS manualSummaries=' + manual + ' automaticSummaries=' + auto + ' failedCompactions=' + failed)
console.log('shadowedNodes=' + shadowedNodes + ' shadowedTokensSum=' + shadowedTokens)
