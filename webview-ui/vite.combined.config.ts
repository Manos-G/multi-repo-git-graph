// The combined graph ("All Repositories") is its own self-contained bundle:
// dist/webview/assets/combined.js + combined.css. A separate build (not a second
// input of vite.config.ts) because the webview loads one classic script with a CSP
// nonce, so shared chunks imported at runtime are not an option.
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';
import { resolve } from 'path';

export default mergeConfig(
  base,
  defineConfig({
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(__dirname, 'combined.html'),
        output: {
          entryFileNames: 'assets/combined.js',
          chunkFileNames: 'assets/combined-[name].js',
          assetFileNames: 'assets/combined.[ext]',
          inlineDynamicImports: true,
        },
      },
    },
  }),
);
