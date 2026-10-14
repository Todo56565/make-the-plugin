// Read-only inspection of compaction/* event payloads and the spill footer.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

function load(file) {
  const buf = readFileSync(file)
  const M = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) starts.push(i)
  const chunks = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { chunks.push(zstdDecompressSync(buf.subarray(starts[k], end))) } catch { /* torn */ }
  }
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

for (const file of process.argv.slice(2)) {
  const events = load(file)
  console.log('\n######## ' + file.split('sessions\\').pop())
  for (const e of events) {
    if (e.type.startsWith('compaction/')) {
      const s = JSON.stringify(e)
      console.log('--- seq=' + e.seq + ' type=' + e.type + ' keys=' + Object.keys(e.data ?? {}).join(',') + ' bytes=' + s.length)
      console.log(s.slice(0, 900))
    }
  }
  const spill = events.find(e => JSON.stringify(e).includes('Full formatted result stored at:'))
  if (spill !== undefined) {
    const text = spill.data.message.content.map(b => b.text ?? '').join('')
    const at = text.indexOf('Full formatted result stored at:')
    console.log('--- spill footer in tool/result seq=' + spill.seq + ' (chars=' + text.length + '):')
    console.log(JSON.stringify(text.slice(Math.max(0, at - 220), at + 320)))
  }
  const pruned = events.find(e => JSON.stringify(e).includes('tool result middle pruned'))
  if (pruned !== undefined) {
    const text = pruned.data.message.content.map(b => b.text ?? '').join('')
    console.log('--- pruned tool/result seq=' + pruned.seq + ' (chars=' + text.length + '):')
    console.log(JSON.stringify(text.slice(0, 160)) + ' ... ' + JSON.stringify(text.slice(-160)))
  }
}
