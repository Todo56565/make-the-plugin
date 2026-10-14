/** 宿主模型目录（下拉选项来源）：`ctx.remote.session.modelCatalog()`。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface CatalogEffort { id: string; name: string }
export interface CatalogModel { id: string; name: string; efforts: CatalogEffort[]; defaultEffort?: string }
export interface CatalogProvider { id: string; name: string; models: CatalogModel[] }

export interface CatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  providers: CatalogProvider[]
}

export class ModelCatalogStore {
  readonly store: SnapshotStore<CatalogState> = createSnapshotStore<CatalogState>({ status: 'idle', providers: [] })
  private generation = 0
  private disposed = false
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /** 首次或失败后重试时加载。 */
  load = (force = false): void => {
    const current = this.store.getSnapshot().status
    if (this.disposed || current === 'loading' || (!force && current === 'ready')) return
    const generation = ++this.generation
    this.store.set({ ...this.store.getSnapshot(), status: 'loading' })
    void this.ctx.remote.session.modelCatalog().then((response) => {
      if (this.disposed || generation !== this.generation) return
      if (!response.ok) { this.store.set({ status: 'error', providers: [] }); return }
      this.store.set({
        status: 'ready',
        providers: response.value.groups.map(group => ({
          id: group.id,
          name: group.name,
          models: group.models.map(model => ({
            id: model.id,
            name: model.name,
            efforts: (model.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name })),
            ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
          })),
        })),
      })
    }, () => {
      if (!this.disposed && generation === this.generation) this.store.set({ status: 'error', providers: [] })
    })
  }

  dispose(): void {
    this.disposed = true
  }
}
