import { Directory, File, Paths } from 'expo-file-system';
import { getKv } from '../../lib/kv';
import { signedUrl, type DocumentRow } from './api';

// PDFs are downloaded only when the viewer opens or on "Baixar para offline" (mobile-app.md §4.1).
const dir = () => new Directory(Paths.document, 'pdfs');
const KEY = 'offline_docs';

function list(): string[] {
  try {
    return JSON.parse(getKv().getString(KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function isDocumentDownloaded(documentId: string): boolean {
  return list().includes(documentId) && new File(dir(), `${documentId}.pdf`).exists;
}

export function localDocumentUri(documentId: string): string | null {
  const f = new File(dir(), `${documentId}.pdf`);
  return f.exists ? f.uri : null;
}

/** Downloads the PDF into the app's document dir (counts toward the storage quota). */
export async function downloadDocumentForOffline(doc: Pick<DocumentRow, 'id' | 'storage_path'>): Promise<string> {
  const existing = localDocumentUri(doc.id);
  if (existing) return existing;
  const url = await signedUrl('documents', doc.storage_path);
  if (!url) throw new Error('no_url');
  const d = dir();
  if (!d.exists) d.create({ intermediates: true });
  const file = await File.downloadFileAsync(url, new File(d, `${doc.id}.pdf`));
  getKv().set(KEY, JSON.stringify([...new Set([...list(), doc.id])]));
  return file.uri;
}

export function clearDownloads(): void {
  const d = dir();
  if (d.exists) d.delete();
  getKv().set(KEY, '[]');
}

export function downloadsSize(): number {
  const d = dir();
  if (!d.exists) return 0;
  return d.list().reduce((sum, f) => sum + (f instanceof File ? (f.size ?? 0) : 0), 0);
}
