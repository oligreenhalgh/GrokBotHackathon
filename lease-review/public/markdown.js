import {marked} from './vendor/markdown/marked.esm.js';
import createDOMPurify from './vendor/markdown/purify.es.mjs';

// Review text is untrusted: it can originate in a document, model output or a note.
// Keep prose formatting and safe links; omit images, styles and executable content.
const allowedTags = [
  'p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

export function createMarkdownRenderer(windowLike) {
  const purifier = createDOMPurify(windowLike);
  purifier.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return source => purifier.sanitize(
    marked.parse(String(source ?? ''), {gfm: true, breaks: false, async: false}),
    {
      ALLOWED_TAGS: allowedTags,
      ALLOWED_ATTR: ['href', 'title', 'start'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/(?!\/)|#)/i,
    },
  );
}

let browserRenderer;
export function renderMarkdown(source) {
  browserRenderer ??= createMarkdownRenderer(window);
  return browserRenderer(source);
}
