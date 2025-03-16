import { Service } from 'cordis'
import { defineProperty, isNullable } from 'cosmokit'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import accepts from 'accepts'

export class Request implements Body {
  readonly url: string
  readonly method: string
  readonly headers: Headers

  private _accepts?: accepts.Accepts
  private _bodyImpl: globalThis.Response

  constructor(public _req: IncomingMessage) {
    defineProperty(this, Service.tracker, { associate: 'server.request' })
    this.url = _req.url!
    this.method = _req.method!
    this.headers = new Headers()
    for (const [key, value] of Object.entries(_req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          this.headers.append(key, v)
        }
      } else if (typeof value === 'string') {
        this.headers.set(key, value)
      }
    }
    this._bodyImpl = new globalThis.Response(Readable.toWeb(this._req) as ReadableStream, {
      headers: this.headers,
    })
  }

  accepts(): string[]
  accepts(types: string[]): string | false
  accepts(...types: string[]): string | false
  accepts(...args: any[]) {
    this._accepts ??= accepts(this._req)
    return this._accepts.types(...args)
  }

  get body() {
    return this._bodyImpl.body
  }

  get bodyUsed() {
    return this._bodyImpl.bodyUsed
  }

  arrayBuffer() {
    return this._bodyImpl.arrayBuffer()
  }

  blob() {
    return this._bodyImpl.blob()
  }

  bytes() {
    return this._bodyImpl.bytes()
  }

  formData() {
    return this._bodyImpl.formData()
  }

  json() {
    return this._bodyImpl.json()
  }

  text() {
    return this._bodyImpl.text()
  }
}

export class Response {
  readonly headers = new Headers()

  private _bodyInit?: BodyInit | null
  private _bodyUsed = false
  private _hasStatus = false

  legacyMode = false

  constructor(public _res: ServerResponse) {
    defineProperty(this, Service.tracker, { associate: 'server.response' })
    _res.statusCode = 404
  }

  get status() {
    return this._res.statusCode
  }

  set status(value) {
    this._res.statusCode = value
    this._hasStatus = true
  }

  get statusText() {
    return this._res.statusMessage
  }

  set statusText(value) {
    this._res.statusMessage = value
  }

  get ok() {
    return this._res.statusCode >= 200 && this._res.statusCode < 300
  }

  get redirected() {
    return this._res.statusCode >= 300 && this._res.statusCode < 400
  }

  get body() {
    return this._bodyInit
  }

  set body(value: BodyInit | null | undefined) {
    if (this._bodyUsed) throw new TypeError('Body already used')
    this._bodyInit = value
    if (!isNullable(value) && !this._hasStatus) {
      this._res.statusCode = 200
    }
  }

  get bodyUsed() {
    return this._bodyUsed
  }

  _end() {
    if (this.legacyMode) return
    this._res.writeHead(this._res.statusCode, this._res.statusMessage, Object.fromEntries(this.headers))
    if (isNullable(this._bodyInit)) {
      return this._res.end()
    }
    this._bodyUsed = true
    const body = new globalThis.Response(this._bodyInit).body! as any
    Readable.fromWeb(body).pipe(this._res, { end: true })
  }
}
