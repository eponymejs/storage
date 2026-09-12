import { AwsClient } from 'aws4fetch'
import { StorageError } from './index'
import type { ListOptions, ListResult, PutMeta, StorageDriver, StorageErrorCode, StorageFactory, StorageFactoryContext, StorageObject, UrlOptions } from './index'

const DEFAULT_EXPIRATION = 900
const MAX_EXPIRATION = 604_800
const MAX_LIST_KEYS = 1000
/** What `stat` reports when the object was stored without a content type. */
const FALLBACK_CONTENT_TYPE = 'application/octet-stream'

export interface S3CompatibleOptions {
  bucket: string
  region: string
  endpoint?: string
  pathStyle?: boolean
  publicUrl?: string
  presignExpiresIn?: number
}

interface AdapterOptions extends S3CompatibleOptions {
  provider: 's3' | 'r2' | 'gcs'
  copyHeaderPrefix: 'x-amz' | 'x-goog'
  defaultEndpoint?: string
}

interface SignedRequestOptions {
  method: string
  headers?: HeadersInit
  body?: BodyInit | null
  query?: Record<string, string>
  expiresIn?: number
  signQuery?: boolean
  allHeaders?: boolean
}

function requiredString(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function validateBucket(bucket: string): string {
  requiredString(bucket, 'bucket')
  if (hasControlCharacter(bucket) || bucket.includes('/') || bucket.includes('\\')) {
    throw new TypeError('bucket contains invalid characters')
  }
  return bucket
}

export function validateKey(key: string): string {
  requiredString(key, 'key')
  if (key.startsWith('/')) {
    throw new TypeError('key must be relative')
  }
  if (key.includes('\0') || key.includes('\\')) {
    throw new TypeError('key contains invalid characters')
  }
  const segments = key.split('/')
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new TypeError('key contains an invalid path segment')
  }
  return key
}

