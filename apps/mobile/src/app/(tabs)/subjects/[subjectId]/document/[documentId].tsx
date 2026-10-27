import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Pdf from 'react-native-pdf';
import { supabase } from '../../../../../api/supabase';
import { ActionBar, Banner, Button, ErrorState, IconButton, Row, Screen, Skeleton, Text, TextField, useOnline } from '../../../../../components';
import { row } from '../../../../../features/common/query';
import { signedUrl, type DocumentRow } from '../../../../../features/subjects/api';
import { downloadDocumentForOffline, localDocumentUri } from '../../../../../features/subjects/files';
import { matchSpans, type PageSpan } from '../../../../../features/subjects/highlight';
import { openTutor } from '../../../../../features/tutor/open';
import { t } from '../../../../../i18n';
import { radius, space, useTheme } from '../../../../../theme';

interface PageRow {
  page_number: number;
  text_source: 'pdf_text_layer' | 'ai_transcription' | 'none';
  image_path: string | null;
  text_items_path: string | null;
  text: string | null;
}

/** S-MAT-08: citation view (page image + highlight) and full PDF viewer (ING-08, TRU-01). */
export default function DocumentViewer() {
  const { documentId, page, cite, subjectId } = useLocalSearchParams<{ documentId: string; page?: string; cite?: string; subjectId: string }>();
  const startPage = Math.max(1, Number(page ?? 1) || 1);
  const [mode, setMode] = useState<'citation' | 'full'>(cite || page ? 'citation' : 'full');
  const [current, setCurrent] = useState(startPage);
  const { colors } = useTheme();
  const online = useOnline();

  const doc = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => row<DocumentRow>(supabase.from('documents').select('*').eq('id', documentId).maybeSingle()),
  });
  const pageRow = useQuery({
    queryKey: ['document', documentId, 'page', current],
    queryFn: () => row<PageRow>(supabase.from('document_pages').select('page_number,text_source,image_path,text_items_path,text').eq('document_id', documentId).eq('page_number', current).maybeSingle()),
  });
  const image = useQuery({
    queryKey: ['document', documentId, 'page', current, 'image'],
    enabled: !!pageRow.data?.image_path,
    staleTime: 50 * 60_000,
    queryFn: () => signedUrl('page-images', pageRow.data!.image_path!),
  });
  const spans = useQuery({
    queryKey: ['document', documentId, 'page', current, 'spans'],
    enabled: !!pageRow.data?.text_items_path && !!cite && current === startPage,
    staleTime: Infinity,
    queryFn: async () => {
      const url = await signedUrl('page-text', pageRow.data!.text_items_path!);
      if (!url) return [];
      const res = await fetch(url);
      return ((await res.json()) as { spans?: PageSpan[] }).spans ?? [];
    },
  });
  const highlights = current === startPage ? matchSpans(spans.data ?? [], cite) : [];
  const total = doc.data?.page_count ?? null;

  if (doc.isError) return <Screen title={t('viewer.title')}><ErrorState message={t('viewer.unavailable')} onRetry={doc.refetch} /></Screen>;

  return (
    <Screen
      title={doc.data?.title ?? t('viewer.title')}
      scroll={mode === 'citation'}
      padded={mode === 'citation'}
      actions={<IconButton icon={mode === 'citation' ? 'document-outline' : 'image-outline'} label={mode === 'citation' ? t('viewer.open_full') : t('viewer.title')} onPress={() => setMode(mode === 'citation' ? 'full' : 'citation')} />}
      context={
        <Row>
          <Text variant="bodySmall" tone="secondary">
            {total ? t('viewer.page_of', { page: current, total }) : `pág. ${current}`}
          </Text>
        </Row>
      }
      footer={
        mode === 'citation' ? (
          <ActionBar>
            <Row>
              <IconButton icon="chevron-back" label="Página anterior" disabled={current <= 1} onPress={() => setCurrent((p) => p - 1)} />
              <Button
                style={{ flex: 1 }}
                variant="tonal"
                icon="chatbubbles-outline"
                label={t('viewer.ask_about')}
                disabled={!online}
                onPress={() =>
                  openTutor({
                    type: 'passage',
                    subject_id: subjectId !== '_' ? subjectId : doc.data?.subject_id,
                    passage: { source: 'pdf', document_id: documentId, page: current, text: (cite ?? pageRow.data?.text ?? '').slice(0, 1500) },
                  })
                }
              />
              <IconButton icon="chevron-forward" label="Próxima página" disabled={!!total && current >= total} onPress={() => setCurrent((p) => p + 1)} />
            </Row>
          </ActionBar>
        ) : undefined
      }
    >
      {mode === 'citation' ? (
        <CitationPage
          imageUrl={image.data ?? null}
          loading={pageRow.isLoading || image.isLoading}
          scanned={pageRow.data?.text_source === 'ai_transcription'}
          highlights={highlights}
          citedText={current === startPage ? cite : undefined}
          fallbackText={pageRow.data?.text ?? null}
          accent={colors.warning}
        />
      ) : doc.data ? (
        <FullPdf doc={doc.data} page={current} onPage={setCurrent} />
      ) : (
        <Skeleton height={400} />
      )}
    </Screen>
  );
}

