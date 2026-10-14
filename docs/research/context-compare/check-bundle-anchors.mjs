// 校验：文档 marker + 紧随围栏块，与真实源文件按「逐行 trim 后相等」比对。
// 与原始 check-*.mjs 的逐行包含语义一致（允许忽略 YAML 前导缩进）。
import { readFileSync } from 'node:fs'

const F = String.fromCharCode(96, 96, 96)
const MARKER = /^<!--\s*src:\s*(.+?):(\d+)-(\d+)\s*-->$/
const files = process.argv.slice(2).filter(a => !a.startsWith('--'))
const onlyNew = !process.argv.includes('--all')

let total = 0, ok = 0, fail = 0
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i].trim())
    if (m === null) continue
    if (onlyNew && !/dsh-base|dsh-web-app|@nanmicoder/.test(m[1])) continue
    total++
    const src = readFileSync(m[1], 'utf8').split(/\r?\n/)
    const range = src.slice(Number(m[2]) - 1, Number(m[3]))
    let j = i + 1
    while (j < lines.length && !lines[j].startsWith(F)) j++
    const body = []
    j++
    while (j < lines.length && !lines[j].startsWith(F)) { body.push(lines[j]); j++ }
    const expect = body.map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
    const have = range.map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
    // 在区间内按顺序寻找连续子序列
    let found = false
    for (let o = 0; o + expect.length <= have.length; o++) {
      let good = true
      for (let k = 0; k < expect.length; k++) if (have[o + k] !== expect[k]) { good = false; break }
      if (good) { found = true; break }
    }
    const short = m[1].split('\\').slice(-3).join('/') + ':' + m[2] + '-' + m[3]
    console.log((found ? 'ok   ' : 'FAIL ') + short + '  (' + expect.length + ' lines)')
    if (found) ok++
    else {
      fail++
      console.log('   期望首行: ' + JSON.stringify(expect[0]))
      console.log('   区间内  : ' + JSON.stringify(have.slice(0, 4)))
    }
  }
}
console.log('---')
console.log('checked: ' + total + '  ok: ' + ok + '  fail: ' + fail)