export function encodeKey(key: string): string {
  return validateKey(key).split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/** A prefix is a string match. It may be empty or stop mid-segment. */
export function validatePrefix(prefix: string): string {
  if (typeof prefix !== 'string') throw new TypeError('prefix must be a string')
  if (prefix === '') return prefix
  if (prefix.startsWith('/')) throw new TypeError('prefix must be relative')
  if (prefix.includes('\0') || prefix.includes('\\')) {
    throw new TypeError('prefix contains invalid characters')
  }
  if (prefix.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new TypeError('prefix contains an invalid path segment')
  }
  return prefix
}

function validateMeta(meta: PutMeta): PutMeta {
  if (!meta || typeof meta !== 'object') {
    throw new TypeError('meta is required')
  }
  requiredString(meta.contentType, 'meta.contentType')
  if (hasControlCharacter(meta.contentType)) {
    throw new TypeError('meta.contentType contains invalid characters')
  }
  if (!Number.isSafeInteger(meta.size) || meta.size < 0) {
    throw new TypeError('meta.size must be a non-negative safe integer')
  }
  return meta
}

function validateExpiration(value: number | undefined, name = 'expiresIn'): number {
  const expiration = value ?? DEFAULT_EXPIRATION
  if (!Number.isInteger(expiration) || expiration < 1 || expiration > MAX_EXPIRATION) {
    throw new RangeError(`${name} must be an integer between 1 and ${MAX_EXPIRATION}`)
  }
  return expiration
}

function normalizeBaseUrl(value: string, name: string): URL {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new TypeError(`${name} must be a valid HTTP URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError(`${name} must be a valid HTTP URL without credentials, query or fragment`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

function publicObjectUrl(base: string, encodedKey: string): string {
  const url = normalizeBaseUrl(base, 'publicUrl')
  url.pathname = `${url.pathname}/${encodedKey}`.replace(/^\/\//, '/')
  return url.toString()
}

function validateDownloadName(download: string): string {
  requiredString(download, 'download')
  if (hasControlCharacter(download)) {
    throw new TypeError('download contains invalid characters')
  }
  return download
}

function contentDisposition(download: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(validateDownloadName(download))}`
}

function errorCode(status: number | undefined): StorageErrorCode {
  if (status === undefined) return 'network'
  if (status === 404 || status === 410) return 'not_found'
  if (status === 401 || status === 403) return 'access_denied'
  if (status === 408 || status === 429 || status >= 500) return 'unavailable'
  return 'unknown'
}

/** Never expose a response body, signed URL or credential in an error. */
function operationError(
  provider: string,
  operation: string,
  key: string,
  response?: Response,
  code?: StorageErrorCode,
): StorageError {
  const status = response ? ` (${response.status}${response.statusText ? ` ${response.statusText}` : ''})` : ''
  return new StorageError({
    message: `[${provider}] ${operation} failed for key ${JSON.stringify(key)}${status}`,
    code: code ?? errorCode(response?.status),
    provider,
    operation,
    key,
    status: response?.status,
  })
}

function validateCredentials(context: StorageFactoryContext): NonNullable<StorageFactoryContext['credentials']> {
  if (!context || typeof context !== 'object' || !context.credentials) {
    throw new TypeError('storage credentials are required')
  }
  const { accessKeyId, secretAccessKey, sessionToken } = context.credentials
  requiredString(accessKeyId, 'credentials.accessKeyId')
  requiredString(secretAccessKey, 'credentials.secretAccessKey')
  if (sessionToken !== undefined) {
    requiredString(sessionToken, 'credentials.sessionToken')
  }
  return { accessKeyId, secretAccessKey, sessionToken }
}

function createObjectUrl(options: AdapterOptions, encodedKey: string): URL {
  if (options.endpoint || options.defaultEndpoint) {
    const endpoint = normalizeBaseUrl(options.endpoint ?? options.defaultEndpoint!, 'endpoint')
    const basePath = endpoint.pathname === '/' ? '' : endpoint.pathname
    const pathStyle = options.pathStyle ?? true
    if (pathStyle) {
      endpoint.pathname = `${basePath}/${encodeURIComponent(options.bucket)}/${encodedKey}`
    }
    else {
      endpoint.hostname = `${options.bucket}.${endpoint.hostname}`
      endpoint.pathname = `${basePath}/${encodedKey}`
    }
    return endpoint
  }

  const pathStyle = options.pathStyle ?? false
  const url = pathStyle
    ? new URL(`https://s3.${options.region}.amazonaws.com`)
    : new URL(`https://${options.bucket}.s3.${options.region}.amazonaws.com`)
  url.pathname = pathStyle
    ? `/${encodeURIComponent(options.bucket)}/${encodedKey}`
    : `/${encodedKey}`
  return url
}

function validateListLimit(value: number | undefined): number {
  const limit = value ?? MAX_LIST_KEYS
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_KEYS) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_LIST_KEYS}`)
  }
  return limit
}

function xmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&')
}

/** Decode keys returned with `encoding-type=url` after reading their XML text. */
function listedKey(value: string): string {
  return decodeURIComponent(xmlText(value).replace(/\+/g, '%2B'))
}

function firstTag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]
}

/** A DOM parser is not available on every supported runtime. */
export function parseListResult(xml: string): ListResult {
  const objects: StorageObject[] = []
  for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = firstTag(entry!, 'Key')
    const size = Number(firstTag(entry!, 'Size'))
    const lastModified = new Date(firstTag(entry!, 'LastModified') ?? '')
    if (key === undefined || !Number.isSafeInteger(size) || Number.isNaN(lastModified.getTime())) continue
    objects.push({ key: listedKey(key), size, lastModified })
  }

  const prefixes: string[] = []
  for (const [, entry] of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
    const prefix = firstTag(entry!, 'Prefix')
    if (prefix !== undefined) prefixes.push(listedKey(prefix))
  }

  const truncated = firstTag(xml, 'IsTruncated')?.trim() === 'true'
  const cursor = truncated ? firstTag(xml, 'NextContinuationToken') : undefined
  return { objects, prefixes, cursor: cursor === undefined ? undefined : xmlText(cursor) }
}

export function createS3CompatibleFactory(rawOptions: AdapterOptions): StorageFactory {
  const options: AdapterOptions = {
    ...rawOptions,
    bucket: validateBucket(rawOptions.bucket),
    region: requiredString(rawOptions.region, 'region'),
  }
  const defaultExpiration = validateExpiration(options.presignExpiresIn, 'presignExpiresIn')
  if (options.endpoint) normalizeBaseUrl(options.endpoint, 'endpoint')
  if (options.publicUrl) normalizeBaseUrl(options.publicUrl, 'publicUrl')

  return (context: StorageFactoryContext): StorageDriver => {
    const credentials = validateCredentials(context)
    const client = new AwsClient({
      ...credentials,
      service: 's3',
      region: options.region,
      retries: 0,
    })

    const signEncoded = async (encodedKey: string, requestOptions: SignedRequestOptions): Promise<Request> => {
      const url = createObjectUrl(options, encodedKey)
      for (const [name, value] of Object.entries(requestOptions.query ?? {})) {
        url.searchParams.set(name, value)
      }
      if (requestOptions.signQuery) {
        url.searchParams.set('X-Amz-Expires', String(validateExpiration(requestOptions.expiresIn)))
      }
      return client.sign(url, {
        method: requestOptions.method,
        headers: requestOptions.headers,
        body: requestOptions.body,
        aws: {
          signQuery: requestOptions.signQuery,
          allHeaders: requestOptions.allHeaders,
          service: 's3',
          region: options.region,
        },
      })
    }

    const sign = async (key: string, requestOptions: SignedRequestOptions): Promise<Request> =>
      signEncoded(encodeKey(key), requestOptions)

    const send = async (
      operation: string,
      key: string,
      signed: Promise<Request>,
    ): Promise<Response> => {
      // Signed outside the guard below, so a caller's invalid key or expiration keeps its own message.
      // Everything left inside is transport, whichever class it throws - a failed `fetch` is a `TypeError`
      // - and it is replaced because the message can quote the signed URL.
      const request = await signed
      try {
        return await fetch(request)
      }
      catch {
        throw operationError(options.provider, operation, key)
      }
    }

    const request = async (operation: string, key: string, requestOptions: SignedRequestOptions): Promise<Response> =>
      send(operation, key, sign(key, requestOptions))

    const driver: StorageDriver = {
      async put(key, data, meta) {
        validateMeta(meta)
        const response = await request('put', key, {
          method: 'PUT',
          headers: {
            'content-length': String(meta.size),
            'content-type': meta.contentType,
          },
          body: data as BodyInit,
          allHeaders: true,
        })
        if (!response.ok) throw operationError(options.provider, 'put', key, response)
      },

      async get(key) {
        const response = await request('get', key, { method: 'GET' })
        if (!response.ok || !response.body) throw operationError(options.provider, 'get', key, response)
        return response.body as ReadableStream<Uint8Array>
      },

      async delete(key) {
        const response = await request('delete', key, { method: 'DELETE' })
        if (!response.ok && response.status !== 404) {
          throw operationError(options.provider, 'delete', key, response)
        }
      },

      async stat(key) {
        const response = await request('stat', key, { method: 'HEAD' })
        if (response.status === 404) return null
        if (!response.ok) throw operationError(options.provider, 'stat', key, response)

        // Objects written by another tool may have no content type.
        const contentType = response.headers.get('content-type')?.trim() || FALLBACK_CONTENT_TYPE
        const rawSize = response.headers.get('content-length')
        const size = rawSize === null ? Number.NaN : Number(rawSize)
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new StorageError({
            message: `[${options.provider}] stat returned invalid metadata for key ${JSON.stringify(key)}`,
            code: 'invalid_response',
            provider: options.provider,
            operation: 'stat',
            key,
            status: response.status,
          })
        }
        return { contentType, size }
      },

      async list(prefix = '', listOptions: ListOptions = {}) {
        validatePrefix(prefix)
        const query: Record<string, string> = {
          'list-type': '2',
          'encoding-type': 'url',
          'max-keys': String(validateListLimit(listOptions.limit)),
        }
        if (prefix) query.prefix = prefix
        if (listOptions.delimiter !== undefined) {
          query.delimiter = requiredString(listOptions.delimiter, 'delimiter')
        }
        if (listOptions.cursor !== undefined) {
          query['continuation-token'] = requiredString(listOptions.cursor, 'cursor')
        }

        // Listing addresses the bucket, not an object, hence the empty key.
        const response = await send('list', prefix, signEncoded('', { method: 'GET', query }))
        if (!response.ok) throw operationError(options.provider, 'list', prefix, response)
        return parseListResult(await response.text())
      },

      async move(from, to, meta) {
        validateKey(from)
        validateKey(to)
        validateMeta(meta)
        if (from === to) throw new TypeError('move source and destination must be different')

        const prefix = options.copyHeaderPrefix
        const response = await request('move', to, {
          method: 'PUT',
          headers: {
            'content-type': meta.contentType,
            [`${prefix}-copy-source`]: `/${encodeURIComponent(options.bucket)}/${encodeKey(from)}`,
            [`${prefix}-metadata-directive`]: 'REPLACE',
          },
          allHeaders: true,
        })
        if (!response.ok) throw operationError(options.provider, 'move', from, response)

        const result = await response.text()
        if (/<(?:[a-z][\w.-]*:)?Error[\s>]/i.test(result)) {
          throw operationError(options.provider, 'move', from, response)
        }
        await driver.delete(from)
      },

      async url(key, urlOptions: UrlOptions = {}) {
        const encodedKey = encodeKey(key)
        if (options.publicUrl && urlOptions.download === undefined) {
          return publicObjectUrl(options.publicUrl, encodedKey)
        }

        const query = urlOptions.download === undefined
          ? undefined
          : { 'response-content-disposition': contentDisposition(urlOptions.download) }
        const signed = await sign(key, {
          method: 'GET',
          query,
          signQuery: true,
          expiresIn: urlOptions.expiresIn ?? defaultExpiration,
        })
        return signed.url
      },

      async presignPut(key, meta) {
        validateMeta(meta)
        const headers = {
          'content-length': String(meta.size),
          'content-type': meta.contentType,
        }
        const signed = await sign(key, {
          method: 'PUT',
          headers,
          signQuery: true,
          allHeaders: true,
          expiresIn: defaultExpiration,
        })
        return {
          url: signed.url,
          method: 'PUT',
          headers,
        }
      },
    }

    return driver
  }
}
