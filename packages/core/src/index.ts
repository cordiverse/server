import { Context, DisposableList, Inject, Service } from 'cordis'
import { Awaitable, defineProperty, trimSlash } from 'cosmokit'
import type {} from '@cordisjs/plugin-logger'
import * as http from 'node:http'
import { ExtractParams, Keys, pathToRegexp } from 'path-to-regexp-typed'
import { WebSocket, WebSocketServer } from 'ws'
import { listen, ListenOptions } from './listen'
import { Request, Response } from './body'
import z from 'schemastery'

export * from './body'

declare module 'cordis' {
  interface Context {
    server: Server
  }

  interface Events {
    'server/ready'(this: Server): void
    'server/request'(this: Server, req: Request, res: Response, next: () => Promise<void>): Promise<void>
    'server/__route'(this: Server, req: Request, res: Response, next: () => Promise<globalThis.Response | void>): Promise<globalThis.Response | void>
  }
}

export abstract class Route {
  regexp: RegExp
  keys?: Keys
  config: Server.Intercept

  abstract dispose: () => void

  constructor(protected server: Server, label: string, public path: string | RegExp) {
    this.config = server[Server.resolveConfig]()
    const paths = [path]
    if (this.config.path) paths.unshift(this.config.path)
    server.ctx.logger?.('server:route').debug('register', label, ...paths)
    if (typeof path === 'string') {
      const { regexp, keys } = pathToRegexp(path)
      this.regexp = regexp
      this.keys = keys
    } else {
      this.regexp = path
    }
  }

  check(req: Request) {
    let pathname = req.path
    if (this.config.path) {
      if (!pathname.startsWith(this.config.path)) return
      pathname = pathname.slice(this.config.path.length)
    }
    const capture = this.regexp.exec(pathname)
    if (!capture) return
    let params: any
    if (this.keys) {
      params = {}
      this.keys.forEach(({ name }, index) => {
        if (capture[index + 1] === undefined) return
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/decodeURIComponent#decoding_query_parameters_from_a_url
        params[name] = decodeURIComponent(capture[index + 1].replace(/\+/g, ' '))
      })
    } else {
      params = capture
    }
    this.server.ctx.logger?.('server:route').debug('match %s with params', this.path, params)
    return params
  }
}

type WsHandler<P = any> = (req: Request & { params: P }, accept: () => Promise<WebSocket>) => Awaitable<void>

export class WsRoute extends Route {
  clients = new Set<WebSocket>()
  dispose: () => void

  constructor(server: Server, path: string | RegExp, public handle?: WsHandler) {
    super(server, 'WS', path)
    const self = this
    this.dispose = server.ctx.effect(function* () {
      yield server.wsRoutes.push(self)
      yield () => {
        for (const socket of self.clients) {
          socket.close()
        }
      }
    }, `ctx.server.ws(${typeof path === 'string' ? JSON.stringify(path) : path})`)
  }
}

export type Middleware<P = any> = (req: Request & { params: P }, res: Response, next: () => Promise<globalThis.Response | void>) => Promise<globalThis.Response | void>

class HttpRoute extends Route {
  dispose: () => void

  constructor(server: Server, public method: string, path: string | RegExp, public callback: Middleware) {
    super(server, method, path)
    const self = this
    this.dispose = server.ctx.effect(function* () {
      yield server.httpRoutes.push(self)
      yield server.ctx.on('server/__route', async (req, res, next) => {
        if (method !== 'all' && req.method.toLowerCase() !== method) return next()
        const params = self.check(req)
        if (!params) return next()
        return callback(Object.assign(Object.create(req), { params }), res, next)
      })
    }, `ctx.server.${method}(${typeof path === 'string' ? JSON.stringify(path) : path})`)
  }
}

interface RouteImpl {
  <P extends string>(path: P, middleware: Middleware<ExtractParams<P>>): HttpRoute
  (path: RegExp, middleware: Middleware<RegExpExecArray>): HttpRoute
  (path: string | RegExp, middleware: Middleware): HttpRoute
}

interface Server extends Record<typeof Server.methods[number], RouteImpl> {}

@Inject('logger', false)
class Server extends Service<Server.Intercept> {
  static readonly methods = ['all', 'get', 'delete', 'head', 'post', 'put', 'patch'] as const

  static {
    for (const method of Server.methods) {
      defineProperty(Server.prototype, method, function (this: Server, path: string | RegExp, middleware: Middleware) {
        return new HttpRoute(this, method, path, middleware)
      })
    }
  }

  Config: z<Server.Intercept> = z.object({
    path: z.string().description('服务器监听的基础路径。'),
  })

  public _http: http.Server
  public _ws: WebSocketServer
  public httpRoutes = new DisposableList<HttpRoute>()
  public wsRoutes = new DisposableList<WsRoute>()

  public host!: string
  public port!: number

