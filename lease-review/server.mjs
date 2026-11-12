import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extractWithFable, FABLE_MODEL, ExtractionError } from './fable-extractor.mjs';
import { GmailClient, GmailError, openSystemBrowser } from './gmail-client.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
try { process.loadEnvFile(path.join(ROOT, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load the server-side .env configuration.'); }
const STORAGE = process.env.LEASE_STORAGE_DIR ? path.resolve(process.env.LEASE_STORAGE_DIR) : path.join(ROOT, 'storage');
const UPLOADS = path.join(STORAGE, 'uploads');
const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';
const VENV_PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const PYTHON = process.env.LEASE_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : process.platform === 'win32' ? 'python' : 'python3');
const STATUSES = new Set(['extracted', 'placeholder', 'optional', 'not_found', 'derived', 'needs_review', 'not_applicable']);
function providerInfo() {
  const configured = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  return { id: 'astra', label: 'Astra · initial collection', live: false,
    upload: { id: 'fable', label: 'Claude Fable 5.2', model: FABLE_MODEL, configured, live: configured } };
}
await fs.mkdir(UPLOADS, { recursive: true });
let index = await readJson(path.join(PUBLIC, 'data/document-index.json'), { documents: [] });
let uploadMetadata = await readJson(path.join(STORAGE, 'uploads.json'), []);
let state = await readJson(path.join(STORAGE, 'state.json'), { reviews: {}, overrides: {}, audit: [] });
let imports = await readJson(path.join(STORAGE, 'imported-rows.json'), []);
let emailProvenance = await readJson(path.join(STORAGE, 'email-provenance.json'), {});
const gmail = await GmailClient.create({ storageDir: STORAGE, origin: `http://127.0.0.1:${PORT}` });
let mutationQueue = Promise.resolve();
const uploadCache = new Map();
const uploadInFlight = new Map();
const extractionJobs = new Map();
const emailImportsInFlight = new Map();
const COMPLETED_EXTRACTIONS = new Set(['extracted', 'supporting_extracted', 'extraction_imported', 'document_review_required', 'unrelated_document']);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return structuredClone(fallback); throw e; }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}
function mutate(fn) {
  const operation = mutationQueue.then(fn);
  mutationQueue = operation.catch(() => {});
  return operation;
}
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function metadata(document) { const { pages, ...meta } = document; return { ...meta, ...(emailProvenance[document.id]?.length ? { emailSources: emailProvenance[document.id] } : {}) }; }
function columnsFrom(data) { return Array.isArray(data) ? data : data.columns || []; }
async function workspace() {
  const columns = columnsFrom(await readJson(path.join(PUBLIC, 'data/columns.json'), []));
  const extraction = await readJson(path.join(PUBLIC, 'data/extraction.json'), { rows: [] });
  const rows = [...(Array.isArray(extraction) ? extraction : extraction.rows || []), ...imports];
  return { columns, rows, documents: [...index.documents.map(metadata), ...uploadMetadata.map(metadata)], state, provider: providerInfo() };
}
async function documentById(id) {
  const prepared = index.documents.find(x => x.id === id);
  if (prepared) return { ...prepared, ...metadata(prepared) };
  const meta = uploadMetadata.find(x => x.id === id);
  if (!meta) return null;
  if (!uploadCache.has(id)) uploadCache.set(id, await readJson(path.join(UPLOADS, id, 'document.json'), null));
  return { ...uploadCache.get(id), ...metadata(meta) };
}
function json(res, status, data) {
  const content = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': content.length, 'Cache-Control': 'no-store' });
  res.end(content);
}
async function body(req, limit = 5 * 1024 * 1024) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Use Content-Type: application/json.');
  if (Number(req.headers['content-length'] || 0) > limit) fail(413, 'Request exceeds the size limit.');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) fail(413, 'Request exceeds the size limit.');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'The request is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Supply a JSON object.');
  return parsed;
}
function checkValue(value, label = 'Value') {
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) fail(400, `${label} must be a string, number, boolean or null.`);
  if (typeof value === 'number' && !Number.isFinite(value)) fail(400, `${label} must be a finite number.`);
  if (typeof value === 'string' && value.length > 20000) fail(400, `${label} is too long.`);
}
function checkNote(note) { if (note !== undefined && (typeof note !== 'string' || note.length > 20000)) fail(400, 'Note must be a string of at most 20,000 characters.'); }
function allowedRequest(req, pathname) {
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (!hosts.has(req.headers.host)) fail(403, 'This app accepts requests to its local address only.');
  if (req.method === 'GET' && pathname === '/api/email/callback') return; // OAuth state + PKCE + browser cookie are checked by the callback.
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(origin)) fail(403, 'Cross-origin requests are not allowed.');
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site requests are not allowed.');
}
function normalize(text) { return text.replace(/\s+/g, ' ').trim(); }
async function validateImport(payload, current) {
  if (!Array.isArray(payload.rows) || payload.rows.length < 1 || payload.rows.length > 250) fail(400, 'Supply between 1 and 250 rows.');
  const knownIds = new Set(current.rows.map(x => x.id));
  const validColumns = new Set(current.columns.map(x => x.id));
  const result = [];
  for (const row of payload.rows) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(row.id)) fail(400, 'Each row needs an ID containing letters, numbers, hyphens or underscores.');
    if (knownIds.has(row.id)) fail(409, `Row ID already exists: ${row.id}.`);
    knownIds.add(row.id);
    if (typeof row.documentId !== 'string' || !await documentById(row.documentId)) fail(400, `Unknown document for row ${row.id}.`);
    if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 500) fail(400, `Row ${row.id} needs a title.`);
    if (typeof row.category !== 'string' || row.category.length > 100) fail(400, `Row ${row.id} needs a category.`);
    if (!row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)) fail(400, `Row ${row.id} needs a cells object.`);
    if (Object.keys(row.cells).length !== validColumns.size || Object.keys(row.cells).some(id => !validColumns.has(id))) fail(400, `Row ${row.id} must contain exactly the ${validColumns.size} configured columns.`);
    const cells = {};
    for (const column of current.columns) {
      const cell = row.cells[column.id];
      const label = `${row.id}/${column.id}`;
      if (!cell || typeof cell !== 'object' || !Object.hasOwn(cell, 'value')) fail(400, `${label} needs a value (use null when unknown).`);
      checkValue(cell.value, label);
      if (!STATUSES.has(cell.status)) fail(400, `${label} has an unsupported status.`);
      if (typeof cell.explanation !== 'string' || !cell.explanation.trim() || cell.explanation.length > 20000) fail(400, `${label} needs an explanation.`);
      if (!Array.isArray(cell.evidence) || cell.evidence.length > 30) fail(400, `${label} needs an evidence array with at most 30 entries.`);
      if (['extracted', 'placeholder', 'optional'].includes(cell.status) && !cell.evidence.length) fail(400, `${label} requires source evidence.`);
      const evidence = [];
      for (const reference of cell.evidence) {
        if (!reference || typeof reference.documentId !== 'string') fail(400, `${label} contains an invalid document reference.`);
        const document = await documentById(reference.documentId);
        if (!document) fail(400, `${label} references an unknown source document.`);
        if (!Number.isInteger(reference.page) || reference.page < 1 || reference.page > document.pageCount) fail(400, `${label} references an invalid page.`);
        if (typeof reference.quote !== 'string' || !reference.quote.trim() || reference.quote.length > 10000) fail(400, `${label} needs a nonempty source quote.`);
        if (!normalize(document.pages[reference.page - 1].text).includes(normalize(reference.quote))) fail(400, `${label}: the quote does not occur on source page ${reference.page}.`);
        evidence.push({ documentId: reference.documentId, page: reference.page, quote: reference.quote });
      }
      cells[column.id] = { value: cell.value, status: cell.status, explanation: cell.explanation, evidence };
    }
    result.push({ id: row.id, documentId: row.documentId, title: row.title, category: row.category, cells });
  }
  return result;
}

