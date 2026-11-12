const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mailIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></svg>';
const fileIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6"/></svg>';
const store = { status:null, messages:[], nextPageToken:null, checkedAt:null, loading:false, error:'', notice:'', pending:new Map(), connecting:false, connectUrl:null, connectExpiry:null, filter:'' };
let activeView = null, viewSequence = 0, connectionSequence = 0, loadSequence = 0, authSequence = 0, statusSequence = 0, mutationSequence = 0;
let pollTimer = null, authTimer = null;
const alive = view => view === activeView && view.host?.isConnected;
const key = (message,attachment) => `${message.id}:${attachment.id}`;
const date = value => {const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});};
const size = bytes => bytes ? bytes<1024*1024 ? `${Math.ceil(bytes/1024)} KB` : `${(bytes/1024/1024).toFixed(1)} MB` : '';
function errorText(value){return typeof value==='string'?value:value?.message||'';}
function setup(){return `<section class="email-connect"><div class="email-connect-icon">${mailIcon}</div><h2>Connect your Gmail</h2><p>See PDF and Word attachments here, then choose which documents to add to your register.</p><p class="email-access">Read-only access. Email messages are never sent to the extraction provider. Only an attachment you choose to add is sent to Fable.</p>${store.status?.configured?`<button class="button primary" id="gmail-connect" ${store.connecting?'disabled':''}>${store.connecting?'Waiting for Google…':'Connect Gmail'}</button><button class="button quiet" id="gmail-change-config">Change Google client</button>`:`<div class="gmail-setup"><h3>One-time Google setup</h3><ol><li>In <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">Google Cloud ↗</a>, select a project and enable the <strong>Gmail API</strong>.</li><li>Configure the <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener noreferrer">Google Auth platform ↗</a> with the app name <strong>Role Model</strong>. For a personal Gmail account, use External / Testing and add your Gmail address as a test user under Audience.</li><li>Under Data Access, add the <strong>gmail.readonly</strong> scope. Under Clients, create a <strong>Desktop app</strong> OAuth client and download its JSON file.</li></ol><label class="button primary" for="gmail-client-file">Choose Google client JSON</label><input id="gmail-client-file" class="import-input" type="file" accept=".json,application/json"><p class="email-setup-note">The file is saved only on this computer. Then sign in through Google in your normal browser.</p></div>`}${store.connecting?`<p class="email-connecting">Finish Google sign-in in your browser. This page will update when you return.</p>`:''}${store.connectUrl?`<div class="email-connect-fallback"><button class="button small" id="gmail-copy-link">Copy sign-in link</button><span>Open the link in Chrome or Safari if your browser did not open.</span></div>`:''}</section>`;}
function visibleMessages(){const needle=store.filter.toLowerCase();return store.messages.filter(m=>`${m.subject} ${m.from} ${m.attachments.map(a=>a.filename).join(' ')}`.toLowerCase().includes(needle));}
function rows(){const messages=visibleMessages();if(!messages.length)return `<div class="empty-state">${mailIcon}<h3>${store.loading?'Checking Gmail…':store.filter?'No matches':'No document attachments found'}</h3><p>${store.filter?'Try another sender, subject or filename.':'PDF and DOCX attachments received in the last 90 days will appear here.'}</p></div>`;return messages.map(m=>`<article class="email-message"><div class="email-message-heading"><div><h2>${escape(m.subject||'(No subject)')}</h2><p>${escape(m.from)}</p></div><time>${escape(date(m.date))}</time></div><div class="email-attachments">${m.attachments.map(a=>{const pending=store.pending.has(key(m,a));return `<div class="email-attachment"><span class="email-file">${fileIcon}<span><strong>${escape(a.filename)}</strong><small>${escape(size(a.size))}${!a.eligible?` · ${escape(a.reason||'Unsupported attachment')}`:''}</small></span></span>${a.added?`<span class="email-added">Added</span>${a.documentId?`<a class="button small" href="/viewer.html?document=${encodeURIComponent(a.documentId)}&page=1" target="_blank" rel="noopener">Open document ↗</a>`:''}`:`<button class="button small ${a.eligible?'primary':''}" data-email-import="${escape(key(m,a))}" ${!a.eligible||pending?'disabled':''}>${pending?'Adding…':'Add to register'}</button>`}</div>`;}).join('')}</div></article>`).join('');}
function paint(view){if(!alive(view))return;const host=view.host;host.innerHTML=`<div class="page-heading"><h1>Email</h1><div class="actions">${store.status?.connected?`<span class="email-account">${escape(store.status.email)}</span><button class="button" id="gmail-refresh" ${store.loading?'disabled':''}>${store.loading?'Checking…':'Refresh'}</button><button class="button quiet" id="gmail-disconnect">Disconnect</button>`:''}</div></div>${store.error?`<div class="email-alert" role="alert">${escape(store.error)}</div>`:''}${store.notice?`<div class="email-notice" role="status">${escape(store.notice)}</div>`:''}${!store.status?'<div class="empty-state"><p>Checking Gmail connection…</p></div>':store.status.connected?`<div class="library-toolbar email-toolbar"><label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input id="email-search" aria-label="Search loaded emails" placeholder="Search sender, subject or filename" value="${escape(store.filter)}"></label><span class="email-poll-status">${store.checkedAt?`Checked ${escape(date(store.checkedAt))}`:''}</span></div><div class="email-list">${rows()}</div>${store.nextPageToken?`<div class="email-more"><button class="button" id="gmail-more" ${store.loading?'disabled':''}>Load older messages</button></div>`:''}<p class="email-footnote">Select an attachment to send it to Fable and add its extracted terms. Gmail is checked every minute while this tab is open.</p>`:setup()}`;bind(view);}
function clearPoll() { clearTimeout(pollTimer); pollTimer = null; }
function clearAuth() { clearTimeout(authTimer); authTimer = null; }
function identity(status) {
  return status?.connected
    ? `connected:${String(status.email || '').trim().toLowerCase()}:${status.connectionRevision ?? ''}`
    : `disconnected:${!!status?.configured}:${status?.connectionRevision ?? ''}`;
}
function invalidateConnection() {
  connectionSequence++; loadSequence++; authSequence++; statusSequence++;
  clearPoll(); clearAuth();
  store.messages = []; store.nextPageToken = null; store.checkedAt = null;
  store.loading = false; store.pending.clear();
  store.connecting = false; store.connectUrl = null; store.connectExpiry = null;
}
function applyStatus(view, status) {
  if (!alive(view)) return false;
  if (identity(store.status) !== identity(status)) invalidateConnection();
  store.status = status;
  if (status.connected) { store.connecting = false; store.connectUrl = null; clearAuth(); }
  return true;
}
function beginMutation(view) {
  if (!alive(view)) return null;
  invalidateConnection();
  return { view, id: ++mutationSequence };
}
const mutationCurrent = token => token && alive(token.view) && token.id === mutationSequence;
const request = (view, url, body = {}) => view.context.api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function bind(view) {
  if (!alive(view)) return;
  const host = view.host, $ = selector => host.querySelector(selector);
  $('#gmail-refresh')?.addEventListener('click', () => loadMessages(view));
  $('#gmail-more')?.addEventListener('click', () => loadMessages(view, { more: true }));
  $('#gmail-connect')?.addEventListener('click', () => connect(view));
  $('#gmail-change-config')?.addEventListener('click', () => {
    if (!alive(view)) return;
    beginMutation(view); store.status = { ...store.status, configured: false }; store.error = ''; paint(view);
  });
  $('#gmail-copy-link')?.addEventListener('click', async () => {
    if (!alive(view) || !store.connectUrl) return;
    const sequence = authSequence, url = store.connectUrl;
    try { await navigator.clipboard.writeText(url); if (alive(view) && sequence === authSequence) view.context.toast('Sign-in link copied. Open it in your browser.'); }
    catch { if (alive(view) && sequence === authSequence) { store.notice = 'Your browser could not copy the link. Use Connect Gmail to open Google again.'; paint(view); } }
  });
  $('#gmail-disconnect')?.addEventListener('click', async () => {
    const token = beginMutation(view); if (!token) return;
    store.status = { ...store.status, connected: false, email: null }; store.error = ''; store.notice = 'Disconnecting Gmail…'; paint(view);
    try {
      const status = await request(view, '/api/email/disconnect');
      if (!mutationCurrent(token)) return;
      applyStatus(view, status); store.error = errorText(status.error);
      store.notice = 'Gmail disconnected. Documents already added stay in the register.'; paint(view);
    } catch (error) {
      if (!mutationCurrent(token)) return;
      store.error = error.message; store.notice = ''; await refreshStatus(view, { reload: true, preserveError: true });
    }
  });
  $('#gmail-client-file')?.addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    const token = beginMutation(view); if (!token) return;
    try {
      if (file.size > 100000) throw new Error('Choose the small OAuth client JSON file downloaded from Google.');
      let client; try { client = JSON.parse(await file.text()); } catch { throw new Error('This is not a valid JSON file. Download the OAuth client JSON from Google Cloud.'); }
      if (!mutationCurrent(token)) return;
      const status = await request(view, '/api/email/config', { client });
      if (!mutationCurrent(token)) return;
      applyStatus(view, status); store.error = ''; store.notice = 'Google client saved. Connect Gmail to finish sign-in.'; paint(view);
    } catch (error) { if (mutationCurrent(token)) { store.error = error.message; paint(view); } }
  });
  $('#email-search')?.addEventListener('input', event => {
    if (!alive(view)) return;
    store.filter = event.target.value; host.querySelector('.email-list').innerHTML = rows(); bindImports(view);
  });
  bindImports(view);
}

