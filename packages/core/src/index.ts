import { Context, DisposableList, Service, z } from 'cordis'
import { defineProperty, Dict, trimSlash } from 'cosmokit'
import * as http from 'node:http'
import { Keys, pathToRegexp } from 'path-to-regexp'
import { WebSocket, WebSocketServer } from 'ws'
import { listen, ListenOptions } from './listen'
import { Request, Response } from './body'

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

type Upper =
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z'

type Lower =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'

/* eslint-disable @typescript-eslint/no-unused-vars */

type Take<S extends string, D extends string, O extends string = ''> =
  | S extends `${infer C extends D}${infer S}`
  ? Take<S, D, `${O}${C}`>
  : [O, S]

type TakeIdent<S extends string> =
  | S extends `"${infer P}"${infer S}`
  ? [P, S]
  : Take<S, Upper | Lower | Digit | '_'>

// path-to-regexp v8 syntax
export type ExtractParams<S extends string, O extends {} = {}, A extends 0[] = []> =
  | S extends `${infer C}${infer S}`
  ? C extends '\\'
    ? S extends `${string}${infer S}`
      ? ExtractParams<S, O, A>
      : O
    : C extends ':' | '*'
      ? TakeIdent<S> extends [infer P extends string, infer S extends string]
        ? ExtractParams<S, O & (
          | A['length'] extends 0
          ? { [K in P]: string }
          : { [K in P]?: string }
        ), A>
        : never
      : C extends '{'
        ? ExtractParams<S, O, [0, ...A]>
        : C extends '}'
          ? A extends [0, ...infer A extends 0[]]
            ? ExtractParams<S, O, A>
            : ExtractParams<S, O, A>
          : ExtractParams<S, O, A>
  : O

export abstract class Route {
  regexp: RegExp
  keys?: Keys

  constructor(protected server: Server, label: string, public path: string | RegExp) {
    server.ctx.logger?.('server:route').debug('register %s %s', label, path)
    if (typeof path === 'string') {
      const { regexp, keys } = pathToRegexp(path)
      this.regexp = regexp
      this.keys = keys
    } else {
      this.regexp = path
    }
  }

  check(req: Request) {
    const capture = this.regexp.exec(req.url!)
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

type WsHandler<P = any> = (req: Request & { params: P }, next: () => Promise<WebSocket>) => Promise<void>

export class WsRoute extends Route {
  clients = new Set<WebSocket>()
  dispose: () => Promise<void>

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
    })
  }
}

export type Middleware<P = any> = (req: Request & { params: P }, res: Response, next: () => Promise<globalThis.Response | void>) => Promise<globalThis.Response | void>

class HttpRoute extends Route {
  dispose: () => Promise<void>

  constructor(server: Server, public method: Server.Method | undefined, path: string | RegExp, public callback: Middleware) {
    super(server, method ?? 'ALL', path)
    const self = this
    this.dispose = server.ctx.effect(function* () {
      yield server.httpRoutes.push(self)
      yield server.ctx.on('server/__route', async (req, res, next) => {
        if (method && req.method !== method) return next()
        const params = self.check(req)
        if (!params) return next()
        return callback(Object.assign(Object.create(req), { params }), res, next)
      })
    })
  }
}

interface RouteImpl {
  <P extends string>(path: P, middleware: Middleware<ExtractParams<P>>): HttpRoute
  (path: RegExp, middleware: Middleware<RegExpExecArray>): HttpRoute
  (path: string | RegExp, middleware: Middleware): HttpRoute
}

interface Server extends Record<typeof Server.methods[number], RouteImpl> {}

class Server extends Service {
  static readonly inject = {
    logger: { required: false },
  }

  static readonly methods = ['all', 'get', 'delete', 'head', 'post', 'put', 'patch'] as const

