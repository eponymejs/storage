import { createS3CompatibleFactory } from './internal'
import type { S3CompatibleOptions } from './internal'
import type { StorageFactory } from './index'

export type S3Options = S3CompatibleOptions

export function s3(options: S3Options): StorageFactory {
  return createS3CompatibleFactory({
    ...options,
    provider: 's3',
    copyHeaderPrefix: 'x-amz',
  })
}
