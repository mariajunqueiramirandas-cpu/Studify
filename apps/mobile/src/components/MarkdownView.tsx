import katex from 'katex';
import MarkdownIt from 'markdown-it';
import { useMemo, useState, type ReactNode } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useOverlay } from './Overlay';
import { radius, space, useTheme, type Palette } from '../theme';
import { Text } from './Text';

// mobile-app.md §8: Markdown + LaTeX ($…$, $$…$$). Raw HTML is disabled; remote images are
// never loaded; links show their domain and open only after confirmation.
// KaTeX renders to MathML, which Android System WebView (Chromium) draws natively — so math
// works offline with no bundled fonts, and TalkBack can read it (ux §11 Math).

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });

function renderMath(src: string): string {
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

function documentHtml(body: string, c: Palette, opts: { fontScale: number; easyReading: boolean }) {
  const font = opts.easyReading ? "'Atkinson Hyperlegible', system-ui, sans-serif" : 'system-ui, sans-serif';
  const spacing = opts.easyReading ? 'letter-spacing:0.05em;line-height:1.8;' : 'line-height:1.5;';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=4">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
html,body{margin:0;padding:0;background:transparent;color:${c.textPrimary};font-family:${font};font-size:${16 * opts.fontScale}px;${spacing}}
p{margin:0 0 0.8em}
h1,h2,h3{font-weight:700;line-height:1.3;margin:1em 0 0.4em}
h1{font-size:1.35em}h2{font-size:1.2em}h3{font-size:1.1em}
a{color:${c.primary}}
a.term{color:inherit;text-decoration:underline dotted;text-underline-offset:3px}
a.cite{display:inline-block;text-decoration:none;font-size:0.85em;font-weight:600;padding:0 8px;border-radius:999px;background:${c.surface2};border:1px solid ${c.border};color:${c.primary};margin-left:2px}
code{font-family:monospace;font-size:0.875em;background:${c.surface2};padding:1px 4px;border-radius:4px}
pre{background:${c.surface2};padding:12px;border-radius:8px;overflow-x:auto}
blockquote{margin:0 0 0.8em;padding:8px 12px;border-left:4px solid ${c.primary};background:${c.primarySoft};border-radius:4px}
.table-wrap{overflow-x:auto;margin:0 0 0.8em}
table{border-collapse:collapse;min-width:100%}
th,td{border:1px solid ${c.border};padding:6px 10px;text-align:left;vertical-align:top}
th{background:${c.surface2}}
tr:nth-child(even) td{background:${c.surface1}}
th:first-child,td:first-child{position:sticky;left:0;background:${c.surface1}}
.math-block{overflow-x:auto;text-align:center;margin:0.6em 0}
math{font-size:1.05em}
ul,ol{padding-left:1.4em;margin:0 0 0.8em}
li{margin:0.2em 0}
hr{border:none;border-top:1px solid ${c.border};margin:1em 0}
img{display:none}
</style></head><body><div id="c">${body}</div>
<script>
document.querySelectorAll('table').forEach(function(t){var w=document.createElement('div');w.className='table-wrap';t.parentNode.insertBefore(w,t);w.appendChild(t);});
function post(o){window.ReactNativeWebView.postMessage(JSON.stringify(o));}
function h(){post({type:'height',value:document.getElementById('c').getBoundingClientRect().height+8});}
document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;e.preventDefault();post({type:'link',href:a.getAttribute('href')});});
new ResizeObserver(h).observe(document.getElementById('c'));h();
</script></body></html>`;
}

export interface MarkdownViewProps {
  markdown: string;
  /** cite:N links are emitted as chips; resolved by the caller (TRU-01). */
  onCitation?: (index: number) => void;
  /** term:<slug> links underline key terms (S-MAT-13). */
  onTerm?: (term: string) => void;
  /** Key terms to underline automatically (dotted underline, ux §7.3). */
  terms?: string[];
  citations?: unknown[];
}

function linkifyTerms(markdown: string, terms: string[] | undefined): string {
  if (!terms?.length) return markdown;
  let out = markdown;
  for (const term of terms.slice(0, 40)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // First occurrence only, outside existing links and math.
    out = out.replace(new RegExp(`(^|[^\\w\\[$])(${escaped})(?![\\w\\]])`, 'i'), (m, pre: string, word: string) => `${pre}[${word}](term:${encodeURIComponent(term)})`);
  }
  return out;
}

/** Long-form content (notes): one WebView per screen with auto height. */
export function MarkdownView({ markdown, onCitation, onTerm, terms }: MarkdownViewProps) {
  const theme = useTheme();
  const overlay = useOverlay();
  const [height, setHeight] = useState(80);
  const html = useMemo(() => {
    const withCites = markdown.replace(/\[\[cite:(\d+)(?::([^\]]*))?\]\]/g, (_, i: string, label?: string) => `[${label ? `📄 ${label}` : '📄'}](cite:${i})`);
    return documentHtml(
      renderMath(linkifyTerms(withCites, terms)).replace(/<a href="cite:/g, '<a class="cite" href="cite:').replace(/<a href="term:/g, '<a class="term" href="term:'),
      theme.colors,
      { fontScale: 1, easyReading: theme.easyReading },
    );
  }, [markdown, terms, theme.colors, theme.easyReading]);

  const onMessage = async (e: WebViewMessageEvent) => {
    const msg = JSON.parse(e.nativeEvent.data) as { type: string; value?: number; href?: string };
    if (msg.type === 'height' && msg.value) setHeight(Math.ceil(msg.value));
    if (msg.type === 'link' && msg.href) {
      if (msg.href.startsWith('cite:')) onCitation?.(Number(msg.href.slice(5)));
      else if (msg.href.startsWith('term:')) onTerm?.(decodeURIComponent(msg.href.slice(5)));
      else if (/^https?:/.test(msg.href)) {
        const domain = new URL(msg.href).host;
        if (await overlay.confirm({ title: `Abrir ${domain}?`, message: msg.href, confirmLabel: 'Abrir' })) void Linking.openURL(msg.href);
      }
    }
  };

  return (
    <View style={{ height, width: '100%' }}>
      <WebView
        originWhitelist={['about:blank']}
        source={{ html }}
        onMessage={onMessage}
        scrollEnabled={false}
        style={{ backgroundColor: 'transparent' }}
        javaScriptEnabled
        textZoom={100}
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        overScrollMode="never"
        accessible
      />
    </View>
  );
}

// ---------- Native renderer for short content without math ----------

type Token = ReturnType<typeof md.parse>[number];

function renderInline(tokens: Token[] | null, c: Palette, keyBase: string, bold: string): ReactNode[] {
  if (!tokens) return [];
  const out: ReactNode[] = [];
  let strong = false;
  let em = false;
  tokens.forEach((tk, i) => {
    if (tk.type === 'strong_open') strong = true;
    else if (tk.type === 'strong_close') strong = false;
    else if (tk.type === 'em_open') em = true;
    else if (tk.type === 'em_close') em = false;
    else if (tk.type === 'softbreak' || tk.type === 'hardbreak') out.push('\n');
    else if (tk.type === 'code_inline')
      out.push(
        <Text key={`${keyBase}-${i}`} variant="mono" style={{ backgroundColor: c.surface2 }}>
          {tk.content}
        </Text>,
      );
    else if (tk.type === 'text')
      out.push(
        strong || em ? (
          <Text key={`${keyBase}-${i}`} style={[strong && { fontFamily: bold }, em && { fontStyle: 'italic' }]}>
            {tk.content}
          </Text>
        ) : (
          tk.content
        ),
      );
  });
  return out;
}

/** Card faces, options and feed items. Falls back to MathView when the text has math. */
export function RichContent({ text, variant = 'body', align }: { text: string; variant?: 'body' | 'cardFace' | 'bodySmall'; align?: 'left' | 'center' }) {
  const theme = useTheme();
  const c = theme.colors;
  const bold = theme.easyReading ? 'AtkinsonHyperlegible_700Bold' : 'Inter_600SemiBold';
  if (hasMath(text)) return <MathView text={text} variant={variant} align={align} />;
  const tokens = md.parse(text ?? '', {});
  const blocks: ReactNode[] = [];
  let listDepth = 0;
  let ordered = false;
  let index = 0;
  tokens.forEach((tk, i) => {
    if (tk.type === 'bullet_list_open') {
      listDepth++;
      ordered = false;
    } else if (tk.type === 'ordered_list_open') {
      listDepth++;
      ordered = true;
      index = 0;
    } else if (tk.type === 'bullet_list_close' || tk.type === 'ordered_list_close') listDepth--;
    else if (tk.type === 'list_item_open') index++;
    else if (tk.type === 'inline') {
      const prefix = listDepth > 0 ? (ordered ? `${index}. ` : '• ') : '';
      const heading = tokens[i - 1]?.type === 'heading_open';
      blocks.push(
        <Text key={i} variant={heading ? 'heading' : variant} align={align} style={listDepth > 0 ? { paddingLeft: space.md * listDepth } : undefined}>
          {prefix}
          {renderInline(tk.children, c, String(i), bold)}
        </Text>,
      );
    }
  });
  return <View style={{ gap: space.sm }}>{blocks}</View>;
}

/** Small WebView for one formula-bearing item (pooled in spirit: render only when visible). */
export function MathView({ text, variant = 'body', align }: { text: string; variant?: 'body' | 'cardFace' | 'bodySmall'; align?: 'left' | 'center' }) {
  const theme = useTheme();
  const [height, setHeight] = useState(40);
  const scale = variant === 'cardFace' ? 1.25 : variant === 'bodySmall' ? 0.875 : 1;
  const html = useMemo(
    () => documentHtml(`<div style="text-align:${align ?? 'left'}">${renderMath(text)}</div>`, theme.colors, { fontScale: scale, easyReading: theme.easyReading }),
    [text, theme.colors, theme.easyReading, scale, align],
  );
  return (
    <View style={{ height, width: '100%' }} accessible accessibilityLabel={text.replace(/\$/g, '')}>
      <WebView
        originWhitelist={['about:blank']}
        source={{ html }}
        scrollEnabled={false}
        style={{ backgroundColor: 'transparent' }}
        onMessage={(e) => {
          const msg = JSON.parse(e.nativeEvent.data) as { type: string; value?: number };
          if (msg.type === 'height' && msg.value) setHeight(Math.ceil(msg.value));
        }}
        textZoom={100}
        allowFileAccess={false}
      />
    </View>
  );
}

export const markdownStyles = StyleSheet.create({
  callout: { borderRadius: radius.md, padding: space.md },
});
