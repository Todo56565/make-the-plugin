import { attachReminder } from '/workspace/work/hoyyang_dsh-smart-compact/src/reminder.ts'
let listener: any
const logs: string[] = []
const obs: any[] = []
attachReminder({ on: (_e: string, l: any) => { listener = l } }, {
  fallbackBufferTokens: 8192, thresholdRatio: 0.85,
  getBudget: async () => ({ totalTokens: 900, contextWindow: 1000, remaining: 100, baselineKind: 'x' } as any),
  getWindowGeneration: () => 0,
  logger: { info: (m: string) => logs.push('info:' + m.slice(0, 40)), warn: (m: string) => logs.push('warn:' + m.slice(0, 90)), debug() {} },
  pluginName: 'dsh-smart-compact', onObservation: (o: any) => obs.push(o.kind),
})
// 0.2.0-rc.2 / 0.1.5-rc.2 real assembly shape
const assembly = { sections: [{ name: 'base', text: 'BASE' }], contexts: [], tools: [], variables: {} }
const out = await listener(assembly, { agent: { session: {} } }, async () => assembly)
console.log('changed=', out !== assembly, 'sections=', JSON.stringify(out.sections), '\nobs=', obs, '\nlogs=', logs)
