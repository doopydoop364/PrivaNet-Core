// Test-only plaintext observation at Host C, below Caddy's TLS termination.
// Every byte read/written by the Coordinator's HTTP server is measured, including errors.
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const create = http.createServer;
const totals = { requests: 0, requestBytes: 0, responseBytes: 0, payloadBytes: 0, oversizedBodies: 0, opaqueBodies: 0 };
const marker = Buffer.from('PRIVANET_ALPHA3_PAYLOAD_CANARY_7db1');
const observe = (bytes, field) => {
  const part = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
  totals[field] += part.length;
  if (part.includes(marker)) totals.payloadBytes += part.length;
  writeFileSync(process.env.PRIVANET_TRANSFER_AUDIT, JSON.stringify(totals));
};
http.createServer = function (...args) {
  const server = create.apply(this, args);
  server.prependListener('request', (req, res) => {
    totals.requests++; let size = 0; const requestBody = []; const responseBody = [];
    const checkBody = parts => { const bytes = Buffer.concat(parts); if (!bytes.length) return; if (bytes.length > 16384) { totals.oversizedBodies++; return; } try { const value = JSON.parse(bytes.toString()); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); } catch { totals.opaqueBodies++; } };
    req.on('data', part => { size += part.length; if (size <= 16384) requestBody.push(part); observe(part, 'requestBytes'); });
    req.on('end', () => { if (size > 16384) totals.oversizedBodies++; else checkBody(requestBody); observe('', 'requestBytes'); });
    const write = res.write; const end = res.end;
    res.write = function (part, ...rest) { if (part) responseBody.push(Buffer.from(part)); observe(part, 'responseBytes'); return write.call(this, part, ...rest); };
    res.end = function (part, ...rest) { if (typeof part === 'string' || Buffer.isBuffer(part)) { responseBody.push(Buffer.from(part)); observe(part, 'responseBytes'); } checkBody(responseBody); observe('', 'responseBytes'); return end.call(this, part, ...rest); };
  });
  return server;
};
syncBuiltinESMExports();
