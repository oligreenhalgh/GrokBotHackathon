import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let moduleCounter = 0;
const connected = {connected:true,configured:true,email:'reviewer@example.test',connectionRevision:1};
const disconnected = {connected:false,configured:true,connectionRevision:1};
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const message = (id='message-1') => ({id,subject:'Lease documents',from:'Agent <agent@example.test>',date:'2026-11-12T12:00:00Z',body:'PRIVATE MESSAGE BODY',snippet:'PRIVATE MESSAGE SNIPPET',attachments:[{id:'attachment-1',filename:'lease.pdf',size:1200,eligible:true},{id:'attachment-2',filename:'deposit.docx',size:2400,eligible:true}]});
const listing = (messages,account=connected) => ({messages,email:account.email,connectionRevision:account.connectionRevision,nextPageToken:null,checkedAt:'2026-11-12T12:00:00Z'});

async function harness(t, handler) {
  const dom = new JSDOM('<!doctype html><body></body>', {url:'http://localhost:4317/'});
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});
  const jobs = new Map();
  let nextJob=1;
  t.mock.method(globalThis,'setTimeout',(fn,delay)=>{const id=nextJob++;jobs.set(id,{fn,delay});return id;});
  t.mock.method(globalThis,'clearTimeout',id=>jobs.delete(id));
  t.mock.method(globalThis,'fetch',()=>{throw new Error('Email UI tests must not access the network');});
  t.after(()=>{dom.window.close();if(previousDocument)Object.defineProperty(globalThis,'document',previousDocument);else delete globalThis.document;});
  const calls=[];
  const state={refreshes:0,watches:0,toasts:[]};
  const context={
    api:async(url,options)=>{calls.push({url,options});return handler(url,options,calls);},
    refresh:async()=>{state.refreshes++;},
    render:()=>{throw new Error('Email UI must not trigger an unrelated app render');},
    toast:value=>state.toasts.push(value),
    watchExtractions:()=>{state.watches++;},
  };
  const {renderEmailView}=await import(`../public/email-tab.js?test=${++moduleCounter}`);
  const makeHost=()=>{const host=dom.window.document.createElement('main');dom.window.document.body.append(host);return host;};
  return {
    dom,calls,state,context,makeHost,render:host=>renderEmailView(host,context),
    count:url=>calls.filter(c=>c.url===url).length,
    timers:delay=>[...jobs.values()].filter(j=>j.delay===delay).length,
    fire:delay=>{const entry=[...jobs].find(([,j])=>j.delay===delay);assert.ok(entry,`Expected a ${delay}ms timer`);jobs.delete(entry[0]);return entry[1].fn();},
  };
}

test('setup and connected views request only the appropriate metadata endpoints', async t => {
  let status={connected:false,configured:false};
  const h=await harness(t,url=>url==='/api/email/status'?status:listing([message()]));
  const first=h.makeHost();await h.render(first);
  assert.ok(first.querySelector('#gmail-client-file'));
  assert.equal(first.querySelector('#gmail-connect'),null);
  assert.deepEqual(h.calls.map(c=>c.url),['/api/email/status']);
  first.remove();status={...connected};
  const second=h.makeHost();await h.render(second);
  assert.equal(second.querySelector('#gmail-client-file'),null);
  assert.equal(second.querySelector('.email-account').textContent,connected.email);
  assert.equal(second.querySelectorAll('[data-email-import]').length,2);
  assert.equal(h.count('/api/email/messages'),1);
  assert.equal(h.count('/api/email/import'),0);
  assert.ok(h.calls.every(c=>!c.options));
  assert.ok(!second.textContent.includes('PRIVATE MESSAGE'));
});

test('email metadata and identifiers are escaped in visible text and attributes', async t => {
  const attack='<img src=x onerror="alert(1)">';
  const m=message('message-" onmouseover="alert(1)');
  m.subject=attack;m.from='<script>alert(2)</script>';
  m.attachments[0].id='attachment-" onclick="alert(3)';
  m.attachments[0].filename=attack+'.pdf';
  m.attachments[1].eligible=false;m.attachments[1].reason=attack;
  const account={...connected,email:attack};
  const h=await harness(t,url=>url==='/api/email/status'?account:listing([m],account));
  const host=h.makeHost();await h.render(host);
  assert.equal(host.querySelector('img,script,iframe'),null);
  assert.equal(host.querySelector('.email-account').textContent,attack);
  assert.equal(host.querySelector('.email-message h2').textContent,attack);
  assert.equal(host.querySelector('.email-file strong').textContent,attack+'.pdf');
  assert.equal(host.querySelector('[data-email-import]').dataset.emailImport,`${m.id}:${m.attachments[0].id}`);
  for(const element of host.querySelectorAll('*')) for(const attribute of element.attributes) assert.ok(!attribute.name.startsWith('on'));
  assert.equal(host.querySelectorAll('[data-email-import]')[1].disabled,true);
});

