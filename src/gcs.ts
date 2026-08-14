import { createS3CompatibleFactory } from './internal'
import type { StorageFactory } from './index'

export interface GCSOptions {
  bucket: string
  publicUrl?: string
  presignExpiresIn?: number
}

export function gcs(options: GCSOptions): StorageFactory {
  return createS3CompatibleFactory({
    ...options,
    region: 'auto',
    provider: 'gcs',
    copyHeaderPrefix: 'x-goog',
    defaultEndpoint: 'https://storage.googleapis.com',
    pathStyle: true,
  })
}
