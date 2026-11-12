import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function pdf() {
  const text = 'BT /F1 12 Tf 72 720 Td (LEASE of Unit 1. Annual rent is 12000.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(result);
  return Buffer.from(result + `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
}

test('Gmail HTTP routes enforce browser-bound OAuth, import one selected attachment with provenance, and deduplicate Fable calls', { timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-model-gmail-http-'));
  const storage = path.join(dir, 'storage'), preload = path.join(dir, 'mock.mjs'), counter = path.join(dir, 'calls.json'), fixture = path.join(dir, 'fixture.json');
  const { columns } = JSON.parse(await fs.readFile(path.join(ROOT,'public/data/columns.json'), 'utf8'));
  const cells = columns.map(c => ({ columnId:c.id,value:null,status:c.id==='c01'?'derived':'not_found',explanation:'Not stated.',evidence:[] }));
  const bytes = pdf();
  await fs.writeFile(counter, JSON.stringify({ attachments:0, fable:0 }));
  await fs.writeFile(fixture, JSON.stringify({ bytes:bytes.toString('base64url'), size:bytes.length, delay:0, output:{kind:'lease',title:'Unit 1',category:'office',classificationExplanation:'Full lease.',classificationEvidence:[{page:1,quote:'LEASE of Unit 1.'}],leases:[{title:'Unit 1',category:'office',cells}],findings:[]} }));
  await fs.writeFile(preload, `import fs from 'node:fs/promises';
const fixture=process.env.GMAIL_TEST_FIXTURE, counter=process.env.GMAIL_TEST_COUNTER;
const reply=data=>new Response(JSON.stringify(data));
globalThis.fetch=async(url,options={})=>{
 const f=JSON.parse(await fs.readFile(fixture,'utf8'));
 const count=async key=>{const c=JSON.parse(await fs.readFile(counter,'utf8'));c[key]++;await fs.writeFile(counter,JSON.stringify(c));};
 if(url==='https://oauth2.googleapis.com/token')return reply({access_token:'MOCK_ACCESS',refresh_token:'MOCK_REFRESH',expires_in:3600,token_type:'Bearer',scope:'https://www.googleapis.com/auth/gmail.readonly'});
 if(url==='https://oauth2.googleapis.com/revoke')return new Response('');
 if(String(url).includes('/profile?'))return reply({emailAddress:'reader@example.com'});
 if(String(url).includes('/attachments/')){await count('attachments');if(f.delay)await new Promise(r=>setTimeout(r,f.delay));return reply({data:f.bytes,size:f.size});}
 if(String(url).includes('/messages/abc123?'))return reply({id:'abc123',threadId:'thread123',internalDate:'1794441600000',payload:{headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:'Lease attachment'}],parts:[{partId:'1',filename:'lease.pdf',mimeType:'application/pdf',body:{attachmentId:'att123',size:f.size}}]}});
 if(String(url).includes('/messages?'))return reply({messages:[{id:'abc123',threadId:'thread123'}],resultSizeEstimate:1});
 if(url==='https://api.anthropic.com/v1/messages'){await count('fable');return reply({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(f.output)}],usage:{input_tokens:1,output_tokens:1}});}
 throw new Error('Unexpected network request blocked by test');
};`);
  const listener = net.createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening'); const port = listener.address().port; await new Promise(resolve=>listener.close(resolve));
  const child = spawn(process.execPath,['--import',preload,'server.mjs'],{cwd:ROOT,env:{...process.env,PORT:String(port),LEASE_STORAGE_DIR:storage,ANTHROPIC_API_KEY:'test-only',GMAIL_TEST_FIXTURE:fixture,GMAIL_TEST_COUNTER:counter},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await fs.rm(dir,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${port}`;
  async function api(route,data,extra={}) {const response=await fetch(origin+route,{...(data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),...extra});return {response,data:await response.json()};}
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(stderr);try{if((await fetch(origin+'/api/email/status')).ok)break;}catch{}await delay(30);}
  const initial=await api('/api/email/status');assert.equal(initial.data.configured,false);assert.equal(initial.data.connected,false);
  const config=await api('/api/email/config',{client:{installed:{client_id:'test.apps.googleusercontent.com',client_secret:'MOCK_CLIENT_SECRET'}}});assert.equal(config.response.status,200);assert.ok(!JSON.stringify(config.data).includes('MOCK_CLIENT_SECRET'));
  const forbidden=await api('/api/email/connect',{}, {headers:{'content-type':'application/json',origin:'https://attacker.example','sec-fetch-site':'cross-site'}});assert.equal(forbidden.response.status,403);
  const connection=await api('/api/email/connect',{openBrowser:false});assert.equal(connection.data.browserOpened,false);
  const handoff=await fetch(connection.data.connectUrl,{redirect:'manual'});assert.equal(handoff.status,302);assert.equal(new URL(handoff.headers.get('location')).origin,'https://accounts.google.com');
  const cookie=handoff.headers.get('set-cookie').split(';')[0];const state=new URL(connection.data.authUrl).searchParams.get('state');
  const wrong=await fetch(origin+`/api/email/callback?state=${state}&code=MOCK_CODE`,{headers:{'sec-fetch-site':'cross-site',cookie:'folio_gmail_oauth=wrong'}});assert.equal(wrong.status,400);
  const callback=await fetch(origin+`/api/email/callback?state=${state}&code=MOCK_CODE`,{headers:{'sec-fetch-site':'cross-site',cookie}});assert.equal(callback.status,200);assert.ok((await callback.text()).includes('Gmail connected'));
  const status=await api('/api/email/status');assert.equal(status.data.connected,true);assert.equal(status.data.email,'reader@example.com');assert.ok(!JSON.stringify(status.data).includes('MOCK_ACCESS'));
  const listed=await api('/api/email/messages');assert.equal(listed.data.messages[0].attachments[0].added,false);assert.equal(JSON.parse(await fs.readFile(counter,'utf8')).attachments,0);
  const selection={messageId:'abc123',attachmentId:'att123',email:status.data.email.toUpperCase(),connectionRevision:status.data.connectionRevision};
  assert.equal(listed.data.connectionRevision,status.data.connectionRevision);assert.equal(listed.data.email,status.data.email);
  for(const stale of [{messageId:'abc123',attachmentId:'att123'},{...selection,email:'other@example.com'},{...selection,connectionRevision:selection.connectionRevision-1}]) {
    const rejected=await api('/api/email/import',stale);assert.equal(rejected.response.status,409);assert.equal(rejected.data.code,'connection_changed');
  }
  assert.equal(JSON.parse(await fs.readFile(counter,'utf8')).attachments,0);
  const imported=await api('/api/email/import',selection);assert.ok(imported.data.document,JSON.stringify(imported.data));const id=imported.data.document.id;
  for(let i=0;i<100;i++){const doc=await api('/api/documents/'+id);if(doc.data.status!=='extracting')break;await delay(25);}
  const workspace=(await api('/api/workspace')).data;assert.equal(workspace.documents.find(d=>d.id===id).emailSources[0].messageId,'abc123');assert.ok(workspace.state.audit.some(event=>event.type==='email_attachment_imported'&&event.documentId===id));
  const again=await api('/api/email/import',selection);assert.equal(again.data.duplicate,true);assert.equal(again.data.document.id,id);assert.equal(JSON.parse(await fs.readFile(counter,'utf8')).fable,1);
  const added=await api('/api/email/messages');assert.equal(added.data.messages[0].attachments[0].added,true);assert.equal(added.data.messages[0].attachments[0].documentId,id);
  const current=JSON.parse(await fs.readFile(fixture,'utf8'));current.delay=1000;await fs.writeFile(fixture,JSON.stringify(current));
  const pending=api('/api/email/import',selection);for(let i=0;i<100;i++){if(JSON.parse(await fs.readFile(counter,'utf8')).attachments>=3)break;await delay(10);}
  const disconnected=await api('/api/email/disconnect',{revoke:false});assert.equal(disconnected.data.connected,false);assert.equal(disconnected.data.localTokensRemoved,true);
  const cancelled=await pending;assert.equal(cancelled.response.status,409);assert.equal(cancelled.data.code,'connection_changed');assert.equal(JSON.parse(await fs.readFile(counter,'utf8')).fable,1);
});