function bindImports(view) {
  view.host.querySelectorAll('[data-email-import]').forEach(button => button.onclick = async () => {
    if (!alive(view) || !store.status?.connected) return;
    let message, attachment;
    for (const candidate of store.messages) {
      const found = candidate.attachments.find(item => key(candidate, item) === button.dataset.emailImport);
      if (found) { message = candidate; attachment = found; break; }
    }
    if (!attachment) return;
    const attachmentKey = key(message, attachment);
    if (store.pending.has(attachmentKey)) return;
    const token = { view, connection: connectionSequence, email: store.status.email, connectionRevision: store.status.connectionRevision };
    const current = () => alive(view) && token.connection === connectionSequence && store.pending.get(attachmentKey) === token;
    store.pending.set(attachmentKey, token); store.error = ''; paint(view);
    try {
      const result = await request(view, '/api/email/import', { messageId: message.id, attachmentId: attachment.id, email: token.email, connectionRevision: token.connectionRevision });
      if (!current()) return;
      for (const item of store.messages) for (const file of item.attachments) if (key(item, file) === attachmentKey) { file.added = true; file.documentId = result.document?.id; }
      store.notice = result.duplicate ? 'This document was already in the library; its email source is now linked.' : result.status === 'extracting' ? 'Document added. Fable is extracting its terms; progress is available in Documents.' : result.message || 'Document added to the library.';
      await view.context.refresh();
      if (!current()) return;
      view.context.watchExtractions(); view.context.toast(result.duplicate ? 'Document already in library' : 'Email attachment added');
    } catch (error) { if (current()) store.error = error.message; }
    finally {
      // Remove only this operation's marker, even if its view was left. A later import
      // with the same Gmail IDs owns a different token and must remain pending.
      if (store.pending.get(attachmentKey) === token) store.pending.delete(attachmentKey);
      if (alive(view) && token.connection === connectionSequence) paint(view);
    }
  });
}

