import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Lit decorators require legacy/experimental decorators
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    globals: true,
  },
});
