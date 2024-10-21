import { Context, Schema, Service } from 'cordis'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Dict, sanitize, Time } from 'cosmokit'
import {} from '@cordisjs/plugin-server'
import {} from '@cordisjs/plugin-http'
import { fileURLToPath } from 'url'
import { Readable } from 'stream'

declare module 'cordis' {
  interface Context {
    'server.temp': TempServer
  }

  namespace Context {
    interface Server {
      temp: TempServer
    }
  }
}

export interface Entry {
  path: string
  url: string
  dispose?: () => void
}

class TempServer extends Service {
  static inject = ['server', 'http']

  public path: string
  public selfUrl!: string
  public baseDir!: string
  public entries: Dict<Entry> = Object.create(null)

  constructor(protected ctx: Context, public config: TempServer.Config) {
    super(ctx, 'server.temp')
    const logger = ctx.logger('temp')

    this.path = sanitize(config.path)
    this.selfUrl = config.selfUrl || ctx.server.config.selfUrl!
    if (!this.selfUrl) {
      logger.warn('missing selfUrl configuration')
    }

    ctx.server.get(this.path + '/:name', async (koa) => {
      logger.debug(koa.params.name)
      const entry = this.entries[koa.params.name]
      if (!entry) return koa.status = 404
      koa.body = createReadStream(entry.path)
    })
  }

  async start() {
    this.baseDir = this.ctx.baseDir + '/temp/' + Math.random().toString(36).slice(2) + '/'
    await mkdir(this.baseDir, { recursive: true })
  }

  async stop() {
    await rm(this.baseDir, { recursive: true })
  }

  async create(data: string | Buffer | ReadableStream): Promise<Entry> {
    const name = Math.random().toString(36).slice(2)
    const url = this.selfUrl + this.path + '/' + name
    let path: string
    if (typeof data === 'string') {
      if (new URL(data).protocol === 'file:') {
        path = fileURLToPath(data)
      } else {
        const stream = await this.ctx.http.get(data, { responseType: 'stream' })
        path = this.baseDir + name
        await writeFile(path, Readable.fromWeb(stream))
      }
    } else {
      path = this.baseDir + name
      await writeFile(path, data instanceof ReadableStream ? Readable.fromWeb(data as any) : data)
    }
    return this.ctx.effect(() => {
      const timer = setTimeout(() => dispose(), this.config.maxAge)
      const dispose = async () => {
        clearTimeout(timer)
        delete this.entries[name]
        if (path.startsWith(this.baseDir)) await rm(path)
      }
      return this.entries[name] = { path, url, dispose }
    })
  }
}

namespace TempServer {
  export interface Config {
    path: string
    selfUrl?: string
    maxAge?: number
  }

  export const Config: Schema<Config> = Schema.object({
    path: Schema.string().default('/temp'),
    selfUrl: Schema.string().role('link').description('此服务暴露在公网的地址。缺省时将使用全局配置。'),
    maxAge: Schema.number().default(Time.minute * 5).description('临时文件的默认最大存活时间。'),
  })
}

export default TempServer
