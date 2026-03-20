import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/validate.ts', 'src/internal.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
