import { describe, expect, it } from 'vitest'
import type { StorageFactory } from '../src/index'
import { gcs } from '../src/gcs'
import { r2 } from '../src/r2'
import { s3 } from '../src/s3'

const provider = process.env.EPONYME_STORAGE_PROVIDER
const integration = provider ? describe : describe.skip

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for live storage tests`)
  return value
}

function factory(): StorageFactory {
  const bucket = required('EPONYME_STORAGE_BUCKET')
  const endpoint = process.env.EPONYME_STORAGE_ENDPOINT
  const pathStyle = process.env.EPONYME_STORAGE_PATH_STYLE !== 'false'
  if (provider === 'r2') return r2({ bucket, endpoint: required('EPONYME_STORAGE_ENDPOINT'), pathStyle })
  if (provider === 'gcs') return gcs({ bucket })
  if (provider === 's3') {
    return s3({
      bucket,
      region: required('EPONYME_STORAGE_REGION'),
      endpoint,
      pathStyle: endpoint ? pathStyle : undefined,
    })
  }
  throw new Error('EPONYME_STORAGE_PROVIDER must be s3, r2 or gcs')
}

integration('live storage cycle', () => {
  it('runs put, stat, get, move, presign and delete', async () => {
    const storage = await factory()({
      credentials: {
        accessKeyId: required('EPONYME_STORAGE_ACCESS_KEY_ID'),
        secretAccessKey: required('EPONYME_STORAGE_SECRET_ACCESS_KEY'),
        sessionToken: process.env.EPONYME_STORAGE_SESSION_TOKEN,
      },
    })
    const run = crypto.randomUUID()
    const source = `eponyme-storage-test/${run}/source.txt`
    const moved = `eponyme-storage-test/${run}/moved.txt`
    const direct = `eponyme-storage-test/${run}/direct.txt`
    const bytes = new TextEncoder().encode('storage integration')
    const meta = { contentType: 'text/plain', size: bytes.byteLength }

    try {
      await storage.put(source, new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }), meta)
      await expect(storage.stat(source)).resolves.toEqual(meta)
      await expect(new Response(await storage.get(source)).text()).resolves.toBe('storage integration')

      await storage.move(source, moved, meta)
      await expect(storage.stat(source)).resolves.toBeNull()
      await expect(storage.stat(moved)).resolves.toEqual(meta)

      const presigned = await storage.presignPut?.(direct, meta)
      if (!presigned) throw new Error('presignPut is not implemented')
      const response = await fetch(presigned.url, {
        method: presigned.method,
        headers: presigned.headers,
        body: bytes,
      })
      expect(response.ok).toBe(true)
      await expect(storage.stat(direct)).resolves.toEqual(meta)
    }
    finally {
      await Promise.allSettled([storage.delete(source), storage.delete(moved), storage.delete(direct)])
    }
  }, 30_000)
})
