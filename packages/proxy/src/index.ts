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
    const path = req.params.path ?? ''
    const target = new URL(path, baseUrl)
    const query = req.url.split('?')[1]
    if (query) target.search = query
    ctx.logger?.debug('%s %s -> %s', req.method, req.url, target.href)
    return ctx.http(target.href, {
      method: req.method as any,
      headers: req.headers,
      data: bodyMethods.has(req.method) ? req.body : undefined,
    })
  })
}
