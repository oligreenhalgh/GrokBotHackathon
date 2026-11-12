import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { validateExtraction, verifyEvidence, extractWithFable, extractionSchema, FABLE_MODEL } from '../fable-extractor.mjs';

const { columns } = JSON.parse(await fs.readFile(new URL('../public/data/columns.json', import.meta.url), 'utf8'));
const source = { id: 'upload-test', title: 'Test lease', sourceFilename: 'test.pdf', pageCount: 3,
  pages: [{ page: 1, text: 'LEASE of Unit 1. The tenant is Example Limited. Annual rent is £12,000. The term begins 1 January 2026.' },
    { page: 2, text: 'Rent is paid monthly in advance. Shared boilerplate.' },
    { page: 3, text: 'Shared boilerplate. Service charge is £0.' }] };
function fullLease() {
  const cells = columns.map(c => ({ columnId: c.id, value: null, status: 'not_found', explanation: 'Not stated in this source.', evidence: [] }));
  const set = (id, cell) => Object.assign(cells.find(c => c.columnId === id), cell);
  set('c01', { status: 'derived', explanation: 'Assigned by app.' });
  set('c14', { value: 'Example Limited', status: 'extracted', evidence: [{ page: 1, quote: 'The tenant is Example Limited.' }] });
  set('c35', { value: 12000, status: 'extracted', evidence: [{ page: 1, quote: 'Annual rent is £12,000.' }] });
  set('c19', { value: '2026-01-01', status: 'extracted', evidence: [{ page: 1, quote: 'The term begins 1 January 2026.' }] });
  set('c45', { value: 0, status: 'extracted', evidence: [{ page: 3, quote: 'Service charge is £0.' }] });
  return { kind: 'lease', title: 'Unit 1', category: 'office', classificationExplanation: 'This document is a full lease.', classificationEvidence: [{ page: 1, quote: 'LEASE of Unit 1.' }], leases: [{ title: 'Unit 1', category: 'office', cells }], findings: [] };
}
const cell = (raw, id) => raw.leases[0].cells.find(c => c.columnId === id);