  static {
    for (const method of Server.methods) {
      defineProperty(Server.prototype, method, function (this: Server, path: string | RegExp, middleware: Middleware) {
        return new HttpRoute(this, method === 'all' ? undefined : method.toUpperCase() as Server.Method, path, middleware)
      })
    }
  }

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
      res.inner.on('finish', () => {
        this.ctx.logger?.('server:response').debug('%c %s %s %s', req.method, req.url, res.status, res.statusText)
      })
      await this.ctx.waterfall(this, 'server/request', req, res, async () => {})
      res._end()
    })

    this.ctx.on('server/request', async (req, res, next) => {
      const response = await this.ctx.waterfall(this, 'server/__route', req, res, async () => {
        const methods = new Set<Server.Method>()
        let asterisk = false
        for (const route of this.httpRoutes) {
          if (!route.check(req)) continue
          if (route.method) {
            methods.add(route.method)
          } else {
            asterisk = true
            break
          }
        }
        if (!methods.size && !asterisk) {
          res.status = 404
        } else if (req.method === 'OPTIONS') {
          res.status = 204
          res.headers.set('allow', asterisk ? '*' : [...methods].join(', '))
        } else {
          res.status = 405
        }
        return next()
      })

      if (response) {
        res.body = response.body
        res.status = response.status
        for (const [key, value] of response.headers) {
          res.headers.set(key, value)
        }
      }
    })

    this._ws = new WebSocketServer({
      server: this._http,
    })

    this._ws.shouldHandle = (_req) => new Promise(async (resolve) => {
      const req = new Request(_req)
      const task = new Promise<WebSocket>((resolve, reject) => {
        _req['__ws_resolve'] = resolve
      })
      const factory = () => {
        resolve(true)
        return task
      }
      await Promise.all([...this.wsRoutes].map(async (route) => {
        const params = route.check(req)
        if (!params) return
        if (!route.handle) {
          await factory()
          return
        }
        try {
          await route.handle(Object.assign(Object.create(req), { params }), factory)
        } catch (error) {
          this.ctx.logger?.error(error)
        }
      }))
      resolve(false)
    })

    this._ws.on('connection', (socket, req) => {
      req['__ws_resolve']?.(socket)
    })

    if (config.selfUrl) {
      config.selfUrl = trimSlash(config.selfUrl)
    }
  }

  async start() {
    this.host = this.config.host
    this.port = await listen(this.config)
    this._http.listen(this.port, this.host)
    this.ctx.logger?.info('server listening at %c', `http://${this.host}:${this.port}`)
    this.ctx.emit(this, 'server/ready')
  }

  async stop() {
    if (this.port) {
      this.ctx.logger?.info(`server closing at %c`, `http://${this.host}:${this.port}`)
    }
    await new Promise<void>((resolve, reject) => {
      this._ws?.close((err) => {
        err ? reject(err) : resolve()
      })
    })
    await new Promise<void>((resolve, reject) => {
      this._http?.close((err) => {
        err ? reject(err) : resolve()
      })
    })
  }

  get selfUrl() {
    const wildcard = ['0.0.0.0', '::']
    const host = wildcard.includes(this.host) ? '127.0.0.1' : this.host
    if (this.port === 80) {
      return `http://${host}`
    } else if (this.port === 443) {
      return `https://${host}`
    } else {
      return `http://${host}:${this.port}`
    }
  }

  ws<P extends string>(path: P, callback?: WsHandler<ExtractParams<P>>): WsRoute
  ws(path: RegExp, callback?: WsHandler<RegExpExecArray>): WsRoute
  ws(path: string | RegExp, callback?: WsHandler) {
    return new WsRoute(this, path, callback)
  }
}

namespace Server {
  export type Method = 'GET' | 'DELETE' | 'HEAD' | 'POST' | 'PUT' | 'PATCH'

  export interface Config extends ListenOptions {
    host: string
    port: number
    maxPort?: number
    selfUrl?: string
  }

  export const Config: z<Config> = z.object({
    host: z.string().default('127.0.0.1').description('要监听的 IP 地址。如果将此设置为 `0.0.0.0` 将监听所有地址，包括局域网和公网地址。'),
    port: z.natural().required().max(65535).description('要监听的初始端口号。'),
    maxPort: z.natural().max(65535).description('允许监听的最大端口号。'),
    selfUrl: z.string().role('link').description('应用暴露在公网的地址。'),
  })
}

export default Server
