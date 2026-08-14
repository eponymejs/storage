import { isStorageError } from '../src/index'
import type {
  ListOptions,
  ListResult,
  PutMeta,
  StorageDriver,
  StorageFactory,
  StorageFactoryContext,
  UrlOptions,
} from '../src/index'
import { gcs, type GCSOptions } from '../src/gcs'
import { r2, type R2Options } from '../src/r2'
import { s3, type S3Options } from '../src/s3'

const context = {
  credentials: {
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    sessionToken: 'token',
  },
} satisfies StorageFactoryContext

const meta = { contentType: 'text/plain', size: 4 } satisfies PutMeta
const urlOptions = { expiresIn: 60, download: 'file.txt' } satisfies UrlOptions
const listOptions = { limit: 100, cursor: 'token', delimiter: '/' } satisfies ListOptions
const s3Options = { bucket: 'bucket', region: 'eu-west-3' } satisfies S3Options
const r2Options = { bucket: 'bucket', endpoint: 'https://account.r2.cloudflarestorage.com' } satisfies R2Options
const gcsOptions = { bucket: 'bucket' } satisfies GCSOptions

const factories: StorageFactory[] = [s3(s3Options), r2(r2Options), gcs(gcsOptions)]

async function exercise(factory: StorageFactory): Promise<StorageDriver> {
  const driver = await factory(context)
  await driver.put('file.txt', new TextEncoder().encode('test'), meta)
  await driver.url('file.txt', urlOptions)
  const listed: ListResult = await driver.list('uploads/', listOptions)
  listed.objects.forEach(object => void object.lastModified.getTime())
  // `presignPut` narrows to PUT: only the headers travel, there are no POST policy fields.
  const presigned = await driver.presignPut?.('file.txt', meta)
  const method: 'PUT' | undefined = presigned?.method
  void method
  try {
    await driver.get('missing.txt')
  }
  catch (error) {
    if (isStorageError(error) && error.code === 'not_found') void error.status
  }
  return driver
}

void Promise.all(factories.map(exercise))
