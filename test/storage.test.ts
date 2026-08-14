import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStorageError } from '../src/index'
import type { StorageDriver, StorageError, StorageFactory } from '../src/index'
import { gcs } from '../src/gcs'
import { r2 } from '../src/r2'
import { s3 } from '../src/s3'

const credentials = {
  accessKeyId: 'ACCESS_KEY',
  secretAccessKey: 'SECRET_KEY',
  sessionToken: 'SESSION_TOKEN',
}

function createDriver(factory: StorageFactory): StorageDriver {
  const result = factory({ credentials })
  if (result instanceof Promise) throw new Error('Expected a synchronous test factory')
  return result
}

function requestFrom(input: RequestInfo | URL): Request {
  if (!(input instanceof Request)) throw new Error('Expected a signed Request')
  return input
}

describe('@eponyme/storage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('shared contract', () => {
    it('streams put bodies without converting them to a byte array', async () => {
      const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])]
      let pulls = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[pulls++]
          if (chunk) controller.enqueue(chunk)
          else controller.close()
        },
      })
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const request = requestFrom(input)
        expect(request.body).toBeInstanceOf(ReadableStream)
        expect(request.headers.get('content-type')).toBe('application/octet-stream')
        expect(request.headers.get('content-length')).toBe('3')
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
        return new Response(null, { status: 200 })
      })
      vi.stubGlobal('fetch', fetchMock)

      await createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))
        .put('stream.bin', stream, { contentType: 'application/octet-stream', size: 3 })

      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('returns the response stream from get', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([4, 5]))))
      const body = await createDriver(s3({ bucket: 'media', region: 'eu-west-3' })).get('asset.bin')
      expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(new Uint8Array([4, 5]))
    })

    it('reads stat metadata and treats 404 as missing', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 200,
          headers: { 'content-type': 'image/webp', 'content-length': '42' },
        }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
      vi.stubGlobal('fetch', fetchMock)
      const driver = createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))

      await expect(driver.stat('cover.webp')).resolves.toEqual({ contentType: 'image/webp', size: 42 })
      await expect(driver.stat('missing.webp')).resolves.toBeNull()
    })

    it('falls back to an octet stream when the object has no content type', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
        status: 200,
        headers: { 'content-length': '7' },
      })))
      await expect(createDriver(s3({ bucket: 'media', region: 'eu-west-3' })).stat('foreign.bin'))
        .resolves.toEqual({ contentType: 'application/octet-stream', size: 7 })
    })

    it.each([
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'text/plain', 'content-length': '-1' },
      { 'content-type': 'text/plain', 'content-length': '1.5' },
      { 'content-type': 'text/plain', 'content-length': 'not-a-number' },
    ])('rejects invalid stat metadata: %j', async (headers) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200, headers })))
      await expect(createDriver(s3({ bucket: 'media', region: 'eu-west-3' })).stat('file.txt'))
        .rejects.toThrow('[s3] stat returned invalid metadata for key "file.txt"')
    })

    it('lists objects and folders, and reports the next cursor', async () => {
      const requests: Request[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        requests.push(requestFrom(input))
        return new Response(`<?xml version="1.0"?>
          <ListBucketResult>
            <Prefix>uploads%2F</Prefix>
            <IsTruncated>true</IsTruncated>
            <NextContinuationToken>token/1==</NextContinuationToken>
            <Contents>
              <Key>uploads%2Fcaf%C3%A9%20%26%20th%C3%A9.png</Key>
              <LastModified>2026-08-13T10:00:00.000Z</LastModified>
              <Size>2048</Size>
            </Contents>
            <CommonPrefixes><Prefix>uploads%2F2026%2F</Prefix></CommonPrefixes>
          </ListBucketResult>`)
      }))

      const result = await createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))
        .list('uploads/', { delimiter: '/', limit: 50 })

      const url = new URL(requests[0]!.url)
      expect(url.pathname).toBe('/')
      expect(url.searchParams.get('list-type')).toBe('2')
      expect(url.searchParams.get('prefix')).toBe('uploads/')
      expect(url.searchParams.get('delimiter')).toBe('/')
      expect(url.searchParams.get('max-keys')).toBe('50')
      expect(result).toEqual({
        objects: [{
          key: 'uploads/café & thé.png',
          size: 2048,
          lastModified: new Date('2026-08-13T10:00:00.000Z'),
        }],
        prefixes: ['uploads/2026/'],
        cursor: 'token/1==',
      })
    })

    it('omits the cursor when the listing is complete', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
      )))
      await expect(createDriver(s3({ bucket: 'media', region: 'eu-west-3' })).list())
        .resolves.toEqual({ objects: [], prefixes: [], cursor: undefined })
    })

    it('passes the cursor back as a continuation token', async () => {
      const requests: Request[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        requests.push(requestFrom(input))
        return new Response('<ListBucketResult/>')
      }))
      await createDriver(s3({ bucket: 'media', region: 'eu-west-3' })).list('', { cursor: 'token/1==' })
      expect(new URL(requests[0]!.url).searchParams.get('continuation-token')).toBe('token/1==')
    })

    it('makes delete idempotent on 404', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
      await expect(createDriver(s3({ bucket: 'media', region: 'eu-west-3' })).delete('gone.txt'))
        .resolves.toBeUndefined()
    })

    it('copies with replaced metadata before deleting the source', async () => {
      const requests: Request[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const request = requestFrom(input)
        requests.push(request)
        return request.method === 'PUT'
          ? new Response('<CopyObjectResult><ETag>ok</ETag></CopyObjectResult>')
          : new Response(null, { status: 204 })
      }))
      const driver = createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))

      await driver.move('draft/file.txt', 'live/file.txt', { contentType: 'text/markdown', size: 12 })

      expect(requests.map(request => request.method)).toEqual(['PUT', 'DELETE'])
      expect(requests[0]?.headers.get('x-amz-copy-source')).toBe('/media/draft/file.txt')
      expect(requests[0]?.headers.get('x-amz-metadata-directive')).toBe('REPLACE')
      expect(requests[0]?.headers.get('content-type')).toBe('text/markdown')
      expect(new URL(requests[1]!.url).pathname).toBe('/draft/file.txt')
    })

    it('keeps the source when a copy fails', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 503, statusText: 'Unavailable' }))
      vi.stubGlobal('fetch', fetchMock)
      const driver = createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))

      await expect(driver.move('from.txt', 'to.txt', { contentType: 'text/plain', size: 1 }))
        .rejects.toThrow('[s3] move failed for key "from.txt" (503 Unavailable)')
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('detects an S3 XML error inside a 200 copy response and keeps the source', async () => {
      const fetchMock = vi.fn(async () => new Response(
        '<?xml version="1.0"?><Error><Code>SlowDown</Code></Error>',
        { status: 200 },
      ))
      vi.stubGlobal('fetch', fetchMock)
      const driver = createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))

      await expect(driver.move('from.txt', 'to.txt', { contentType: 'text/plain', size: 1 }))
        .rejects.toThrow('[s3] move failed for key "from.txt" (200)')
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('uses a public URL unless a download disposition requires signing', async () => {
      const driver = createDriver(s3({
        bucket: 'media',
        region: 'eu-west-3',
        publicUrl: 'https://cdn.example.com/assets',
      }))

      await expect(driver.url('covers/café image.jpg')).resolves
        .toBe('https://cdn.example.com/assets/covers/caf%C3%A9%20image.jpg')
      const download = new URL(await driver.url('covers/file.pdf', { download: 'rapport été.pdf' }))
      expect(download.hostname).toBe('media.s3.eu-west-3.amazonaws.com')
      expect(download.searchParams.get('response-content-disposition'))
        .toBe('attachment; filename*=UTF-8\'\'rapport%20%C3%A9t%C3%A9.pdf')
      expect(download.searchParams.get('X-Amz-Expires')).toBe('900')
    })

    it('presigns PUT with the exact content length, content type, expiration and session token', async () => {
      const result = await createDriver(s3({
        bucket: 'media',
        region: 'eu-west-3',
        presignExpiresIn: 120,
      })).presignPut?.('uploads/image.png', { contentType: 'image/png', size: 10 })
      const url = new URL(result!.url)

      expect(result).toMatchObject({
        method: 'PUT',
        headers: { 'content-length': '10', 'content-type': 'image/png' },
      })
      expect(url.searchParams.get('X-Amz-Expires')).toBe('120')
      expect(url.searchParams.get('X-Amz-Security-Token')).toBe('SESSION_TOKEN')
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length')
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type')
    })

    it('binds the presigned PUT signature to the declared object size', async () => {
      const driver = createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))
      const tenBytes = new URL((await driver.presignPut?.('uploads/image.png', {
        contentType: 'image/png',
        size: 10,
      }))!.url)
      const elevenBytes = new URL((await driver.presignPut?.('uploads/image.png', {
        contentType: 'image/png',
        size: 11,
      }))!.url)

      expect(tenBytes.searchParams.get('X-Amz-Signature'))
        .not.toBe(elevenBytes.searchParams.get('X-Amz-Signature'))
    })
  })

  describe('provider endpoints', () => {
    it('uses virtual-host style for native AWS S3', async () => {
      const url = new URL(await createDriver(s3({ bucket: 'media', region: 'eu-west-3' })).url('prefix//a b.txt'))
      expect(url.hostname).toBe('media.s3.eu-west-3.amazonaws.com')
      expect(url.pathname).toBe('/prefix//a%20b.txt')
      expect(url.searchParams.get('X-Amz-Credential')).toContain('/eu-west-3/s3/aws4_request')
    })

    it('allows path style for native AWS S3', async () => {
      const url = new URL(await createDriver(s3({
        bucket: 'media',
        region: 'eu-west-3',
        pathStyle: true,
      })).url('file.txt'))
      expect(url.hostname).toBe('s3.eu-west-3.amazonaws.com')
      expect(url.pathname).toBe('/media/file.txt')
    })

    it.each([
      'https://minio.example.com',
      'https://s3.fr-par.scw.cloud',
    ])('defaults custom endpoint %s to path style', async (endpoint) => {
      const url = new URL(await createDriver(s3({
        bucket: 'media',
        region: 'fr-par',
        endpoint,
      })).url('folder/file.txt'))
      expect(url.origin).toBe(endpoint)
      expect(url.pathname).toBe('/media/folder/file.txt')
    })

    it('allows virtual-host style on a custom endpoint', async () => {
      const url = new URL(await createDriver(s3({
        bucket: 'media',
        region: 'fr-par',
        endpoint: 'https://s3.fr-par.scw.cloud',
        pathStyle: false,
      })).url('file.txt'))
      expect(url.hostname).toBe('media.s3.fr-par.scw.cloud')
      expect(url.pathname).toBe('/file.txt')
    })

    it('configures R2 with path style and the auto signing region', async () => {
      const url = new URL(await createDriver(r2({
        bucket: 'media',
        endpoint: 'https://account.r2.cloudflarestorage.com',
      })).url('file.txt'))
      expect(url.pathname).toBe('/media/file.txt')
      expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request')
    })

    it('uses the GCS XML API and x-goog copy headers', async () => {
      const requests: Request[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const request = requestFrom(input)
        requests.push(request)
        return request.method === 'PUT'
          ? new Response('<CopyObjectResult><ETag>ok</ETag></CopyObjectResult>')
          : new Response(null, { status: 204 })
      }))
      const driver = createDriver(gcs({ bucket: 'media' }))
      const url = new URL(await driver.url('folder/file.txt'))
      await driver.move('from.txt', 'to.txt', { contentType: 'text/plain', size: 2 })

      expect(url.origin).toBe('https://storage.googleapis.com')
      expect(url.pathname).toBe('/media/folder/file.txt')
      expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request')
      expect(requests[0]?.headers.get('x-goog-copy-source')).toBe('/media/from.txt')
      expect(requests[0]?.headers.get('x-goog-metadata-directive')).toBe('REPLACE')
      expect(requests[0]?.headers.has('x-amz-copy-source')).toBe(false)
    })
  })

  describe('validation and safe errors', () => {
    it.each(['', '/absolute', 'folder/./file', 'folder/../file', 'folder\\file', 'nul\0file'])('rejects invalid key %j', async (key) => {
      await expect(createDriver(s3({ bucket: 'media', region: 'eu-west-3' })).url(key)).rejects.toThrow()
    })

    it.each([0, -1, 1.5, 604_801])('rejects invalid expiration %s', async (expiresIn) => {
      await expect(createDriver(s3({ bucket: 'media', region: 'eu-west-3' })).url('file', { expiresIn }))
        .rejects.toThrow('expiresIn must be an integer between 1 and 604800')
    })

    it('rejects unsafe metadata and download values', async () => {
      const driver = createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))
      await expect(driver.put('file', new Uint8Array(), { contentType: 'text/plain\r\nX-Test: bad', size: 0 }))
        .rejects.toThrow('meta.contentType contains invalid characters')
      await expect(driver.url('file', { download: 'bad\r\nname' }))
        .rejects.toThrow('download contains invalid characters')
    })

    it('reports provider, operation, key and status without leaking secrets or signed URLs', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('ACCESS_KEY SECRET_KEY SESSION_TOKEN', {
        status: 403,
        statusText: 'Forbidden',
      })))
      const driver = createDriver(r2({
        bucket: 'media',
        endpoint: 'https://account.r2.cloudflarestorage.com',
      }))

      const error = await driver.get('private/file.txt').catch(value => value as Error)
      expect(error.message).toBe('[r2] get failed for key "private/file.txt" (403 Forbidden)')
      expect(error.message).not.toContain('ACCESS_KEY')
      expect(error.message).not.toContain('SECRET_KEY')
      expect(error.message).not.toContain('SESSION_TOKEN')
      expect(error.message).not.toContain('X-Amz-')
    })

    it.each([
      { status: 404, code: 'not_found' },
      { status: 403, code: 'access_denied' },
      { status: 429, code: 'unavailable' },
      { status: 503, code: 'unavailable' },
      { status: 400, code: 'unknown' },
    ])('tells a $code apart from an outage on $status', async ({ status, code }) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })))
      const driver = createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))

      const error = await driver.get('file.txt').catch(value => value as StorageError)
      expect(isStorageError(error)).toBe(true)
      expect(error).toMatchObject({ code, status, provider: 's3', operation: 'get', key: 'file.txt' })
    })

    it('reports a lost request as a network failure with no status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('socket hang up')
      }))
      const error = await createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))
        .get('file.txt').catch(value => value as StorageError)
      expect(error).toMatchObject({ code: 'network', status: undefined })
    })

    it('keeps an invalid key an argument error rather than a storage failure', async () => {
      const error = await createDriver(s3({ bucket: 'media', region: 'eu-west-3' }))
        .stat('../escape').catch(value => value as Error)
      expect(error).toBeInstanceOf(TypeError)
      expect(isStorageError(error)).toBe(false)
    })

    it('does not expose credentials when fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('request for ?X-Amz-Credential=ACCESS_KEY failed with SECRET_KEY')
      }))
      const driver = createDriver(gcs({ bucket: 'media' }))

      await expect(driver.get('private.txt')).rejects.toThrow('[gcs] get failed for key "private.txt"')
    })
  })
})
