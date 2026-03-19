import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const outdir = path.resolve(import.meta.dirname, 'dist');
fs.mkdirSync(outdir, { recursive: true });

// Bundle Lit components into a single IIFE for inline embedding
await esbuild.build({
  entryPoints: [path.resolve(import.meta.dirname, 'src/ui/client/app.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: process.env.NODE_ENV === 'production',
  outfile: path.join(outdir, 'client-bundle.js'),
  // Lit decorators require legacy/experimental decorators
  tsconfigRaw: JSON.stringify({
    compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
  }),
});

// Copy CSS alongside
const cssPath = path.resolve(import.meta.dirname, 'src/ui/client/styles.css');
fs.copyFileSync(cssPath, path.join(outdir, 'client-styles.css'));
