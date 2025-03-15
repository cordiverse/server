import { Service } from 'cordis'
import { defineProperty, isNullable } from 'cosmokit'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

export class Request implements Body {
  readonly url: string
  readonly method: string
  readonly headers: Headers

  private _bodyImpl: globalThis.Response

  constructor(public inner: IncomingMessage) {
    defineProperty(this, Service.tracker, { associate: 'server.request' })
    this.url = inner.url!
    this.method = inner.method!
    this.headers = new Headers()
    for (const [key, value] of Object.entries(inner.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          this.headers.append(key, v)
        }
      } else if (typeof value === 'string') {
        this.headers.set(key, value)
      }
    }
    this._bodyImpl = new globalThis.Response(Readable.toWeb(this.inner) as ReadableStream, {
      headers: this.headers,
    })
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

  private _body?: BodyInit | null
  private _bodyUsed = false
  private _hasStatus = false

  constructor(public inner: ServerResponse) {
    defineProperty(this, Service.tracker, { associate: 'server.response' })
    inner.statusCode = 404
  }

  get status() {
    return this.inner.statusCode
  }

  set status(value) {
    this.inner.statusCode = value
    this._hasStatus = true
  }

  get statusText() {
    return this.inner.statusMessage
  }

  set statusText(value) {
    this.inner.statusMessage = value
  }

  get ok() {
    return this.inner.statusCode >= 200 && this.inner.statusCode < 300
  }

  get redirected() {
    return this.inner.statusCode >= 300 && this.inner.statusCode < 400
  }

  get body() {
    return this._body
  }

  set body(value: BodyInit | null | undefined) {
    if (this._bodyUsed) throw new TypeError('Body already used')
    this._body = value
    if (!isNullable(value) && !this._hasStatus) {
      this.inner.statusCode = 200
    }
  }

  get bodyUsed() {
    return this._bodyUsed
  }

  _end() {
    if (isNullable(this._body)) return
    this._bodyUsed = true
    const body = new globalThis.Response(this._body).body! as any
    Readable.fromWeb(body).pipe(this.inner, { end: true })
  }
}
