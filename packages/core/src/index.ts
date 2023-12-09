import { Context } from 'cordis'
import { MaybeArray, remove, trimSlash } from 'cosmokit'
import { createServer, IncomingMessage, Server } from 'http'
import { pathToRegexp } from 'path-to-regexp'
import type { Logger } from '@cordisjs/logger'
import parseUrl from 'parseurl'
import WebSocket from 'ws'
import Schema from 'schemastery'
import KoaRouter from '@koa/router'
import Koa from 'koa'
import { listen } from './listen'

declare module 'koa' {
  // koa-bodyparser
  interface Request {
    body?: any
    rawBody?: string
  }
}

declare module 'cordis' {
  interface Context {
    server: Router
    /** @deprecated use `ctx.server` instead */
    router: Router
  }

  interface Events {
    'server/ready'(this: Router): void
  }
}

type WebSocketCallback = (socket: WebSocket, request: IncomingMessage) => void

export class WebSocketLayer {
  clients = new Set<WebSocket>()
  regexp: RegExp

  constructor(private server: Router, path: MaybeArray<string | RegExp>, public callback?: WebSocketCallback) {
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

export interface Router extends Context.Associate<'server'> {}

export class Router extends KoaRouter {
  public _http: Server
  public _ws: WebSocket.Server
  public wsStack: WebSocketLayer[] = []

  public host!: string
  public port!: number

  private logger: Logger

  constructor(protected ctx: Context, public config: Router.Config) {
    super()
    ctx.provide('server')
    ctx.alias('server', ['router'])
    this.logger = ctx.logger('server')

    // create server
    const koa = new Koa()
    koa.use(require('koa-bodyparser')({
      enableTypes: ['json', 'form', 'xml'],
      jsonLimit: '10mb',
      formLimit: '10mb',
      textLimit: '10mb',
      xmlLimit: '10mb',
    }))
    koa.use(this.routes())
    koa.use(this.allowedMethods())

    this._http = createServer(koa.callback())
    this._ws = new WebSocket.Server({
      server: this._http,
    })

    this._ws.on('connection', (socket, request) => {
      for (const manager of this.wsStack) {
        if (manager.accept(socket, request)) return
      }
      socket.close()
    })

    ctx.decline(['selfUrl', 'host', 'port', 'maxPort'])

    if (config.selfUrl) {
      config.selfUrl = trimSlash(config.selfUrl)
    }

    ctx.on('ready', async () => {
      const { host = '127.0.0.1', port } = config
      if (!port) return
      this.host = host
      this.port = await listen(config)
      this._http.listen(this.port, host)
      this.logger.info('server listening at %c', this.selfUrl)
      ctx.emit(this, 'server/ready')
    }, true)

    ctx.on('dispose', () => {
      if (config.port) {
        this.logger.info('http server closing')
      }
      this._ws?.close()
      this._http?.close()
    })

    const self = this
    ctx.on('internal/listener', function (name: string, listener: Function) {
      if (name !== 'server/ready' || !self[Context.filter](this) || !self.port) return
      this.scope.ensure(async () => listener())
      return () => false
    })

    return ctx.server = Context.associate(this, 'server')
  }

  [Context.filter](ctx: Context) {
    return ctx[Context.shadow].server === this.ctx[Context.shadow].server
  }

  get selfUrl() {
    const wildcard = ['0.0.0.0', '::']
    const host = wildcard.includes(this.host) ? '127.0.0.1' : this.host
    return `http://${host}:${this.port}`
  }

  /**
   * hack into router methods to make sure that koa middlewares are disposable
   */
  register(...args: Parameters<KoaRouter['register']>) {
    const layer = super.register(...args)
    const context = this[Context.current]
    context?.state.disposables.push(() => {
      remove(this.stack, layer)
    })
    return layer
  }

  ws(path: MaybeArray<string | RegExp>, callback?: WebSocketCallback) {
    const layer = new WebSocketLayer(this, path, callback)
    this.wsStack.push(layer)
    const context = this[Context.current]
    context?.state.disposables.push(() => layer.close())
    return layer
  }
}

export namespace Router {
  export interface Config {
    host: string
    port: number
    maxPort?: number
    selfUrl?: string
  }

  export const Config: Schema<Config> = Schema.object({
    host: Schema.string().default('127.0.0.1').description('要监听的 IP 地址。如果将此设置为 `0.0.0.0` 将监听所有地址，包括局域网和公网地址。'),
    port: Schema.natural().max(65535).description('要监听的初始端口号。'),
    maxPort: Schema.natural().max(65535).description('允许监听的最大端口号。'),
    selfUrl: Schema.string().role('link').description('应用暴露在公网的地址。'),
  })
}

export default Router
