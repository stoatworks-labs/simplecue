import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The version comes from the WORKSPACE ROOT, not from this package. A copy in
// the workspace drifts behind it silently, and the version is what a bug report
// quotes.
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],

  // Relative, so the build works from a Worker hostname or a subdirectory
  // without being rebuilt for either.
  base: './',

  define: {
    __APP_VERSION__: JSON.stringify(`v${rootPkg.version}`),
  },

  server: {
    port: 5230,
    strictPort: true,
  },

  build: {
    // The wasm engine is a chunk on its own account; the warning is noise here.
    chunkSizeWarningLimit: 1200,
  },
});
