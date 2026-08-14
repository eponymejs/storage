export interface PutMeta {
  contentType: string
  size: number
}

export interface UrlOptions {
  expiresIn?: number
  download?: string
}

export interface ListOptions {
  /** Maximum number of objects in one page, 1 to 1000. @default 1000 */
  limit?: number
  /** `cursor` of a previous result, to read the next page. */
  cursor?: string
  /**
   * Collapses everything after the next occurrence of this string into `prefixes`, which is how
   * a flat bucket is browsed as folders. Pass `'/'` to list one level.
   */
  delimiter?: string
}

export interface StorageObject {
  key: string
  size: number
  lastModified: Date
}

export interface ListResult {
  objects: StorageObject[]
  /** Common prefixes, only when `delimiter` was given. */
  prefixes: string[]
  /** Passed back as `cursor` to read the next page; absent on the last one. */
  cursor?: string
}

export interface StorageFactoryContext {
  /** Absent for a driver that needs none, such as one backed by the local filesystem. */
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
}

/**
 * Why an operation failed, so a caller can tell a missing object from an outage.
 *
 * - `not_found` — the object does not exist.
 * - `access_denied` — the credentials are refused for this object.
 * - `unavailable` — the provider answered but could not serve it: 5xx, throttling, timeout.
 * - `network` — no answer at all; the request never completed.
 * - `invalid_response` — the provider answered something this driver cannot read.
 * - `unknown` — anything else, including 4xx codes with no specific meaning here.
 */
export type StorageErrorCode
  = | 'not_found'
    | 'access_denied'
    | 'unavailable'
    | 'network'
    | 'invalid_response'
    | 'unknown'

export class StorageError extends Error {
  override readonly name = 'StorageError'
  readonly code: StorageErrorCode
  readonly provider: string
  readonly operation: string
  readonly key: string
  /** HTTP status, absent when the request never got an answer. */
  readonly status?: number

  constructor(options: {
    message: string
    code: StorageErrorCode
    provider: string
    operation: string
    key: string
    status?: number
  }) {
    super(options.message)
    this.code = options.code
    this.provider = options.provider
    this.operation = options.operation
    this.key = options.key
    this.status = options.status
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError
}

export interface StorageDriver {
  put(key: string, data: ReadableStream<Uint8Array> | Uint8Array, meta: PutMeta): Promise<void>
  get(key: string): Promise<ReadableStream<Uint8Array>>
  delete(key: string): Promise<void>
  stat(key: string): Promise<PutMeta | null>
  list(prefix?: string, options?: ListOptions): Promise<ListResult>
  move(from: string, to: string, meta: PutMeta): Promise<void>
  url(key: string, opts?: UrlOptions): Promise<string>
  presignPut?(key: string, meta: PutMeta): Promise<{
    url: string
    method: 'PUT'
    /** Sent verbatim by the browser; the signature is bound to them. */
    headers: Record<string, string>
  }>
}

export type StorageFactory
  = (context: StorageFactoryContext) => StorageDriver | Promise<StorageDriver>
