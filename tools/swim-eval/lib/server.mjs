// A static file server for the eval runs: the repo as the page sees it, and /assets/ from another checkout when this
// one has none (the M3 model and engine recordings are never committed, so a worktree lacks them). The game's flight
// recorder POSTs to /session-log; the runner catches those in the page, so here they are just acknowledged.
// usage: node tools/swim-eval/lib/server.mjs <port> <repo dir> [assets dir]
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.gz': 'application/gzip', '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.webp': 'image/webp'
};

function headCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function startServer(port, repo, assets = null) {
  const root = resolve(repo);
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        res.writeHead(204);
        res.end();
      });
      return;
    }
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // The flight recorder names its build from .git/HEAD; in a worktree .git is a file pointing elsewhere, so the
    // commit is answered directly (session-recorder.js buildId takes a bare 40-hex HEAD)
    if (path === '/.git/HEAD') {
      const commit = headCommit(root);
      res.writeHead(commit ? 200 : 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end(commit ? `${commit}\n` : undefined);
      return;
    }
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (assets && path.startsWith('/assets/') && !existsSync(file)) file = join(resolve(assets), path.slice('/assets/'.length));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => done(server));
  });
}

export { startServer };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port, repo, assets] = process.argv.slice(2);
  await startServer(Number(port), repo, assets);
  console.log(`swim-eval server: http://127.0.0.1:${port}/ (pid ${process.pid})`);
}
