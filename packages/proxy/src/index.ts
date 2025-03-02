import { Context, Service } from 'cordis'
import {} from '@cordisjs/plugin-http'
import {} from '@cordisjs/plugin-server'
import { Readable } from 'node:stream'
import { sanitize } from 'cosmokit'
import Schema from 'schemastery'

declare module 'cordis' {
  interface Context {
    'server.proxy': ProxyServer
  }

  namespace Context {
    interface Server {
      proxy: ProxyServer
    }
  }
}

class ProxyServer extends Service {
  static inject = ['server', 'http']

  public path: string

  constructor(protected ctx: Context, public config: ProxyServer.Config) {
    super(ctx, 'server.proxy')

    const logger = ctx.logger('proxy')

    this.path = sanitize(config.path)

    ctx.server.get(this.path + '/:url(.*)', async (koa) => {
      logger.debug(koa.params.url)
      koa.header['Access-Control-Allow-Origin'] = ctx.server.config.selfUrl || '*'
      try {
        koa.body = Readable.fromWeb(await ctx.http.get(koa.params.url, { responseType: 'stream' }))
      } catch (error) {
        if (!ctx.http.isError(error) || !error.response) throw error
        koa.status = error.response.status
        koa.body = error.response.data
      }
    })
  }
}

namespace ProxyServer {
  export interface Config {
    path: string
  }

  export const Config: Schema<Config> = Schema.object({
    path: Schema.string().default('/proxy'),
  })
}

export default ProxyServer
