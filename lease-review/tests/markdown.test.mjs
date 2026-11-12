import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {createMarkdownRenderer} from '../public/markdown.js';

function render(source) {
  const dom = new JSDOM('<!doctype html><body></body>');
  dom.window.document.body.innerHTML = createMarkdownRenderer(dom.window)(source);
  return dom.window.document.body;
}

test('review Markdown renders headings, emphasis, paragraphs and conditions as lists', () => {
  const body = render('### Current rent needs review\n\n**Initial rent:** £120,000 per year.\n\nThe review date has passed.\n\n- Obtain the rent memorandum.\n- Confirm the effective date.\n\n1. Check the lease.\n2. Record the decision.');
  assert.equal(body.querySelector('h3').textContent, 'Current rent needs review');
  assert.equal(body.querySelector('strong').textContent, 'Initial rent:');
  assert.equal(body.querySelectorAll('p').length, 2);
  assert.equal(body.querySelectorAll('ul>li').length, 2);
  assert.equal(body.querySelectorAll('ol>li').length, 2);
});

test('untrusted document and correction Markdown cannot add executable or styled content', () => {
  const attempts = [
    '<script>alert(1)</script><p onclick="alert(1)" style="position:fixed">Visible review</p>',
    '<img src="https://example.com/tracker" onerror="alert(1)">![tracking](https://example.com/image)',
    '<svg><a xlink:href="javascript:alert(1)">unsafe</a></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="javascript:alert(1)"></object>',
    '<form action="https://example.com"><input name="secret"><button>Submit</button></form>',
    '<div id="evidence-panel" class="panel" data-action="delete" aria-label="fake panel">Untrusted text</div>',
  ];
  for (const source of attempts) {
    const body = render(source);
    assert.equal(body.querySelector('script,img,svg,math,iframe,object,embed,style,form,input,button'), null, source);
    for (const element of body.querySelectorAll('*')) {
      for (const attr of element.attributes) {
        assert.ok(!/^on|^(style|id|class|data-|aria-)/i.test(attr.name), `${attr.name} survived`);
      }
    }
  }
});

test('unsafe links and encoded protocol variants lose their href', () => {
  const attempts = [
    '[Run](javascript:alert%281%29)',
    '<a href="jav&#x61;script:alert(1)">Run</a>',
    '<a href="java&#x09;script:alert(1)">Run</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD4=">Run</a>',
    '<a href="vbscript:msgbox(1)">Run</a>',
    '<a href="//example.com">External protocol-relative</a>',
    '<a href="file:///etc/passwd">Local file</a>',
  ];
  for (const source of attempts) {
    const body = render(source);
    assert.equal(body.querySelector('a[href]'), null, source);
  }
});

test('safe evidence links open separately with fixed safe attributes', () => {
  const body = render('[Public reference](https://example.com/lease)\n\n[PDF](/viewer.html?document=one&page=1)\n\n<a href="https://example.com" target="_self" rel="opener" onclick="alert(1)">Reference</a>');
  const links = [...body.querySelectorAll('a')];
  assert.equal(links.length, 3);
  for (const link of links) {
    assert.ok(link.hasAttribute('href'));
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(link.hasAttribute('onclick'), false);
  }
});

test('missing and ordinary review text remain readable', () => {
  assert.equal(render(null).textContent, '');
  assert.equal(render(undefined).textContent, '');
  assert.equal(render('The rent is £20,000 & VAT is separate.').textContent.trim(), 'The rent is £20,000 & VAT is separate.');
});

test('deployed Markdown libraries match installed pinned versions', () => {
  const files = [
    ['marked/lib/marked.esm.js', 'marked.esm.js'],
    ['dompurify/dist/purify.es.mjs', 'purify.es.mjs'],
  ];
  for (const [installed, deployed] of files) {
    assert.deepEqual(
      fs.readFileSync(new URL(`../node_modules/${installed}`, import.meta.url)),
      fs.readFileSync(new URL(`../public/vendor/markdown/${deployed}`, import.meta.url)),
    );
  }
});
