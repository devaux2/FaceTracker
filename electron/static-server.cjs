// Tiny static file server used by the Electron main process to serve the web
// app over http://127.0.0.1 — this gives the renderer a proper secure origin
// (so camera, ES modules, IndexedDB and BroadcastChannel all behave exactly as
// they do in a browser served over localhost). Works for files inside an
// Electron asar archive too, because Electron patches Node's fs.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.task': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

function createServer(root) {
  const rootResolved = path.resolve(root);
  return http.createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
      // Resolve and guard against path traversal outside the root.
      const filePath = path.join(rootResolved, path.normalize(urlPath));
      if (!filePath.startsWith(rootResolved)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('Not found');
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(filePath).pipe(res);
      });
    } catch (e) {
      res.writeHead(500);
      res.end('Server error');
    }
  });
}

// Listen on an ephemeral loopback port; resolves with { server, port }.
function listen(root) {
  return new Promise((resolve, reject) => {
    const server = createServer(root);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { createServer, listen, MIME };
