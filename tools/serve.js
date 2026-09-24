#!/usr/bin/env node
/**
 * ローカル確認用の静的サーバー（_site/ を配信）。
 *   node tools/serve.js            下書きを含めてビルドしてから配信（port 4893）
 *   node tools/serve.js --no-build ビルドせずに配信
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const PORT = Number(process.env.PORT || 4893);

if (!process.argv.includes('--no-build')) {
  execFileSync(process.execPath, [path.join(__dirname, 'build.js'), '--drafts'], { cwd: ROOT, stdio: 'inherit' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
                '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(OUT, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': TYPES['.html'] });
    return res.end(fs.existsSync(path.join(OUT, '404.html')) ? fs.readFileSync(path.join(OUT, '404.html')) : 'Not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}/`));
