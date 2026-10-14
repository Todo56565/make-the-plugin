/**
 * dsh-token-budget 浏览器端：在插件管理面板为本行注册设置页（模型下拉选择）。
 *
 * 设置命名空间 = cordis.patch.yml 中的行 id（`dsh-token-budget`）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ModelCatalogStore } from './catalog.ts'
import { NS, en, zh, type TokenBudgetKey } from './locales.ts'
import { TokenBudgetForm } from './settings-form.ts'
import { TokenBudgetSettings } from './TokenBudgetSettings.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-token-budget 设置页文案。 */
    tokenBudget: TokenBudgetKey
  }
}

/** 包名与行 id。 */
const PACKAGE = 'dsh-token-budget'
const ROW = 'dsh-token-budget'

export const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-token-budget: locale')
  ctx.effect(() => ctx.configForms.whileServed([ROW], () => {
    const form = new TokenBudgetForm(ctx.configForms.get<Record<string, unknown>>(ROW))
    const catalog = new ModelCatalogStore(ctx)
    const unregister = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config',
      key: `${PACKAGE}#${ROW}`,
      locale: NS,
      inject: () => ({ ...form.inject(), hooks: { ...form.inject().hooks, modelCatalog: catalog.store }, loadCatalog: catalog.load }),
    }, TokenBudgetSettings))
    return () => {
      unregister()
      catalog.dispose()
      form.dispose()
    }
  }), 'dsh-token-budget: settings page')
}
