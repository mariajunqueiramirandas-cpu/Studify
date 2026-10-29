// Image-occlusion card creation (MEM-03): the image is re-encoded on device (≤ 1568 px), ML Kit proposes masks
// from the text it reads (MEM-03.2), and saving uploads the image to media/{subject}/occlusion/… and inserts one
// card per labeled mask with a shared sibling group (MEM-03.4). Personal by default in a Turma subject (03.7).
import TextRecognition from '@react-native-ml-kit/text-recognition';
import { CAPTURE_IMAGE, fitLongEdge, occlusionCardText, occlusionCardsFor, suggestMasks, type OcclusionMask, type OcclusionMode } from '@studify/shared';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { uploadFile } from '../../api/storage';

export interface OcclusionSource {
  uri: string;
  width: number;
  height: number;
}

/** Resizes the image and suggests masks from recognized text. Recognition failures leave the mask list empty. */
export async function prepareOcclusionImage(source: OcclusionSource): Promise<OcclusionSource & { masks: OcclusionMask[] }> {
  const size = fitLongEdge(source.width, source.height, CAPTURE_IMAGE.longEdge);
  const context = ImageManipulator.manipulate(source.uri);
  if (size.width !== source.width || size.height !== source.height) context.resize(size);
  const saved = await (await context.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: CAPTURE_IMAGE.jpegQuality });
  let masks: OcclusionMask[] = [];
  try {
    const result = await TextRecognition.recognize(saved.uri);
    const boxes = result.blocks.flatMap((b) => b.lines).filter((l) => l.frame).map((l) => ({ text: l.text, frame: l.frame! }));
    masks = suggestMasks(boxes, saved.width, saved.height);
  } catch {
    masks = [];
  }
  return { uri: saved.uri, width: saved.width, height: saved.height, masks };
}

export async function createOcclusionCards(
  _userId: string,
  input: { subjectId: string; nodeId: string; image: OcclusionSource; masks: OcclusionMask[]; mode: OcclusionMode; personal: boolean },
): Promise<number> {
  const object = `${input.subjectId}/occlusion/${uuidv7()}.jpg`;
  await uploadFile({ bucket: 'media', path: object, uri: input.image.uri, contentType: 'image/jpeg' });
  const medias = occlusionCardsFor({ path: `media/${object}`, width: input.image.width, height: input.image.height }, input.masks, input.mode);
  const group = uuidv7();
  const cards = medias.map((media) => {
    const text = occlusionCardText(media);
    return { id: uuidv7(), front: text.front, back: text.back, media };
  });
  if (cards.length === 0) return 0;
  await data(
    'learn-occlusion-cards',
    { subject_id: input.subjectId, node_id: input.nodeId, sibling_group_id: group, personal: input.personal, cards },
    { idempotencyKey: group },
  );
  return cards.length;
}
