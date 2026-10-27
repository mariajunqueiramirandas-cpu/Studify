// Câmera Mágica photo preparation, all on device (spec 11 §8.1–8.2, CAM-00.6): the photo is re-encoded at
// ≤ 1568 px long edge (which also drops EXIF and location), checked for blur, darkness and glare on a 1024-px
// copy, and every face ML Kit finds is pixelated before anything is uploaded. The server never sees a face.
import FaceDetection from '@react-native-ml-kit/face-detection';
import { CAPTURE_IMAGE, CAPTURE_QUALITY, assessImageQuality, fitLongEdge, imageStats, pixelateRegions, type NormalizedBox, type QualityIssue } from '@studify/shared';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as jpeg from 'jpeg-js';

export interface PreparedPhoto {
  /** Local JPEG ready to upload (resized, EXIF-free, faces pixelated). */
  uri: string;
  width: number;
  height: number;
  issues: QualityIssue[];
  /** Faces found and pixelated (CAM-00.6). */
  faces: number;
}

async function resized(uri: string, width: number, height: number, longEdge: number, compress: number): Promise<{ uri: string; width: number; height: number }> {
  const size = fitLongEdge(width, height, longEdge);
  const context = ImageManipulator.manipulate(uri);
  if (size.width !== width || size.height !== height) context.resize({ width: size.width, height: size.height });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress });
  return { uri: saved.uri, width: saved.width, height: saved.height };
}

function decode(bytes: Uint8Array) {
  return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
}

/** §8.1 quality on a 1024-px copy. Returns the issues to show; "Usar mesmo assim" is always allowed. */
export async function photoQuality(uri: string, width: number, height: number): Promise<QualityIssue[]> {
  const small = await resized(uri, width, height, CAPTURE_QUALITY.analysisLongEdge, 0.9);
  const img = decode(await new File(small.uri).bytes());
  return assessImageQuality(imageStats(img.data, img.width, img.height));
}

/** Face boxes (normalized) found by ML Kit on the prepared image. */
async function detectFaces(uri: string, width: number, height: number): Promise<NormalizedBox[]> {
  const faces = await FaceDetection.detect(uri, { performanceMode: 'accurate', minFaceSize: 0.05 });
  return faces.map((f) => ({ x: f.frame.left / width, y: f.frame.top / height, w: f.frame.width / width, h: f.frame.height / height }));
}

/**
 * Prepares one photo for upload. When face detection is unavailable the photo is still usable, but the capture
 * is marked as not blurred, so the API refuses to add it to a Turma subject (CAM-01.7).
 */
export async function preparePhoto(source: { uri: string; width: number; height: number }): Promise<PreparedPhoto & { blurChecked: boolean }> {
  const base = await resized(source.uri, source.width, source.height, CAPTURE_IMAGE.longEdge, CAPTURE_IMAGE.jpegQuality);
  const issues = await photoQuality(base.uri, base.width, base.height).catch(() => [] as QualityIssue[]);
  let boxes: NormalizedBox[];
  try {
    boxes = await detectFaces(base.uri, base.width, base.height);
  } catch {
    return { ...base, issues, faces: 0, blurChecked: false };
  }
  if (boxes.length === 0) return { ...base, issues, faces: 0, blurChecked: true };
  const img = decode(await new File(base.uri).bytes());
  pixelateRegions(img.data, img.width, img.height, boxes);
  const encoded = jpeg.encode({ data: img.data, width: img.width, height: img.height }, Math.round(CAPTURE_IMAGE.jpegQuality * 100));
  const out = new File(Paths.cache, `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
  await out.write(new Uint8Array(encoded.data));
  return { uri: out.uri, width: img.width, height: img.height, issues, faces: boxes.length, blurChecked: true };
}
