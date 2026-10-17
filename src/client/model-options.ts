/** 级联下拉的选项计算（纯函数，便于测试）。 */
import type { CatalogEffort, CatalogModel, CatalogProvider } from './catalog.ts'

export interface Option { value: string; label: string; unavailable?: true }

/** 当前值不在列表中时，补一个「不可用」选项，避免静默改值。 */
function withCurrent(options: Option[], current: string, unavailable: (value: string) => string): Option[] {
  if (current === '' || options.some(o => o.value === current)) return options
  return [{ value: current, label: unavailable(current), unavailable: true }, ...options]
}

export function providerOptions(providers: readonly CatalogProvider[], current: string, unavailable: (v: string) => string): Option[] {
  return withCurrent(providers.map(p => ({ value: p.id, label: p.name })), current, unavailable)
}

export function modelsOf(providers: readonly CatalogProvider[], provider: string): readonly CatalogModel[] {
  return providers.find(p => p.id === provider)?.models ?? []
}

export function modelOptions(providers: readonly CatalogProvider[], provider: string, current: string, unavailable: (v: string) => string): Option[] {
  return withCurrent(modelsOf(providers, provider).map(m => ({ value: m.id, label: m.name })), current, unavailable)
}

export function effortsOf(providers: readonly CatalogProvider[], provider: string, model: string): readonly CatalogEffort[] {
  return modelsOf(providers, provider).find(m => m.id === model)?.efforts ?? []
}

export function effortOptions(providers: readonly CatalogProvider[], provider: string, model: string, current: string, unavailable: (v: string) => string): Option[] {
  return withCurrent(effortsOf(providers, provider, model).map(e => ({ value: e.id, label: e.name })), current, unavailable)
}

/** 规范化编号文本：逗号/空格分隔的正整数，去重升序；不合格返回 undefined。 */
export function normalizePicks(text: string): string | undefined {
  const parts = text.split(/[,，\s]+/).filter(p => p !== '')
  if (!parts.every(p => /^[1-9]\d*$/.test(p))) return undefined
  return [...new Set(parts.map(Number))].sort((a, b) => a - b).join(',')
}