async function updateUpload(id, patch, auditType) {
  const existing = uploadMetadata.find(x => x.id === id);
  if (!existing) fail(404, 'Uploaded document not found.');
  const updated = { ...existing, ...patch };
  const nextUploads = uploadMetadata.map(x => x.id === id ? updated : x);
  await atomicJson(path.join(STORAGE, 'uploads.json'), nextUploads); uploadMetadata = nextUploads;
  if (auditType) {
    const next = structuredClone(state);
    next.audit.push({ id: randomUUID(), type: auditType, documentId: id, at: new Date().toISOString(), status: updated.status });
    await atomicJson(path.join(STORAGE, 'state.json'), next); state = next;
  }
  return updated;
}
function uploadedRows(id) { return imports.filter(row => row.documentId === id); }
function extractionResponse(document, duplicate = false) {
  return { document, status: document.status, rows: uploadedRows(document.id), duplicate,
    message: document.status === 'extracting' ? 'Document stored and indexed. Fable extraction is running.' :
      document.status === 'awaiting_configuration' ? 'Document stored and indexed. Configure the server-side Anthropic key, then retry extraction.' :
      document.status === 'needs_ocr' ? 'Document stored. OCR is required before source quotes can be verified.' :
      document.status === 'extraction_failed' ? 'The source is retained. Review the extraction error and retry explicitly.' :
      document.status === 'supporting_extracted' ? 'Supporting findings extracted; no existing lease terms were changed.' :
      document.status === 'extracted' ? 'Lease rows extracted and source quotes checked.' :
      document.status === 'document_review_required' ? 'The document needs review before a full lease row can be created.' :
      'Document is available in the library.' };
}
async function completeExtraction(id, result) {
  const existingIds = new Set(imports.map(row => row.id));
  const baseline = await readJson(path.join(PUBLIC, 'data/extraction.json'), { rows: [] });
  const baselineRows = Array.isArray(baseline) ? baseline : baseline.rows || [];
  for (const row of baselineRows) existingIds.add(row.id);
  const matching = imports.filter(row => row.documentId === id);
  if (matching.some(row => !result.rows.some(candidate => candidate.id === row.id))) {
    throw new ExtractionError('existing_rows', 'This document already has imported rows. Review them before running another extraction.', false);
  }
  const nextRows = result.rows.filter(row => !existingIds.has(row.id));
  for (let i = 0; i < nextRows.length; i++) {
    nextRows[i].cells.c01 = { value: baselineRows.length + imports.length + i + 1, status: 'derived', explanation: 'Assigned register row number; not a source-document fact.', evidence: [] };
  }
  const nextImports = [...imports, ...nextRows];
  await atomicJson(path.join(STORAGE, 'imported-rows.json'), nextImports); imports = nextImports;
  const previous = uploadMetadata.find(x => x.id === id);
  const status = result.kind === 'lease' ? 'extracted' : result.kind === 'supporting' ? 'supporting_extracted' : result.kind === 'unrelated' ? 'unrelated_document' : 'document_review_required';
  return updateUpload(id, { title: result.title, category: result.category, kind: result.kind === 'lease' ? 'lease' : 'supporting-document', status,
    analysis: result.analysis,
    extraction: { ...previous.extraction, provider: 'fable', model: FABLE_MODEL, completedAt: result.completedAt,
      elapsedMs: result.elapsedMs, usage: result.usage, inputMode: result.inputMode, requestId: result.requestId,
      rowIds: result.rows.map(row => row.id), validationIssues: result.validationIssues, error: null } }, 'extraction_completed');
}
async function runExtraction(id, guard = () => {}) {
  const started = Date.now();
  try {
    const document = await documentById(id);
    const columns = columnsFrom(await readJson(path.join(PUBLIC, 'data/columns.json'), []));
    const result = { ...await extractWithFable({ document, columns, pdfPath: path.join(UPLOADS, id, 'document.pdf'), beforeRequest: guard }),
      completedAt: new Date().toISOString(), elapsedMs: Date.now() - started };
    // Keep the validated result before importing rows so a restart can recover without another paid call.
    await atomicJson(path.join(UPLOADS, id, 'extraction-result.json'), result);
    await mutate(() => completeExtraction(id, result));
  } catch (error) {
    const safe = error instanceof ExtractionError ? error : error instanceof GmailError && error.code === 'connection_changed' ? new ExtractionError('email_import_cancelled', 'Gmail was disconnected before extraction started. The indexed source was retained; start extraction explicitly if needed.') : new ExtractionError('processing_error', 'Extraction could not be saved or processed. The indexed source was retained; retry explicitly after checking the local setup.');
    await mutate(async () => {
      const previous = uploadMetadata.find(x => x.id === id);
      await updateUpload(id, { status: 'extraction_failed', extraction: { ...previous.extraction,
        completedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
        error: { code: safe.code, message: safe.message, retryable: safe.retryable } } }, 'extraction_failed');
    });
  } finally { extractionJobs.delete(id); }
}
async function startExtraction(id, guard = () => {}) {
  const outcome = await mutate(async () => {
    guard();
    const document = await documentById(id);
    if (!document || !uploadMetadata.some(x => x.id === id)) fail(404, 'Only newly uploaded documents can be extracted with Fable.');
    if (document.status === 'extracting' || extractionJobs.has(id)) return { document: metadata(document), start: false };
    if (COMPLETED_EXTRACTIONS.has(document.status) || uploadedRows(id).length) fail(409, 'This document already has extraction results. Existing results will not be overwritten.');
    const previous = document.extraction || { provider: 'fable', model: FABLE_MODEL, attempts: 0 };
    const saved = await readJson(path.join(UPLOADS, id, 'extraction-result.json'), null);
    if (saved) return { document: await completeExtraction(id, saved), start: false };
    if (!providerInfo().upload.configured) {
      return { document: await updateUpload(id, { status: 'awaiting_configuration', extraction: { ...previous,
        error: { code: 'not_configured', message: 'Configure ANTHROPIC_API_KEY in the server-side .env file and restart the app, then retry extraction.', retryable: true } } }), start: false };
    }
    if (!document.pages?.some(p => normalize(p.text || ''))) {
      return { document: await updateUpload(id, { status: 'needs_ocr', extraction: { ...previous,
        error: { code: 'needs_ocr', message: 'No embedded text was found. OCR is required before source evidence can be verified.', retryable: false } } }), start: false };
    }
    return { document: await updateUpload(id, { status: 'extracting', extraction: { ...previous,
      attempts: (previous.attempts || 0) + 1, startedAt: new Date().toISOString(), completedAt: null, elapsedMs: null, error: null } }, 'extraction_started'), start: true };
  });
  if (outcome.start) {
    // Errors are reflected in document metadata; there are no background retries.
    const job = runExtraction(id, guard).catch(() => { console.error('Could not persist an extraction failure. The source file is retained.'); });
    extractionJobs.set(id, job);
  }
  return outcome.document;
}
async function recoverInterruptedExtractions() {
  for (const document of [...uploadMetadata]) {
    if (document.status !== 'extracting') continue;
    const saved = await readJson(path.join(UPLOADS, document.id, 'extraction-result.json'), null);
    if (saved) await completeExtraction(document.id, saved);
    else await updateUpload(document.id, { status: 'extraction_failed', extraction: { ...document.extraction,
      error: { code: 'interrupted', message: 'The app stopped during extraction. No automatic retry was made; retry explicitly if needed.', retryable: true } } });
  }
}
async function existingUploadForHash(sha256) {
  return uploadMetadata.find(d => d.sourceSha256 === sha256 || d.pdfSha256 === sha256) ||
    index.documents.find(d => d.sourceSha256 === sha256 || d.pdfSha256 === sha256);
}
async function storeUpload(input, bytes, extension, sha256, guard = () => {}) {
  guard();
  const duplicate = await existingUploadForHash(sha256);
  if (duplicate) return { ...extractionResponse(metadata(duplicate), true), rows: (await workspace()).rows.filter(row => row.documentId === duplicate.id) };
  const id = `upload-${randomUUID()}`; const folder = path.join(UPLOADS, id);
  await fs.mkdir(folder, { recursive: false });
  try {
    await fs.writeFile(path.join(folder, 'original' + extension), bytes, { mode: 0o600 });
    await runUploadHelper([folder, id, path.basename(input.name), extension]);
    const document = await readJson(path.join(folder, 'document.json'), null);
    if (!document) fail(422, 'Document index was not produced.');
    const meta = { ...metadata(document), sourceSha256: sha256, uploadedAt: new Date().toISOString() };
    guard();
    await mutate(async () => {
      guard();
      const nextUploads = [...uploadMetadata, meta];
      await atomicJson(path.join(STORAGE, 'uploads.json'), nextUploads); uploadMetadata = nextUploads;
      uploadCache.set(id, document);
      const next = structuredClone(state); next.audit.push({ id: randomUUID(), type: 'document_uploaded', documentId: id, at: meta.uploadedAt, name: meta.sourceFilename });
      await atomicJson(path.join(STORAGE, 'state.json'), next); state = next;
    });
    guard();
    return extractionResponse(await startExtraction(id, guard));
  } catch (error) { if (!uploadMetadata.some(x => x.id === id)) await fs.rm(folder, { recursive: true, force: true }); throw error; }
}

