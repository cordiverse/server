import { Context, z } from 'cordis'
import fetchFile from '@cordisjs/fetch-file'
import {} from '@cordisjs/plugin-server'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

export interface Config {
  path: string
  root: string
  download?: boolean
  extensions: string[]
}

export const Config: z<Config> = z.object({
  path: z.string().required(),
  root: z.string().required(),
  download: z.boolean(),
  extensions: z.array(String),
})

export const inject = {
  server: { required: true },
  logger: { required: false, config: { name: 'server:static' } },
}

export function apply(ctx: Context, config: Config) {
  function _fetchFile(filename: string) {
    return fetchFile(pathToFileURL(filename), {}, {
      download: config.download,
      onError: ctx.logger?.warn,
    })
  }

  ctx.server.get(config.path + '{/*path}', async (req, res, next) => {
    const filename = join(ctx.baseDir, config.root, req.url.slice(config.path.length))
    let response = await _fetchFile(filename)
    if (response.status === 200) return response
    for (const ext of config.extensions) {
      response = await _fetchFile(filename + ext)
      if (response.status === 200) return
    }
    return response
  })
}
