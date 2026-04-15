import { Context } from 'cordis'
import { expect } from 'chai'
import { WebSocket } from 'ws'
import Server from '../src'

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function setup(config: Partial<Server.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(Server, {
    host: '127.0.0.1',
    port: 30000,
    maxPort: 39999,
    ...config,
  })
  return { ctx, url: ctx.server.selfUrl }
}

describe('@cordisjs/plugin-server', () => {
  let ctx: Context
  let url: string

  afterEach(async () => {
    ctx?.registry.delete(Server)
    await sleep()
  })

  describe('basic server lifecycle', () => {
    it('should start and listen', async () => {
      ({ ctx, url } = await setup())
      const res = await fetch(`${url}/`)
      expect(res.status).to.equal(404)
    })

    it('should fallback to next port if configured port is in use', async () => {
      ({ ctx, url } = await setup({ port: 30010 }))
      const port1 = ctx.server.port

      const ctx2 = new Context()
      await ctx2.plugin(Server, { host: '127.0.0.1', port: 30010, maxPort: 30020 })
      expect(ctx2.server.port).to.equal(port1 + 1)
      ctx2.registry.delete(Server)
      await sleep()
    })
  })

  describe('HTTP routing', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should handle GET route', async () => {
      ctx.server.get('/hello', async (req, res, next) => {
        res.body = 'world'
      })
      await sleep()

      const res = await fetch(`${url}/hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('world')
    })

    it('should handle POST route', async () => {
      ctx.server.post('/echo', async (req, res, next) => {
        const text = await req.text()
        res.body = text
      })
      await sleep()

      const res = await fetch(`${url}/echo`, {
        method: 'POST',
        body: 'hello',
      })
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello')
    })

    it('should handle route returning Response object', async () => {
      ctx.server.get('/response', async (req, res, next) => {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
      await sleep()

      const res = await fetch(`${url}/response`)
      expect(res.status).to.equal(200)
      expect(await res.json()).to.deep.equal({ ok: true })
    })

    it('should extract typed path params', async () => {
      ctx.server.get('/users/:id', async (req, res, next) => {
        res.body = req.params.id
      })
      await sleep()

      const res = await fetch(`${url}/users/42`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('42')
    })

    it('should decode path params', async () => {
      ctx.server.get('/files/:name', async (req, res, next) => {
        res.body = req.params.name
      })
      await sleep()

      const res = await fetch(`${url}/files/hello%20world`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello world')
    })

    it('should handle wildcard path params', async () => {
      ctx.server.get('{/*path}', async (req, res, next) => {
        res.body = req.params.path
      })
      await sleep()

      const res = await fetch(`${url}/a/b/c`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('a/b/c')
    })

    it('should match route with query string', async () => {
      ctx.server.get('/search', async (req, res, next) => {
        res.body = req.query.get('q') ?? ''
      })
      await sleep()

      const res = await fetch(`${url}/search?q=hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello')
    })

    it('should not leak query string into path params', async () => {
      ctx.server.get('{/*path}', async (req, res, next) => {
        res.body = req.params.path
      })
      await sleep()

      const res = await fetch(`${url}/a/b?foo=bar`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('a/b')
    })

    it('should handle regex routes', async () => {
      ctx.server.get(/^\/re\/(\d+)$/, async (req, res, next) => {
        res.body = req.params[1]
      })
      await sleep()

      const res = await fetch(`${url}/re/123`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('123')
    })

    it('should support all() to match any method', async () => {
      ctx.server.all('/any', async (req, res, next) => {
        res.body = req.method
      })
      await sleep()

      const get = await fetch(`${url}/any`)
      expect(await get.text()).to.equal('GET')

      const post = await fetch(`${url}/any`, { method: 'POST' })
      expect(await post.text()).to.equal('POST')
    })
  })

  describe('status codes', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should return 404 for unmatched path', async () => {
      const res = await fetch(`${url}/nonexistent`)
      expect(res.status).to.equal(404)
    })

    it('should return 405 with Allow header for mismatched method', async () => {
      ctx.server.get('/only-get', async (req, res, next) => {
        res.body = 'ok'
      })
      await sleep()

      const res = await fetch(`${url}/only-get`, { method: 'POST' })
      expect(res.status).to.equal(405)
      expect(res.headers.get('allow')).to.equal('get')
    })

    it('should treat all() as wildcard method in Allow header', async () => {
      ctx.server.all('/any', async (req, res, next) => {
        return next()
      })
      await sleep()

      const res = await fetch(`${url}/any`, { method: 'OPTIONS' })
      expect(res.status).to.equal(204)
      expect(res.headers.get('allow')).to.equal('*')
    })

    it('should handle OPTIONS with Allow header', async () => {
      ctx.server.get('/resource', async (req, res, next) => {
        res.body = 'ok'
      })
      ctx.server.post('/resource', async (req, res, next) => {
        res.body = 'ok'
      })
      await sleep()

      const res = await fetch(`${url}/resource`, { method: 'OPTIONS' })
      expect(res.status).to.equal(204)
      const allow = res.headers.get('allow')
      expect(allow).to.include('get')
      expect(allow).to.include('post')
    })

    it('should allow setting custom status code', async () => {
      ctx.server.get('/created', async (req, res, next) => {
        res.status = 201
        res.body = 'created'
      })
      await sleep()

      const res = await fetch(`${url}/created`)
      expect(res.status).to.equal(201)
    })
  })

  describe('middleware (use)', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should run middleware before routes', async () => {
      const order: string[] = []
      ctx.server.use(async (req, res, next) => {
        order.push('middleware')
        await next()
      })
      ctx.server.get('/test', async (req, res, next) => {
        order.push('route')
        res.body = 'ok'
      })
      await sleep()

      await fetch(`${url}/test`)
      expect(order).to.deep.equal(['middleware', 'route'])
    })

    it('should allow middleware to short-circuit', async () => {
      ctx.server.use(async (req, res, next) => {
        res.status = 403
        res.body = 'forbidden'
      })
      ctx.server.get('/test', async (req, res, next) => {
        res.body = 'should not reach'
      })
      await sleep()

      const res = await fetch(`${url}/test`)
      expect(res.status).to.equal(403)
      expect(await res.text()).to.equal('forbidden')
    })
  })

  describe('request body parsing', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should parse JSON body', async () => {
      ctx.server.post('/json', async (req, res, next) => {
        const data = await req.json()
        res.body = JSON.stringify(data)
        res.headers.set('content-type', 'application/json')
      })
      await sleep()

      const res = await fetch(`${url}/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      })
      expect(await res.json()).to.deep.equal({ foo: 'bar' })
    })

    it('should parse text body', async () => {
      ctx.server.post('/text', async (req, res, next) => {
        const text = await req.text()
        res.body = text.toUpperCase()
      })
      await sleep()

      const res = await fetch(`${url}/text`, {
        method: 'POST',
        body: 'hello',
      })
      expect(await res.text()).to.equal('HELLO')
    })
  })

  describe('response headers', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should set custom response headers', async () => {
      ctx.server.get('/headers', async (req, res, next) => {
        res.headers.set('x-custom', 'value')
        res.body = 'ok'
      })
      await sleep()

      const res = await fetch(`${url}/headers`)
      expect(res.headers.get('x-custom')).to.equal('value')
    })
  })

  describe('route disposal', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should remove route on dispose', async () => {
      const route = ctx.server.get('/temp', async (req, res, next) => {
        res.body = 'exists'
      })
      await sleep()

      const res1 = await fetch(`${url}/temp`)
      expect(res1.status).to.equal(200)

      route.dispose()
      await sleep()

      const res2 = await fetch(`${url}/temp`)
      expect(res2.status).to.equal(404)
    })
  })

  describe('selfUrl', () => {
    it('should compute selfUrl from host and port', async () => {
      ({ ctx } = await setup())
      expect(ctx.server.selfUrl).to.match(/^http:\/\/127\.0\.0\.1:\d+$/)
    })

    it('should resolve wildcard host to 127.0.0.1', async () => {
      ({ ctx } = await setup({ host: '0.0.0.0' }))
      expect(ctx.server.selfUrl).to.match(/^http:\/\/127\.0\.0\.1:\d+$/)
    })

    it('should prefer config.selfUrl when set', async () => {
      ({ ctx } = await setup({ selfUrl: 'https://example.com/' }))
      expect(ctx.server.selfUrl).to.equal('https://example.com')
    })
  })

  describe('error handling', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should return 500 when route throws', async () => {
      ctx.server.get('/error', async (req, res, next) => {
        throw new Error('test error')
      })
      await sleep()

      const res = await fetch(`${url}/error`)
      expect(res.status).to.equal(500)
    })

    it('should not override status if already set before throw', async () => {
      ctx.server.get('/error', async (req, res, next) => {
        res.status = 503
        throw new Error('test error')
      })
      await sleep()

      const res = await fetch(`${url}/error`)
      expect(res.status).to.equal(503)
    })
  })

  describe('WebSocket routing', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    function connect(path: string) {
      const wsUrl = url.replace('http', 'ws') + path
      return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        ws.on('open', () => resolve(ws))
        ws.on('error', reject)
      })
    }

    function connectRaw(path: string): Promise<{ statusCode: number }> {
      const wsUrl = url.replace('http', 'ws') + path
      return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl)
        ws.on('open', () => {
          ws.close()
          resolve({ statusCode: 101 })
        })
        ws.on('unexpected-response', (_req, res) => {
          resolve({ statusCode: res.statusCode! })
        })
        ws.on('error', () => {})
      })
    }

    it('should accept ws connection on matched route', async () => {
      ctx.server.ws('/ws')
      await sleep()

      const ws = await connect('/ws')
      expect(ws.readyState).to.equal(WebSocket.OPEN)
      ws.close()
    })

    it('should return 404 for unmatched ws route', async () => {
      const { statusCode } = await connectRaw('/no-such-ws')
      expect(statusCode).to.equal(404)
    })

    it('should track clients and clean up on close', async () => {
      const route = ctx.server.ws('/ws')
      await sleep()

      const ws = await connect('/ws')
      expect(route.clients.size).to.equal(1)

      const closed = new Promise<void>((resolve) => {
        for (const client of route.clients) {
          client.on('close', resolve)
        }
      })
      ws.close()
      await closed
      expect(route.clients.size).to.equal(0)
    })

    it('should close clients on route dispose', async () => {
      const route = ctx.server.ws('/ws')
      await sleep()

      const ws = await connect('/ws')
      const closed = new Promise<void>((resolve) => ws.on('close', resolve))

      route.dispose()
      await closed
      expect(ws.readyState).to.equal(WebSocket.CLOSED)
    })

    it('should support ws handler with accept', async () => {
      const messages: string[] = []
      ctx.server.ws('/ws', async (req, accept) => {
        const ws = await accept()
        ws.on('message', (data) => messages.push(data.toString()))
      })
      await sleep()

      const ws = await connect('/ws')
      ws.send('hello')
      await sleep(50)
      expect(messages).to.deep.equal(['hello'])
      ws.close()
    })

    it('should return 500 when ws handler throws', async () => {
      ctx.server.ws('/ws', async (req, accept) => {
        throw new Error('ws error')
      })
      await sleep()

      const { statusCode } = await connectRaw('/ws')
      expect(statusCode).to.equal(500)
    })

    it('should destroy socket when handler does not accept', async () => {
      ctx.server.ws('/ws', async (req, accept) => {
        // intentionally not calling accept
      })
      await sleep()

      const result = await new Promise<string>((resolve) => {
        const ws = new WebSocket(url.replace('http', 'ws') + '/ws')
        ws.on('error', (err) => resolve(err.message))
        ws.on('open', () => resolve('open'))
      })
      expect(result).to.not.equal('open')
    })
  })

  describe('intercept path prefix', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should scope route under intercept path', async () => {
      const scoped = ctx.intercept('server', { path: '/api' })
      scoped.server.get('/data', async (req, res, next) => {
        res.body = 'scoped'
      })
      await sleep()

      const res1 = await fetch(`${url}/api/data`)
      expect(res1.status).to.equal(200)
      expect(await res1.text()).to.equal('scoped')

      const res2 = await fetch(`${url}/data`)
      expect(res2.status).to.equal(404)
    })
  })
})
