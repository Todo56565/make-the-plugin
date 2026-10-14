// Insert (or remove) the preset-standard override block in the profile patch.
//
// Idempotent and self-verifying: refuses to run if the block is already present
// (unless --replace), and prints the exact boundaries it changed so the revert
// is unambiguous.
//
// Usage:
//   node install-override.mjs <patch.yml> <override-block.yml> [--replace]
//   node install-override.mjs <patch.yml> --remove
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const [patchPath, blockPath, ...flags] = process.argv.slice(2)
if (patchPath === undefined || blockPath === undefined) {
  console.error('usage: node install-override.mjs <patch.yml> <override-block.yml> [--replace]')
  console.error('       node install-override.mjs <patch.yml> --remove')
  process.exit(2)
}
const replace = flags.includes('--replace')
const remove = blockPath === '--remove'
const MARK = 'TEMP-TEST-OVERRIDE: preset-standard'

const text = readFileSync(patchPath, 'utf8')
const lines = text.split(/\r?\n/)

// Boundary detection: the override block is a contiguous top-level run starting
// at its `- id: preset-standard` line, with its leading banner comment above it.
const entryIdx = lines.findIndex((l) => l === '- id: preset-standard')
const existing = entryIdx !== -1

if (remove) {
  if (!existing) { console.log('nothing to remove: no preset-standard entry found'); process.exit(0) }
  let first = entryIdx
  while (first > 0 && /^#/.test(lines[first - 1])) first--
  let last = entryIdx + 1
  while (last < lines.length && !/^- /.test(lines[last]) && !/^# ==/.test(lines[last])) last++
  const removed = lines.splice(first, last - first)
  // Collapse the separator blank line(s) the block left behind, so the file
  // returns to its pre-insert shape rather than accumulating empty lines.
  while (first > 0 && first < lines.length && lines[first].trim() === '' && lines[first - 1].trim() === '') lines.splice(first, 1)
  writeFileSync(patchPath, lines.join('\n'), 'utf8')
  console.log(`removed ${removed.length} lines (was lines ${first + 1}..${last})`)
  console.log('first surviving lines:')
  console.log(lines.slice(Math.max(0, first - 2), first + 3).map((l, i) => `  ${Math.max(1, first - 1) + i}: ${l}`).join('\n'))
  process.exit(0)
}

if (existing && !replace) {
  console.error(`refusing: ${patchPath} already contains a preset-standard entry at line ${entryIdx + 1}`)
  console.error('re-run with --replace, or --remove first')
  process.exit(3)
}

const blockLines = readFileSync(blockPath, 'utf8').split(/\r?\n/)
while (blockLines.length > 0 && blockLines.at(-1).trim() === '') blockLines.pop()
const banner = blockLines.findIndex((l) => l.startsWith('- id: '))
if (banner === -1) { console.error('override block has no `- id:` line'); process.exit(4) }

// Insert before the trailing `- insert:` list (which must stay last), keeping any
// blank separator lines intact.
let insertIdx = lines.findIndex((l) => /^- insert:/.test(l))
if (insertIdx === -1) insertIdx = lines.length
let at = insertIdx
while (at > 0 && lines[at - 1].trim() === '') at--

if (existing && replace) {
  let first = entryIdx
  while (first > 0 && /^#/.test(lines[first - 1])) first--
  let last = entryIdx + 1
  while (last < lines.length && !/^- /.test(lines[last]) && !/^# ==/.test(lines[last])) last++
  lines.splice(first, last - first)
  at = lines.findIndex((l) => /^- insert:/.test(l))
  if (at === -1) at = lines.length
  while (at > 0 && lines[at - 1].trim() === '') at--
  console.log(`replaced existing block (removed ${last - first} lines)`)
}

copyFileSync(patchPath, `${patchPath}.before-insert`)
const stamp = new Date().toISOString()
const out = [
  ...lines.slice(0, at),
  `# ${MARK} (inserted ${stamp})`,
  ...blockLines.slice(banner),
  '',
  ...lines.slice(at),
]
writeFileSync(patchPath, out.join('\n'), 'utf8')
console.log(`inserted ${blockLines.length - banner} override lines at line ${at + 1}`)
console.log(`pre-insert copy: ${patchPath}.before-insert`)
console.log(`bytes: ${text.length} -> ${out.join('\n').length}`)
