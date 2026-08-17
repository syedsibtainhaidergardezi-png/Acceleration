#!/usr/bin/env node
/**
 * Zero-dependency static server.
 *
 * The app must be served over http:// rather than opened as a file:// URL,
 * because AudioWorklet.addModule and ES module imports are both blocked by
 * the file:// origin policy. Opening index.html directly produces a page that
 * looks fine and makes no sound, which is a miserable way to find out.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8080', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(ROOT, url === '/' ? 'index.html' : url);

  // Refuse to serve anything outside the project root.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || stat.isDirectory()) {
      if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      else {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
});

/** Any non-internal IPv4 address, so the page can be opened from a phone. */
function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) return iface.address;
  }
  return null;
}

/**
 * Listen on `port`, stepping to the next free one if it is taken.
 *
 * A hard EADDRINUSE crash is the single most common reason a static server
 * feels broken -- usually something unrelated is already on 8080, and the
 * error says nothing about how to proceed.
 */
// A single persistent 'listening' handler that reports the port the socket
// actually bound to.
//
// Passing the callback to server.listen(port, cb) instead would be wrong here:
// Node registers it as a one-time 'listening' listener, and a listen attempt
// that fails with EADDRINUSE leaves it attached. After one retry, the stale
// callback from the failed attempt fires alongside the new one and announces
// the port we could not bind. Asking the socket is always truthful.
server.on('listening', () => {
  const port = server.address().port;
  const lan = lanAddress();
  console.log(`\n  Acceleration — running at http://localhost:${port}`);
  if (lan) console.log(`  On this network:  http://${lan}:${port}`);
  console.log('\n  Open that URL in a browser. Audio starts on your first click.');
  console.log('  Press Ctrl+C to stop.\n');
});

function listen(port, attemptsLeft = 12) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  port ${port} is busy, trying ${port + 1}…`);
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Could not find a free port near ${PORT}.`);
      console.error('  Pick one explicitly:  PORT=3000 npm start\n');
    } else {
      console.error(`\n  Server error: ${err.message}\n`);
    }
    process.exit(1);
  });

  server.listen(port);
}

listen(PORT);
