// T3 evidence checker: each `<!-- src: path:start-end -->` marker is verified
// against the NEAREST following fence that matches it verbatim (runtime/command
// blocks between a marker and its snippet do not break pairing). Unmarked
// non-empty blocks are reported as runtime/command evidence.
//
// Usage: node check-t3-evidence.mjs <report.md> <dshRoot> <dshHome> [--list-unmarked]
import { readdirSync, readFileSync } from 'node:fs'

const F = String.fromCharCode(96, 96, 96)
const MARKER = /^<!--\s*src:\s*(.+?):(\d+)-(\d+)\s*-->$/
const MAX = 20

const reportPath = process.argv[2]
const roots = process.argv.slice(3).filter(a => !a.startsWith('--'))
const listUnmarked = process.argv.includes('--list-unmarked')

function walk(dir, depth, out) {
  if (depth > 8) return out
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = dir + '\\' + e.name
    if (e.isDirectory()) walk(full, depth + 1, out)
    else if (/\.(js|ts|json|yml|yaml|md)$/.test(e.name)) out.push(full)
  }
  return out
}

const sources = new Map()
for (const root of roots) for (const f of walk(root, 0, [])) {
  const k = f.replace(/\//g, '\\').toLowerCase()
  if (!sources.has(k)) sources.set(k, readFileSync(f, 'utf8').split(/\r?\n/))
}
function resolve(file) {
  const needle = file.replace(/\//g, '\\').toLowerCase()
  if (sources.has(needle)) return sources.get(needle)
  for (const [k, v] of sources) if (k.endsWith(needle)) return v
  return undefined
}

const lines = readFileSync(reportPath, 'utf8').split(/\r?\n/)
const markers = []
const blocks = []
let inF = false
let body = []
let start = 0
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (!inF) {
    const m = MARKER.exec(line.trim())
    if (m !== null) { markers.push({ line: i + 1, file: m[1], start: Number(m[2]), end: Number(m[3]) }); continue }
  }
  if (line.startsWith(F)) {
    if (!inF) { inF = true; body = []; start = i + 1 } else {
      inF = false
      const copy = [...body]
      while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop()
      blocks.push({ body: copy, start })
    }
    continue
  }
  if (inF) body.push(line)
}

function sliceMatch(src, range, block) {
  for (let o = 0; o + block.length <= range.length; o++) {
    let good = true
    for (let k = 0; k < block.length; k++) if (range[o + k] !== block[k]) { good = false; break }
    if (good) return o
  }
  return null
}

let failures = 0
let ok = 0
let compared = 0
const claimed = new Set()

for (const m of markers) {
  const src = resolve(m.file)
  if (src === undefined) { failures++; console.log('FAIL marker ' + m.line + ': cannot resolve ' + m.file); continue }
  const range = src.slice(m.start - 1, m.end)
  // Nearest following unclaimed block that matches verbatim (allow gaps).
  let found = null
  const following = blocks.filter(b => b.start > m.line && b.body.length > 0 && !claimed.has(b.start)).slice(0, 6)
  for (const b of following) {
    const off = sliceMatch(src, range, b.body)
    if (off !== null) { found = { block: b, off }; break }
  }
  if (found === null) {
    failures++
    console.log('FAIL ' + m.file + ':' + m.start + '-' + m.end + ' (marker line ' + m.line + ') no verbatim match in the next ' + following.length + ' block(s)')
    if (following[0] !== undefined) console.log('  next block first: ' + JSON.stringify(following[0].body[0].slice(0, 90)))
    continue
  }
  claimed.add(found.block.start)
  if (found.block.body.length > MAX) { failures++; console.log('FAIL report:' + found.block.start + ' is ' + found.block.body.length + ' lines (>' + MAX + ')'); continue }
  ok++
  compared += found.block.body.length
  console.log('ok   ' + m.file + ':' + (m.start + found.off) + '-' + (m.start + found.off + found.block.body.length - 1) + ' (' + found.block.body.length + ' lines)')
}

let unmarked = 0
for (const b of blocks) {
  if (b.body.length === 0 || claimed.has(b.start)) continue
  unmarked++
  if (listUnmarked) console.log('unmarked(report:' + b.start + ', ' + b.body.length + ' lines): ' + JSON.stringify(b.body[0].slice(0, 70)))
}

console.log('---')
console.log('markers        : ' + markers.length)
console.log('snippets ok    : ' + ok)
console.log('lines compared : ' + compared)
console.log('unmarked blocks: ' + unmarked + ' (runtime/command evidence)')
console.log('failures       : ' + failures)
process.exit(failures === 0 ? 0 : 1)
