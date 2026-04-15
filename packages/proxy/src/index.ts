import { Context } from 'cordis'
import type {} from '@cordisjs/plugin-http'
import type {} from '@cordisjs/plugin-logger'
import type {} from '@cordisjs/plugin-server'
import z from 'schemastery'

export interface Config {
  baseUrl: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
})

export const inject = {
  http: true,
  server: true,
  logger: {
    required: false,
    config: {
      name: 'server:proxy',
    },
  },
}

export function apply(ctx: Context, config: Config) {
  const baseUrl = config.baseUrl.replace(/\/+$/, '') + '/'
  const bodyMethods = new Set(['POST', 'PUT', 'PATCH'])

  ctx.server.all('{/*path}', async (req, res, next) => {
    const url = new URL(req.params.path ?? '', baseUrl)
    url.search = req.query.toString()
    ctx.logger?.debug('%s %s -> %s', req.method, req.url, url.href)
    return ctx.http(url.href, {
      method: req.method as any,
      headers: req.headers,
      data: bodyMethods.has(req.method) ? req.body : undefined,
    })
  })
}
