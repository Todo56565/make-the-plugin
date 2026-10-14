// Read-only survey of context pressure across every session projection cache.
import { readFileSync, readdirSync } from 'node:fs'
const dir = process.argv[2]
const rows = []
for (const name of readdirSync(dir)) {
  if (!name.endsWith('.json')) continue
  try {
    const j = JSON.parse(readFileSync(dir + '/' + name, 'utf8'))
    const rows_ = j?.record?.rows ?? {}
    const p = rows_.contextPressure?.val
    const b = rows_.contextBreakdown?.val
    const u = rows_.tokenUsage?.val
    const t = rows_.title?.val
    if (p === undefined) continue
    rows.push({
      session: name.replace('.json', ''),
      surface: p.surfaceTokens,
      window: p.contextWindow,
      pressure: p.pressureTokens,
      sys: b?.breakdown?.systemTokens,
      tools: b?.breakdown?.toolsTokens,
      msgs: b?.breakdown?.messageTokens,
      nodes: b?.nodes?.length,
      cacheRead: u?.totals?.cacheReadTokens,
      title: typeof t === 'string' ? t.slice(0, 30) : '',
    })
  } catch { /* ignore */ }
}
rows.sort((a, b) => (b.pressure ?? 0) - (a.pressure ?? 0))
console.log('sessions with pressure projection: ' + rows.length)
for (const r of rows) {
  console.log([r.session, 'pressure=' + r.pressure, 'surface=' + r.surface, 'window=' + r.window, 'sys=' + r.sys, 'tools=' + r.tools, 'msgs=' + r.msgs, 'nodes=' + r.nodes, 'cacheRead=' + r.cacheRead].join(' | '))
}
