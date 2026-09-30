// A stand-in for a public website on the LAN test's "web" host: /p/N answers after SITE_DELAY_MS; /robots.txt does not exist.
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers';
const delay = Number(process.env.SITE_DELAY_MS ?? 100);
createServer((req, res) => {
  if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
  setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><head><title>Page ${req.url}</title></head><body><p>${'lorem ipsum '.repeat(60)}</p></body></html>`); }, delay);
}).listen(8080, '0.0.0.0', () => console.log(JSON.stringify({ event: 'site.started' })));
