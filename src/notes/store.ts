/**
 * 笔记文件读写（设计 §4.2.2）。
 *
 * - 同一文件的写入在进程内串行（按物理路径，跨实例共享）；跨进程「最后写入赢」
 * - 方法接收虚拟路径；构造时给出团队代则映射到物理位置，返回的 meta.path 仍是虚拟路径
 * - 超过 maxFileBytes 拒绝写入，不静默截断
 * - 搜索为区分大小写的字面包含
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WORKSPACE_NOTE, physicalNotePath, type NoteTeam } from './paths.ts'

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

const locks = new Map<string, Promise<unknown>>()

export class NotesStore {
  readonly root: string
  readonly team: NoteTeam | undefined
  private readonly limit: () => number

  /**
   * @param maxFileBytes 单文件上限；传函数时每次写入读取当下值（设置页可即时修改）。
   * @param team 团队代；省略时虚拟路径即物理路径（测试与旧调用）。
   */
  constructor(root: string, maxFileBytes: number | (() => number), team?: NoteTeam) {
    this.root = root
    this.team = team
    this.limit = typeof maxFileBytes === 'function' ? maxFileBytes : () => maxFileBytes
  }

  get maxFileBytes(): number {
    return this.limit()
  }

  private abs(path: string): string {
    return join(this.root, ...physicalNotePath(path, this.team).split('/'))
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

  /**
   * 条件写入：仅当当前内容仍等于 expected（undefined 表示文件不存在）时写入。
   * 返回 undefined 表示内容已被他人改动，未写入。
   */
  writeIf(path: string, expected: string | undefined, content: string): Promise<NoteMeta | undefined> {
    return this.serialize(path, async () => {
      if ((await this.read(path)) !== expected) return undefined
      return this.commit(path, content)
    })
  }

  /** 列出共享笔记与某团队的全部笔记，按修改时间倒序。 */
  async list(teamId: string): Promise<NoteMeta[]> {
    const paths = [WORKSPACE_NOTE]
    try {
      const dir = physicalNotePath(`teams/${teamId}/`, this.team)
      for (const name of await readdir(join(this.root, ...dir.split('/').filter(Boolean)))) {
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
    const key = this.abs(path)
    const prior = locks.get(key) ?? Promise.resolve()
    const run = prior.then(task, task)
    const settled = run.catch(() => undefined)
    locks.set(key, settled)
    void settled.then(() => {
      if (locks.get(key) === settled) locks.delete(key)
    })
    return run
  }
}
