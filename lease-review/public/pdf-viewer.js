import * as pdfjs from '/vendor/pdfjs/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
const docs = new Map();
const metadata = new Map();
export async function getDocument(id) {
  if (!metadata.has(id)) metadata.set(id, fetch(`/api/documents/${encodeURIComponent(id)}`).then(async r => {if(!r.ok) throw new Error('Document unavailable'); return r.json();}));
  return metadata.get(id);
}
export const normalize = s => String(s).normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'").replace(/[“”]/g,'"').replace(/[^\p{L}\p{N}]/gu,'');
export function locateQuote(page, quote) {
  if (!quote || !page?.words) return [];
  const target=normalize(quote); if(!target) return [];
  let stream='', spans=[];
  for (const w of page.words) {const start=stream.length; stream+=normalize(w.text); spans.push({start,end:stream.length,w});}
  const start=stream.indexOf(target); if(start<0) return [];
  const end=start+target.length;
  const words=spans.filter(s=>s.end>start && s.start<end).map(s=>s.w);
  const rects=[];
  for(const w of words) {
    let last=rects.at(-1);
    if(last && Math.abs(last.y0-w.y0)<3 && w.x0-last.x1<22 && w.x0>=last.x0) {last.x1=Math.max(last.x1,w.x1);last.y1=Math.max(last.y1,w.y1);}
    else rects.push({x0:w.x0,y0:w.y0,x1:w.x1,y1:w.y1});
  }
  return rects;
}
export class PdfPane {
  constructor(host,{onPage=()=>{}}={}) {this.host=host;this.onPage=onPage;this.sequence=0;this.zoom=1;}
  async show(id,page=1,quote='') {
    const seq=++this.sequence;
    this.host.classList.add('pdf-loading');
    this.host.innerHTML='<div class="pdf-message">Loading source page…</div>';
    try {
      const meta=await getDocument(id); if(seq!==this.sequence) return;
      if(!docs.has(id)) docs.set(id,pdfjs.getDocument({url:meta.pdfUrl,cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/'}).promise);
      const pdf=await docs.get(id); if(seq!==this.sequence) return;
      this.id=id;this.meta=meta;this.page=Math.max(1,Math.min(Number(page)||1,pdf.numPages));this.quote=quote;
      const p=await pdf.getPage(this.page); if(seq!==this.sequence) return;
      const raw=p.getViewport({scale:1});
      const css=getComputedStyle(this.host);const width=Math.max(260,this.host.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight));
      const scale=width/raw.width*this.zoom;
      const viewport=p.getViewport({scale});
      const paper=document.createElement('div');paper.className='pdf-paper';paper.style.width=viewport.width+'px';paper.style.height=viewport.height+'px';
      const canvas=document.createElement('canvas');const dpr=Math.min(window.devicePixelRatio||1,2);
      canvas.width=Math.round(viewport.width*dpr);canvas.height=Math.round(viewport.height*dpr);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
      paper.append(canvas); this.host.replaceChildren(paper);
      const task=p.render({canvasContext:canvas.getContext('2d'),viewport,transform:dpr===1?null:[dpr,0,0,dpr,0,0]});await task.promise;if(seq!==this.sequence)return;
      const indexed=meta.pages?.find(p=>p.page===this.page);
      const rects=locateQuote(indexed,quote);
      for(const rect of rects) {const h=document.createElement('div');h.className='pdf-highlight';Object.assign(h.style,{left:(rect.x0*scale-2)+'px',top:(rect.y0*scale-1)+'px',width:((rect.x1-rect.x0)*scale+4)+'px',height:((rect.y1-rect.y0)*scale+3)+'px'});paper.append(h);}
      this.host.scrollTop=rects.length?Math.max(0,rects[0].y0*scale-90):0;
      this.host.classList.remove('pdf-loading');
      this.onPage({page:this.page,total:pdf.numPages,matched:rects.length>0,quote:!!quote});
    } catch(e) {if(seq!==this.sequence)return;this.host.innerHTML='<div class="pdf-message">The PDF could not be opened. Use “View PDF” to view the document.</div>';this.host.classList.remove('pdf-loading');console.error(e);}
  }
  next(delta){return this.show(this.id,this.page+delta,this.quote);}
  setZoom(delta){this.zoom=Math.min(2,Math.max(.65,this.zoom+delta));return this.show(this.id,this.page,this.quote);}
  destroy(){this.sequence++;}
}
