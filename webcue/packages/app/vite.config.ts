import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The version comes from the WORKSPACE ROOT, not from this package. A copy in
// the workspace drifts behind it silently, and the version is what a bug report
// quotes.
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };

/** The shared Stoatworks footer, and with it the "report a bug" button.
 *
 * Vendored into public/ from stoatworks-backend and never edited here — it is
 * a copy, and a copy that has been edited stops being one. The version is
 * stamped from the same package.json that feeds __APP_VERSION__, because a
 * version typed beside the script tag drifts and the version is what a bug
 * report quotes.
 *
 * Build only: there is no point loading it against a dev server. */
function supportFooter(): Plugin {
  return {
    name: 'stoatworks-support-footer',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [
          {
            tag: 'script',
            injectTo: 'body',
            attrs: {
              src: '/support-footer.js',
              defer: true,
              'data-app': 'webcue',
              'data-repo': 'https://github.com/stoatworks-labs/simplecue',
              'data-version': `v${rootPkg.version}`,
              'data-note':
                'It runs entirely in your browser — no show and no audio you open is uploaded.',
            },
          },
        ];
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), supportFooter()],

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