  constructor(public ctx: Context, public config: Server.Config) {
    super(ctx, 'server')

    this._http = http.createServer()

    this._http.on('request', async (_req, _res) => {
      const req = new Request(_req)
      const res = new Response(_res)
      this.ctx.logger?.('server:request').debug('%c %s', req.method, req.url)
      _res.on('finish', () => {
        this.ctx.logger?.('server:response').debug('%c %s %s %s', req.method, req.url, res.status, res.statusText)
      })
      try {
        await this.ctx.waterfall(this, 'server/request', req, res, async () => {})
      } catch (error) {
        this.ctx.logger?.error(error)
        if (!res.claimed) {
          res.status = 500
        }
      }
      res._end()
    })

    this.ctx.on('server/request', async (req, res, next) => {
      const response = await this.ctx.waterfall(this, 'server/__route', req, res, next)
      if (response) {
        res.body = response.body
        res.status = response.status
        for (const [key, value] of response.headers) {
          res.headers.set(key, value)
        }
      }

      if (res.claimed) return
      const methods = new Set<string>()
      let asterisk = false
      for (const route of this.httpRoutes) {
        if (!route.check(req)) continue
        if (route.method === 'all') {
          asterisk = true
          break
        }
        methods.add(route.method)
      }
      if (!methods.size && !asterisk) {
        res.status = 404
      } else {
        const allow = asterisk ? '*' : [...methods].join(', ')
        if (req.method === 'OPTIONS') {
          res.status = 204
        } else {
          res.status = 405
        }
        res.headers.set('allow', allow)
      }
    })

    this._ws = new WebSocketServer({ noServer: true })

    this._http.on('upgrade', async (_req, socket, head) => {
      const req = new Request(_req)
      this.ctx.logger?.('server:ws').debug('upgrade %s', req.path)
      for (const route of this.wsRoutes) {
        const params = route.check(req)
        if (!params) continue
        let connection: WebSocket | undefined
        const accept = () => new Promise<WebSocket>((resolve) => {
          // handleUpgrade calls the callback synchronously upon success
          this._ws.handleUpgrade(_req, socket, head, (ws) => {
            connection = ws
            this._ws.emit('connection', ws, _req)
            route.clients.add(ws)
            ws.on('close', () => {
              route.clients.delete(ws)
              this.ctx.logger?.('server:ws').debug('close %s', req.path)
            })
            this.ctx.logger?.('server:ws').debug('accept %s', req.path)
            resolve(ws)
          })
        })
        if (!route.handle) {
          await accept()
          return
        }
        try {
          await route.handle(Object.assign(Object.create(req), { params }), accept)
        } catch (error) {
          this.ctx.logger?.error(error)
          if (connection) {
            connection.close()
          } else if (!socket.destroyed) {
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
            socket.destroy()
          }
        }
        if (!connection && !socket.destroyed) {
          this.ctx.logger?.('server:ws').warn('ws handler for %s did not call accept()', req.path)
          socket.destroy()
        }
        return
      }
      this.ctx.logger?.('server:ws').debug('refuse %s', req.path)
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
    })

    if (config.baseUrl) {
      config.baseUrl = trimSlash(config.baseUrl)
    }
  }

  async* [Service.init]() {
    this.host = this.config.host
    this.port = await listen(this._http, this.config)
    yield () => new Promise<void>((resolve, reject) => {
      this._http.close((err) => err ? reject(err) : resolve())
    })
    this.ctx.logger?.info('server listening at %c', `http://${this.host}:${this.port}`)
    yield () => this.ctx.logger?.info(`server closing at %c`, `http://${this.host}:${this.port}`)
    this.ctx.emit(this, 'server/ready')
  }

  get baseUrl() {
    const intercept = this[Service.resolveConfig]()
    const pathPrefix = intercept.path ?? ''
    if (this.config.baseUrl) return this.config.baseUrl + pathPrefix
    const wildcard = ['0.0.0.0', '::']
    const host = wildcard.includes(this.host) ? '127.0.0.1' : this.host
    let root: string
    if (this.port === 80) {
      root = `http://${host}`
    } else if (this.port === 443) {
      root = `https://${host}`
    } else {
      root = `http://${host}:${this.port}`
    }
    return root + pathPrefix
  }

  use(middleware: (req: Request, res: Response, next: () => Promise<void>) => Promise<void>) {
    return this.ctx.on('server/request', middleware, { prepend: true })
  }

  ws<P extends string>(path: P, callback?: WsHandler<ExtractParams<P>>): WsRoute
  ws(path: RegExp, callback?: WsHandler<RegExpExecArray>): WsRoute
  ws(path: string | RegExp, callback?: WsHandler) {
    return new WsRoute(this, path, callback)
  }
}

namespace Server {
  export interface Intercept {
    path?: string
  }

  export interface Config extends ListenOptions {
    host: string
    port: number
    maxPort?: number
    baseUrl?: string
  }

  export const Config: z<Config> = z.object({
    host: z.string().default('127.0.0.1').description('要监听的 IP 地址。如果将此设置为 `0.0.0.0` 将监听所有地址，包括局域网和公网地址。'),
    port: z.natural().required().max(65535).description('要监听的初始端口号。'),
    maxPort: z.natural().max(65535).description('允许监听的最大端口号。'),
    baseUrl: z.string().role('link').description('应用暴露在公网的地址。'),
  })
}

export default Server
