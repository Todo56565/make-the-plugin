/**
 * 笔记文件读写（设计 §4.2.2）。
 *
 * - 同一文件的写入在进程内串行；跨进程「最后写入赢」
 * - 超过 maxFileBytes 拒绝写入，不静默截断
 * - 搜索为区分大小写的字面包含
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WORKSPACE_NOTE } from './paths.ts'

export interface NoteMeta {
  path: string
  lines: number
  bytes: number
  /** 修改时间（毫秒）。 */
  mtimeMs: number
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

export class NoteSizeError extends Error {}

/** 文本行数（末尾换行不算新行；空文件为 0）。 */
export function countLines(text: string): number {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

export class NotesStore {
  private readonly locks = new Map<string, Promise<unknown>>()
  readonly root: string
  readonly maxFileBytes: number

  constructor(root: string, maxFileBytes: number) {
    this.root = root
    this.maxFileBytes = maxFileBytes
  }

  private abs(path: string): string {
    return join(this.root, ...path.split('/'))
  }

  /** 读取笔记；不存在返回 undefined。 */
  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(this.abs(path), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async meta(path: string): Promise<NoteMeta | undefined> {
    const abs = this.abs(path)
    try {
      const [info, text] = await Promise.all([stat(abs), readFile(abs, 'utf8')])
      return { path, lines: countLines(text), bytes: Buffer.byteLength(text), mtimeMs: info.mtimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** 全量写入。 */
  write(path: string, content: string): Promise<NoteMeta> {
    return this.serialize(path, async () => this.commit(path, content))
  }

  /** 追加（自动补换行分隔）。 */
  append(path: string, content: string): Promise<NoteMeta> {
    return this.serialize(path, async () => {
      const prior = (await this.read(path)) ?? ''
      const sep = prior === '' || prior.endsWith('\n') ? '' : '\n'
      const tail = content.endsWith('\n') ? content : `${content}\n`
      return this.commit(path, prior + sep + tail)
    })
  }

  /** 列出共享笔记与某团队的全部笔记，按修改时间倒序。 */
  async list(teamId: string): Promise<NoteMeta[]> {
    const paths = [WORKSPACE_NOTE]
    try {
      for (const name of await readdir(join(this.root, 'teams', teamId))) {
        if (name.endsWith('.md')) paths.push(`teams/${teamId}/${name}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const metas = (await Promise.all(paths.map(p => this.meta(p)))).filter((m): m is NoteMeta => m !== undefined)
    return metas.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1))
  }

  /** 在可读笔记中做区分大小写的字面搜索。 */
  async search(teamId: string, query: string, limit: number): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const hits: SearchHit[] = []
    for (const meta of await this.list(teamId)) {
      const text = (await this.read(meta.path)) ?? ''
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (!line.includes(query)) continue
        if (hits.length >= limit) return { hits, truncated: true }
        hits.push({ path: meta.path, line: i + 1, text: line })
      }
    }
    return { hits, truncated: false }
  }

  private async commit(path: string, content: string): Promise<NoteMeta> {
    const bytes = Buffer.byteLength(content)
    if (bytes > this.maxFileBytes) {
      throw new NoteSizeError(`写入后 ${path} 为 ${bytes} 字节，超过上限 ${this.maxFileBytes} 字节；请先精简（用 write 重写为更短的版本）`)
    }
    const abs = this.abs(path)
    await mkdir(dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, abs)
    const info = await stat(abs)
    return { path, lines: countLines(content), bytes, mtimeMs: info.mtimeMs }
  }

  private serialize<T>(path: string, task: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(path) ?? Promise.resolve()
    const run = prior.then(task, task)
    const settled = run.catch(() => undefined)
    this.locks.set(path, settled)
    void settled.then(() => {
      if (this.locks.get(path) === settled) this.locks.delete(path)
    })
    return run
  }
}
