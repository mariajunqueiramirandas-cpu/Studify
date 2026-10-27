// Limits from the specs, in one place (spec 01 §4 ING-01.2, ING-02.5, §8.1; ai-pipeline §4.1).
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_PAGES = 1000;
/** Raw slice size for a Claude request, leaving room for base64 and the prompt (spec 01 §8.1). */
export const MAX_SLICE_BYTES = 20 * 1024 * 1024;
/** Topic slices are split into consecutive slices of at most this many pages (spec 01 §8.1). */
export const TOPIC_SLICE_PAGES = 60;
export const OUTLINE_SLICE_PAGES = 150;
/** Transcription requests take at most this many scanned pages (ING-02.6, T4). */
export const TRANSCRIPTION_PAGES = 20;
