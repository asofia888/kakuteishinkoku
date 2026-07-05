// 静的エクスポート(out/)をE2Eテスト用に配信する最小サーバ。
// 依存パッケージなし・Node標準のみ。trailingSlash: true の出力
// (/transactions/ → out/transactions/index.html)に対応する。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../out/', import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
// GitHub Pages のサブパス配信(/kakuteishinkoku)を再現する。
// ビルド時と同じ NEXT_PUBLIC_BASE_PATH を設定すると、そのパス配下だけを out/ に対応させ、
// 接頭辞のないURL(リンクの付け忘れ等)は本番同様に404になる。
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (BASE_PATH) {
      if (pathname === BASE_PATH) pathname = '/';
      else if (pathname.startsWith(`${BASE_PATH}/`)) pathname = pathname.slice(BASE_PATH.length);
      else {
        res.writeHead(404).end('Not Found (basePath外のURL)');
        return;
      }
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    else if (!extname(pathname)) pathname += '/index.html';
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(normalize(ROOT + sep)) && filePath !== normalize(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    try {
      const notFound = await readFile(join(ROOT, '404.html'));
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(notFound);
    } catch {
      res.writeHead(404).end('Not Found');
    }
  }
});

server.listen(PORT, () => {
  console.log(`serving out/ at http://localhost:${PORT}${BASE_PATH}/`);
});
