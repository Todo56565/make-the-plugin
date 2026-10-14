// T2 final evidence checker.
//
// Part A: every ```ts block must be a verbatim slice of some loaded source file,
//         must be <= 15 lines, and must have a preceding `<!-- src: F:S-E -->`
//         marker whose file contains the block and whose range covers it.
// Part B: every docs excerpt fence must quote the cited docs file.
//
// Usage: node check-t2-evidence.mjs <report.md> <repoRoot> <dshRoot?>
import { readdirSync, readFileSync } from 'node:fs'

const [reportPath, repoRoot, dshRoot] = process.argv.slice(2)
const MAX = 15
const F = String.fromCharCode(96, 96, 96)
const MARKER = /^<!--\s*src:\s*(.+?):(\d+)(?:-(\d+))?\s*-->$/

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
    const full = dir + '/' + e.name
    if (e.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|md)$/.test(e.name)) out.push(full)
  }
  return out
}

const sources = new Map()
for (const [prefix, root] of [['', repoRoot], ['@deepseek-ai/', dshRoot]]) {
  if (root === undefined) continue
  for (const file of walk(root)) sources.set(prefix + file.slice(root.length + 1), readFileSync(file, 'utf8').split(/\r?\n/))
}

const lines = readFileSync(reportPath, 'utf8').split(/\r?\n/)

// Pass 1: all fences and all markers, keyed by line number.
const markers = []
const blocks = []
let inF = false
let body = []
let start = 0
let tag = ''
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (!inF) {
    const m = MARKER.exec(line.trim())
    if (m !== null) markers.push({ line: i + 1, file: m[1], start: Number(m[2]), end: m[3] === undefined ? Number(m[2]) : Number(m[3]) })
  }
  if (line.startsWith(F)) {
    if (!inF) { inF = true; body = []; start = i + 1; tag = line.slice(3) } else {
      inF = false
      const copy = [...body]
      while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop()
      blocks.push({ body: copy, start, tag })
    }
    continue
  }
  if (inF) body.push(line)
}

function markerBefore(line) {
  let best = null
  for (const m of markers) if (m.line < line && (best === null || m.line > best.line)) best = m
  return best
}

function findSlice(file, block) {
  const src = sources.get(file)
  if (src === undefined) return { error: 'unknown source ' + file }
  for (let s = 0; s + block.length <= src.length; s++) {
    let ok = true
    for (let k = 0; k < block.length; k++) if (src[s + k] !== block[k]) { ok = false; break }
    if (ok) return { start: s + 1, end: s + block.length }
  }
  return { error: 'not verbatim in ' + file }
}

let failures = 0
let okCount = 0
let compared = 0
for (const b of blocks) {
  if (!b.tag.startsWith('ts') || b.body.length === 0) continue
  const m = markerBefore(b.start)
  if (m === null) {
    failures++
    console.log('FAIL report:' + b.start + ' ts block has no preceding src marker')
    continue
  }
  const found = findSlice(m.file, b.body)
  if (found.error !== undefined) {
    failures++
    console.log('FAIL report:' + b.start + ' (marker@' + m.line + ' ' + m.file + ':' + m.start + '-' + m.end + '): ' + found.error)
    console.log('  first: ' + JSON.stringify(b.body[0]))
    continue
  }
  if (!(found.start >= m.start && found.end <= m.end)) {
    failures++
    console.log('FAIL report:' + b.start + ' marker ' + m.file + ':' + m.start + '-' + m.end + ' does not cover block at ' + found.start + '-' + found.end)
    continue
  }
  if (b.body.length > MAX) {
    failures++
    console.log('FAIL report:' + b.start + ' snippet is ' + b.body.length + ' lines (> ' + MAX + ')')
    continue
  }
  okCount++
  compared += b.body.length
  console.log('ok   ' + m.file + ':' + found.start + '-' + found.end + ' (' + b.body.length + ' lines)')
}

// Part B: docs excerpts.
const DOC = /`(docs\/[A-Za-z0-9_./-]+\.md):(\d+)`/g
const docs = []
for (let i = 0; i < lines.length; i++) {
  for (const m of lines[i].matchAll(new RegExp(DOC.source, 'g'))) docs.push({ line: i + 1, file: m[1], no: Number(m[2]) })
}
let docOk = 0
for (const b of blocks) {
  if (b.tag !== '' || b.body.length === 0) continue
  let best = null
  for (const d of docs) if (d.line < b.start && (best === null || d.line > best.line)) best = d
  if (best === null) continue
  const src = readFileSync(repoRoot + '/' + best.file, 'utf8').split(/\r?\n/)
  let at = null
  for (let s = 0; s + b.body.length <= src.length; s++) {
    let ok = true
    for (let k = 0; k < b.body.length; k++) if (src[s + k] !== b.body[k]) { ok = false; break }
    if (ok) { at = s + 1; break }
  }
  if (at === null) {
    failures++
    console.log('FAIL report:' + b.start + ' docs excerpt is not verbatim in ' + best.file)
    continue
  }
  docOk++
  console.log('ok   docs ' + best.file + ':' + at + '-' + (at + b.body.length - 1) + ' (report:' + b.start + ')')
}

console.log('---')
console.log('src snippets ok   : ' + okCount)
console.log('src lines compared: ' + compared)
console.log('docs excerpts ok  : ' + docOk)
console.log('failures          : ' + failures)
process.exit(failures === 0 ? 0 : 1)
