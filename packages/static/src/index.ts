import { Context, z } from 'cordis'
import fetchFile from '@cordisjs/fetch-file'
import {} from '@cordisjs/plugin-server'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { Dict } from 'cosmokit'

export interface Config {
  path: string
  root: string
  download?: boolean
  fallthrough?: boolean
  extensions: string[]
  errorPages: Dict<string>
}

export const Config: z<Config> = z.object({
  path: z.string().required(),
  root: z.string().required(),
  download: z.boolean(),
  fallthrough: z.boolean(),
  extensions: z.array(String).default(['.html', '.htm']),
  errorPages: z.dict(String),
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
    const filename = join(resolve(ctx.baseDir, config.root), req.url.slice(config.path.length))
    let response = await _fetchFile(filename)
    if (response.ok) return response
    for (const ext of config.extensions) {
      response = await _fetchFile(filename + ext)
      if (response.ok) return response
    }
    if (config.fallthrough) return next()
    if (config.errorPages[response.status]) {
      return _fetchFile(resolve(ctx.baseDir, config.root, config.errorPages[response.status]))
    }
    return new Response(null, { status: 404, statusText: 'Not Found' })
  })
}
