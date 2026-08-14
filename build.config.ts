import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['src/index', 'src/s3', 'src/r2', 'src/gcs'],
  declaration: true,
  clean: true,
  externals: ['aws4fetch'],
  rollup: { emitCJS: false },
})