test('all 56 fields, exact evidence, zero and unknown values survive validation', () => {
  const result = validateExtraction(fullLease(), source, columns);
  assert.equal(result.rows.length, 1);
  assert.equal(Object.keys(result.rows[0].cells).length, 56);
  assert.equal(result.rows[0].cells.c35.value, 12000);
  assert.equal(result.rows[0].cells.c45.value, 0);
  assert.equal(result.rows[0].cells.c07.value, null);
  assert.equal(result.rows[0].cells.c19.value, '2026-01-01');
  assert.equal(result.rows[0].cells.c14.evidence[0].documentId, source.id);
});
test('wrong page is corrected only by one unique exact quote match', () => {
  const raw = fullLease(); cell(raw, 'c14').evidence[0].page = 22;
  const result = validateExtraction(raw, source, columns);
  assert.equal(result.rows[0].cells.c14.evidence[0].page, 1);
  assert.equal(result.rows[0].cells.c14.status, 'extracted');
  assert.ok(result.validationIssues.some(x => x.code === 'page_corrected'));
});
test('ambiguous or invented quotes never become supporting evidence', () => {
  const issues = [];
  assert.deepEqual(verifyEvidence([{ page: 99, quote: 'Shared boilerplate.' }, { page: 1, quote: 'Annual rent is £999,999.' }], source, issues), []);
  assert.deepEqual(issues.map(i => i.code), ['ambiguous_quote', 'unsupported_quote']);
  const raw = fullLease(); cell(raw, 'c14').evidence[0].quote = 'Tenant is Invented LLC.';
  const checked = validateExtraction(raw, source, columns).rows[0].cells.c14;
  assert.equal(checked.value, null); assert.equal(checked.status, 'needs_review'); assert.deepEqual(checked.evidence, []);
});
test('one invalid reference downgrades a claim even when another quote is valid', () => {
  const raw = fullLease(); cell(raw, 'c14').evidence.push({ page: 1, quote: 'Not in source.' });
  assert.equal(validateExtraction(raw, source, columns).rows[0].cells.c14.status, 'needs_review');
});
test('missing/duplicate/unknown columns reject the result rather than create partial rows', () => {
  for (const alter of [r => r.leases[0].cells.pop(), r => { r.leases[0].cells[2].columnId = 'c02'; }, r => { r.leases[0].cells[2].columnId = 'c57'; }]) {
    const raw = fullLease(); alter(raw); assert.throws(() => validateExtraction(raw, source, columns), /56|column/i);
  }
});
test('numeric and date types are normalized conservatively; zero is never replaced by blank', () => {
  const raw = fullLease(); cell(raw, 'c35').value = '£12,000'; cell(raw, 'c19').value = '2026-02-30';
  const checked = validateExtraction(raw, source, columns).rows[0].cells;
  assert.equal(checked.c35.value, 12000); assert.equal(checked.c45.value, 0);
  assert.equal(checked.c19.value, null); assert.equal(checked.c19.status, 'needs_review');
  const raw2 = fullLease(); cell(raw2, 'c35').value = 'quarterly £3,000';
  assert.equal(validateExtraction(raw2, source, columns).rows[0].cells.c35.value, null);
});
test('placeholder and optional numeric/date fields do not become actual values', () => {
  const raw = fullLease(); cell(raw, 'c35').status = 'optional'; cell(raw, 'c19').status = 'placeholder';
  const checked = validateExtraction(raw, source, columns).rows[0].cells;
  assert.equal(checked.c35.value, null); assert.equal(checked.c19.value, null);
});
test('unsupported classification creates no register row', () => {
  const raw = fullLease(); raw.classificationEvidence[0].quote = 'COMPLETE EXECUTED LEASE';
  const result = validateExtraction(raw, source, columns);
  assert.equal(result.kind, 'uncertain'); assert.deepEqual(result.rows, []);
});
test('supporting documents retain verified findings but never create or overwrite lease rows', () => {
  const raw = fullLease(); raw.kind = 'supporting'; raw.findings = [cell(raw, 'c35')]; raw.leases = [];
  const result = validateExtraction(raw, source, columns);
  assert.deepEqual(result.rows, []); assert.equal(result.analysis.findings[0].value, 12000);
  assert.equal(result.analysis.association, null);
  const invalid = fullLease(); invalid.kind = 'supporting'; assert.throws(() => validateExtraction(invalid, source, columns), /standalone/);
});
test('schema uses a repeated array cell with fixed IDs, not 56 nullable unions', () => {
  const schema = extractionSchema(columns);
  assert.equal(schema.additionalProperties, false);
  const fields = schema.properties.leases.items.properties.cells.items;
  assert.deepEqual(fields.properties.columnId.enum, columns.map(c => c.id));
  assert.equal((JSON.stringify(schema).match(/"type":\[/g) || []).length, 2);
});
test('single mock API call uses low-effort Fable and validates its response', async () => {
  let calls = 0;
  const result = await extractWithFable({ document: source, columns, apiKey: 'test-only', fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const request = JSON.parse(init.body);
    assert.equal(request.model, FABLE_MODEL); assert.equal(request.output_config.effort, 'low');
    assert.equal(request.thinking.type, 'adaptive'); assert.equal(request.output_config.format.type, 'json_schema');
    assert.ok(!request.messages[0].content.some(c => c.citations));
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fullLease()) }], usage: { input_tokens: 500, output_tokens: 200 } }), { headers: { 'request-id': 'test-request' } });
  } });
  assert.equal(calls, 1); assert.equal(result.rows.length, 1); assert.equal(result.usage.output_tokens, 200);
});
test('provider errors, malformed output and truncated output never retry automatically or expose response secrets', async () => {
  for (const response of [new Response('secret-provider-message', { status: 401 }), new Response('not-json'), new Response(JSON.stringify({ stop_reason: 'max_tokens', content: [] }))]) {
    let calls = 0;
    await assert.rejects(extractWithFable({ document: source, columns, apiKey: 'test-only', fetchImpl: async () => { calls++; return response; } }), error => !error.message.includes('secret-provider-message'));
    assert.equal(calls, 1);
  }
});
test('no key, no text or oversized input prevents a paid API call', async () => {
  for (const input of [{ document: source, apiKey: '' }, { document: { ...source, pages: [{ page: 1, text: '' }] }, apiKey: 'test-only' }, { document: { ...source, pages: [{ page: 1, text: 'x'.repeat(600001) }] }, apiKey: 'test-only' }]) {
    let calls = 0;
    await assert.rejects(extractWithFable({ ...input, columns, fetchImpl: async () => { calls++; throw new Error(); } }));
    assert.equal(calls, 0);
  }
});

test('a valid quote cannot justify a different numeric value or a different date', () => {
  const raw = fullLease(); cell(raw, 'c35').value = 999999; cell(raw, 'c19').value = '2027-01-01';
  const result = validateExtraction(raw, source, columns).rows[0].cells;
  assert.equal(result.c35.value, null); assert.equal(result.c35.status, 'needs_review');
  assert.equal(result.c19.value, null); assert.equal(result.c19.status, 'needs_review');
});
test('duplicate verified evidence is deduplicated without downgrading the supported claim', () => {
  const raw = fullLease(); cell(raw, 'c14').evidence.push({ ...cell(raw, 'c14').evidence[0] });
  raw.classificationEvidence.push({ ...raw.classificationEvidence[0] });
  const result = validateExtraction(raw, source, columns);
  assert.equal(result.kind, 'lease'); assert.equal(result.rows[0].cells.c14.status, 'extracted');
  assert.equal(result.rows[0].cells.c14.evidence.length, 1);
});
