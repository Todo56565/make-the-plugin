import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effortOptions, modelOptions, providerOptions } from '../src/client/model-options.ts'
import { toSettings, Config } from '../src/config.ts'

const providers = [
  { id: 'ds', name: 'DeepSeek', models: [{ id: 'v4', name: 'V4', efforts: [{ id: 'high', name: '高' }] }, { id: 'flash', name: 'Flash', efforts: [] }] },
  { id: 'oa', name: 'OpenAI', models: [] },
]
const un = (v: string) => `${v}（不可用）`

test('级联选项', () => {
  assert.deepEqual(providerOptions(providers, '', un).map(o => o.value), ['ds', 'oa'])
  assert.deepEqual(modelOptions(providers, 'ds', '', un).map(o => o.value), ['v4', 'flash'])
  assert.deepEqual(effortOptions(providers, 'ds', 'v4', '', un).map(o => o.value), ['high'])
  assert.deepEqual(effortOptions(providers, 'ds', 'flash', '', un), [])
})

test('当前值不在目录中时保留为不可用选项', () => {
  const opts = modelOptions(providers, 'ds', 'old', un)
  assert.deepEqual(opts[0], { value: 'old', label: 'old（不可用）', unavailable: true })
})

test('扁平配置换算与默认值', () => {
  const s = toSettings(Config({}))
  assert.equal(s.budget.remindAtRatio, 0.37)
  assert.equal(s.budget.compactAtRatio, 0.45)
  assert.equal(s.notesMerge.enabled, false)
  assert.equal(s.notesMerge.model, undefined)
  assert.equal(s.notesOptions.maxFileBytes, 10_000)
  assert.equal(s.notesOptions.readMaxBytes, 24_000)
  assert.equal(s.budget.bucketStep, 0.03)
  assert.equal(s.budget.fallbackBufferTokens, 16_384)
  assert.equal(s.notesOptions.hintMaxBytes, 4_000)
  assert.equal(s.notesOptions.hintRecentNotes, 5)
  assert.throws(() => Config({ hintMaxBytes: 3999 }), 'hintMaxBytes 最低 4000')
  assert.throws(() => Config({ compactAtRatio: 0.02 }), 'compactAtRatio 最低 0.03')
  assert.equal(toSettings(Config({ compactAtRatio: 0.03, remindAtRatio: 0.02 })).budget.compactAtRatio, 0.03)
  assert.equal(toSettings({ ...Config({}), compactAtRatio: 0.01 } as never).budget.compactAtRatio, 0.03, '绕过 schema 的值也夹到最低值')
  assert.equal(toSettings(Config({ notesMerge: true, mergeProvider: 'ds', mergeModel: '' })).notesMerge.model, undefined)
})

test('normalizePicks：逗号/空格分隔正整数，去重升序；不合格返回 undefined', async () => {
  const { normalizePicks } = await import('../src/client/model-options.ts')
  assert.equal(normalizePicks('12, 5,1，5'), '1,5,12')
  assert.equal(normalizePicks('3 7'), '3,7')
  assert.equal(normalizePicks('0,2'), undefined)
  assert.equal(normalizePicks('a'), undefined)
  assert.equal(normalizePicks('1.5'), undefined)
})

test('plainPace：默认按队员；captain 按队长；其他值退回默认', () => {
  assert.equal(toSettings(Config({})).budget.plainPace, 'member')
  assert.equal(toSettings(Config({ plainPace: 'captain' })).budget.plainPace, 'captain')
  assert.equal(toSettings(Config({ plainPace: 'x' })).budget.plainPace, 'member')
})