async function ingestBytes(input, bytes, extension, guard = () => {}) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (uploadInFlight.has(sha256)) { const same = await uploadInFlight.get(sha256); guard(); return { ...same, duplicate: true }; }
  guard();
  const operation = storeUpload(input, bytes, extension, sha256, guard);
  uploadInFlight.set(sha256, operation);
  try { return await operation; } finally { uploadInFlight.delete(sha256); }
}
function validateFileBytes(bytes, extension) {
  if (!['.pdf', '.docx'].includes(extension)) fail(415, 'Upload a PDF or DOCX file.');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) fail(413, 'File must be between 1 byte and 20 MB.');
  if (extension === '.pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail(400, 'File is not a PDF.');
  if (extension === '.docx' && !bytes.subarray(0, 2).equals(Buffer.from('PK'))) fail(400, 'File is not a DOCX archive.');
}
async function recordEmailProvenance(documentId, provenance, duplicate, guard) {
  await mutate(async () => {
    guard();
    const existing = emailProvenance[documentId] || [];
    if (existing.some(source => source.account === provenance.account && source.messageId === provenance.messageId && source.attachmentId === provenance.attachmentId)) return;
    const source = { ...provenance, importedAt: new Date().toISOString() };
    const nextProvenance = { ...emailProvenance, [documentId]: [...existing, source] };
    await atomicJson(path.join(STORAGE, 'email-provenance.json'), nextProvenance); emailProvenance = nextProvenance;
    const next = structuredClone(state);
    next.audit.push({ id: randomUUID(), type: 'email_attachment_imported', documentId, at: source.importedAt, source, duplicate });
    await atomicJson(path.join(STORAGE, 'state.json'), next); state = next;
  });
}
function oauthPage(res, status, heading, message) {
  const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Roll Model · Gmail</title><style>body{font:16px Helvetica,Arial,sans-serif;color:#30272a;max-width:560px;margin:14vh auto;padding:24px;line-height:1.6}h1{font-size:25px;color:#741f34}a{color:#741f34}</style></head><body><h1>${escape(heading)}</h1><p>${escape(message)}</p><p>You can close this tab and return to Roll Model.</p><a href="/">Open Roll Model</a></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(html);
}

function runUploadHelper(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(ROOT, 'upload_document.py'), ...args], { cwd: ROOT, env: { ...process.env, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Object.assign(new Error('Document processing exceeded three minutes.'), { status: 422 })); }, 180000);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-8000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code) reject(Object.assign(new Error(stderr.trim().split('\n').at(-1) || 'Document processing failed.'), { status: 422 }));
      else resolve(stdout);
    });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
