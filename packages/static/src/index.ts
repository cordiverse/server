import { Context } from 'cordis'
import fetchFile from '@cordisjs/fetch-file'
import type {} from '@cordisjs/plugin-logger'
import type {} from '@cordisjs/plugin-server'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Dict } from 'cosmokit'
import z from 'schemastery'

export interface Config {
  root: string
  download?: boolean
  fallthrough?: boolean
  index: string
  redirect: boolean
  extensions: string[]
  errorPages: Dict<string>
}

export const Config: z<Config> = z.object({
  root: z.string().required(),
  download: z.boolean(),
  fallthrough: z.boolean(),
  index: z.string().default('index'),
  redirect: z.boolean().default(true),
  extensions: z.array(String).default(['.html', '.htm']),
  errorPages: z.dict(String),
})

export const inject = {
  server: {
    required: true,
    config: {
      path: '/static',
    },
  },
  logger: {
    required: false,
    config: {
      name: 'server:static',
    },
  },
}

export function apply(ctx: Context, config: Config) {
  const baseDir = fileURLToPath(new URL(config.root, ctx.get('baseUrl')))

  function _fetchFile(filename: string) {
    return fetchFile(pathToFileURL(filename), {}, {
      download: config.download,
      onError: ctx.logger?.warn,
    })
  }

  ctx.server.get('{/*path}', async (req, res, next) => {
    let path = req.params.path ?? ''
    if (path.endsWith('/') && config.index) {
      path += config.index
    }
    const filename = resolve(baseDir, path)
    if (!filename.startsWith(baseDir)) {
      return new Response(null, { status: 403, statusText: 'Forbidden' })
    }
    const response = await _fetchFile(filename)
    if (response.ok) return response
    if (response[fetchFile.kError]?.code === 'EISDIR' && config.redirect && !req.url.endsWith('/')) {
      return new Response(null, {
        status: 301,
        statusText: 'Moved Permanently',
        headers: { Location: req.url + '/' },
      })
    }
    for (const ext of config.extensions) {
      const response = await _fetchFile(filename + ext)
      if (response.ok) return response
    }
    if (config.fallthrough) return next()
    const errorPagePath = config.errorPages[response.status]
    if (errorPagePath) {
      const errorPage = await fetchFile(pathToFileURL(resolve(baseDir, errorPagePath)), {}, {
        onError: ctx.logger?.warn,
      })
      if (errorPage.ok) {
        return new Response(errorPage.body, {
          status: response.status,
          statusText: response.statusText,
          headers: errorPage.headers,
        })
      }
    }
    return response
  })
}
