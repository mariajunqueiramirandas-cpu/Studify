import katex from 'katex';
import MarkdownIt from 'markdown-it';
import type { Palette } from '../theme/tokens';
import { READER_FONTS } from './reader-fonts';

// mobile-app.md §8: Markdown + LaTeX ($…$, $$…$$). Raw HTML is disabled; remote images are
// never loaded; links show their domain and open only after confirmation.
// KaTeX renders to MathML, which Android System WebView (Chromium) draws natively — so math
// works offline with no bundled fonts, and TalkBack can read it (ux §11 Math).

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });

export function renderMath(src: string): string {
  // Protect math before Markdown sees it (underscores and asterisks inside formulas).
  const blocks: string[] = [];
  const stash = (html: string) => {
    blocks.push(html);
    return `@@MATH${blocks.length - 1}@@`;
  };
  const tex = (expr: string, display: boolean) => {
    try {
      return katex.renderToString(expr, { output: 'mathml', displayMode: display, throwOnError: false, strict: 'ignore' });
    } catch {
      return `<code>${expr.replace(/</g, '&lt;')}</code>`;
    }
  };
  let out = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, e: string) => stash(`<div class="math-block">${tex(e.trim(), true)}</div>`));
  out = out.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (_, pre: string, e: string) => pre + stash(tex(e.trim(), false)));
  let html = md.render(out);
  html = html.replace(/@@MATH(\d+)@@/g, (_, i: string) => blocks[Number(i)] ?? '');
  return html;
}

export function hasMath(text: string | null | undefined): boolean {
  return !!text && /\$[^$]+\$/.test(text);
}

// The study sections of a Resumo (LRN-01.3) get their own treatment in the reader.
const SECTION_KINDS: Record<string, string> = {
  'ideia central': 'lead',
  'cuidado na prova': 'caution',
  'conexões': 'links',
};

export interface PageOptions {
  fontScale: number;
  easyReading: boolean;
  /** `reader`: a whole note with headings and sections. `snippet`: one formula-bearing card face or option. */
  mode: 'reader' | 'snippet';
  /** Snippets match the native text they sit next to: Literata for study text, Figtree for UI text. */
  face?: 'read' | 'ui';
}

function fontFaces(opts: PageOptions): string {
  const face = (family: string, data: string, weight: number, style = 'normal') =>
    `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${data}) format('woff2');font-weight:${weight};font-style:${style};font-display:block}`;
  if (opts.easyReading) return face('Easy', READER_FONTS.atkinson, 400) + face('Easy', READER_FONTS.atkinsonBold, 700);
  if (opts.mode === 'snippet' && opts.face === 'ui') return face('Ui', READER_FONTS.figtree, 400) + face('Ui', READER_FONTS.figtreeSemiBold, 700);
  if (opts.mode === 'snippet') return face('Read', READER_FONTS.literata, 400) + face('Read', READER_FONTS.literataBold, 700);
  return [
    face('Read', READER_FONTS.literata, 400),
    face('Read', READER_FONTS.literataItalic, 400, 'italic'),
    face('Read', READER_FONTS.literataBold, 700),
    face('Head', READER_FONTS.bricolage, 800),
    face('Ui', READER_FONTS.figtreeSemiBold, 600),
  ].join('');
}

/**
 * The lesson page. Literata for reading at a book's rhythm, Bricolage headings with room above them, bold text laid
 * on a highlighter stroke, key terms dotted in lagoon teal, citations as small footnote links.
 */
