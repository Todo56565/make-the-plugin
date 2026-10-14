// Dump the raw compaction bracket of a session, verbatim, so claims about token
// counts, trigger mode and shadowed ranges are audited against the data rather
// than against a summary of the data.
//
// Usage: node dump-compaction-raw.mjs <log.zstd> [seqLo] [seqHi]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const buf = readFileSync(process.argv[2])
const lo = process.argv[3] === undefined ? -Infinity : Number(process.argv[3])
const hi = process.argv[4] === undefined ? Infinity : Number(process.argv[4])
const offs = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
}
let text = ''
for (let k = 0; k < offs.length; k++) {
  text += zstdDecompressSync(buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)).toString('utf8')
}
const events = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
const fmtTime = (t) => new Date(t).toISOString()

for (const e of events) {
  if (typeof e.seq !== 'number' || e.seq < lo || e.seq > hi) continue
  if (!/^compaction\//.test(e.type) && e.type !== 'system/message') continue
  const d = e.data ?? {}
  console.log(`\n[seq ${e.seq}] ${e.type}  at ${fmtTime(e.time)}  surfaceOp=${JSON.stringify(e.surfaceOp)}`)
  if (e.type === 'compaction/start') {
    console.log(`  compactionId=${d.compactionId}  sourceCommandId=${d.sourceCommandId ?? '(NONE => AUTOMATIC)'}  turn=${JSON.stringify(d.turn)}`)
  } else if (e.type === 'compaction/summary') {
    console.log(`  compactionId=${d.compactionId}  sourceCommandId=${d.sourceCommandId ?? '(NONE)'}`)
    console.log(`  shadowedRange=${JSON.stringify(d.shadowedRange)}  shadowedSeqs=${d.shadowedSeqs?.length}  shadowedTokenCount=${d.shadowedTokenCount}`)
    console.log(`  provider=${d.provider}  model=${d.model}  maxTokens=${d.maxTokens}`)
    console.log(`  usage=${JSON.stringify(d.usage)}`)
    console.log(`  llmStreamCall=${JSON.stringify(d.llmStreamCall)}`)
    console.log(`  rawOutput keys=${d.rawOutput === undefined ? 'none' : JSON.stringify(Object.keys(d.rawOutput))}`)
  } else if (e.type === 'compaction/end') {
    console.log(`  compactionId=${d.compactionId}  sourceCommandId=${d.sourceCommandId ?? '(NONE)'}`)
  } else {
    const t = d.message?.content?.[0]?.text ?? ''
    console.log(`  textLen=${t.length}`)
  }
}
