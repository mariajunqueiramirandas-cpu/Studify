import { test } from 'bun:test';
// storage-upload and storage-sign (data-model §7): the storage policies decide who gets a signed URL, the
// bucket limits decide what may be uploaded, and with R2 the size and type are part of the signature.
import { r2Storage } from '@studify/storage';
import { assert, assertEquals } from './assert.ts';
import { ALICE, BOB, json, makeHarness, request, type Harness } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler as storageUpload } from '../src/functions/storage-upload.ts';
import { handler as storageSign } from '../src/functions/storage-sign.ts';

const GROUP = '6a000000-0000-4000-8000-000000000001';
const GROUP_SUBJECT = '5a000000-0000-4000-8000-000000000003';
const GROUP_DOC = 'd0c00000-0000-4000-8000-000000000003';

const upload = (h: Harness, path: string, opts: { size?: number; type?: string; token?: string } = {}) =>
  storageUpload(request('storage-upload', { token: opts.token, idem: null, body: { path, content_type: opts.type ?? 'application/pdf', size: opts.size ?? 2048 } }), h.deps);

const sign = async (h: Harness, paths: string[], token?: string) => {
  const res = await storageSign(request('storage-sign', { token, idem: null, body: { paths } }), h.deps);
  assertEquals(res.status, 200);
  return (await json(res)).urls as Array<string | null>;
};

/** Bob's Turma owns a shared subject; Alice is an active member. Member uploads are off. */
async function world(): Promise<Harness> {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('class_groups', { id: GROUP, name: 'Turma', owner_id: BOB.id, allow_member_uploads: false, deleted_at: null });
  h.db.seed('class_group_members', [
    { class_group_id: GROUP, user_id: BOB.id, role: 'owner', status: 'active' },
    { class_group_id: GROUP, user_id: ALICE.id, role: 'member', status: 'active' },
  ]);
  h.db.seed('subjects', { id: GROUP_SUBJECT, owner_profile_id: null, owner_class_group_id: GROUP, created_by: BOB.id, name: 'Química', content_language: 'pt-BR', is_language_subject: false, enem_area: null, deleted_at: null });
  h.db.seed('documents', { id: GROUP_DOC, subject_id: GROUP_SUBJECT, title: 'Apostila', kind: 'textbook', storage_path: `${GROUP_SUBJECT}/${GROUP_DOC}.pdf`, size_bytes: 10, checksum_sha256: 'c'.repeat(64), status: 'ready', deleted_at: null, uploaded_by: BOB.id });
  return h;
}

test('storage-upload: signs a PDF into a subject the student may upload to', async () => {
  const h = await world();
  const res = await upload(h, `documents/${IDS.subject}/${v7(1)}.pdf`);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.method, 'PUT');
  assertEquals(body.url, `https://storage.test/upload/documents/${IDS.subject}/${v7(1)}.pdf?token=t`);
  assertEquals(body.headers['Content-Type'], 'application/pdf');
  assert(Date.parse(body.expires_at) > Date.now() - 10 * 365 * 86_400_000);
});

test('storage-upload: the storage policies decide, with one answer for "not yours" and "no such subject"', async () => {
  const h = await world();
  assertEquals((await upload(h, `documents/${IDS.bobSubject}/${v7(2)}.pdf`)).status, 403);
  assertEquals((await upload(h, `documents/${v7(999)}/${v7(2)}.pdf`)).status, 403);
  // A Turma member reads the shared subject but cannot upload while member uploads are off; the owner can.
  assertEquals((await upload(h, `documents/${GROUP_SUBJECT}/${v7(3)}.pdf`)).status, 403);
  assertEquals((await upload(h, `documents/${GROUP_SUBJECT}/${v7(3)}.pdf`, { token: BOB.jwt })).status, 200);
  // Photos: only under the student's own folder.
  assertEquals((await upload(h, `photos/${ALICE.id}/${v7(4)}/1.jpg`, { type: 'image/jpeg' })).status, 200);
  assertEquals((await upload(h, `photos/${BOB.id}/${v7(4)}/1.jpg`, { type: 'image/jpeg' })).status, 403);
  // Media: readers of the subject; avatars: the own file only; server-only buckets: nobody.
  assertEquals((await upload(h, `media/${GROUP_SUBJECT}/occlusion/${v7(5)}.jpg`, { type: 'image/jpeg' })).status, 200);
  assertEquals((await upload(h, `media/${IDS.bobSubject}/occlusion/${v7(5)}.jpg`, { type: 'image/jpeg' })).status, 403);
  assertEquals((await upload(h, `avatars/${ALICE.id}.webp`, { type: 'image/webp', size: 1000 })).status, 200);
  assertEquals((await upload(h, `avatars/${BOB.id}.webp`, { type: 'image/webp', size: 1000 })).status, 403);
  for (const path of [`slices/${IDS.doc}/1-2.pdf`, `page-images/${IDS.doc}/1.webp`, `exports/${ALICE.id}/x.zip`, `audio/answers/${ALICE.id}/x.mp3`]) {
    const type = path.endsWith('.pdf') ? 'application/pdf' : path.endsWith('.webp') ? 'image/webp' : path.endsWith('.zip') ? 'application/zip' : 'audio/mpeg';
    assertEquals((await upload(h, path, { type })).status, 403, path);
  }
});

