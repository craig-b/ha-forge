import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Generates the complete UI HTML as a string.
 * Monaco Editor is loaded from CDN. Lit components and CSS are bundled
 * by esbuild at build time and inlined for single-request HA ingress loading.
 */
export function generateUIHtml(ingressPath: string): string {
  // At runtime, this file is bundled into dist/index.js by tsup.
  // The client bundle lives alongside it in the same dist/ directory.
  const distDir = path.resolve(import.meta.dirname ?? __dirname);

  let clientJS = '// client bundle not found — run pnpm build:client';
  let clientCSS = '/* styles not found */';

  try {
    clientJS = fs.readFileSync(path.join(distDir, 'client-bundle.js'), 'utf-8');
  } catch { /* bundle not built yet */ }

  try {
    clientCSS = fs.readFileSync(path.join(distDir, 'client-styles.css'), 'utf-8');
  } catch { /* styles not built yet */ }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HA Forge</title>
  <style>${clientCSS}</style>
</head>
<body>
  <tse-app></tse-app>

  <script>
    window.__INGRESS_PATH__ = ${JSON.stringify(ingressPath)};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/loader.js"><\/script>
  <script>${clientJS}<\/script>
</body>
</html>`;
}
