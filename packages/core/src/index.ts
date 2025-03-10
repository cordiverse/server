import { Context, Service, z } from 'cordis'
import { makeArray, MaybeArray, remove, trimSlash } from 'cosmokit'
import { createServer, Server as HTTPServer, IncomingMessage } from 'node:http'
import { pathToRegexp } from 'path-to-regexp'
import { koaBody } from 'koa-body'
import parseUrl from 'parseurl'
import { WebSocket, WebSocketServer } from 'ws'
import KoaRouter, { Middleware } from '@koa/router'
import Koa from 'koa'
import { listen } from './listen'

export {} from 'koa-body'

declare module 'cordis' {
  interface Context {
    server: Server
  }

  interface Events {
    'server/ready'(this: Server): void
  }
}

type WebSocketCallback = (socket: WebSocket, request: IncomingMessage) => void

export class WebSocketLayer {
  clients = new Set<WebSocket>()
  regexp: RegExp

  constructor(private server: Server, path: MaybeArray<string | RegExp>, public callback?: WebSocketCallback) {
    this.regexp = pathToRegexp(path)
  }

  accept(socket: WebSocket, request: IncomingMessage) {
    if (!this.regexp.test(parseUrl(request)!.pathname!)) return
    this.clients.add(socket)
    socket.addEventListener('close', () => {
      this.clients.delete(socket)
    })
    this.callback?.(socket, request)
    return true
  }

  close() {
    remove(this.server.wsStack, this)
    for (const socket of this.clients) {
      socket.close()
    }
  }
}

export class Server extends KoaRouter {
  [Service.tracker] = {
    associate: 'server',
    property: 'ctx',
  }

  static inject = {
    logger: { required: false },
  }

  public _http: HTTPServer
  public _ws: WebSocketServer
  public wsStack: WebSocketLayer[] = []
  public _koa = new Koa()
  public _body: Middleware

  public host!: string
  public port!: number

  constructor(protected ctx: Context, public config: Server.Config) {
    super()
    ctx.provide('server')
    ctx.alias('server', ['router'])

    // create server
    this._body = koaBody({
      multipart: true,
      jsonLimit: '10mb',
      formLimit: '10mb',
      textLimit: '10mb',
      includeUnparsed: true,
    })
    this._koa.use(this.routes())
    this._koa.use(this.allowedMethods())

    this._http = createServer(this._koa.callback())
    this._ws = new WebSocketServer({
      server: this._http,
    })

    this._ws.on('connection', (socket, request) => {
      for (const manager of this.wsStack) {
        if (manager.accept(socket, request)) return
      }
      socket.close()
    })

    if (config.selfUrl) {
      config.selfUrl = trimSlash(config.selfUrl)
    }

    ctx.on('ready', async () => {
      const { host = '127.0.0.1', port } = config
      if (!port) return
      this.host = host
      this.port = await listen(config)
      this._http.listen(this.port, host)
      this.ctx.logger?.info('server listening at %c', `http://${host}:${this.port}`)
      ctx.emit(this, 'server/ready')
    }, true)

    ctx.on('dispose', () => {
      if (config.port) {
        this.ctx.logger?.info('server closing')
      }
      this._ws?.close()
      this._http?.close()
    })

    const self = this
    ctx.set('server', self)
    ctx.on('internal/listener', function (name: string, listener: Function) {
      if (name !== 'server/ready' || !self[Context.filter](this) || !self.port) return
      listener()
      return () => false
    })

    return self
  }

  [Context.filter](ctx: Context) {
    return ctx[Context.isolate].server === this.ctx[Context.isolate].server
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

  /**
   * hack into router methods to make sure that koa middlewares are disposable
   */
  register(...args: Parameters<KoaRouter['register']>) {
    args[2] = makeArray(args[2])
    if (!args[2][0][Symbol.for('noParseBody')]) {
      args[2].unshift(this._body)
    }
    const layer = super.register(...args)
    this.ctx.scope.disposables.push(() => {
      remove(this.stack, layer)
    })
    return layer
  }

  ws(path: MaybeArray<string | RegExp>, callback?: WebSocketCallback) {
    const layer = new WebSocketLayer(this, path, callback)
    this.wsStack.push(layer)
    this.ctx.scope.disposables.push(() => layer.close())
    return layer
  }
}

export namespace Server {
  export interface Config {
    host: string
    port: number
    maxPort?: number
    selfUrl?: string
  }

  export const Config: z<Config> = z.object({
    host: z.string().default('127.0.0.1').description('要监听的 IP 地址。如果将此设置为 `0.0.0.0` 将监听所有地址，包括局域网和公网地址。'),
    port: z.natural().max(65535).description('要监听的初始端口号。'),
    maxPort: z.natural().max(65535).description('允许监听的最大端口号。'),
    selfUrl: z.string().role('link').description('应用暴露在公网的地址。'),
  })
}

export default Server
