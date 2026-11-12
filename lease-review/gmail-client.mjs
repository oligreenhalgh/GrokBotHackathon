import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_QUERY = 'has:attachment (filename:pdf OR filename:docx) newer_than:90d';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BYTES = 20 * 1024 * 1024;
const OAUTH_TTL = 10 * 60 * 1000;
const COOKIE_NAME = 'folio_gmail_oauth';
const SECRET_FILES = ['client.json', 'tokens.json'];
const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const safeError = error => error instanceof GmailError ? error : new GmailError('gmail_error', 'Gmail could not complete this request. Try again.', 502);

export class GmailError extends Error {
  constructor(code, message, status = 400, retryable = true) { super(message); this.name = 'GmailError'; this.code = code; this.status = status; this.retryable = retryable; }
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new GmailError('local_storage', 'The saved Gmail configuration could not be read. Reconfigure the connection.', 500); }
}
async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(temp, file); await fs.chmod(file, 0o600);
}
function scalarString(value, max = 2048) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value); }
function identifier(value, label) {
  if (!scalarString(value, 2048) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new GmailError('invalid_identifier', `Supply a valid ${label}.`);
  return value;
}
function cookie(value, maxAge = 600) { return `${COOKIE_NAME}=${value}; Path=/api/email/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`; }
function browserCookie(header = '') {
  return header.split(';').map(part => part.trim().split('=')).find(([key]) => key === COOKIE_NAME)?.[1] || '';
}
export function validateClientConfig(input, redirectUri) {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { throw new GmailError('invalid_config', 'Choose a valid Google OAuth client JSON file.'); } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GmailError('invalid_config', 'Choose a Google Desktop OAuth client JSON file.');
  const type = input.installed ? 'installed' : input.web ? 'web' : null;
  const config = type && input[type];
  if (!config || !scalarString(config.client_id, 300) || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.client_id)) throw new GmailError('invalid_config', 'This file does not contain a valid Google OAuth client ID. Choose the downloaded Desktop app client JSON.');
  if (config.client_secret !== undefined && !scalarString(config.client_secret, 500)) throw new GmailError('invalid_config', 'The OAuth client secret is invalid. Choose the original downloaded client JSON.');
  if (type === 'web' && (!Array.isArray(config.redirect_uris) || !config.redirect_uris.includes(redirectUri))) throw new GmailError('redirect_mismatch', `For a Web OAuth client, register this exact redirect URI first: ${redirectUri}. A Desktop app client is simpler for this local app.`);
  // URLs from uploaded JSON are never used as network destinations.
  return { type, clientId: config.client_id, clientSecret: config.client_secret || '', redirectUri, redirectUris: type === 'web' ? config.redirect_uris.filter(uri => scalarString(uri, 2000)) : [] };
}
function mimeFields(depth = 12) {
  const fields = 'partId,mimeType,filename,body(attachmentId,size)';
  return depth ? `${fields},parts(${mimeFields(depth - 1)})` : fields;
}
const MESSAGE_FIELDS = `id,threadId,internalDate,payload(headers(name,value),${mimeFields()})`;
function cleanHeader(value, max = 2000) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : ''; }
export function describeMessage(raw) {
  const headers = raw.payload?.headers || [];
  const header = name => cleanHeader(headers.find(h => String(h.name).toLowerCase() === name)?.value);
  const attachments = [];
  function walk(part) {
    if (!part || typeof part !== 'object') return;
    if (typeof part.filename === 'string' && /\.(pdf|docx)$/i.test(part.filename)) {
      const filename = cleanHeader(part.filename, 240);
      const size = Number(part.body?.size);
      const attachmentId = part.body?.attachmentId;
      const downloadable = scalarString(attachmentId) && /^[A-Za-z0-9_-]+$/.test(attachmentId);
      const eligible = downloadable && Number.isSafeInteger(size) && size > 0 && size <= MAX_BYTES && filename.length > 0;
      attachments.push({ id: downloadable ? attachmentId : `inline-${cleanHeader(part.partId || '0', 100)}`, filename,
        mimeType: cleanHeader(part.mimeType, 150), size: Number.isSafeInteger(size) && size >= 0 ? size : null, eligible,
        reason: !downloadable ? 'Gmail did not expose a separate attachment download ID.' : !Number.isSafeInteger(size) || size <= 0 ? 'Attachment size is unavailable or empty.' : size > MAX_BYTES ? 'Attachment exceeds the 20 MB limit.' : null });
    }
    for (const child of part.parts || []) walk(child);
  }
  walk(raw.payload);
  const time = Number(raw.internalDate);
  return { id: String(raw.id || ''), threadId: String(raw.threadId || ''), from: header('from'), subject: header('subject') || '(No subject)',
    date: Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : header('date'), attachments };
}
async function responseJson(response, limit) {
  if (Number(response.headers?.get('content-length') || 0) > limit) throw new GmailError('response_too_large', 'Google returned more data than this request allows.', 502);
  const chunks = []; let count = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; count += value.length; if (count > limit) { await reader.cancel(); throw new GmailError('response_too_large', 'Google returned more data than this request allows.', 502); } chunks.push(Buffer.from(value)); }
    } finally { reader.releaseLock(); }
  } else {
    const text = await response.text(); count = Buffer.byteLength(text); if (count > limit) throw new GmailError('response_too_large', 'Google returned more data than this request allows.', 502); chunks.push(Buffer.from(text));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GmailError('invalid_response', 'Google returned an unreadable response. Try again.', 502); }
}
function googleError(status, data, context) {
  const code = typeof data?.error === 'string' ? data.error : data?.error?.status;
  if (code === 'invalid_grant' || status === 401) return new GmailError('reconnect_required', 'Google authorization expired or was revoked. Connect Gmail again. Test-mode Google grants may expire after seven days.', 401);
  if (code === 'invalid_client') return new GmailError('invalid_client', 'Google rejected this OAuth client. Download its current client JSON and configure it again.', 400);
  if (status === 403) return new GmailError('access_denied', 'Google denied Gmail access. Check that the Gmail API is enabled and this account is an allowed OAuth test user.', 403);
  if (status === 404) return new GmailError('not_found', 'This Gmail message or attachment is no longer available.', 404);
  if (status === 429) return new GmailError('rate_limited', 'Google temporarily rate limited this connection. Wait before refreshing again.', 429);
  return new GmailError('google_error', `Google could not complete ${context} (HTTP ${status}). Try again.`, 502);
}