function CitationPage({ imageUrl, loading, scanned, highlights, citedText, fallbackText, accent }: { imageUrl: string | null; loading: boolean; scanned: boolean; highlights: PageSpan[]; citedText?: string; fallbackText: string | null; accent: string }) {
  const { width } = useWindowDimensions();
  const { colors } = useTheme();
  const [ratio, setRatio] = useState(1.414);
  const w = Math.min(width - space.lg * 2, 600);
  return (
    <View style={{ gap: space.md }}>
      {scanned ? <Banner kind="neutral" message={t('viewer.scanned')} /> : null}
      {loading ? <Skeleton height={w * 1.3} rounded={radius.md} /> : null}
      {imageUrl ? (
        <ScrollView maximumZoomScale={4} minimumZoomScale={1} bouncesZoom centerContent style={{ borderRadius: radius.md, borderWidth: 1, borderColor: colors.border }}>
          <View style={{ width: w, height: w * ratio }}>
            <Image source={{ uri: imageUrl }} style={StyleSheet.absoluteFill} contentFit="contain" onLoad={(e) => setRatio(e.source.height / e.source.width)} accessibilityLabel={citedText ? `Trecho citado: ${citedText}` : 'Página do material'} />
            {highlights.map((h, i) => (
              <View key={i} pointerEvents="none" style={{ position: 'absolute', left: h.x * w, top: h.y * w * ratio, width: h.w * w, height: h.h * w * ratio, backgroundColor: `${accent}55`, borderRadius: 2 }} />
            ))}
          </View>
        </ScrollView>
      ) : !loading && fallbackText ? (
        <Text variant="bodySmall">{fallbackText}</Text>
      ) : null}
      {citedText ? (
        <View style={{ backgroundColor: colors.warningSoft, borderRadius: radius.md, padding: space.md, gap: space.xs }}>
          <Text variant="label">Trecho citado</Text>
          <Text variant="bodySmall">“{citedText}”</Text>
        </View>
      ) : null}
    </View>
  );
}

function FullPdf({ doc, page, onPage }: { doc: DocumentRow; page: number; onPage: (p: number) => void }) {
  const [uri, setUri] = useState<string | null>(localDocumentUri(doc.id));
  const [error, setError] = useState(false);
  const [goto, setGoto] = useState('');
  const [target, setTarget] = useState(page);
  useEffect(() => {
    if (uri) return;
    downloadDocumentForOffline(doc)
      .then(setUri)
      .catch(() => setError(true));
  }, [doc, uri]);
  if (error) return <ErrorState message={t('viewer.unavailable')} onRetry={() => setError(false)} />;
  if (!uri) return <Skeleton height={500} />;
  return (
    <View style={{ flex: 1 }}>
      <Row style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <View style={{ flex: 1 }}>
          <TextField placeholder={t('viewer.go_to_page')} keyboardType="number-pad" value={goto} onChangeText={setGoto} onSubmitEditing={() => goto && setTarget(Number(goto))} />
        </View>
        <Button compact variant="tonal" label="Ir" onPress={() => goto && setTarget(Number(goto))} />
      </Row>
      <Pdf source={{ uri }} page={target} onPageChanged={(p) => onPage(p)} style={{ flex: 1 }} enablePaging={false} trustAllCerts={false} />
    </View>
  );
}
