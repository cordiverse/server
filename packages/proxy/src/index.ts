import { Context, z } from 'cordis'
import {} from '@cordisjs/plugin-http'
import {} from '@cordisjs/plugin-server'

export interface Config {
  // path: string
  baseUrl: string
}

export const Config: z<Config> = z.object({
  // path: z.string().required(),
  baseUrl: z.string().required(),
})

export const inject = {
  http: true,
  server: {
    required: true,
    config: {
      path: '/proxy',
    },
  },
}

export function apply(ctx: Context, config: Config) {
  ctx.server.get('{/*path}', async (req, res, next) => {
    const response = await ctx.http(config.baseUrl + req.params.path, {
      method: req.method as any,
      headers: req.headers,
      responseType: 'stream',
    })
    res.status = response.status
    for (const [key, value] of response.headers) {
      res.headers.set(key, value)
    }
    res.body = response.data
  })
}
