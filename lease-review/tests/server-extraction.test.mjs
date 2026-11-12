import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { columns } = JSON.parse(await fs.readFile(path.join(ROOT, 'public/data/columns.json'), 'utf8'));
function pdf(label = 'A') {
  const content = `BT /F1 12 Tf 72 720 Td (LEASE of Unit 1. The tenant is Example Limited.) Tj 0 -20 Td (Annual rent is 12000. Source ${label}.) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
function output(kind = 'lease') {
  const cells = columns.map(c => ({ columnId: c.id, value: null, status: 'not_found', explanation: 'Not stated.', evidence: [] }));
  cells.find(c => c.columnId === 'c01').status = 'derived';
  Object.assign(cells.find(c => c.columnId === 'c35'), { value: 12000, status: 'extracted', evidence: [{ page: 1, quote: 'Annual rent is 12000.' }] });
  return { kind, title: 'Example lease', category: 'office', classificationExplanation: 'A source lease.', classificationEvidence: [{ page: 1, quote: 'LEASE of Unit 1.' }],
    leases: kind === 'lease' ? [{ title: 'Unit 1', category: 'office', cells }] : [], findings: kind === 'supporting' ? [cells.find(c => c.columnId === 'c35')] : [] };
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('upload jobs, SHA deduplication, explicit retries and restart recovery use only mocked Fable', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-backend-test-'));
  const storage = path.join(dir, 'storage'); const mockFile = path.join(dir, 'mock.json'); const countFile = path.join(dir, 'calls.json');
  const preload = path.join(dir, 'mock-fetch.mjs');
  await fs.writeFile(countFile, '0');
  await fs.writeFile(preload, `import fs from 'node:fs/promises';\nglobalThis.fetch = async (url, init) => {\n if (url !== 'https://api.anthropic.com/v1/messages') throw new Error('Unexpected external request');\n const config = JSON.parse(await fs.readFile(process.env.FOLIO_TEST_MOCK, 'utf8'));\n const countFile = process.env.FOLIO_TEST_COUNT;\n await fs.writeFile(countFile, String(Number(await fs.readFile(countFile, 'utf8')) + 1));\n if (config.delay) await new Promise(r => setTimeout(r, config.delay));\n return new Response(JSON.stringify(config.status ? {error:{message:'private upstream detail'}} : {stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(config.output)}],usage:{input_tokens:100,output_tokens:100}}), {status:config.status || 200});\n};\n`);
  let child, port;
  async function stop() { if (!child || child.exitCode !== null) return; const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; child = null; }
  async function start(config = { output: output(), delay: 150 }, key = 'test-only-key') {
    await fs.writeFile(mockFile, JSON.stringify(config)); port = await freePort();
    child = spawn(process.execPath, ['--import', preload, 'server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), LEASE_STORAGE_DIR: storage, ANTHROPIC_API_KEY: key, FOLIO_TEST_MOCK: mockFile, FOLIO_TEST_COUNT: countFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let messages = ''; child.stderr.on('data', d => { messages += d.toString(); });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Test server failed: ${messages}`);
      try { const response = await fetch(`http://127.0.0.1:${port}/api/workspace`); if (response.ok) return; } catch {}
      await delay(50);
    }
    throw new Error('Test server did not become ready.');
  }
  async function api(route, data) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  const upload = label => api('/api/upload', { name: `test-${label}.pdf`, base64: pdf(label).toString('base64') });
  const calls = async () => Number(await fs.readFile(countFile, 'utf8'));
  async function settled(id) {
    for (let i = 0; i < 100; i++) { const response = await api(`/api/documents/${id}`); if (response.data.status !== 'extracting') return response.data; await delay(50); }
    throw new Error('Extraction did not settle.');
  }
  t.after(async () => { await stop(); await fs.rm(dir, { recursive: true, force: true }); });
  await start();
  await t.test('concurrent duplicate uploads index once and make exactly one Fable call', async () => {
    const [a, b] = await Promise.all([upload('A'), upload('A')]);
    assert.ok(a.data.document, JSON.stringify(a)); assert.ok(b.data.document, JSON.stringify(b));
    assert.equal(a.data.document.id, b.data.document.id); assert.equal([a.data.duplicate, b.data.duplicate].filter(Boolean).length, 1);
    assert.ok([a.status, b.status].includes(202));
    const document = await settled(a.data.document.id);
    assert.equal(document.status, 'extracted'); assert.equal(document.extraction.attempts, 1); assert.ok(document.extraction.elapsedMs >= 0);
    assert.equal(await calls(), 1);
    const workspace = (await api('/api/workspace')).data;
    assert.equal(workspace.provider.id, 'astra'); assert.equal(workspace.provider.upload.configured, true);
    assert.equal(workspace.rows.filter(r => r.documentId === document.id).length, 1);
    const again = await upload('A'); assert.equal(again.data.duplicate, true); assert.equal(again.data.rows.length, 1); assert.equal(await calls(), 1);
    const retry = await api(`/api/documents/${document.id}/extract`, {}); assert.equal(retry.status, 409); assert.equal(await calls(), 1);
  });
  await t.test('provider failure retains source and only an explicit retry starts another call', async () => {
    await fs.writeFile(mockFile, JSON.stringify({ status: 429 }));
    const uploaded = await upload('B'); const id = uploaded.data.document.id;
    const failed = await settled(id); assert.equal(failed.status, 'extraction_failed'); assert.equal(failed.extraction.error.code, 'rate_limited');
    assert.ok(!JSON.stringify(failed).includes('private upstream detail'));
    assert.ok((await fs.stat(path.join(storage, 'uploads', id, 'document.pdf'))).size > 0);
    assert.equal(await calls(), 2);
    const repeated = await upload('B'); assert.equal(repeated.data.duplicate, true); assert.equal(repeated.data.status, 'extraction_failed'); assert.equal(await calls(), 2);
    await fs.writeFile(mockFile, JSON.stringify({ output: output('supporting') }));
    assert.equal((await api(`/api/documents/${id}/extract`, {})).status, 202);
    const complete = await settled(id); assert.equal(complete.status, 'supporting_extracted'); assert.equal(complete.extraction.attempts, 2); assert.equal(complete.analysis.findings[0].value, 12000);
    assert.equal((await api('/api/workspace')).data.rows.filter(row => row.documentId === id).length, 0); assert.equal(await calls(), 3);
  });
  await t.test('an interrupted attempt is not silently repeated after server restart', async () => {
    await fs.writeFile(mockFile, JSON.stringify({ output: output(), delay: 10000 }));
    const uploadResult = await upload('C'); const id = uploadResult.data.document.id;
    for (let i = 0; i < 50 && await calls() < 4; i++) await delay(20);
    assert.equal(await calls(), 4); await stop(); await start({ output: output() });
    const document = (await api(`/api/documents/${id}`)).data;
    assert.equal(document.status, 'extraction_failed'); assert.equal(document.extraction.error.code, 'interrupted'); assert.equal(await calls(), 4);
    await api(`/api/documents/${id}/extract`, {}); assert.equal((await settled(id)).status, 'extracted'); assert.equal(await calls(), 5);
  });
  await t.test('missing configuration stores the source without starting extraction', async () => {
    await stop(); await start({ output: output() }, '');
    const uploaded = await upload('D'); assert.equal(uploaded.status, 201); assert.equal(uploaded.data.status, 'awaiting_configuration');
    assert.equal((await api('/api/workspace')).data.provider.upload.configured, false); assert.equal(await calls(), 5);
  });
});
