import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Vite plugin to add COOP/COEP headers to ALL responses (required for SharedArrayBuffer)
 */
function crossOriginIsolationPlugin(): Plugin {
  return {
    name: 'vite-plugin-cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        // Prevent caching of WASM files during development
        if (req.url?.includes('.wasm') || req.url?.includes('wasm')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
        next();
      });
    },
  };
}

/**
 * Vite plugin for local file writing (dev only)
 * Exposes POST /__write-file endpoint for editors to save assets
 */
function fileWritePlugin(): Plugin {
  return {
    name: 'vite-plugin-file-write',
    configureServer(server) {
      server.middlewares.use('/__write-file', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }

        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }

        try {
          const { path: filePath, content } = JSON.parse(body);

          // Security: only allow writing to public/mods/
          const normalizedPath = path.normalize(filePath);
          if (!normalizedPath.startsWith('public/mods/')) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: 'Can only write to public/mods/' }));
            return;
          }

          // Ensure directory exists
          const dir = path.dirname(normalizedPath);
          fs.mkdirSync(dir, { recursive: true });

          // Decode base64 content and write
          const buffer = Buffer.from(content, 'base64');
          fs.writeFileSync(normalizedPath, buffer);

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, path: normalizedPath }));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(error) }));
        }
      });

      // Endpoint to list files in a directory
      server.middlewares.use('/__list-files', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }

        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const prefix = url.searchParams.get('prefix') || 'public/mods';

          // Security: only allow listing in public/mods/
          const normalizedPath = path.normalize(prefix);
          if (!normalizedPath.startsWith('public/mods')) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: 'Can only list public/mods/' }));
            return;
          }

          const files = listFilesRecursive(normalizedPath);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ files }));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    },
  };
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

export default defineConfig({
  plugins: [react(), crossOriginIsolationPlugin(), fileWritePlugin(), wasm(), topLevelAwait()],
  server: {
    port: 5178,
    strictPort: true,
    headers: {
      // Required for SharedArrayBuffer (zap-engine)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: {
      // Allow serving files from the linked zap-engine package
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
    // Exclude @zap/web from pre-bundling - it has .wgsl files esbuild can't handle
    exclude: ['@zap/web', '@zap/web/react'],
  },
  worker: {
    format: 'es',
  },
});