export function documentHtml(body: string, c: Palette, opts: PageOptions) {
  const easy = opts.easyReading;
  const read = easy ? "'Easy', system-ui, sans-serif" : opts.face === 'ui' ? "'Ui', system-ui, sans-serif" : "'Read', Georgia, serif";
  const head = easy ? "'Easy', system-ui, sans-serif" : "'Head', system-ui, sans-serif";
  const ui = easy ? "'Easy', system-ui, sans-serif" : "'Ui', system-ui, sans-serif";
  const size = (opts.mode === 'reader' ? 17 : 16) * opts.fontScale;
  const leading = easy ? 1.9 : opts.mode === 'reader' ? 1.7 : 1.55;
  const tracking = easy ? 'letter-spacing:0.05em;word-spacing:0.08em;' : '';
  const docIcon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 14"><path d="M1.5 1h6l3 3v9h-9z" fill="none" stroke="${c.primary}" stroke-width="1.4" stroke-linejoin="round"/><path d="M3.5 7h5M3.5 9.5h5" stroke="${c.primary}" stroke-width="1.2"/></svg>`)}`;
  return `<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=4">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:;">
<style>
${fontFaces(opts)}
html,body{margin:0;padding:0;background:transparent;color:${c.textPrimary};font-family:${read};font-size:${size}px;line-height:${leading};${tracking}-webkit-text-size-adjust:100%;font-variant-numeric:oldstyle-nums proportional-nums}
#c{overflow-wrap:break-word}
p{margin:0 0 0.95em;text-wrap:pretty;hyphens:auto}
h1,h2,h3,h4{font-family:${head};font-weight:800;color:${c.textPrimary};line-height:1.2;letter-spacing:${easy ? '0.03em' : '-0.01em'};margin:1.9em 0 0.55em;text-wrap:balance;font-variant-numeric:lining-nums}
h1{font-size:1.65em}h2{font-size:1.38em}h3{font-size:1.14em}h4{font-size:1em}
#c>:first-child,#c>section:first-child>:first-child{margin-top:0}
h3{color:${c.primary}}
strong,b{font-weight:700;background:linear-gradient(transparent 56%,${c.highlight} 56%,${c.highlight} 94%,transparent 94%);-webkit-box-decoration-break:clone;box-decoration-break:clone;padding:0 0.08em;margin:0 -0.08em}
h1 strong,h2 strong,h3 strong{background:none}
em,i{font-style:italic}
a{color:${c.primary};text-decoration-thickness:1px;text-underline-offset:3px}
a.term{color:inherit;text-decoration:underline dotted ${c.lagoon};text-decoration-thickness:2px;text-underline-offset:5px}
a.cite{font-family:${ui};font-weight:600;font-size:0.72em;line-height:1;letter-spacing:0.01em;color:${c.primary};text-decoration:none;white-space:nowrap;vertical-align:0.28em;padding:0 0 0 1.3em;margin-left:0.2em;background:url("${docIcon}") no-repeat left center/0.95em 1.1em}
code{font-family:monospace;font-size:0.84em;background:${c.surface2};padding:0.1em 0.35em;border-radius:4px}
pre{background:${c.surface2};padding:12px 14px;border-radius:10px;overflow-x:auto;line-height:1.5}
pre code{background:none;padding:0}
blockquote{margin:1.2em 0;padding:0.1em 0 0.1em 1em;border-left:3px solid ${c.lagoon};font-style:italic;color:${c.textSecondary}}
blockquote p:last-child{margin-bottom:0}
ul,ol{padding-left:1.5em;margin:0 0 1em}
li{margin:0.35em 0;padding-left:0.15em}
li>p{margin:0 0 0.4em}
ul{list-style:none}
ul>li{position:relative}
ul>li::before{content:'';position:absolute;left:-1.05em;top:0.72em;width:0.36em;height:0.36em;background:${c.lagoon};transform:rotate(45deg);border-radius:1px}
ol{counter-reset:n;list-style:none}
ol>li{counter-increment:n;position:relative}
ol>li::before{content:counter(n);position:absolute;left:-1.6em;width:1.2em;text-align:right;font-family:${head};font-weight:800;font-size:0.92em;color:${c.primary};font-variant-numeric:lining-nums}
.table-wrap{overflow-x:auto;margin:1.2em 0;border-radius:10px;border:1px solid ${c.border}}
table{border-collapse:collapse;min-width:100%;font-size:0.9em;line-height:1.45}
th,td{padding:8px 12px;text-align:left;vertical-align:top;border-bottom:1px solid ${c.border}}
tr:last-child td{border-bottom:none}
th{font-family:${ui};font-weight:600;font-size:0.92em;background:${c.surface2};color:${c.textPrimary}}
td{background:${c.surface1}}
th:first-child,td:first-child{position:sticky;left:0}
th:first-child{background:${c.surface2}}
.math-block{overflow-x:auto;text-align:center;margin:1.1em 0;padding:0.5em 0.4em;background:${c.surface1};border-radius:10px}
math{font-size:1.06em}
hr{border:none;margin:1.8em 0;text-align:center;line-height:1}
hr::after{content:'\\2042';color:${c.lamp};font-size:1.2em}
img{display:none}
::selection{background:${c.highlight}}
section.lead>p{font-size:1.12em;line-height:1.62}
section.caution{background:${c.warningSoft};border-radius:12px;padding:0.2em 1em 0.3em;margin:1.4em -0.25em}
section.caution>h2{color:${c.warning};margin-top:0.8em}
section.links{color:${c.textSecondary}}
</style></head><body><div id="c">${body}</div>
<script>
var KINDS=${JSON.stringify(SECTION_KINDS)};
document.querySelectorAll('table').forEach(function(t){var w=document.createElement('div');w.className='table-wrap';t.parentNode.insertBefore(w,t);w.appendChild(t);});
var root=document.getElementById('c');
Array.prototype.slice.call(root.children).forEach(function(h){
  if(h.tagName!=='H2')return;
  var kind=KINDS[h.textContent.trim().toLowerCase()];
  if(!kind)return;
  var s=document.createElement('section');s.className=kind;root.insertBefore(s,h);
  var n=h;while(n&&!(n!==h&&n.tagName==='H2')){var next=n.nextElementSibling;s.appendChild(n);n=next;}
});
function post(o){window.ReactNativeWebView.postMessage(JSON.stringify(o));}
function h(){post({type:'height',value:root.getBoundingClientRect().height+8});}
document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;e.preventDefault();post({type:'link',href:a.getAttribute('href')});});
new ResizeObserver(h).observe(root);h();
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(h);
</script></body></html>`;
}

export function linkifyTerms(markdown: string, terms: string[] | undefined): string {
  if (!terms?.length) return markdown;
  let out = markdown;
  for (const term of terms.slice(0, 40)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // First occurrence only, outside existing links and math.
    out = out.replace(new RegExp(`(^|[^\\w\\[$])(${escaped})(?![\\w\\]])`, 'i'), (m, pre: string, word: string) => `${pre}[${word}](term:${encodeURIComponent(term)})`);
  }
  return out;
}

/** A note's Markdown as the reader's HTML body: citations become footnote links, key terms get their dotted line. */
export function noteBody(markdown: string, terms: string[] | undefined, sourceLabel: string): string {
  const withCites = markdown.replace(/\[\[cite:(\d+)(?::([^\]]*))?\]\]/g, (_, i: string, label?: string) => `[${label || sourceLabel}](cite:${i})`);
  return renderMath(linkifyTerms(withCites, terms)).replace(/<a href="cite:/g, '<a class="cite" href="cite:').replace(/<a href="term:/g, '<a class="term" href="term:');
}
