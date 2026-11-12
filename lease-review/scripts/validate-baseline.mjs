import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
const [{columns},{documents},extraction]=await Promise.all(['public/data/columns.json','public/data/document-index.json','public/data/extraction.json'].map(read));
const rows=extraction.rows;
const normalized=s=>String(s).normalize('NFKC').replace(/\s+/g,' ').trim();
const highlights=s=>String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
assert.equal(columns.length,56);
assert.equal(documents.length,20);
assert.equal(rows.length,10);
assert.equal(new Set(documents.map(d=>d.id)).size,20);
assert.equal(new Set(rows.map(r=>r.id)).size,10);
const map=new Map(documents.map(d=>[d.id,d]));
const counts={rows:rows.length,documents:documents.length,pages:0,cells:0,evidence:0,highlightable:0,filled:0,needsReview:0,statuses:{}};
for(const d of documents){
 assert.equal(d.isTemplate,false,d.id);
 assert.equal(d.isSynthetic,true,d.id);
 assert.equal(d.pages.length,d.pageCount,d.id);
 assert.match(d.syntheticGroup,/^SYN-\d{2}$/);
 counts.pages+=d.pageCount;
 const bytes=await fs.readFile(path.join(root,'public',d.pdfUrl));
 const hash=crypto.createHash('sha256').update(bytes).digest('hex');
 assert.equal(hash,d.pdfSha256,d.id+' PDF hash');
 for(const p of d.pages){
  assert.ok(p.width>0&&p.height>0,d.id+' page dimensions');
  assert.ok(p.page>=1&&p.page<=d.pageCount,d.id+' page number');
  for(const w of p.words)assert.ok(w.x0>=-1&&w.y0>=-1&&w.x1<=p.width+1&&w.y1<=p.height+1,`${d.id} page ${p.page}: word outside page`);
 }
}
for(const r of rows){
 assert.ok(map.has(r.documentId),r.id+' primary document');
 assert.equal(map.get(r.documentId).kind,'lease');
 assert.deepEqual(Object.keys(r.cells).sort(),columns.map(c=>c.id).sort(),r.id+' complete 56 columns');
 for(const [id,c] of Object.entries(r.cells)){
  counts.cells++;counts.statuses[c.status]=(counts.statuses[c.status]||0)+1;
  if(c.value!==null)counts.filled++;
  if(c.status==='needs_review')counts.needsReview++;
  assert.ok(['extracted','derived','not_found','needs_review','not_applicable','optional','placeholder'].includes(c.status),r.id+id+' status');
  assert.equal(typeof c.explanation,'string');
  assert.ok(Array.isArray(c.evidence));
  if(c.status==='extracted')assert.ok(c.evidence.length,r.id+id+' extracted claim without evidence');
  for(const e of c.evidence){
   counts.evidence++;
   const d=map.get(e.documentId),p=d?.pages.find(p=>p.page===e.page);
   assert.ok(p,`${r.id} ${id}: source page missing`);
   assert.ok(e.quote&&normalized(p.text).includes(normalized(e.quote)),`${r.id} ${id}: quote mismatch ${e.documentId} p${e.page}: ${e.quote}`);
   assert.equal(d.syntheticGroup,map.get(r.documentId).syntheticGroup,r.id+id+' cross-property evidence');
   const target=highlights(e.quote),stream=p.words.map(w=>highlights(w.text)).join('');
   assert.ok(target&&stream.includes(target),`${r.id} ${id}: quote cannot be highlighted`);
   counts.highlightable++;
  }
 }
}
console.log(JSON.stringify(counts,null,2));
