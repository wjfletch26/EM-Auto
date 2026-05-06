/**
 * Confirms Node's default HTTP listen(port) accepts connections on 127.0.0.1:port.
 * Express uses the same stack (app.listen(port) → server.listen(port)); vps-deploy.sh
 * curls http://127.0.0.1:${UNSUB_PORT}/health — this documents that default bind covers localhost.
 */
import http from 'node:http';

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

await new Promise((resolve, reject) => {
  server.listen(0, (err) => (err ? reject(err) : resolve()));
});

const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : null;
if (port == null) {
  console.error('FAIL: no bound port');
  process.exit(1);
}

const res = await fetch(`http://127.0.0.1:${port}/`);
const body = await res.text();
server.close();

if (!res.ok || body !== 'ok') {
  console.error('FAIL: 127.0.0.1 should reach default listen(port) server');
  process.exit(1);
}

console.log(
  'OK: default listen(port) is reachable at 127.0.0.1 (same class of bind as Express in src/web/server.ts).',
);
