import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'storage/memory': 'src/storage/memory.ts',
    'storage/postgres': 'src/storage/postgres.ts',
    'storage/redis': 'src/storage/redis.ts',
    'observability/otel': 'src/observability/otel.ts',
  },
  external: ['pg', 'ioredis', '@opentelemetry/api'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: 'es2020',
  platform: 'neutral',
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
