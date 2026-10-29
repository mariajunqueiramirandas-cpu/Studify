// Data endpoints of apps/mobile/src/features/camera (define.ts explains the contract): the camera_captures row the
// app creates after uploading the photos, reading and discarding it, and typed school-answer essays. Analysis and
// actions are capture-analyze / capture-act; grading is grade-essay.
import { z } from 'zod';
import { dataRoute, done, maybe, type DataRoute } from './define.ts';

const Id = z.string().uuid();
/** Every column the student may select: `solver` (the hint ladder with the answer, CAM-02.4) is server only. */
const CAPTURE_COLUMNS =
  'id,user_id,intent,subject_id,node_id,image_paths,quality_flags,faces_blurred,content_type,language,transcription,confirmed_text,edited_ratio,' +
  'detected_questions,match,result,status,error_code,saved,expires_at,document_id,question_id,essay_id,tutor_thread_id,created_at,updated_at,deleted_at';

export const routes: DataRoute[] = [
  dataRoute({
    // The photos are already at photos/{user}/{capture}/n.jpg; RLS checks every path is the student's.
    name: 'camera-data-capture-create',
    write: true,
    input: z.object({
      id: Id,
      intent: z.enum(['explain', 'solve', 'add_to_subject', 'grade_answer', 'grade_essay']),
      subject_id: Id.nullable().optional(),
      node_id: Id.nullable().optional(),
      image_paths: z.array(z.string().min(1).max(300)).min(1).max(20),
      quality_flags: z.object({ device: z.array(z.unknown()).max(20).optional(), faces: z.number().int().min(0).optional() }).passthrough(),
      faces_blurred: z.boolean(),
    }),
    example: (seed) => {
      const id = crypto.randomUUID();
      return { id, intent: 'explain' as const, subject_id: seed.subjectId, image_paths: [`photos/${seed.userId}/${id}/1.jpg`], quality_flags: { device: [[]], faces: 0 }, faces_blurred: true };
    },
    run: async ({ db, user, input }) => {
      await done(
        db.from('camera_captures').insert({
          id: input.id,
          user_id: user.userId,
          intent: input.intent,
          subject_id: input.subject_id ?? null,
          node_id: input.node_id ?? null,
          image_paths: input.image_paths,
          quality_flags: input.quality_flags,
          faces_blurred: input.faces_blurred,
        }),
      );
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'camera-data-capture',
    write: false,
    input: z.object({ capture_id: Id }),
    example: (seed) => ({ capture_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('camera_captures').select(CAPTURE_COLUMNS).eq('id', input.capture_id).maybeSingle()),
  }),

  dataRoute({
    // An unsaved capture; the photos follow with the nightly purge (spec 11 §8.4).
    name: 'camera-data-capture-discard',
    write: true,
    input: z.object({ capture_id: Id }),
    example: (seed) => ({ capture_id: seed.missingId }),
    run: async ({ db, input, now }) => {
      await done(db.from('camera_captures').update({ deleted_at: now.toISOString() }).eq('id', input.capture_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'camera-data-essay',
    write: false,
    input: z.object({ essay_id: Id }),
    example: (seed) => ({ essay_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('essays').select('*').eq('id', input.essay_id).maybeSingle()),
  }),

  dataRoute({
    // PRA-07.1 typed school answer: the question goes in `prompt`; a new version points at the earlier one (07.8).
    name: 'camera-data-essay-create',
    write: true,
    input: z.object({
      id: Id,
      text: z.string().max(20_000),
      question_id: Id.nullable().optional(),
      question_text: z.string().max(5_000).nullable().optional(),
      max_points: z.number().min(0).max(1000).nullable().optional(),
      subject_id: Id.nullable().optional(),
      parent_essay_id: Id.nullable().optional(),
    }),
    example: () => ({ id: crypto.randomUUID(), text: 'A velocidade média é a razão entre deslocamento e tempo.', question_text: 'Defina velocidade média.', max_points: 10 }),
    run: async ({ db, user, input }) => {
      await done(
        db.from('essays').insert({
          id: input.id,
          user_id: user.userId,
          kind: 'school_answer',
          question_id: input.question_id ?? null,
          text: input.text,
          input_mode: 'typed',
          parent_essay_id: input.parent_essay_id ?? null,
          prompt: input.question_text ? { question_text: input.question_text, max_points: input.max_points ?? 10, subject_id: input.subject_id ?? null } : null,
        }),
      );
      return { id: input.id };
    },
  }),
];