async function serveFile(req, res, filepath, root) {
  const resolved = path.resolve(filepath);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) fail(403, 'Invalid asset path.');
  let stat;
  try { stat = await fs.stat(resolved); } catch (e) { if (e.code === 'ENOENT') fail(404, 'File not found.'); throw e; }
  if (!stat.isFile()) fail(404, 'File not found.');
  const real = await fs.realpath(resolved);
  if (!real.startsWith(path.resolve(root) + path.sep)) fail(403, 'Invalid asset path.');
  const headers = { 'Content-Type': MIME[path.extname(real)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Content-Length': stat.size };
  let start = 0, end = stat.size - 1, status = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!range) fail(416, 'Unsupported byte range.');
    start = Number(range[1]); end = range[2] ? Number(range[2]) : end;
    if (start > end || end >= stat.size) fail(416, 'Byte range is outside the file.');
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    status = 206;
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(real, { start, end }).on('error', () => res.destroy()).pipe(res);
}

await recoverInterruptedExtractions();

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { fail(400, 'The request path contains invalid URL encoding.'); }
    allowedRequest(req, pathname);
    if (req.method === 'GET' && pathname === '/api/email/status') return json(res, 200, gmail.status());
    if (req.method === 'POST' && pathname === '/api/email/config') {
      const input = await body(req, 256 * 1024);
      return json(res, 200, await gmail.configure(input.client ?? input.clientJson ?? input));
    }
    if (req.method === 'POST' && pathname === '/api/email/connect') {
      const input = await body(req);
      if (input.openBrowser !== undefined && typeof input.openBrowser !== 'boolean') fail(400, 'openBrowser must be boolean.');
      const { cookie, ...connection } = gmail.connect();
      res.setHeader('Set-Cookie', cookie);
      const browserOpened = input.openBrowser === true ? await openSystemBrowser(connection.connectUrl) : false;
      return json(res, 200, { ...connection, browserOpened });
    }
    if (req.method === 'GET' && pathname === '/api/email/authorize') {
      const handoff = gmail.authorize(url.searchParams.get('ticket'));
      res.writeHead(302, { Location: handoff.authUrl, 'Set-Cookie': handoff.cookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (req.method === 'GET' && pathname === '/api/email/callback') {
      try {
        const result = await gmail.callback(url.searchParams, req.headers.cookie || '');
        res.setHeader('Set-Cookie', result.cookie);
        return oauthPage(res, 200, 'Gmail connected', 'Roll Model can now list document attachments with read-only access. Choose an attachment in the Email tab to add it to the register.');
      } catch (error) {
        const safe = error instanceof GmailError ? error : new GmailError('connection_failed', 'Gmail sign-in could not be completed. Return to Roll Model and try again.', 502);
        return oauthPage(res, safe.status, 'Gmail was not connected', safe.message);
      }
    }
    if (req.method === 'POST' && pathname === '/api/email/disconnect') {
      const input = await body(req);
      if (input.revoke !== undefined && typeof input.revoke !== 'boolean') fail(400, 'revoke must be boolean.');
      return json(res, 200, await gmail.disconnect({ revoke: input.revoke !== false }));
    }
    if (req.method === 'GET' && pathname === '/api/email/messages') {
      return json(res, 200, await gmail.listMessages({ pageToken: url.searchParams.get('pageToken') || undefined }));
    }
    if (req.method === 'POST' && pathname === '/api/email/import') {
      const input = await body(req);
      if (typeof input.messageId !== 'string' || typeof input.attachmentId !== 'string') fail(400, 'Choose a Gmail message and attachment.');
      const connection = gmail.status();
      if (!connection.connected || typeof input.email !== 'string' || input.email.trim().toLowerCase() !== connection.email?.toLowerCase()
        || !Number.isSafeInteger(input.connectionRevision) || input.connectionRevision !== connection.connectionRevision) {
        throw new GmailError('connection_changed', 'The displayed Gmail account changed. Refresh the Email tab and select the attachment again.', 409, false);
      }
      const epoch = gmail.connectionEpoch();
      const guard = () => gmail.assertConnection(epoch);
      guard();
      const key = `${epoch}:${input.messageId}:${input.attachmentId}`;
      if (emailImportsInFlight.has(key)) return json(res, 200, { ...await emailImportsInFlight.get(key), duplicate: true });
      const operation = (async () => {
        const attachment = await gmail.attachment(input.messageId, input.attachmentId);
        guard();
        const extension = path.extname(attachment.filename).toLowerCase();
        validateFileBytes(attachment.bytes, extension);
        const result = await ingestBytes({ name: attachment.filename }, attachment.bytes, extension, guard);
        guard();
        await recordEmailProvenance(result.document.id, attachment.provenance, result.duplicate, guard);
        guard();
        await gmail.recordAdded(attachment.provenance, result.document.id);
        const currentDocument = metadata(await documentById(result.document.id));
        return { ...extractionResponse(currentDocument, result.duplicate), rows: result.duplicate ? (await workspace()).rows.filter(row => row.documentId === currentDocument.id) : uploadedRows(currentDocument.id), provenance: attachment.provenance };
      })();
      emailImportsInFlight.set(key, operation);
      try {
        const result = await operation;
        return json(res, result.duplicate ? 200 : result.status === 'extracting' ? 202 : 201, result);
      } finally { emailImportsInFlight.delete(key); }
    }
    if (req.method === 'GET' && pathname === '/api/workspace') return json(res, 200, await workspace());
    if (req.method === 'GET' && pathname.startsWith('/api/documents/')) {
      const id = pathname.slice('/api/documents/'.length);
      const document = await documentById(id);
      if (!document) fail(404, 'Document not found.');
      return json(res, 200, document);
    }
    if (req.method === 'POST' && pathname === '/api/cells') {
      const input = await body(req);
      const result = await mutate(async () => {
        const current = await workspace();
        if (!current.rows.some(x => x.id === input.rowId)) fail(404, 'Row not found.');
        if (!current.columns.some(x => x.id === input.columnId)) fail(400, 'Column not found.');
        if (input.reset !== undefined && typeof input.reset !== 'boolean') fail(400, 'Reset must be boolean.');
        if (input.reviewed !== undefined && typeof input.reviewed !== 'boolean') fail(400, 'Reviewed must be boolean.');
        if (Object.hasOwn(input, 'value')) checkValue(input.value);
        checkNote(input.note);
        if (!input.reset && !Object.hasOwn(input, 'value') && input.note === undefined && input.reviewed === undefined) fail(400, 'No cell change supplied.');
        const key = `${input.rowId}:${input.columnId}`;
        const next = structuredClone(state);
        const before = { override: state.overrides[key] || null, reviewed: state.reviews[key] || false };
        const updatedAt = new Date().toISOString();
        if (input.reset) { delete next.overrides[key]; delete next.reviews[key]; }
        else {
          if (Object.hasOwn(input, 'value') || input.note !== undefined) {
            const original = current.rows.find(x => x.id === input.rowId).cells[input.columnId].value;
            next.overrides[key] = { value: Object.hasOwn(input, 'value') ? input.value : Object.hasOwn(state.overrides, key) ? state.overrides[key].value : original,
              note: input.note ?? state.overrides[key]?.note ?? '', updatedAt };
          }
          if (input.reviewed !== undefined) next.reviews[key] = input.reviewed;
        }
        next.audit.push({ id: randomUUID(), type: input.reset ? 'cell_reset' : 'cell_update', rowId: input.rowId, columnId: input.columnId, at: updatedAt,
          before, after: { override: next.overrides[key] || null, reviewed: next.reviews[key] || false } });
        await atomicJson(path.join(STORAGE, 'state.json'), next); state = next;
        return state;
      });
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/upload') {
      const input = await body(req, 29 * 1024 * 1024);
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 240 || /[\u0000-\u001f]/.test(input.name)) fail(400, 'Supply a valid filename.');
      const extension = path.extname(input.name).toLowerCase();
      if (!['.pdf', '.docx'].includes(extension)) fail(415, 'Upload a PDF or DOCX file.');
      if (typeof input.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) fail(400, 'File content must be valid base64.');
      const bytes = Buffer.from(input.base64, 'base64');
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) fail(413, 'File must be between 1 byte and 20 MB.');
      if (extension === '.pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail(400, 'File is not a PDF.');
      if (extension === '.docx' && !bytes.subarray(0, 2).equals(Buffer.from('PK'))) fail(400, 'File is not a DOCX archive.');
      const result = await ingestBytes(input, bytes, extension);
      return json(res, result.duplicate ? 200 : result.status === 'extracting' ? 202 : 201, result);
    }
    const retryMatch = /^\/api\/documents\/(upload-[a-f0-9-]+)\/extract$/.exec(pathname);
    if (req.method === 'POST' && retryMatch) {
      await body(req);
      const document = await startExtraction(retryMatch[1]);
      return json(res, document.status === 'extracting' ? 202 : 200, extractionResponse(document));
    }
    if (req.method === 'POST' && pathname === '/api/import') {
      const input = await body(req);
      const result = await mutate(async () => {
        const accepted = await validateImport(input, await workspace());
        if (accepted.some(row => uploadMetadata.some(d => d.id === row.documentId && d.status === 'extracting'))) fail(409, 'Wait for active extraction to finish before importing rows for this document.');
        const nextImports = [...imports, ...accepted];
        await atomicJson(path.join(STORAGE, 'imported-rows.json'), nextImports); imports = nextImports;
        const importedIds = new Set(accepted.map(x => x.documentId));
        const nextUploads = uploadMetadata.map(x => importedIds.has(x.id) ? { ...x, status: 'extraction_imported' } : x);
        await atomicJson(path.join(STORAGE, 'uploads.json'), nextUploads); uploadMetadata = nextUploads;
        const next = structuredClone(state); next.audit.push({ id: randomUUID(), type: 'rows_imported', rowIds: accepted.map(x => x.id), at: new Date().toISOString() });
        await atomicJson(path.join(STORAGE, 'state.json'), next); state = next;
        return { imported: accepted.length, rows: accepted, state };
      });
      return json(res, 201, result);
    }
    if (req.method === 'GET' && pathname === '/api/export.xlsx') {
      const { exportWorkbook } = await import('./export.mjs');
      const exportPath = path.join(STORAGE, 'exports', `lease-review-${randomUUID()}.xlsx`);
      await exportWorkbook(await workspace(), exportPath);
      const bytes = await fs.readFile(exportPath);
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="roll-model.xlsx"', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      res.end(bytes);
      await fs.unlink(exportPath).catch(() => {});
      return;
    }
    if (pathname.startsWith('/api/')) fail(404, 'API route not found.');
    if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Method not allowed.');
    if (pathname.startsWith('/documents/uploads/')) {
      const match = /^\/documents\/uploads\/(upload-[a-f0-9-]+)\/(document\.pdf|original\.(pdf|docx))$/.exec(pathname);
      if (!match || !uploadMetadata.some(x => x.id === match[1])) fail(404, 'Uploaded asset not found.');
      return await serveFile(req, res, path.join(UPLOADS, match[1], match[2]), UPLOADS);
    }
    const asset = pathname === '/' ? '/index.html' : pathname;
    return await serveFile(req, res, path.join(PUBLIC, asset), PUBLIC);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    json(res, error.status || 500, { error: error.message || 'Unexpected server error.', ...(error instanceof GmailError ? { code: error.code, retryable: error.retryable } : {}) });
  }
});
server.listen(PORT, HOST, () => console.log(`Roll Model: http://${HOST}:${PORT}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
