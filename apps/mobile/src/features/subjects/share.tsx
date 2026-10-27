import { router } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect } from 'react';
import { create } from 'zustand';
import { useOverlay } from '../../components';
import { t } from '../../i18n';

/** A PDF handed to Studify from another app (Android share sheet, ING-01.3). */
export interface SharedFile {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
}

interface SharedFileState {
  file: SharedFile | null;
  set: (file: SharedFile | null) => void;
  take: () => SharedFile | null;
}

export const useSharedFile = create<SharedFileState>((set, get) => ({
  file: null,
  set: (file) => set({ file }),
  take: () => {
    const file = get().file;
    set({ file: null });
    return file;
  },
}));

const toUri = (path: string) => (path.includes('://') ? path : `file://${path}`);

/**
 * Mounted once signed in: a shared PDF goes to "Salvar em qual matéria?" (S-MAT-04);
 * anything else gets the "only PDF" message instead of a silent drop.
 */
export function ShareIntentHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const overlay = useOverlay();

  useEffect(() => {
    if (!hasShareIntent) return;
    const pdf = (shareIntent.files ?? []).find((f) => f.mimeType === 'application/pdf' || f.fileName.toLowerCase().endsWith('.pdf'));
    resetShareIntent();
    if (!pdf) {
      overlay.snack(t('upload.only_pdf'));
      return;
    }
    useSharedFile.getState().set({ uri: toUri(pdf.path), name: pdf.fileName, size: pdf.size ?? 0, mimeType: 'application/pdf' });
    router.push('/share');
  }, [hasShareIntent, shareIntent, resetShareIntent, overlay]);

  return null;
}
