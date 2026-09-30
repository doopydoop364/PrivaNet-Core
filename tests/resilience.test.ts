import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION } from '@privanet/protocol';
import { PrivaNetClient, ApiError } from '@privanet/sdk';
import { Transport } from '@privanet/shared';
import { HealthSchema } from '@privanet/protocol';
import { connectionFailure } from '@privanet/node/failure';

// What an application and a node see when the Coordinator, or the proxy in front of it, is briefly unavailable.
const finished = { id: '11111111-1111-4111-8111-111111111111', type: 'system.echo.v1', protocolVersion: PROTOCOL_VERSION, input: { message: 'x' }, status: 'COMPLETED',
  createdAt: 1, completedAt: 2, attempts: 1, result: { message: 'x' }, error: null };
async function stub(t: test.TestContext, handler: (n: number, respond: (status: number, body: string, json?: boolean) => void) => void): Promise<string> {
  let n = 0;
  const server: Server = createServer((_req, res) => handler(n++, (status, body, json = true) => {
    res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/html', 'X-PrivaNet-Protocol': String(PROTOCOL_VERSION) }); res.end(body);
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
/** A loopback URL with nothing listening (a port that was free a moment ago). */
async function closedUrl(): Promise<string> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return `http://127.0.0.1:${port}`;
}
const client = (url: string) => new PrivaNetClient({ url, token: 'a'.repeat(64), allowInsecureLoopback: true });

test('a proxy error page (502 with no JSON) is an API error, not a parse error', async t => {
  const url = await stub(t, (_n, respond) => respond(502, '<html>Bad Gateway</html>', false));
  await assert.rejects(new Transport({ url, allowInsecureLoopback: true }).request('GET', '/v1/health', HealthSchema), (error: unknown) => error instanceof ApiError && error.status === 502 && error.code === 'INVALID_RESPONSE');
  assert.deepEqual(connectionFailure(new ApiError(502, 'INVALID_RESPONSE', 'x')), { code: 'INVALID_RESPONSE' });
});

test('waiting for a result survives a proxy 502 and a refused connection, and still ends at its own deadline', async t => {
  const url = await stub(t, (n, respond) => { if (n < 2) respond(502, '', false); else respond(200, JSON.stringify(finished)); });
  assert.deepEqual(await client(url).waitForResult(finished.id, { timeoutMs: 20000 }), { message: 'x' });
  // Nothing listening at all: retried until the deadline, then a clear timeout rather than a raw network error.
  const closed = await closedUrl();
  await assert.rejects(client(closed).waitForResult(finished.id, { timeoutMs: 1500 }), (error: unknown) => error instanceof ApiError && error.code === 'WAIT_TIMEOUT');
});

test('a real refusal from the Coordinator is not retried as if it were an outage', async t => {
  const url = await stub(t, (_n, respond) => respond(401, JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no' } })));
  await assert.rejects(client(url).waitForResult(finished.id, { timeoutMs: 5000 }), (error: unknown) => error instanceof ApiError && error.status === 401);
});

test('connection failures are logged with a fixed vocabulary that never carries an address, URL or message', async () => {
  const refused = await fetch(await closedUrl()).catch((error: unknown) => error);
  assert.deepEqual(connectionFailure(refused), { code: 'TRANSPORT_ERROR', reason: 'CONNECTION_REFUSED' });
  const timeout = new DOMException('x', 'TimeoutError'); assert.deepEqual(connectionFailure(timeout), { code: 'TRANSPORT_ERROR', reason: 'TIMEOUT' });
  const tls = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('unable to verify 10.0.0.68'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
  assert.deepEqual(connectionFailure(tls), { code: 'TRANSPORT_ERROR', reason: 'TLS_CERTIFICATE' });
  const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
  assert.deepEqual(connectionFailure(dns), { code: 'TRANSPORT_ERROR', reason: 'DNS' });
  assert.deepEqual(connectionFailure(new Error('boom')), { code: 'TRANSPORT_ERROR', reason: 'OTHER' });
  assert.equal(JSON.stringify(connectionFailure(tls)).includes('10.0.0.68'), false);
});
