import MarkdownIt from 'markdown-it';
import { useMemo, useState, type ReactNode } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { t } from '../i18n';
import { useOverlay } from './Overlay';
import { boldFamily, FONTS, radius, space, useTheme, type Palette } from '../theme';
import { documentHtml, hasMath, noteBody, renderMath } from './reader-html';
import { Text } from './Text';

export { hasMath } from './reader-html';

// The native renderer below parses short content; the reader's own parser lives in reader-html.ts.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });

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

/** Long-form content (notes): one WebView per screen with auto height. */
export function MarkdownView({ markdown, onCitation, onTerm, terms }: MarkdownViewProps) {
  const theme = useTheme();
  const overlay = useOverlay();
  const [height, setHeight] = useState(80);
  const html = useMemo(() => {
    return documentHtml(noteBody(markdown, terms, t('global.source')), theme.colors, { fontScale: 1, easyReading: theme.easyReading, mode: 'reader' });
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

function renderInline(tokens: Token[] | null, c: Palette, keyBase: string, bold: string, italic: string | undefined): ReactNode[] {
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
          <Text key={`${keyBase}-${i}`} style={[strong && { fontFamily: bold }, strong && literata(bold) && { backgroundColor: c.highlight }, em && (italic && !strong ? { fontFamily: italic } : { fontStyle: 'italic' })]}>
            {tk.content}
          </Text>
        ) : (
          tk.content
        ),
      );
  });
  return out;
}

const literata = (family: string) => family.startsWith('Literata');

type RichVariant = 'body' | 'cardFace' | 'bodySmall' | 'reading';

/** Card faces, options and feed items. Falls back to MathView when the text has math. */
export function RichContent({ text, variant = 'body', align }: { text: string; variant?: RichVariant; align?: 'left' | 'center' }) {
  const theme = useTheme();
  const c = theme.colors;
  const bold = boldFamily(variant, theme.easyReading);
  // Android only finds the italic face by name.
  const italic = !theme.easyReading && (variant === 'cardFace' || variant === 'reading') ? FONTS.readItalic : undefined;
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
          {renderInline(tk.children, c, String(i), bold, italic)}
        </Text>,
      );
    }
  });
  return <View style={{ gap: space.sm }}>{blocks}</View>;
}

/** Small WebView for one formula-bearing item (pooled in spirit: render only when visible). */
export function MathView({ text, variant = 'body', align }: { text: string; variant?: RichVariant; align?: 'left' | 'center' }) {
  const theme = useTheme();
  const [height, setHeight] = useState(40);
  const scale = variant === 'cardFace' ? 1.3 : variant === 'reading' ? 1.12 : variant === 'bodySmall' ? 0.875 : 1;
  const face = variant === 'cardFace' || variant === 'reading' ? 'read' : 'ui';
  const html = useMemo(
    () => documentHtml(`<div style="text-align:${align ?? 'left'}">${renderMath(text)}</div>`, theme.colors, { fontScale: scale, easyReading: theme.easyReading, mode: 'snippet', face }),
    [text, theme.colors, theme.easyReading, scale, align, face],
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
