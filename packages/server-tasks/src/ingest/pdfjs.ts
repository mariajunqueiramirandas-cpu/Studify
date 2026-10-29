// pdf.js (legacy build, required on Node) with a @napi-rs/canvas factory. Shared by preflight, text
// extraction and rendering. Node 22 has no Promise.try; the legacy build carries the polyfills.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';

export { pdfjs };

/** The subset of PDFDocumentProxy the pipeline uses (the legacy typings omit destroy()). */
export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

export interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
  render(params: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
}

interface CanvasHandle {
  canvas: Canvas;
  context: SKRSContext2D;
}

export class NodeCanvasFactory {
  create(width: number, height: number): CanvasHandle {
    const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(handle: CanvasHandle, width: number, height: number): void {
    handle.canvas.width = Math.max(1, Math.ceil(width));
    handle.canvas.height = Math.max(1, Math.ceil(height));
  }

  destroy(handle: CanvasHandle): void {
    handle.canvas.width = 0;
    handle.canvas.height = 0;
  }
}

/** Opens a PDF with pdf.js. Throws PasswordException / InvalidPDFException on the failure cases. */
export async function openPdf(bytes: Uint8Array): Promise<PdfDocumentLike> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    canvasFactory: new NodeCanvasFactory(),
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = (await task.promise) as unknown as { numPages: number; getPage(n: number): Promise<PdfPageLike> };
  // pdf.js destroys the document through its loading task.
  return {
    numPages: doc.numPages,
    getPage: (n: number) => doc.getPage(n),
    destroy: () => task.destroy(),
  } as PdfDocumentLike;
}
