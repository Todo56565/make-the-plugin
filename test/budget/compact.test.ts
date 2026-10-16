import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseSummarize, takeOverSummarize } from '../../src/budget/compact.ts'

class FakeEngine {
  calls = 0
  async summarize(_input: unknown, _owner: unknown): Promise<unknown> {
    this.calls += 1
    return { summary: [{ type: 'text', text: 'LLM 摘要' }], provider: 'p', model: 'm', llmStreamCall: true }
  }
  /** 宿主同款：每次动态取 this.summarize。 */
  run(owner: unknown): Promise<unknown> {
    return this.summarize(undefined, owner)
  }
}

const owner = (team: boolean) => ({ id: team ? 'team' : 'solo', session: { requestHeader: () => ({ config: { provider: 'ds', model: 'flash' } }) } })

test('接管 summarize：团队会话返回交接、零 LLM 调用；非团队走原方法', async () => {
  const target = new FakeEngine()
  // serviceFor() 每次返回新代理：标记必须落在实例上
  const proxyA = new Proxy(target, {}) as never
  const proxyB = new Proxy(target, {}) as never
  const handler = (o: { id: string }) => o.id === 'team' ? '【交接】…' : undefined
  assert.equal(takeOverSummarize(proxyA, handler as never), true)
  assert.equal(takeOverSummarize(proxyB, handler as never), false, '第二个代理认出已接管')
  assert.deepEqual(await target.run(owner(true)), { summary: [{ type: 'text', text: '【交接】…' }], provider: 'ds', model: 'flash' })
  assert.equal(target.calls, 0)
  assert.equal(((await target.run(owner(false))) as { summary: Array<{ text: string }> }).summary[0]!.text, 'LLM 摘要')
  assert.equal(target.calls, 1)
})

test('处理器随插件实例更新；卸载后一律走原方法', async () => {
  const target = new FakeEngine()
  takeOverSummarize(target as never, (() => 'v1') as never)
  takeOverSummarize(target as never, (() => 'v2') as never)
  assert.equal(((await target.run(owner(true))) as { summary: Array<{ text: string }> }).summary[0]!.text, 'v2')
  releaseSummarize(target as never)
  assert.equal(((await target.run(owner(true))) as { summary: Array<{ text: string }> }).summary[0]!.text, 'LLM 摘要')
})
