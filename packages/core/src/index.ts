import { Context, Service, z } from 'cordis'
import { defineProperty, Dict, remove, trimSlash } from 'cosmokit'
import * as http from 'node:http'
import { Keys, pathToRegexp } from 'path-to-regexp'
import { WebSocket, WebSocketServer } from 'ws'
import { listen, ListenOptions } from './listen'

export {} from 'koa-body'

declare module 'cordis' {
  interface Context {
    server: Server
  }

  interface Events {
    'server/ready'(this: Server): void
    'server/request'(this: Server, request: Server.Request, response: Server.Response, next: () => Promise<void>): Promise<void>
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

type WebSocketCallback<P> = (socket: WebSocket, request: Server.Request<P>) => void

export class WebSocketLayer<P = never> {
  clients = new Set<WebSocket>()
  regexp: RegExp
  keys: Keys

  constructor(private server: Server, path: string, public callback?: WebSocketCallback<P>) {
    const { regexp, keys } = pathToRegexp(path)
    this.regexp = regexp
    this.keys = keys
  }

  _accept(socket: WebSocket, request: Server.Request<P>) {
    const capture = this.regexp.exec(request.url!)
    if (!capture) return
    const params: Dict<string> = {}
    this.keys.forEach(({ name }, index) => {
      params[name] = capture[index + 1]
    })
    this.clients.add(socket)
    socket.addEventListener('close', () => {
      this.clients.delete(socket)
    })
    if (this.callback) {
      request = Object.create(request)
      request.params = params as P
      this.callback?.(socket, request)
    }
    return true
  }

  close() {
    remove(this.server.wsStack, this)
    for (const socket of this.clients) {
      socket.close()
    }
  }
}

interface Server {
  get(path: string)
}

class Server extends Service {
  static inject = {
    logger: { required: false },
  }

  public _http: http.Server
  public _ws: WebSocketServer
  public wsStack: WebSocketLayer[] = []

  public host!: string
  public port!: number

  constructor(protected ctx: Context, public config: Server.Config) {
    super(ctx, 'server')

    this._http = http.createServer()

    this._http.on('request', async (req, res) => {
      defineProperty(req, Service.tracker, { associate: 'server.request' })
      defineProperty(res, Service.tracker, { associate: 'server.response' })
      this.ctx.logger('server:request')?.debug('%c %s', req.method, req.url)
      await this.ctx.waterfall(this, 'server/request', req as any, res as any, async () => {})
      res.on('finish', () => {
        this.ctx.logger('server:response')?.debug('%c %s %s', req.method, req.url, res.statusCode)
      })
    })

    this._ws = new WebSocketServer({
      server: this._http,
    })

    this._ws.on('connection', (socket, request: Server.Request) => {
      defineProperty(request, Service.tracker, { associate: 'server.request' })
      for (const layer of this.wsStack) {
        if (layer._accept(socket, request)) return
      }
      socket.close()
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

  ws<P extends string>(path: P, callback?: WebSocketCallback<ExtractParams<P>>) {
    const layer = new WebSocketLayer<ExtractParams<P>>(this, path, callback)
    this.wsStack.push(layer)
    this.ctx.scope.disposables.push(() => layer.close())
    return layer
  }
}

namespace Server {
  export interface Request<P = never> extends http.IncomingMessage {
    params: P
  }

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