test('only the explicitly selected attachment is imported, once while pending, with IDs and displayed account identity only', async t => {
  const pending=deferred();
  const h=await harness(t,(url,options)=>{
    if(url==='/api/email/status')return {...connected};
    if(url==='/api/email/messages')return listing([message()]);
    if(url==='/api/email/import')return pending.promise;
    throw new Error(`Unexpected API request: ${url}`);
  });
  const host=h.makeHost();await h.render(host);
  assert.equal(h.count('/api/email/import'),0);
  const button=host.querySelectorAll('[data-email-import]')[1];
  button.click();button.click();await flush();
  assert.equal(h.count('/api/email/import'),1);
  const request=h.calls.find(c=>c.url==='/api/email/import');
  assert.equal(request.options.method,'POST');
  assert.deepEqual(JSON.parse(request.options.body),{messageId:'message-1',attachmentId:'attachment-2',email:connected.email,connectionRevision:connected.connectionRevision});
  assert.ok(!JSON.stringify(request).includes('PRIVATE MESSAGE'));
  assert.equal(host.querySelectorAll('[data-email-import]')[1].disabled,true);
  pending.resolve({status:'extracting',document:{id:'uploaded-lease'}});await flush();
  assert.equal(host.querySelectorAll('.email-added').length,1);
  assert.equal(host.querySelectorAll('[data-email-import]').length,1);
  assert.equal(h.state.refreshes,1);assert.equal(h.state.watches,1);
});

test('a duplicate import is marked added and links to the existing document', async t => {
  const h=await harness(t,url=>{
    if(url==='/api/email/status')return {...connected};
    if(url==='/api/email/messages')return listing([message()]);
    if(url==='/api/email/import')return {duplicate:true,document:{id:'existing-document'}};
    throw new Error(`Unexpected API request: ${url}`);
  });
  const host=h.makeHost();await h.render(host);
  host.querySelector('[data-email-import]').click();await flush();
  assert.match(host.querySelector('.email-notice').textContent,/already in the library/);
  assert.equal(host.querySelectorAll('.email-added').length,1);
  assert.equal(host.querySelector('.email-attachment a').getAttribute('href'),'/viewer.html?document=existing-document&page=1');
  assert.deepEqual(h.state.toasts,['Document already in library']);
  assert.equal(h.count('/api/email/import'),1);
});

test('a late status response from a removed host cannot disable the new host polling', async t => {
  const oldStatus=deferred();let statusCalls=0;
  const h=await harness(t,url=>{
    if(url==='/api/email/status')return ++statusCalls===1?oldStatus.promise:{...connected};
    if(url==='/api/email/messages')return listing([message()]);
    throw new Error(`Unexpected API request: ${url}`);
  });
  const first=h.makeHost(),firstRender=h.render(first);await flush();first.remove();
  const second=h.makeHost();await h.render(second);
  oldStatus.resolve({...disconnected});await firstRender;
  await h.fire(60000);
  assert.equal(h.count('/api/email/messages'),2,'The active connected tab should still poll after the stale status response');
  assert.equal(second.querySelector('.email-account').textContent,connected.email);
});

test('a late list response cannot clear the active host loading guard or replace its messages', async t => {
  const oldList=deferred(),currentList=deferred();let lists=0;
  const h=await harness(t,url=>{
    if(url==='/api/email/status')return {...connected};
    if(url==='/api/email/messages'){lists++;return lists===1?oldList.promise:lists===2?currentList.promise:listing([message('unwanted-third-request')]);}
    throw new Error(`Unexpected API request: ${url}`);
  });
  const first=h.makeHost(),firstRender=h.render(first);await flush();first.remove();
  const second=h.makeHost(),secondRender=h.render(second);await flush();
  oldList.resolve(listing([message('stale-message')]));await firstRender;
  second.querySelector('#gmail-refresh').click();await flush();
  const requestCount=h.count('/api/email/messages');
  currentList.resolve(listing([message('current-message')]));await secondRender;
  assert.equal(requestCount,2,'Only the original and active list requests should exist while the active request is pending');
  assert.match(second.querySelector('[data-email-import]').dataset.emailImport,/^current-message:/);
  assert.ok(!second.innerHTML.includes('stale-message'));
});

test('a late OAuth connect response cannot cancel the new host connection polling', async t => {
  const connectResponse=deferred();
  const h=await harness(t,url=>{
    if(url==='/api/email/status')return {...disconnected};
    if(url==='/api/email/connect')return connectResponse.promise;
    throw new Error(`Unexpected API request: ${url}`);
  });
  const first=h.makeHost();await h.render(first);
  first.querySelector('#gmail-connect').click();await flush();
  assert.equal(h.count('/api/email/connect'),1);
  first.remove();const second=h.makeHost();await h.render(second);
  assert.equal(h.timers(2000),1);
  connectResponse.resolve({connectUrl:'https://accounts.google.com/test-only',expiresAt:new Date(Date.now()+600000).toISOString()});await flush();
  assert.equal(h.timers(2000),1,'The active host must retain its OAuth status poll');
  await h.fire(2000);
  assert.equal(h.count('/api/email/status'),3);
});

