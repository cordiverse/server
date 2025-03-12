import { Context, DisposableList, Service, z } from 'cordis'
import { defineProperty, Dict, trimSlash } from 'cosmokit'
import * as http from 'node:http'
import { Keys, pathToRegexp } from 'path-to-regexp'
import { WebSocket, WebSocketServer } from 'ws'
import { listen, ListenOptions } from './listen'

declare module 'cordis' {
  interface Context {
    server: Server
  }

  interface Events {
    'server/ready'(this: Server): void
    'server/request'(this: Server, req: Server.Request, res: Server.Response, next: () => Promise<void>): Promise<void>
    'server/request/route'(this: Server, req: Server.Request, res: Server.Response, next: () => Promise<void>): Promise<void>
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
  keys: Keys

  constructor(protected server: Server, public path: string | RegExp) {
    if (typeof path === 'string') {
      const { regexp, keys } = pathToRegexp(path)
      this.regexp = regexp
      this.keys = keys
    } else {
      this.regexp = path
      this.keys = []
    }
  }

  check(req: Server.Request) {
    const capture = this.regexp.exec(req.url!)
    if (!capture) return
    const params: Dict<string> = {}
    this.keys.forEach(({ name }, index) => {
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/decodeURIComponent#decoding_query_parameters_from_a_url
      params[name] = decodeURIComponent(capture[index + 1].replace(/\+/g, ' '))
    })
    return params
  }
}

type WsCallback<P = any> = (socket: WebSocket, req: Server.Request & { params: P }) => void

export class WsRoute extends Route {
  clients = new Set<WebSocket>()
  dispose: () => Promise<void>

  constructor(server: Server, path: string | RegExp, public callback?: WsCallback) {
    super(server, path)
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

  _accept(socket: WebSocket, req: Server.Request) {
    const params = this.check(req)
    if (!params) return false
    this.clients.add(socket)
    socket.addEventListener('close', () => {
      this.clients.delete(socket)
    })
    if (this.callback) {
      this.callback(socket, Object.assign(Object.create(req), { params }))
    }
    return true
  }
}

export type Middleware<P = any> = (req: Server.Request & { params: P }, res: Server.Response, next: () => Promise<void>) => Promise<void>

interface Server {
  all<P extends string>(path: P | RegExp, middleware: Middleware<ExtractParams<P>>): HttpRoute
  get<P extends string>(path: P | RegExp, middleware: Middleware<ExtractParams<P>>): HttpRoute
  delete<P extends string>(path: P | RegExp, middleware: Middleware<ExtractParams<P>>): HttpRoute
  head<P extends string>(path: P | RegExp, middleware: Middleware<ExtractParams<P>>): HttpRoute
  post<P extends string>(path: P | RegExp, middleware: Middleware<ExtractParams<P>>): HttpRoute
  put<P extends string>(path: P | RegExp, middleware: Middleware<ExtractParams<P>>): HttpRoute
  patch<P extends string>(path: P | RegExp, middleware: Middleware<ExtractParams<P>>): HttpRoute
}

class HttpRoute extends Route {
  dispose: () => Promise<void>

  constructor(server: Server, public method: Server.Method | undefined, path: string | RegExp, public callback: Middleware) {
    super(server, path)
    const self = this
    this.dispose = server.ctx.effect(function* () {
      yield server.httpRoutes.push(self)
      yield server.ctx.on('server/request/route', async (req, res, next) => {
        const params = self.check(req)
        if (!params) return next()
        return callback(Object.assign(Object.create(req), { params }), res, next)
      })
    })
  }
}

class Server extends Service {
  static inject = {
    logger: { required: false },
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

    this._http.on('request', async (req: Server.Request, res: Server.Response) => {
      defineProperty(req, Service.tracker, { associate: 'server.request' })
      defineProperty(res, Service.tracker, { associate: 'server.response' })
      this.ctx.logger('server:request')?.debug('%c %s', req.method, req.url)
      res.on('finish', () => {
        this.ctx.logger('server:response')?.debug('%c %s %s', req.method, req.url, res.statusCode)
      })
      await this.ctx.waterfall(this, 'server/request', req, res, async () => {})
      res.end()
    })

    this.ctx.on('server/request', async (req, res, next) => {
      return this.ctx.waterfall(this, 'server/request/route', req, res, async () => {
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
          res.statusCode = 404
        } else if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.setHeader('Allow', asterisk ? '*' : [...methods].join(', '))
        } else {
          res.statusCode = 405
        }
        return next()
      })
    })

    this._ws = new WebSocketServer({
      server: this._http,
    })

    this._ws.on('connection', (socket, req: Server.Request) => {
      defineProperty(req, Service.tracker, { associate: 'server.request' })
      for (const route of this.wsRoutes) {
        if (route._accept(socket, req)) return
      }
      socket.close()
    })

    if (config.selfUrl) {
      config.selfUrl = trimSlash(config.selfUrl)
    }
  }

  static {
    const methods = ['all', 'get', 'delete', 'head', 'post', 'put', 'patch'] as const
    for (const method of methods) {
      defineProperty(Server.prototype, method, function (this: Server, path, middleware) {
        return new HttpRoute(this, method === 'all' ? undefined : method.toUpperCase() as Server.Method, path, middleware)
      })
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
      this.ctx.logger?.info('server closing')
    }
    this._ws?.close()
    this._http?.close()
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

  ws<P extends string>(path: P | RegExp, callback?: WsCallback<ExtractParams<P>>) {
    return new WsRoute(this, path, callback)
  }
}

namespace Server {
  export type Method = 'GET' | 'DELETE' | 'HEAD' | 'POST' | 'PUT' | 'PATCH'

  export interface Request extends http.IncomingMessage {}

  export interface Response extends http.ServerResponse {}

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