async function refreshStatus(view, { reload = false, preserveError = false } = {}) {
  if (!alive(view)) return;
  const sequence = ++statusSequence;
  try {
    const status = await view.context.api('/api/email/status');
    if (!alive(view) || sequence !== statusSequence) return;
    applyStatus(view, status);
    if (!preserveError) store.error = errorText(status.error);
    paint(view);
    if (reload && status.connected) await loadMessages(view, { quiet: true });
    else if (store.connecting) watchConnection(view);
  } catch (error) {
    if (!alive(view) || sequence !== statusSequence) return;
    store.error = error.message; store.status ??= { connected: false, configured: false }; paint(view);
  }
}
function listMatches(status, result) {
  return String(result.email || '').trim().toLowerCase() === String(status.email || '').trim().toLowerCase()
    && result.connectionRevision === status.connectionRevision;
}
async function loadMessages(view, { more = false, quiet = false } = {}) {
  if (!alive(view) || store.loading || !store.status?.connected) return;
  const token = { id: ++loadSequence, connection: connectionSequence, status: store.status };
  const current = () => alive(view) && token.id === loadSequence && token.connection === connectionSequence;
  store.loading = true; store.error = ''; if (!quiet) paint(view);
  try {
    const query = more && store.nextPageToken ? `?pageToken=${encodeURIComponent(store.nextPageToken)}` : '';
    const result = await view.context.api('/api/email/messages' + query);
    if (!current()) return;
    if (!listMatches(token.status, result)) {
      // Another browser/tab changed the server's Gmail connection while this view
      // was open. Never merge a different account or connection's message list.
      invalidateConnection(); paint(view); await refreshStatus(view, { reload: true }); return;
    }
    const next = result.messages || [];
    store.messages = more ? [...store.messages, ...next.filter(message => !store.messages.some(old => old.id === message.id))]
      : quiet ? [...next, ...store.messages.filter(message => !next.some(fresh => fresh.id === message.id))] : next;
    if (!quiet || !store.nextPageToken) store.nextPageToken = result.nextPageToken;
    store.checkedAt = result.checkedAt; store.status.error = null;
  } catch (error) {
    if (!current()) return;
    store.error = error.message; await refreshStatus(view, { preserveError: true });
  } finally {
    if (!current()) return;
    store.loading = false;
    const host = view.host, searchInput = host.querySelector('#email-search'), focused = document.activeElement === searchInput, position = searchInput?.selectionStart, scroll = host.scrollTop;
    paint(view); host.scrollTop = scroll;
    if (focused) { host.querySelector('#email-search')?.focus(); host.querySelector('#email-search')?.setSelectionRange(position, position); }
    schedulePoll(view);
  }
}
function schedulePoll(view) {
  if (!alive(view)) return;
  clearPoll();
  if (store.status?.connected) pollTimer = setTimeout(() => { if (alive(view)) loadMessages(view, { quiet: true }); }, 60000);
}
async function connect(view) {
  if (!alive(view)) return;
  clearAuth(); const sequence = ++authSequence;
  store.error = ''; store.notice = ''; store.connecting = true; store.connectUrl = null; store.connectExpiry = Date.now() + 10 * 60 * 1000; paint(view);
  try {
    const result = await request(view, '/api/email/connect', { openBrowser: true });
    if (!alive(view) || sequence !== authSequence) return;
    store.connectUrl = result.connectUrl; store.connectExpiry = Date.parse(result.expiresAt); paint(view); watchConnection(view, sequence);
  } catch (error) { if (alive(view) && sequence === authSequence) { store.connecting = false; store.error = error.message; paint(view); } }
}
function watchConnection(view, sequence = authSequence) {
  if (!alive(view) || sequence !== authSequence || !store.connecting) return;
  clearAuth();
  authTimer = setTimeout(async () => {
    if (!alive(view) || sequence !== authSequence || !store.connecting) return;
    const statusRequest = ++statusSequence;
    try {
      const status = await view.context.api('/api/email/status');
      if (!alive(view) || sequence !== authSequence || statusRequest !== statusSequence) return;
      applyStatus(view, status);
      if (status.connected) { store.notice = 'Gmail connected. Choose an attachment to add.'; paint(view); await loadMessages(view); return; }
      if (store.connectExpiry && Date.now() > store.connectExpiry) { store.connecting = false; store.connectUrl = null; store.error = 'The sign-in link expired. Connect Gmail to try again.'; paint(view); return; }
      if (status.error) { store.error = errorText(status.error); store.connecting = false; store.connectUrl = null; paint(view); return; }
      watchConnection(view, sequence);
    } catch (error) { if (alive(view) && sequence === authSequence && statusRequest === statusSequence) { store.error = error.message; store.connecting = false; paint(view); } }
  }, 2000);
}
export async function renderEmailView(host, context) {
  clearPoll(); clearAuth(); loadSequence++; authSequence++; statusSequence++;
  const view = { host, context, id: ++viewSequence }; activeView = view;
  store.loading = false; paint(view);
  await refreshStatus(view, { reload: true });
}
