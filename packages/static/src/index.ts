import { Context, z } from 'cordis'
import fetchFile from '@cordisjs/fetch-file'
import {} from '@cordisjs/plugin-server'
import { pathToFileURL } from 'node:url'

export interface Config {
  path: string
  root: string
  download?: boolean
}

export const Config: z<Config> = z.object({
  path: z.string().required(),
  root: z.string().required(),
  download: z.boolean(),
})

export const inject = {
  server: { required: true },
  logger: { required: false, config: { name: 'server:static' } },
}

export function apply(ctx: Context, config: Config) {
  ctx.server.get(config.path + '{/*path}', async (req, res, next) => {
    return fetchFile(pathToFileURL(config.root + req.url.slice(config.path.length)), {}, {
      download: config.download,
      onError: ctx.logger?.warn,
    })
  })
}
