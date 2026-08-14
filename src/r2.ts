import { createS3CompatibleFactory } from './internal'
import type { StorageFactory } from './index'
import type { S3Options } from './s3'

export interface R2Options extends Omit<S3Options, 'region'> {
  endpoint: string
}

export function r2(options: R2Options): StorageFactory {
  return createS3CompatibleFactory({
    ...options,
    region: 'auto',
    provider: 'r2',
    copyHeaderPrefix: 'x-amz',
  })
}
