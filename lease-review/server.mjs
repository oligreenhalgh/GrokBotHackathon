import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const STORAGE = process.env.LEASE_STORAGE_DIR ? path.resolve(process.env.LEASE_STORAGE_DIR) : path.join(ROOT, 'storage');
const UPLOADS = path.join(STORAGE, 'uploads');
const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';
const VENV_PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const PYTHON = process.env.LEASE_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : process.platform === 'win32' ? 'python' : 'python3');
const STATUSES = new Set(['extracted', 'placeholder', 'optional', 'not_found', 'derived', 'needs_review', 'not_applicable']);
const provider = { id: 'prepared', label: 'Prepared extraction', live: false };
await fs.mkdir(UPLOADS, { recursive: true });
let index = await readJson(path.join(PUBLIC, 'data/document-index.json'), { documents: [] });
let uploadMetadata = await readJson(path.join(STORAGE, 'uploads.json'), []);
let state = await readJson(path.join(STORAGE, 'state.json'), { reviews: {}, overrides: {}, audit: [] });
let imports = await readJson(path.join(STORAGE, 'imported-rows.json'), []);
let mutationQueue = Promise.resolve();
const uploadCache = new Map();

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
function metadata(document) { const { pages, ...meta } = document; return meta; }
function columnsFrom(data) { return Array.isArray(data) ? data : data.columns || []; }
async function workspace() {
  const columns = columnsFrom(await readJson(path.join(PUBLIC, 'data/columns.json'), []));
  const extraction = await readJson(path.join(PUBLIC, 'data/extraction.json'), { rows: [] });
  const rows = [...(Array.isArray(extraction) ? extraction : extraction.rows || []), ...imports];
  return { columns, rows, documents: [...index.documents.map(metadata), ...uploadMetadata], state, provider };
}
async function documentById(id) {
  const prepared = index.documents.find(x => x.id === id);
  if (prepared) return prepared;
  const meta = uploadMetadata.find(x => x.id === id);
  if (!meta) return null;
  if (!uploadCache.has(id)) uploadCache.set(id, await readJson(path.join(UPLOADS, id, 'document.json'), null));
  return { ...uploadCache.get(id), ...meta };
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
function allowedRequest(req) {
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (!hosts.has(req.headers.host)) fail(403, 'This app accepts requests to its local address only.');
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

function runUploadHelper(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(ROOT, 'upload_document.py'), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    allowedRequest(req);
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { fail(400, 'The request path contains invalid URL encoding.'); }
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
      const id = `upload-${randomUUID()}`; const folder = path.join(UPLOADS, id);
      await fs.mkdir(folder, { recursive: false });
      try {
        await fs.writeFile(path.join(folder, 'original' + extension), bytes, { mode: 0o600 });
        await runUploadHelper([folder, id, path.basename(input.name), extension]);
        const document = await readJson(path.join(folder, 'document.json'), null);
        if (!document) fail(422, 'Document index was not produced.');
        const meta = { ...metadata(document), uploadedAt: new Date().toISOString() };
        await mutate(async () => {
          const nextUploads = [...uploadMetadata, meta];
          await atomicJson(path.join(STORAGE, 'uploads.json'), nextUploads); uploadMetadata = nextUploads;
          uploadCache.set(id, document);
          const next = structuredClone(state); next.audit.push({ id: randomUUID(), type: 'document_uploaded', documentId: id, at: meta.uploadedAt, name: meta.sourceFilename });
          await atomicJson(path.join(STORAGE, 'state.json'), next); state = next;
        });
        return json(res, 201, { document: meta, status: 'awaiting_extraction', message: 'Document stored and indexed. No AI extraction has run. Import structured results to add a row.' });
      } catch (error) { if (!uploadMetadata.some(x => x.id === id)) await fs.rm(folder, { recursive: true, force: true }); throw error; }
    }
    if (req.method === 'POST' && pathname === '/api/import') {
      const input = await body(req);
      const result = await mutate(async () => {
        const accepted = await validateImport(input, await workspace());
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
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="lease-review.xlsx"', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
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
    json(res, error.status || 500, { error: error.message || 'Unexpected server error.' });
  }
});
server.listen(PORT, HOST, () => console.log(`Lease review: http://${HOST}:${PORT}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
