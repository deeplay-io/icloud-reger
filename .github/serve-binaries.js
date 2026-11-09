// Отдаёт файлы каталога по http://127.0.0.1:<порт>/<имя> для ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL.
// Использование: node .github/serve-binaries.js <каталог> <порт>
const fs = require('node:fs');
const path = require('node:path');

const [dir, port] = process.argv.slice(2);
require('node:http').createServer((req, res) => {
  const file = path.join(dir, path.basename(decodeURIComponent(req.url.split('?')[0])));
  fs.stat(file, (error, stat) => {
    if (error) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-length', stat.size);
    fs.createReadStream(file).pipe(res);
  });
}).listen(Number(port), '127.0.0.1');
