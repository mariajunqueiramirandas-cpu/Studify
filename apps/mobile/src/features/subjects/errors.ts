/** documents.error_code → copy key (copy-pt-br §4.3). */
export const DOCUMENT_ERROR_KEYS: Record<string, string> = {
  password_protected: 'ingest.password',
  corrupt: 'ingest.corrupt',
  empty: 'ingest.corrupt',
  too_large: 'ingest.too_large',
  too_many_pages: 'ingest.too_many_pages',
  not_study_material: 'ingest.not_study',
  ai_failed: 'ingest.failed',
  ai_refused: 'ingest.failed',
  unsupported_type: 'upload.only_pdf',
};
