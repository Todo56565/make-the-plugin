// Why did session-dee7fe rewrite its system prompt right after compaction while
// session-f59ff5a3 / session-f729634a did not?
//
// Competing explanations:
//   (H1) compaction itself changes surface.contentGeneration, so the next step
//        starts a new request series and consolidates the prompt at the head;
//   (H2) the rewrite in dee7fe was a MODEL SWAP (request/context change), which
//        happens to land right after that session's compaction -- coincidence,
//        not cause.
//
// Discriminator: for each session, list request/context changes and line them up
// against system/message rewrites and compaction sequencerange.
//
// Usage: node probe-why-rerender.mjs <log1.zstd> [...]
import { readFileSync } from 'node:fs'
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

for (const path of process.argv.slice(2)) {
  const events = decode(path)
  const name = path.split(/[\\/]/).slice(-2)[0]
  console.log(`\n${'='.repeat(78)}\n${name}`)

  const show = (label, pred, fmt) => {
    const hits = events.filter(pred)
    console.log(`  ${label}: ${hits.length}`)
    for (const e of hits) console.log(`    seq=${e.seq}  ${fmt(e)}`)
  }

  show('request/context (provider.model change)', (e) => e.type === 'request/context',
    (e) => `${e.data.provider}/${e.data.model} window=${e.data.contextWindow} systemPromptUpdate=${e.data.systemPromptUpdate ?? '(unset)'}`)
  show('request/header', (e) => e.type === 'request/header',
    (e) => `reason=${e.data.reason} startsSeries=${e.data.startsSeries ?? '(unset)'}`)
  show('system/message', (e) => e.type === 'system/message',
    (e) => `len=${(e.data?.message?.content?.[0]?.text ?? '').length} surfaceOp=${JSON.stringify(e.surfaceOp)}`)
  show('compaction/start', (e) => e.type === 'compaction/start',
    (e) => `sourceCommandId=${e.data.sourceCommandId ?? '(none => automatic)'}`)
  show('compaction/end', (e) => e.type === 'compaction/end', () => '')
  show('turn/start', (e) => e.type === 'turn/start', (e) => `turn=${e.data.turn}`)

  // Did the model ever change? If yes, were the rewrites adjacent to that?
  const ctx = events.filter((e) => e.type === 'request/context').map((e) => ({ seq: e.seq, model: e.data.model }))
  console.log(`  distinct models: ${JSON.stringify([...new Set(ctx.map((c) => c.model))])}`)
}
