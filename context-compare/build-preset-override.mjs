// Generate a top-level `preset-standard` override block from the composed
// config dump, changing ONLY the internal compaction entry's trigger.
//
// Why this shape: --dump-config proved (diff of 3 lines) that a top-level
// `- id: compaction-basic` patch lands on the HOST-plane entry, which carries
// `disabled: true`, while the live backend is the entry the standard preset
// mounts inside its isolated `compaction` group. The profile patch layer cannot
// address that nested entry, so the only reachable knob is the preset
// DECLARATION row, whose override replaces the complete config
// (editing-cordis-compositions SKILL.md:56).
//
// Usage: node build-preset-override.mjs <composed-config.txt> <out.yml> <thresholdRatio> <retainRatio>
import { readFileSync, writeFileSync } from 'node:fs'

const [dumpPath, outPath, thresholdRatio, retainRatio] = process.argv.slice(2)
for (const [n, v] of [['dumpPath', dumpPath], ['outPath', outPath], ['thresholdRatio', thresholdRatio]]) {
  if (v === undefined) { console.error(`missing ${n}`); process.exit(2) }
}

const lines = readFileSync(dumpPath, 'utf8').split(/\r?\n/)

// Locate the top-level `- id: preset-standard` entry and its end (next
// top-level entry or provenance comment at column 0).
const start = lines.findIndex((l) => l === '- id: preset-standard')
if (start === -1) { console.error('preset-standard block not found in dump'); process.exit(3) }
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^- /.test(lines[i]) || /^# ==/.test(lines[i])) { end = i; break }
}
const block = lines.slice(start, end)

// The declaration may already be preceded by a provenance comment; drop it so
// only entry lines are reformatted. Comments INSIDE the block are preserved.
const body = block.filter((l) => l !== '' && !/^# ==/.test(l))
if (body[0] !== '- id: preset-standard') { console.error(`unexpected block start: ${body[0]}`); process.exit(4) }

// Insert the new compaction config. The nested entry currently carries no
// config, so add it right after the compaction-basic name line.
const cbi = body.findIndex((l) => l.trim() === "- id: compaction-basic")
if (cbi === -1) { console.error('nested compaction-basic entry not found'); process.exit(5) }
const cbNameIdx = body[cbi + 1]
if (!/'@deepseek-ai\/dsh-compaction-basic'/.test(cbNameIdx)) { console.error(`unexpected compaction-basic name line: ${cbNameIdx}`); process.exit(6) }
const nameIndent = cbNameIdx.length - cbNameIdx.trimStart().length
const cfgIndent = ' '.repeat(nameIndent)
body.splice(cbi + 2, 0,
  `${cfgIndent}config:`,
  `${cfgIndent}  thresholdRatio: ${thresholdRatio}`,
  ...(retainRatio === undefined ? [] : [`${cfgIndent}  retainRatio: ${retainRatio}`]),
)

const header = [
  '# ---------------------------------------------------------------------------',
  '# TEMPORARY TEST OVERRIDE - agent preset "standard" with an early compaction',
  '# trigger. Added to force auto-compaction instead of waiting for ~734k tokens.',
  '#',
  '# This block replaces the COMPLETE preset-standard config, so it restates the',
  '# shipped plugin list verbatim from `dsh --profile web --dump-config` and',
  '# changes only the nested compaction-basic threshold.',
  '#',
  '# TO REVERT: delete everything from this comment down to the end of the',
  '# `preset-standard` block (the file that follows it is the `insert:` list).',
  '# `build-preset-override.mjs` can regenerate it; `--dump-config` verifies it.',
  '# ---------------------------------------------------------------------------',
]
writeFileSync(outPath, [...header, ...body, ''].join('\n'), 'utf8')
console.log(`wrote ${outPath}: ${body.length} entry lines (source dump lines ${start + 1}..${end})`)
console.log(`compaction-basic config added at body index ${cbi + 2}: thresholdRatio=${thresholdRatio}${retainRatio === undefined ? '' : ` retainRatio=${retainRatio}`}`)
