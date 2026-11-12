import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { GmailClient, GMAIL_SCOPE, GMAIL_QUERY, validateClientConfig, openSystemBrowser } from '../gmail-client.mjs';

const ORIGIN = 'http://127.0.0.1:4173';
const CONFIG = { installed: { client_id: '123-test.apps.googleusercontent.com', client_secret: 'TEST_CLIENT_SECRET', auth_uri: 'https://attacker.example/ignored', token_uri: 'https://attacker.example/ignored' } };
const PDF = Buffer.from('%PDF-1.4\nSelected document only.');
const message = { id: 'abc123', threadId: 'thread123', internalDate: '1794441600000', snippet: 'PRIVATE SNIPPET', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Landlord <landlord@example.com>' }, { name: 'Subject', value: 'Lease <script>alert(1)</script>' }, { name: 'Date', value: '12 Nov 2026' }], body: { data: 'PRIVATE BODY' }, parts: [{ partId: '0', mimeType: 'text/plain', body: { data: 'PRIVATE EMAIL TEXT' } }, { partId: '1', mimeType: 'application/pdf', filename: 'lease.pdf', body: { attachmentId: 'attachment123', size: PDF.length } }, { partId: '2', mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'image123', size: 100 } }] } };
function token() { return { access_token: 'TEST_ACCESS_TOKEN', refresh_token: 'TEST_REFRESH_TOKEN', token_type: 'Bearer', expires_in: 3600, scope: GMAIL_SCOPE }; }
function reply(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function setup(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-model-gmail-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = Date.UTC(2026, 10, 12); const requests = []; let handler = null;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (handler) { const result = await handler(String(url), options); if (result !== undefined) return result; }
    if (url === 'https://oauth2.googleapis.com/token') return reply(token());
    if (String(url).includes('/profile?')) return reply({ emailAddress: 'reader@example.com' });
    if (String(url).includes('/attachments/')) return reply({ size: PDF.length, data: PDF.toString('base64url') });
    if (String(url).includes('/messages/abc123?')) return reply(message);
    if (String(url).includes('/messages?')) return reply({ messages: [{ id: 'abc123', threadId: 'thread123' }], nextPageToken: 'next-token', resultSizeEstimate: 2 });
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
    throw new Error('Unexpected external endpoint in mock');
  };
  const client = await GmailClient.create({ storageDir: dir, origin: ORIGIN, fetchImpl, now: () => now, ...overrides });
  await client.configure(CONFIG);
  async function connected() { const start = client.connect(); const handoff = client.authorize(new URL(start.connectUrl).searchParams.get('ticket')); const state = new URL(handoff.authUrl).searchParams.get('state'); await client.callback(new URLSearchParams({ state, code: 'TEST_CODE' }), handoff.cookie.split(';')[0]); return start; }
  return { client, dir, requests, connected, advance: ms => { now += ms; }, setHandler: fn => { handler = fn; } };
}

test('only a downloaded Google client and explicit matching web redirect are accepted', () => {
  const redirect = `${ORIGIN}/api/email/callback`;
  assert.equal(validateClientConfig(CONFIG, redirect).type, 'installed');
  assert.throws(() => validateClientConfig({ web: { ...CONFIG.installed, redirect_uris: ['https://other.example'] } }, redirect), /exact redirect/);
  assert.equal(validateClientConfig({ web: { ...CONFIG.installed, redirect_uris: [redirect] } }, redirect).type, 'web');
  assert.throws(() => validateClientConfig({ installed: { client_id: 'attacker.example' } }, redirect), /valid Google/);
});
test('PKCE, strict read-only scope, single-use handoff and browser-bound state protect OAuth', async t => {
  const { client, requests } = await setup(t);
  const start = client.connect(); const url = new URL(start.authUrl);
  assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('scope'), GMAIL_SCOPE); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(start.cookie.includes('HttpOnly')); assert.ok(start.cookie.includes('SameSite=Lax'));
  const params = new URLSearchParams({ state: url.searchParams.get('state'), code: 'TEST_CODE' });
  await assert.rejects(client.callback(params, 'folio_gmail_oauth=wrong'), error => error.code === 'invalid_state'); assert.equal(requests.length, 0);
  const ticket = new URL(start.connectUrl).searchParams.get('ticket'); const handoff = client.authorize(ticket);
  assert.throws(() => client.authorize(ticket), /already used/);
  await client.callback(params, handoff.cookie.split(';')[0]);
  const exchange = requests.find(request => request.url.endsWith('/token')); const form = new URLSearchParams(exchange.options.body);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(form.get('redirect_uri'), `${ORIGIN}/api/email/callback`);
  await assert.rejects(client.callback(params, handoff.cookie.split(';')[0]), error => error.code === 'invalid_state');
  assert.equal(client.status().connected, true);
});
test('expired attempts and consent denial never read the mailbox', async t => {
  const { client, requests, advance } = await setup(t); const start = client.connect(); advance(600001);
  await assert.rejects(client.callback(new URLSearchParams({ state: new URL(start.authUrl).searchParams.get('state'), code: 'TEST_CODE' }), start.cookie.split(';')[0]), error => error.code === 'invalid_state');
  const second = client.connect(); await assert.rejects(client.callback(new URLSearchParams({ state: new URL(second.authUrl).searchParams.get('state'), error: 'access_denied' }), second.cookie.split(';')[0]), error => error.code === 'consent_denied');
  assert.equal(requests.length, 0); assert.equal(client.status().connected, false);
});
test('secrets are mode 0600 and never returned in safe status', async t => {
  const { client, connected, dir } = await setup(t); await connected();
  for (const name of ['client.json', 'tokens.json']) assert.equal((await fs.stat(path.join(dir, 'gmail', name))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dir, 'gmail'))).mode & 0o777, 0o700);
  const safe = JSON.stringify(client.status()); for (const secret of ['TEST_CLIENT_SECRET','TEST_ACCESS_TOKEN','TEST_REFRESH_TOKEN']) assert.ok(!safe.includes(secret));
  assert.equal(client.status().email, 'reader@example.com');
});
test('metadata listing omits all message body and attachment data and uses recent attachment query', async t => {
  const { client, connected, requests } = await setup(t); await connected(); requests.length = 0;
  const result = await client.listMessages({ pageToken: 'opaque-page' });
  assert.equal(result.email, client.status().email); assert.equal(result.connectionRevision, client.status().connectionRevision);
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].attachments.length, 1);
  assert.equal(result.messages[0].attachments[0].eligible, true); assert.equal(result.nextPageToken, 'next-token');
  assert.equal(new URL(requests[0].url).searchParams.get('q'), GMAIL_QUERY);
  assert.equal(new URL(requests[0].url).searchParams.get('pageToken'), 'opaque-page');
  assert.ok(requests.every(request => !request.url.includes('/attachments/')));
  const fields = new URL(requests[1].url).searchParams.get('fields'); assert.ok(fields.includes('body(attachmentId,size)')); assert.ok(!fields.includes('data')); assert.ok(!fields.includes('snippet'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.equal(requests.length, 2);
});
test('only the explicitly selected verified attachment downloads; invalid selection makes no download call', async t => {
  const { client, connected, requests } = await setup(t); await connected(); requests.length = 0;
  await assert.rejects(client.attachment('abc123', 'image123'), error => error.code === 'attachment_not_found');
  assert.equal(requests.filter(request => request.url.includes('/attachments/')).length, 0);
  const result = await client.attachment('abc123', 'attachment123'); assert.deepEqual(result.bytes, PDF);
  assert.equal(result.provenance.account, 'reader@example.com'); assert.equal(result.provenance.messageId, 'abc123');
  assert.equal(requests.filter(request => request.url.includes('/attachments/')).length, 1);
  await client.recordAdded(result.provenance, 'document-primary');
  const listed = await client.listMessages(); assert.equal(listed.messages[0].attachments[0].added, true); assert.equal(listed.messages[0].attachments[0].documentId, 'document-primary');
});
test('oversized attachment metadata rejects before downloading bytes', async t => {
  const { client, connected, requests, setHandler } = await setup(t); await connected(); requests.length = 0;
  setHandler(url => { if (url.includes('/messages/abc123?')) { const oversized = structuredClone(message); oversized.payload.parts[1].body.size = 21 * 1024 * 1024; return reply(oversized); } });
  await assert.rejects(client.attachment('abc123', 'attachment123'), error => error.code === 'attachment_not_allowed');
  assert.ok(requests.every(request => !request.url.includes('/attachments/')));
});
test('refresh is shared across concurrent reads and preserves the refresh token', async t => {
  const { client, connected, requests, advance, setHandler } = await setup(t); await connected(); requests.length = 0; advance(3600000);
  setHandler(url => url.endsWith('/token') ? reply({ ...token(), refresh_token: undefined }) : undefined);
  await Promise.all([client.listMessages(), client.listMessages()]);
  assert.equal(requests.filter(request => request.url.endsWith('/token')).length, 1);
  assert.equal(client.status().connected, true);
});
test('a revoked Google grant clears tokens and exposes a safe reconnect error', async t => {
  const { client, connected, advance, setHandler, dir } = await setup(t); await connected(); advance(3600000);
  setHandler(url => url.endsWith('/token') ? reply({ error: 'invalid_grant', error_description: 'PRIVATE REFRESH DETAIL TEST_REFRESH_TOKEN' }, 400) : undefined);
  await assert.rejects(client.listMessages(), error => error.code === 'reconnect_required');
  assert.equal(client.status().connected, false); assert.ok(!JSON.stringify(client.status()).includes('PRIVATE'));
  await assert.rejects(fs.stat(path.join(dir, 'gmail', 'tokens.json')), error => error.code === 'ENOENT');
});
test('disconnect during refresh prevents credentials from being persisted again', async t => {
  const { client, connected, advance, setHandler, dir } = await setup(t); await connected(); advance(3600000);
  let release, entered; const pending = new Promise(resolve => { entered = resolve; });
  setHandler(url => { if (url.endsWith('/token')) { entered(); return new Promise(resolve => { release = resolve; }); } });
  const refreshing = client.accessToken(); await pending; await client.disconnect({ revoke: false }); release(reply(token()));
  await assert.rejects(refreshing, error => error.code === 'connection_changed');
  assert.equal(client.status().connected, false); await assert.rejects(fs.stat(path.join(dir, 'gmail', 'tokens.json')), error => error.code === 'ENOENT');
});
test('queued stale invalid-grant cleanup cannot delete a newly connected account', async t => {
  const { client, connected, advance, setHandler, dir } = await setup(t); await connected(); advance(3600000);
  const refreshEntered = deferred(), refreshResponse = deferred(), releaseWrites = deferred();
  setHandler((url, options) => {
    if (url.endsWith('/token')) {
      if (new URLSearchParams(options.body).get('grant_type') === 'refresh_token') { refreshEntered.resolve(); return refreshResponse.promise; }
      return reply({ ...token(), access_token: 'SECOND_ACCESS', refresh_token: 'SECOND_REFRESH' });
    }
    if (url.includes('/profile?')) return reply({ emailAddress: 'second@example.com' });
  });
  const refreshing = assert.rejects(client.accessToken(), error => error.code === 'connection_changed'); await refreshEntered.promise;
  const blockingWrite = client.write(() => releaseWrites.promise);
  const callbackQueued = deferred(), cleanupQueued = deferred(); const originalWrite = client.write.bind(client); let writes = 0;
  client.write = operation => { const result = originalWrite(operation); if (++writes === 1) callbackQueued.resolve(); else if (writes === 2) cleanupQueued.resolve(); return result; };
  const start = client.connect();
  const callback = client.callback(new URLSearchParams({ state: new URL(start.authUrl).searchParams.get('state'), code: 'SECOND_CODE' }), start.cookie.split(';')[0]);
  await callbackQueued.promise;
  refreshResponse.resolve(reply({ error: 'invalid_grant' }, 400)); await cleanupQueued.promise;
  releaseWrites.resolve(); await blockingWrite; const result = await callback; await refreshing;
  assert.equal(result.connected, true); assert.equal(client.status().connected, true); assert.equal(client.status().email, 'second@example.com'); assert.equal(client.status().error, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'gmail', 'tokens.json'), 'utf8')).accessToken, 'SECOND_ACCESS');
});
test('a new connection never shares an older account refresh promise', async t => {
  const { client, connected, advance, setHandler } = await setup(t); await connected(); advance(3600000);
  const entered = deferred(), response = deferred(); let refreshes = 0;
  setHandler((url, options) => {
    if (url.endsWith('/token')) {
      if (new URLSearchParams(options.body).get('grant_type') === 'refresh_token' && ++refreshes === 1) { entered.resolve(); return response.promise; }
      return reply({ ...token(), access_token: 'SECOND_ACCESS', refresh_token: 'SECOND_REFRESH' });
    }
    if (url.includes('/profile?')) return reply({ emailAddress: 'second@example.com' });
  });
  const oldRefresh = assert.rejects(client.accessToken(), error => error.code === 'connection_changed'); await entered.promise;
  await connected(); const currentRefresh = client.accessToken(true);
  response.resolve(reply({ error: 'invalid_grant' }, 400));
  assert.equal(await currentRefresh, 'SECOND_ACCESS'); await oldRefresh;
  assert.equal(refreshes, 2); assert.equal(client.status().email, 'second@example.com'); assert.equal(client.status().error, null);
});
for (const operation of ['list', 'attachment']) test(`a stale ${operation} error cannot affect a newly connected account`, async t => {
  const { client, connected, setHandler, requests } = await setup(t); await connected();
  const entered = deferred(), response = deferred();
  setHandler((url, options) => {
    if (operation === 'list' ? url.includes('/messages?') : url.includes('/attachments/')) { entered.resolve(); return response.promise; }
    if (url.endsWith('/token')) return reply({ ...token(), access_token: 'SECOND_ACCESS' });
    if (url.includes('/profile?')) return reply({ emailAddress: 'second@example.com' });
  });
  const pending = assert.rejects(operation === 'list' ? client.listMessages() : client.attachment('abc123', 'attachment123'), error => error.code === 'connection_changed');
  await entered.promise; const oldRevision = client.status().connectionRevision; await connected();
  response.resolve(reply({ error: { status: 'UNAUTHENTICATED' } }, 401)); await pending;
  assert.equal(client.status().connected, true); assert.equal(client.status().email, 'second@example.com'); assert.equal(client.status().error, null);
  assert.ok(client.status().connectionRevision > oldRevision);
  assert.equal(requests.filter(request => request.url.endsWith('/token') && new URLSearchParams(request.options.body).get('grant_type') === 'refresh_token').length, 0);
});
test('disconnect during attachment fetch cancels the import before bytes can reach the extraction pipeline', async t => {
  const { client, connected, setHandler } = await setup(t); await connected(); let release, entered; const pending = new Promise(resolve => { entered = resolve; });
  setHandler(url => { if (url.includes('/attachments/')) { entered(); return new Promise(resolve => { release = resolve; }); } });
  const importing = client.attachment('abc123', 'attachment123'); await pending; await client.disconnect({ revoke: false }); release(reply({ size: PDF.length, data: PDF.toString('base64url') }));
  await assert.rejects(importing, error => error.code === 'connection_changed'); assert.equal(client.status().connected, false);
});
test('broader OAuth scopes are refused instead of accepting send or modify access', async t => {
  const { client, setHandler, requests } = await setup(t); const start = client.connect();
  setHandler(url => url.endsWith('/token') ? reply({ ...token(), scope: `${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.modify` }) : undefined);
  await assert.rejects(client.callback(new URLSearchParams({ state: new URL(start.authUrl).searchParams.get('state'), code: 'TEST_CODE' }), start.cookie.split(';')[0]), error => error.code === 'scope_mismatch');
  assert.ok(requests.every(request => !request.url.includes('/profile'))); assert.equal(client.status().connected, false);
});
test('OS browser launcher uses fixed argv and refuses arbitrary destinations without launching a real browser', async () => {
  const calls = []; const spawnImpl = (command, args, options) => { calls.push({ command, args, options }); const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child; };
  const url = `${ORIGIN}/api/email/authorize?ticket=${'a'.repeat(43)}`;
  assert.equal(await openSystemBrowser(url, { platform: 'darwin', spawnImpl }), true);
  assert.equal(calls[0].command, 'open'); assert.deepEqual(calls[0].args, [url]); assert.equal(calls[0].options.shell, false);
  await assert.rejects(openSystemBrowser('https://attacker.example', { spawnImpl }), /invalid/); assert.equal(calls.length, 1);
});