test('storage-upload: bucket type and size limits, path syntax, and write-once buckets', async () => {
  const h = await world();
  const path = `documents/${IDS.subject}/${v7(6)}.pdf`;
  assertEquals((await upload(h, path, { type: 'image/png' })).status, 400);
  const big = await upload(h, `photos/${ALICE.id}/${v7(6)}/1.jpg`, { type: 'image/jpeg', size: 15 * 1024 * 1024 + 1 });
  assertEquals(big.status, 422);
  assertEquals((await json(big)).error.message, 'Esse arquivo é grande demais (máx. 15 MB).');
  for (const bad of ['nope/a.pdf', `documents/${IDS.subject}/../x.pdf`, `documents/${IDS.subject}//x.pdf`, 'documents']) {
    assertEquals((await upload(h, bad)).status, 400, bad);
  }
  // documents and media have no update policy: an uploaded file is never replaced through a signed URL.
  h.db.objects.set(path, new Uint8Array([1]));
  assertEquals((await upload(h, path)).status, 409);
  h.db.objects.set(`photos/${ALICE.id}/${v7(6)}/1.jpg`, new Uint8Array([1]));
  assertEquals((await upload(h, `photos/${ALICE.id}/${v7(6)}/1.jpg`, { type: 'image/jpeg' })).status, 200);
});

test('storage-upload with R2: the URL signs the exact size and type', async () => {
  const h = await world();
  h.deps.storage = r2Storage({ accountId: '0123456789abcdef0123456789abcdef', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'studify' }, async (req) =>
    new Response(null, { status: req.method === 'HEAD' ? 404 : 200 }),
  );
  const res = await upload(h, `documents/${IDS.subject}/${v7(7)}.pdf`, { size: 4096 });
  assertEquals(res.status, 200);
  const url = new URL((await json(res)).url);
  assertEquals(url.host, '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com');
  assertEquals(url.pathname, `/studify/documents/${IDS.subject}/${v7(7)}.pdf`);
  assertEquals(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
  assertEquals(url.searchParams.get('X-Amz-Expires'), '3600');
});

test('storage-sign: signed URLs for what the student may read, null for the rest, in request order', async () => {
  const h = await world();
  for (const key of [
    `documents/${IDS.subject}/${IDS.doc}.pdf`,
    `documents/${GROUP_SUBJECT}/${GROUP_DOC}.pdf`,
    `page-images/${GROUP_DOC}/3.webp`,
    `page-images/${IDS.bobDoc}/3.webp`,
    `photos/${ALICE.id}/c/1.jpg`,
    `photos/${BOB.id}/c/1.jpg`,
    'enem/2023/123/1.webp',
    `audio/answers/${ALICE.id}/a.mp3`,
    `audio/answers/${BOB.id}/a.mp3`,
    `avatars/${BOB.id}.webp`,
    `slices/${IDS.doc}/1-2.pdf`,
  ]) {
    h.db.objects.set(key, new Uint8Array([1]));
  }
  const urls = await sign(h, [
    `documents/${IDS.subject}/${IDS.doc}.pdf`,
    `documents/${IDS.bobSubject}/${IDS.bobDoc}.pdf`,
    `documents/${GROUP_SUBJECT}/${GROUP_DOC}.pdf`,
    `page-images/${GROUP_DOC}/3.webp`,
    `page-images/${IDS.bobDoc}/3.webp`,
    `photos/${ALICE.id}/c/1.jpg`,
    `photos/${BOB.id}/c/1.jpg`,
    'enem/2023/123/1.webp',
    `audio/answers/${ALICE.id}/a.mp3`,
    `audio/answers/${BOB.id}/a.mp3`,
    `avatars/${BOB.id}.webp`,
    `slices/${IDS.doc}/1-2.pdf`,
    'nope/a.pdf',
  ]);
  assertEquals(
    urls.map((u) => (u ? new URL(u).pathname.slice(1) : null)),
    [
      `documents/${IDS.subject}/${IDS.doc}.pdf`,
      null,
      `documents/${GROUP_SUBJECT}/${GROUP_DOC}.pdf`,
      `page-images/${GROUP_DOC}/3.webp`,
      null,
      `photos/${ALICE.id}/c/1.jpg`,
      null,
      'enem/2023/123/1.webp',
      `audio/answers/${ALICE.id}/a.mp3`,
      null,
      // Alice and Bob share the Turma, so Bob's avatar is readable.
      `avatars/${BOB.id}.webp`,
      null,
      null,
    ],
  );
});

test('storage-sign: a student outside the Turma gets nothing of it', async () => {
  const h = await world();
  await h.db.from('class_group_members').update({ status: 'left' }).eq('user_id', ALICE.id);
  h.db.objects.set(`documents/${GROUP_SUBJECT}/${GROUP_DOC}.pdf`, new Uint8Array([1]));
  h.db.objects.set(`avatars/${BOB.id}.webp`, new Uint8Array([1]));
  assertEquals(await sign(h, [`documents/${GROUP_SUBJECT}/${GROUP_DOC}.pdf`, `avatars/${BOB.id}.webp`]), [null, null]);
});
