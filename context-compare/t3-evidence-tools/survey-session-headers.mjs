// Read-only header survey of every DSH session artifact under a workspace dir.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function headerOf(file) {
  const buf = readFileSync(file)
  // The header is the first zstd frame; decode only up to the second magic.
  const second = (() => {
    for (let i = 4; i + 4 <= buf.length; i++) {
      if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) return i
    }
    return buf.length
  })()
  const text = zstdDecompressSync(buf.subarray(0, second)).toString('utf8')
  return JSON.parse(text.split('\n')[0])
}

for (const name of readdirSync(root)) {
  const dir = root + '/' + name
  if (!statSync(dir).isDirectory()) continue
  const file = dir + '/session.v4.jsonl.zstd'
  try {
    const h = headerOf(file)
    const size = statSync(file).size
    console.log([name, size, 'depth=' + h.delegationDepth, 'seeded=' + h.isSeeded, 'origin=' + (h.origin ?? '-'), 'parent=' + (h.parentSession ?? '-'), 'preset=' + (h.agentPreset ?? '-')].join(' | '))
  } catch (error) {
    console.log(name + ' | ' + String(error.message))
  }
}
