# @eponyme/storage

Edge-compatible object storage drivers for Amazon S3, S3-compatible providers, Cloudflare R2 and
Google Cloud Storage — the last through its XML API and HMAC interoperability keys.

One small interface over four providers: `put`, `get`, `delete`, `stat`, `list`, `move`, `url` and
`presignPut`. Written for [Eponyme](https://github.com/karibsen-studio/eponyme), which uses it for
its media library, but it does not depend on it and never imports it. Anything that runs `fetch`
can use it on its own.

## Install

```bash
pnpm add @eponyme/storage
```

`aws4fetch` is the only runtime dependency. The drivers use `fetch`, `ReadableStream`, `URL` and
Web Crypto, and do not import Node APIs.

## Factories and credentials

A factory is created from the options that describe *where* things are stored, then called with the
credentials that say *who* is storing them. Splitting the two is what lets the location live in a
checked-in file while the secrets come from the environment.

```ts
import type { StorageFactoryContext } from '@eponyme/storage'
import { s3 } from '@eponyme/storage/s3'

const factory = s3({
  bucket: 'media',
  region: 'eu-west-3',
})

const context: StorageFactoryContext = {
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
    sessionToken: process.env.STORAGE_SESSION_TOKEN,
  },
}

const storage = await factory(context)
```

Use short-lived, least-privilege credentials when the provider supports them. Never expose the
factory context to browser code. Generated signed URLs are bearer credentials until they expire.

### Amazon S3

Without an endpoint, S3 uses AWS virtual-host style:

```ts
import { s3 } from '@eponyme/storage/s3'

const factory = s3({ bucket: 'media', region: 'eu-west-3' })
```

Custom endpoints default to path style, which works for services such as MinIO and Scaleway. Set
`pathStyle: false` when the provider requires a bucket subdomain.

```ts
const factory = s3({
  bucket: 'media',
  region: 'fr-par',
  endpoint: 'https://s3.fr-par.scw.cloud',
})
```

### Cloudflare R2

R2 fixes the signing region to `auto` and requires the account endpoint:

```ts
import { r2 } from '@eponyme/storage/r2'

const factory = r2({
  bucket: 'media',
  endpoint: 'https://ACCOUNT_ID.r2.cloudflarestorage.com',
  publicUrl: 'https://media.example.com',
})
```

### Google Cloud Storage

The GCS adapter uses `https://storage.googleapis.com`, the XML API, AWS4-compatible signatures and
`x-goog-*` copy headers. Its `accessKeyId` and `secretAccessKey` must be a GCS HMAC interoperability
key pair. Service-account JSON and OAuth credentials are not supported in this version.

```ts
import { gcs } from '@eponyme/storage/gcs'

const factory = gcs({ bucket: 'media' })
```

## URLs and uploads

Signed URLs expire after 900 seconds by default. `presignExpiresIn` changes that default. Per-call
download URLs can use `expiresIn`; accepted values are integers from 1 to 604800 seconds (seven
days).

```ts
const inlineUrl = await storage.url('articles/cover.jpg')
const downloadUrl = await storage.url('exports/report.pdf', {
  expiresIn: 60,
  download: 'report.pdf',
})

const upload = await storage.presignPut?.('uploads/photo.jpg', {
  contentType: 'image/jpeg',
  size: 128_000,
})
```

When `publicUrl` is configured, `url()` returns that public origin for normal reads. Passing
`download` deliberately returns a signed storage-origin URL so the response can override
`Content-Disposition`.

`presignPut()` returns a `PUT` URL — and only a `PUT`; there is no POST policy form — with signed
`content-type` and `content-length` headers, sent back as `headers` for the uploader to repeat. The
uploader must send a body whose byte length exactly matches `size`; the storage provider rejects a
different length because it no longer matches the signature. Browser uploads should pass a `Blob`
or another body whose generated `Content-Length` matches the declared size.

## Listing

`list()` walks a bucket one page at a time. Without a `delimiter` it returns every key under the
prefix; with one it collapses everything past the next occurrence into `prefixes`, which is how a
flat bucket is browsed as folders.

```ts
let cursor: string | undefined
do {
  const page = await storage.list('uploads/', { delimiter: '/', limit: 100, cursor })
  page.prefixes // ['uploads/2026/'] — the folders at this level
  page.objects // [{ key, size, lastModified }]
  cursor = page.cursor // absent on the last page
}
while (cursor)
```

`limit` accepts 1 to 1000, the provider's own page ceiling.

## Errors

Every failure that comes from the provider is a `StorageError` carrying a `code`, so a caller can
tell a missing object from an outage instead of matching on a message.

```ts
import { isStorageError } from '@eponyme/storage'

try {
  await storage.get(key)
}
catch (error) {
  if (isStorageError(error) && error.code === 'not_found') return null
  throw error
}
```

| `code` | Meaning |
| --- | --- |
| `not_found` | The object does not exist (404, 410). |
| `access_denied` | The credentials are refused for this object (401, 403). |
| `unavailable` | The provider answered but could not serve it (408, 429, 5xx). |
| `network` | No answer at all; the request never completed. |
| `invalid_response` | The provider answered something the driver cannot read. |
| `unknown` | Anything else. |

A message never carries a response body, a signed URL or a credential — only the provider, the
operation, the key and the status.

Invalid arguments stay `TypeError` and `RangeError`: a key with a `..` segment is a bug in the
caller, not a storage failure.

## Limits

- `move()` is a provider-side copy followed by delete, so S3's single-copy object-size limits apply.
- The destination content type replaces the source metadata during a move.
- GCS support is limited to the XML API with HMAC interoperability keys.
- Signed URLs cannot live longer than seven days.
- Object keys must be non-empty and relative, and cannot contain `.`, `..`, NUL or backslash segments.
- `stat()` reports `application/octet-stream` for an object stored without a content type, which is
  common for a file put there by another tool.
- `put()` and `presignPut()` are single `PUT` requests, so S3's 5 GiB per-request ceiling applies.

## Optional live integration test

The default test suite never contacts a provider. To run the real cycle `put -> stat -> get -> move
-> presigned put -> delete`, set the following variables and run `pnpm test:integration`:

```bash
EPONYME_STORAGE_PROVIDER=s3
EPONYME_STORAGE_BUCKET=media
EPONYME_STORAGE_REGION=eu-west-3
EPONYME_STORAGE_ENDPOINT=https://s3.example.com # optional for AWS
EPONYME_STORAGE_ACCESS_KEY_ID=...
EPONYME_STORAGE_SECRET_ACCESS_KEY=...
EPONYME_STORAGE_SESSION_TOKEN=... # optional
pnpm test:integration
```

Use `EPONYME_STORAGE_PROVIDER=r2` with an endpoint, or `gcs` with GCS HMAC credentials. Set
`EPONYME_STORAGE_PATH_STYLE=false` for a custom virtual-host endpoint.

## Licence

MIT