test('a removed Email view does not continue listing or import anything automatically', async t => {
  const h=await harness(t,url=>url==='/api/email/status'?{...connected}:listing([message()]));
  const host=h.makeHost();await h.render(host);
  host.remove();await h.fire(60000);
  assert.equal(h.count('/api/email/messages'),1);
  assert.equal(h.count('/api/email/import'),0);
  assert.equal(h.timers(60000),0);
});

test('switching connected accounts clears prior messages and pagination before the new list arrives', async t => {
  const accountA={...connected,email:'account-a@example.test',connectionRevision:1};
  const accountB={...connected,email:'account-b@example.test',connectionRevision:2};
  const secondList=deferred();let current=accountA;
  const h=await harness(t,url=>{
    if(url==='/api/email/status')return {...current};
    if(url==='/api/email/messages')return current===accountA?{...listing([message('account-a-message')],accountA),nextPageToken:'account-a-cursor'}:secondList.promise;
    if(url==='/api/email/import')return {status:'extracting',document:{id:'account-b-document'}};
    throw new Error(`Unexpected API request: ${url}`);
  });
  const first=h.makeHost();await h.render(first);
  assert.ok(first.querySelector('#gmail-more'));
  const oldImportButton=first.querySelector('[data-email-import]');
  first.remove();current=accountB;
  const second=h.makeHost(),secondRender=h.render(second);await flush();
  const pendingIds=[...second.querySelectorAll('[data-email-import]')].map(b=>b.dataset.emailImport);
  const pendingAccount=second.querySelector('.email-account')?.textContent;
  secondList.resolve(listing([message('account-b-message')],accountB));await secondRender;
  assert.equal(pendingAccount,accountB.email);
  assert.ok(pendingIds.every(id=>!id.startsWith('account-a-message:')),'Account A metadata must be removed as soon as status identifies B');
  assert.equal(second.querySelectorAll('[data-email-import]').length,2);
  assert.ok([...second.querySelectorAll('[data-email-import]')].every(b=>b.dataset.emailImport.startsWith('account-b-message:')));
  assert.equal(second.querySelector('#gmail-more'),null,'Account A pagination token must not carry over');
  oldImportButton.click();await flush();
  assert.equal(h.count('/api/email/import'),0);
  second.querySelector('[data-email-import]').click();await flush();
  assert.equal(h.count('/api/email/import'),1);
  assert.deepEqual(JSON.parse(h.calls.find(c=>c.url==='/api/email/import').options.body),{
    messageId:'account-b-message',attachmentId:'attachment-1',email:accountB.email,connectionRevision:accountB.connectionRevision,
  });
});

test('disconnecting while a list is pending does not restore old-account messages on a later connection', async t => {
  const accountA={...connected,email:'account-a@example.test',connectionRevision:1};
  const accountB={...connected,email:'account-b@example.test',connectionRevision:3};
  const lateList=deferred();let current=accountA,lists=0;
  const h=await harness(t,url=>{
    if(url==='/api/email/status')return {...current};
    if(url==='/api/email/disconnect'){current={...disconnected,connectionRevision:2};return {...current};}
    if(url==='/api/email/messages'){lists++;return lists===1?listing([message('initial-a')],accountA):lists===2?lateList.promise:listing([message('only-b')],accountB);}
    throw new Error(`Unexpected API request: ${url}`);
  });
  const first=h.makeHost();await h.render(first);
  first.querySelector('#gmail-refresh').click();await flush();
  first.querySelector('#gmail-disconnect').click();await flush();
  assert.ok(first.querySelector('#gmail-connect'));
  lateList.resolve(listing([message('late-private-a')],accountA));await flush();
  first.remove();current=accountB;
  const second=h.makeHost();await h.render(second);
  assert.equal(second.querySelectorAll('[data-email-import]').length,2);
  assert.ok([...second.querySelectorAll('[data-email-import]')].every(b=>b.dataset.emailImport.startsWith('only-b:')));
  assert.ok(!second.innerHTML.includes('late-private-a'));
  assert.equal(h.count('/api/email/import'),0);
});

test('a list from a different connection is discarded until the account status is refreshed', async t => {
  const accountA={...connected,email:'account-a@example.test',connectionRevision:1};
  const accountB={...connected,email:'account-b@example.test',connectionRevision:2};
  let statuses=0,lists=0;
  const h=await harness(t,url=>{
    if(url==='/api/email/status')return {...(++statuses===1?accountA:accountB)};
    if(url==='/api/email/messages')return listing([message(++lists===1?'unverified-response':'verified-account-b')],accountB);
    throw new Error(`Unexpected API request: ${url}`);
  });
  const host=h.makeHost();await h.render(host);await flush();
  assert.equal(h.count('/api/email/status'),2);
  assert.equal(h.count('/api/email/messages'),2);
  assert.equal(host.querySelector('.email-account').textContent,accountB.email);
  assert.equal(host.querySelectorAll('[data-email-import]').length,2);
  assert.ok([...host.querySelectorAll('[data-email-import]')].every(b=>b.dataset.emailImport.startsWith('verified-account-b:')));
  assert.ok(!host.innerHTML.includes('unverified-response'));
});