export class GmailClient {
  static async create(options) { const client = new GmailClient(options); await client.load(); return client; }
  constructor({ storageDir, origin, fetchImpl = fetch, now = () => Date.now() }) {
    this.dir = path.join(storageDir, 'gmail'); this.origin = origin; this.redirectUri = `${origin}/api/email/callback`;
    this.fetch = fetchImpl; this.now = now; this.config = null; this.tokens = null; this.receipts = {};
    this.pending = new Map(); this.handoffs = new Map(); this.error = null; this.lastCheckedAt = null;
    this.refreshPromise = null; this.refreshEpoch = null; this.writeQueue = Promise.resolve(); this.generation = 0;
  }
  async load() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 }); await fs.chmod(this.dir, 0o700);
    this.config = await readJson(path.join(this.dir, 'client.json')); this.tokens = await readJson(path.join(this.dir, 'tokens.json'));
    this.receipts = await readJson(path.join(this.dir, 'added.json'), {});
    for (const filename of SECRET_FILES) await fs.chmod(path.join(this.dir, filename), 0o600).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (this.config?.type === 'web' && !this.config.redirectUris?.includes(this.redirectUri)) this.error = { code: 'redirect_mismatch', message: `Configure a Web OAuth client with this exact redirect URI: ${this.redirectUri}.`, retryable: false };
  }
  write(fn) { const op = this.writeQueue.then(fn); this.writeQueue = op.catch(() => {}); return op; }
  status() {
    return { configured: !!this.config, connected: !!(this.tokens?.accessToken && this.tokens?.email), email: this.tokens?.email || null,
      clientType: this.config?.type || null, redirectUri: this.redirectUri, connectionRevision: this.generation, error: this.error,
      poll: { intervalSeconds: 60, lastCheckedAt: this.lastCheckedAt, query: GMAIL_QUERY } };
  }
  connectionEpoch() { return this.generation; }
  assertConnection(epoch) { if (epoch !== this.generation || !this.tokens?.email) throw new GmailError('connection_changed', 'Gmail was disconnected or changed while this import was running. No new extraction was started after cancellation.', 409, false); }
  setError(error, epoch = this.generation) {
    if (epoch !== this.generation) return new GmailError('connection_changed', 'The Gmail connection changed during this request. Refresh the connection status.', 409, false);
    const safe = safeError(error); this.error = { code: safe.code, message: safe.message, retryable: safe.retryable }; return safe;
  }
  async configure(input) {
    const config = validateClientConfig(input, this.redirectUri); const epoch = ++this.generation; this.configuringEpoch = epoch;
    return this.write(async () => {
      if (epoch !== this.generation) return this.status();
      await saveJson(path.join(this.dir, 'client.json'), config);
      if (epoch !== this.generation) return this.status();
      await fs.rm(path.join(this.dir, 'tokens.json'), { force: true });
      this.config = config; this.tokens = null; this.error = null; this.pending.clear(); this.handoffs.clear();
      return this.status();
    }).finally(() => { if (this.configuringEpoch === epoch) this.configuringEpoch = null; });
  }
  connect() {
    if (this.configuringEpoch != null) throw new GmailError('configuration_pending', 'Wait for the Gmail configuration to finish saving, then connect again.', 409);
    if (!this.config) throw new GmailError('not_configured', 'Upload the Google OAuth client JSON before connecting Gmail.', 409);
    if (this.config.type === 'web' && !this.config.redirectUris?.includes(this.redirectUri)) throw new GmailError('redirect_mismatch', `Register this exact Web OAuth redirect URI and upload its client JSON again: ${this.redirectUri}.`, 409);
    const now = this.now();
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    for (const [key, value] of this.handoffs) if (value.expiresAt <= now) this.handoffs.delete(key);
    if (this.pending.size >= 10) throw new GmailError('too_many_attempts', 'Too many sign-in attempts are pending. Wait ten minutes and try again.', 429);
    const state = random(), verifier = random(), browser = random(), ticket = random(), expiresAt = now + OAUTH_TTL;
    const url = new URL(AUTH_URL);
    for (const [key, value] of Object.entries({ client_id: this.config.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: GMAIL_SCOPE,
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' })) url.searchParams.set(key, value);
    const attempt = { state, verifier, browserHash: digest(browser), expiresAt, generation: this.generation, authUrl: url.toString() };
    this.pending.set(state, attempt); this.handoffs.set(ticket, { state, browser, expiresAt }); this.error = null;
    return { authUrl: attempt.authUrl, connectUrl: `${this.origin}/api/email/authorize?ticket=${ticket}`, expiresAt: new Date(expiresAt).toISOString(), cookie: cookie(browser) };
  }
  authorize(ticket) {
    const handoff = this.handoffs.get(ticket); this.handoffs.delete(ticket);
    if (!handoff || handoff.expiresAt <= this.now()) throw new GmailError('expired_signin', 'This sign-in link expired or was already used. Return to Role Model and connect again.', 400);
    const attempt = this.pending.get(handoff.state);
    if (!attempt || attempt.generation !== this.generation) throw new GmailError('expired_signin', 'The Gmail setup changed. Return to Role Model and connect again.', 400);
    return { authUrl: attempt.authUrl, cookie: cookie(handoff.browser) };
  }
  async request(url, options = {}, limit = 6 * 1024 * 1024) {
    let response;
    try { response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new GmailError('connection_failed', 'Could not reach Google. Check your connection and try again.', 502); }
    const data = await responseJson(response, limit);
    return { response, data };
  }
  validateTokens(raw, previous = null) {
    const scopes = String(raw.scope || previous?.scope || '').split(/\s+/).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== GMAIL_SCOPE) throw new GmailError('scope_mismatch', 'Google did not grant exactly the requested read-only Gmail permission. Reconnect using a dedicated OAuth client.', 403, false);
    if (!scalarString(raw.access_token, 20000) || String(raw.token_type || '').toLowerCase() !== 'bearer') throw new GmailError('invalid_tokens', 'Google returned an invalid authorization response. Connect again.', 502);
    const expiresIn = Number(raw.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 2592000) throw new GmailError('invalid_tokens', 'Google returned an invalid authorization expiry. Connect again.', 502);
    const refreshToken = raw.refresh_token || previous?.refreshToken || null;
    if (refreshToken !== null && !scalarString(refreshToken, 20000)) throw new GmailError('invalid_tokens', 'Google returned an invalid refresh token. Connect again.', 502);
    return { accessToken: raw.access_token, refreshToken, expiresAt: this.now() + expiresIn * 1000, scope: GMAIL_SCOPE, email: previous?.email || null };
  }
  async callback(params, cookieHeader) {
    const state = params.get('state'); const attempt = this.pending.get(state);
    if (!attempt || !scalarString(state, 200) || attempt.expiresAt <= this.now() || attempt.generation !== this.generation || !equal(attempt.browserHash, digest(browserCookie(cookieHeader)))) {
      throw new GmailError('invalid_state', 'This sign-in could not be matched to this browser, or it expired. Return to Role Model and connect again.', 400);
    }
    this.pending.delete(state);
    for (const [ticket, handoff] of this.handoffs) if (handoff.state === state) this.handoffs.delete(ticket);
    if (params.has('error')) throw this.setError(new GmailError('consent_denied', 'Google sign-in was cancelled or access was not granted. Your mailbox was not connected.', 400));
    const code = params.get('code');
    if (!scalarString(code, 10000)) throw new GmailError('invalid_code', 'Google did not return an authorization code. Connect again.', 400);
    let expectedEpoch = attempt.generation;
    try {
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.config.clientId,
        redirect_uri: this.redirectUri, code_verifier: attempt.verifier });
      if (this.config.clientSecret) form.set('client_secret', this.config.clientSecret);
      const { response, data } = await this.request(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, 1024 * 1024);
      if (!response.ok) throw googleError(response.status, data, 'sign-in');
      if (expectedEpoch !== this.generation) throw new GmailError('connection_changed', 'The Gmail setup changed during sign-in.', 409);
      const tokens = this.validateTokens(data);
      const profile = await this.request(`${API_BASE}/profile?fields=emailAddress`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
      if (!profile.response.ok) throw googleError(profile.response.status, profile.data, 'the Gmail connection');
      if (!scalarString(profile.data.emailAddress, 320) || !profile.data.emailAddress.includes('@')) throw new GmailError('invalid_profile', 'Google did not identify the connected Gmail account.', 502);
      if (attempt.generation !== this.generation) throw new GmailError('connection_changed', 'The Gmail setup changed during sign-in. Connect again.', 409);
      tokens.email = profile.data.emailAddress;
      await this.write(async () => {
        if (attempt.generation !== this.generation) throw new GmailError('connection_changed', 'The Gmail setup changed during sign-in.', 409);
        const epoch = ++this.generation; expectedEpoch = epoch; this.pending.clear(); this.handoffs.clear();
        await saveJson(path.join(this.dir, 'tokens.json'), tokens);
        if (epoch !== this.generation) throw new GmailError('connection_changed', 'Gmail was disconnected during sign-in.', 409);
        this.tokens = tokens;
      });
      if (expectedEpoch !== this.generation) throw new GmailError('connection_changed', 'The Gmail setup changed during sign-in.', 409);
      this.error = null; return { ...this.status(), cookie: cookie('', 0) };
    } catch (error) { throw this.setError(error, expectedEpoch); }
  }
  async accessToken(force = false) {
    if (!this.tokens || !this.config) throw new GmailError('not_connected', 'Connect Gmail to view document attachments.', 401);
    if (!force && this.tokens.expiresAt > this.now() + 60000) return this.tokens.accessToken;
    if (this.refreshPromise && this.refreshEpoch === this.generation) return this.refreshPromise;
    const generation = this.generation, previous = this.tokens;
    const refreshPromise = (async () => {
      if (!previous.refreshToken) throw new GmailError('reconnect_required', 'The Gmail session expired. Connect Gmail again.', 401);
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previous.refreshToken, client_id: this.config.clientId });
      if (this.config.clientSecret) form.set('client_secret', this.config.clientSecret);
      const { response, data } = await this.request(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, 1024 * 1024);
      if (!response.ok) throw googleError(response.status, data, 'authorization refresh');
      const tokens = this.validateTokens(data, previous);
      if (generation !== this.generation) throw new GmailError('connection_changed', 'Gmail was disconnected during this request.', 409);
      await this.write(async () => { if (generation !== this.generation) throw new GmailError('connection_changed', 'Gmail was disconnected.', 409); await saveJson(path.join(this.dir, 'tokens.json'), tokens); if (generation !== this.generation) throw new GmailError('connection_changed', 'Gmail was disconnected.', 409); this.tokens = tokens; });
      return tokens.accessToken;
    })().catch(async error => {
      if (error.code === 'reconnect_required' && generation === this.generation) {
        await this.write(async () => {
          if (generation !== this.generation) return;
          this.tokens = null; await fs.rm(path.join(this.dir, 'tokens.json'), { force: true });
        });
      }
      throw this.setError(error, generation);
    }).finally(() => { if (this.refreshPromise === refreshPromise) { this.refreshPromise = null; this.refreshEpoch = null; } });
    this.refreshPromise = refreshPromise; this.refreshEpoch = generation;
    return refreshPromise;
  }
  async gmailGet(route, limit) {
    const generation = this.generation;
    let token = await this.accessToken();
    if (generation !== this.generation) throw new GmailError('connection_changed', 'The Gmail connection changed during this request.', 409);
    let result = await this.request(`${API_BASE}${route}`, { headers: { authorization: `Bearer ${token}` } }, limit);
    if (generation !== this.generation) throw new GmailError('connection_changed', 'The Gmail connection changed during this request.', 409);
    if (result.response.status === 401) { token = await this.accessToken(true); if (generation !== this.generation) throw new GmailError('connection_changed', 'The Gmail connection changed during this request.', 409); result = await this.request(`${API_BASE}${route}`, { headers: { authorization: `Bearer ${token}` } }, limit); }
    if (generation !== this.generation) throw new GmailError('connection_changed', 'Gmail was disconnected during this request.', 409);
    if (!result.response.ok) throw this.setError(googleError(result.response.status, result.data, 'the Gmail request'), generation);
    return result.data;
  }
  async message(id) {
    identifier(id, 'message ID');
    const params = new URLSearchParams({ format: 'full', fields: MESSAGE_FIELDS });
    return describeMessage(await this.gmailGet(`/messages/${encodeURIComponent(id)}?${params}`));
  }
  receiptKey(messageId, attachmentId, email = this.tokens?.email) { return digest(`${email || ''}\n${messageId}\n${attachmentId}`); }
  async listMessages({ pageToken } = {}) {
    if (pageToken !== undefined && (!scalarString(pageToken, 4096))) throw new GmailError('invalid_page', 'Invalid Gmail page token.');
    const params = new URLSearchParams({ q: GMAIL_QUERY, maxResults: '20', includeSpamTrash: 'false', fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate' });
    if (pageToken) params.set('pageToken', pageToken);
    const epoch = this.generation, email = this.tokens?.email || null;
    try {
      const listed = await this.gmailGet(`/messages?${params}`);
      const ids = (listed.messages || []).slice(0, 20); const messages = new Array(ids.length); let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length) { this.assertConnection(epoch); const at = next++; const message = await this.message(ids[at].id); this.assertConnection(epoch);
          message.attachments = message.attachments.map(attachment => { const receipt = this.receipts[this.receiptKey(message.id, attachment.id)]; return { ...attachment, added: !!receipt, documentId: receipt?.documentId || null, addedAt: receipt?.addedAt || null }; });
          messages[at] = message;
        }
      }));
      this.assertConnection(epoch);
      this.lastCheckedAt = new Date(this.now()).toISOString(); this.error = null;
      return { email, connectionRevision: epoch, messages: messages.filter(message => message.attachments.length), nextPageToken: listed.nextPageToken || null,
        resultSizeEstimate: Number.isFinite(listed.resultSizeEstimate) ? listed.resultSizeEstimate : null, checkedAt: this.lastCheckedAt, query: GMAIL_QUERY };
    } catch (error) { throw this.setError(error, epoch); }
  }
  async attachment(messageId, attachmentId) {
    identifier(messageId, 'message ID'); identifier(attachmentId, 'attachment ID');
    const epoch = this.generation;
    try {
      const message = await this.message(messageId);
      const attachment = message.attachments.find(item => item.id === attachmentId);
      if (!attachment) throw new GmailError('attachment_not_found', 'This attachment does not belong to the selected message, or is not a PDF/DOCX.', 404, false);
      if (!attachment.eligible) throw new GmailError('attachment_not_allowed', attachment.reason || 'This attachment cannot be imported.', 413, false);
      this.assertConnection(epoch);
      const data = await this.gmailGet(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?fields=data,size`, 29 * 1024 * 1024);
      if (!Number.isSafeInteger(data.size) || data.size <= 0 || data.size > MAX_BYTES || typeof data.data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data.data)) throw new GmailError('invalid_attachment', 'Gmail returned an invalid or oversized attachment.', 422, false);
      const bytes = Buffer.from(data.data, 'base64url');
      if (!bytes.length || bytes.length > MAX_BYTES || bytes.length !== data.size || bytes.length !== attachment.size) throw new GmailError('invalid_attachment', 'The downloaded attachment size did not match its Gmail metadata.', 422, false);
      this.assertConnection(epoch);
      return { bytes, filename: attachment.filename, provenance: { source: 'gmail', account: this.tokens.email, messageId, attachmentId, from: message.from, subject: message.subject, date: message.date, filename: attachment.filename } };
    } catch (error) { throw this.setError(error, epoch); }
  }
  async recordAdded(provenance, documentId) {
    await this.write(async () => {
      const key = this.receiptKey(provenance.messageId, provenance.attachmentId, provenance.account);
      this.receipts[key] = { documentId, addedAt: new Date(this.now()).toISOString() };
      await saveJson(path.join(this.dir, 'added.json'), this.receipts);
    });
  }
  async disconnect({ revoke = true } = {}) {
    const token = this.tokens?.refreshToken || this.tokens?.accessToken;
    const epoch = ++this.generation; this.pending.clear(); this.handoffs.clear(); this.tokens = null;
    await this.write(async () => { if (epoch !== this.generation) return; this.tokens = null; await fs.rm(path.join(this.dir, 'tokens.json'), { force: true }); });
    let revoked = false;
    if (revoke && token) {
      try {
        const response = await this.fetch(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(), redirect: 'error', signal: AbortSignal.timeout(15000) });
        revoked = response.ok; await response.body?.cancel();
      } catch {}
    }
    if (epoch === this.generation) this.error = revoke && token && !revoked ? { code: 'revocation_unconfirmed', message: 'Local Gmail tokens were removed. Google revocation could not be confirmed; you can also remove access in your Google Account permissions.', retryable: true } : null;
    return { ...this.status(), revoked, localTokensRemoved: true };
  }
}

export async function openSystemBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  // The server passes only its generated one-time loopback handoff URL.
  if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/email\/authorize\?ticket=[A-Za-z0-9_-]{43}$/.test(url)) throw new GmailError('invalid_browser_url', 'The sign-in browser URL is invalid.');
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise(resolve => {
    let settled = false; const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish(false), 5000);
    let child;
    try { child = spawnImpl(command, args, { stdio: 'ignore', shell: false, windowsHide: true, env: { ...process.env, ANTHROPIC_API_KEY: '' } }); }
    catch { finish(false); return; }
    child.on('error', () => finish(false)); child.on('close', code => finish(code === 0));
  });
}
