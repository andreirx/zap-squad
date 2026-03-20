import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import * as fs from 'fs';
import * as path from 'path';

/**
 * COOP/COEP headers required for SharedArrayBuffer (zap-engine rendering pipeline).
 * In production (S3+CloudFront), these headers are set via CloudFront response headers policy.
 */
function crossOriginIsolationPlugin(): Plugin {
  return {
    name: 'vite-plugin-cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
  };
}

/**
 * Serve baked assets from the sibling ui/web/public/assets/ directory.
 * In local dev, this maps /assets/* to ../web/public/assets/* so freedom-board
 * uses the same atlas PNGs and manifests as the main zap-squad app.
 * In production, VITE_ASSETS_URL points to CloudFront and this plugin is inactive.
 */
function localAssetsPlugin(): Plugin {
  const assetsDir = path.resolve(__dirname, '../web/public/assets');
  const MIME: Record<string, string> = {
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
  };

  return {
    name: 'vite-plugin-local-assets',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const reqPath = decodeURIComponent(req.url || '/');
        const filePath = path.join(assetsDir, reqPath);
        const normalized = path.normalize(filePath);

        // Security: stay within assetsDir
        if (!normalized.startsWith(assetsDir)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
          const ext = path.extname(normalized).toLowerCase();
          res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
          // Required for COEP require-corp
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          res.setHeader('Cache-Control', 'no-cache');
          fs.createReadStream(normalized).pipe(res);
        } else {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), crossOriginIsolationPlugin(), localAssetsPlugin(), wasm(), topLevelAwait()],
  server: {
    port: 5179,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: {
      allow: [
        '.',
        '/Users/apple/Documents/APLICATII BIJUTERIE/zap-engine',
      ],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  optimizeDeps: {
    exclude: ['@zap/web', '@zap/web/react'],
  },
  worker: {
    format: 'es',
  },
});
