import { test } from 'bun:test';
// Salas de estudo (SOC-05): only members open and join, the host alone drives the shared timer, reactions are
// limited to one per 5 s, a room holds 20. Podcast (INT-01): a cached episode is reused at no cost, a new one
// goes to the worker, and ✋ answers stream with cloud audio when TTS is configured, device audio otherwise.
import type { TtsProvider } from '@studify/speech';
import { silentFrame } from '@studify/speech';
import { assert, assertEquals } from './assert.ts';
import { ALICE, BOB, json, makeHarness, parseSse, request, type Harness } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import type { BroadcastMessage, P2Deps } from '../src/shared-p2/deps.ts';
import { handler as roomControl } from '../src/functions/room-control.ts';
import { handler as podcastCreate } from '../src/functions/podcast-create.ts';
import { handler as podcastAsk } from '../src/functions/podcast-ask.ts';

const GROUP = '6a000000-0000-4000-8000-0000000000e0';
const CAROL = { id: '0190a000-0000-7000-8000-0000000000c0', jwt: 'jwt-carol' };

function p2(h: Harness, extra: Partial<P2Deps> = {}): { deps: P2Deps; broadcasts: BroadcastMessage[] } {
  const broadcasts: BroadcastMessage[] = [];
  const deps: P2Deps = {
    ...h.deps,
    userRpc: () => Promise.resolve({ data: null, error: { message: 'no rpc' } }),
    broadcast: (messages) => {
      broadcasts.push(...messages);
      return Promise.resolve();
    },
    baseUrl: 'studify.test',
    randomInt: () => 0,
    randomBytes: (n) => new Uint8Array(n),
    ...extra,
  };
  return { deps, broadcasts };
}

async function turma(): Promise<Harness> {
  const h = makeHarness();
  await seedWorld(h);
  h.db.users.set(CAROL.jwt, { id: CAROL.id, email: 'carol@example.com' });
  h.db.seed('class_groups', { id: GROUP, name: 'Turma', settings: {}, deleted_at: null });
  h.db.seed('class_group_members', [
    { class_group_id: GROUP, user_id: ALICE.id, role: 'owner', status: 'active', nickname: 'Ali' },
    { class_group_id: GROUP, user_id: BOB.id, role: 'member', status: 'active', nickname: null },
  ]);
  return h;
}

const room = (body: Record<string, unknown>, token = ALICE.jwt, n = 1) => request('room-control', { token, body, idem: v7(n) });

test('room-control: members open and join; the host alone drives the timer, stamped with server time', async () => {
  const h = await turma();
  const { deps, broadcasts } = p2(h);
  const created = await roomControl(room({ action: 'create', class_group_id: GROUP, name: 'Foco de bio', timer_config: { focus_min: 25, break_min: 5 }, group_goal: { kind: 'cards', target: 50 } }), deps);
  assertEquals(created.status, 200);
  const r = await json(created);
  assertEquals(r.members, 1);
  assertEquals(r.goal, { progress: 0, target: 50, kind: 'cards' });
  assert(broadcasts.some((b) => b.topic === `turma:${GROUP}` && b.event === 'room_opened'));

  // Carol is not in the Turma: she can neither open a room there nor see this one.
  const carolCreate = await roomControl(room({ action: 'create', class_group_id: GROUP, name: 'Intrusa' }, CAROL.jwt, 2), deps);
  assertEquals(carolCreate.status, 403);
  const carolJoin = await roomControl(room({ action: 'join', room_id: r.room_id }, CAROL.jwt, 3), deps);
  assertEquals(carolJoin.status, 404);

  // Alice blocked Bob: both still study in the room, but neither app shows the other (SOC-X.3).
  h.db.seed('user_blocks', { blocker_id: ALICE.id, blocked_id: BOB.id });
  const joined = await json(await roomControl(room({ action: 'join', room_id: r.room_id }, BOB.jwt, 4), deps));
  assertEquals(joined.members, 2);
  assertEquals(joined.hidden_user_ids, [ALICE.id]);
  const bobStart = await roomControl(room({ action: 'start', room_id: r.room_id }, BOB.jwt, 5), deps);
  assertEquals(bobStart.status, 403);

  const started = await json(await roomControl(room({ action: 'start', room_id: r.room_id }, ALICE.jwt, 6), deps));
  assertEquals(started.timer_state.phase, 'focus');
  assertEquals(started.timer_state.started_at, new Date(Date.parse('2026-10-27T15:00:00Z')).toISOString());
  const timer = broadcasts.find((b) => b.topic === `room:${r.room_id}` && b.event === 'timer')!;
  assertEquals(timer.private, true);
  assertEquals((timer.payload as { phase: string }).phase, 'focus');

  // Cards Bob reviews while in the room count toward the group goal (total only).
  h.db.seed('review_logs', { id: v7(800), user_id: BOB.id, card_id: IDS.card, reviewed_at: '2026-10-27T15:00:00.000Z' });
  const status = await json(await roomControl(room({ action: 'status', room_id: r.room_id, status_mode: 'hidden' }, BOB.jwt, 7), deps));
  assertEquals(status.goal.progress, 1);
});

test('room-control: one reaction per 5 s, nickname first; a full room refuses the 21st member', async () => {
  const h = await turma();
  const { deps, broadcasts } = p2(h);
  const r = await json(await roomControl(room({ action: 'create', class_group_id: GROUP, name: 'Sala' }), deps));
  const first = await roomControl(room({ action: 'react', room_id: r.room_id, reaction: '🔥' }, ALICE.jwt, 2), deps);
  assertEquals(first.status, 200);
  const reaction = broadcasts.find((b) => b.event === 'reaction')!;
  assertEquals(reaction.payload, { user_id: ALICE.id, nickname: 'Ali', reaction: '🔥' });
  const second = await roomControl(room({ action: 'react', room_id: r.room_id, reaction: '👏' }, ALICE.jwt, 3), deps);
  assertEquals(second.status, 429);

  for (let i = 0; i < 19; i++) {
    const id = `0190a000-0000-7000-8000-0000000f${String(i).padStart(4, '0')}`;
    h.db.seed('study_room_members', { room_id: r.room_id, user_id: id, joined_at: '2026-10-27T15:00:00.000Z', left_at: null });
  }
  const full = await roomControl(room({ action: 'join', room_id: r.room_id }, BOB.jwt, 4), deps);
  assertEquals(full.status, 422);
  assertEquals((await json(full)).error.code, 'class_full');

  // Only the host (or a moderator) closes the room.
  h.db.seed('class_group_members', { class_group_id: GROUP, user_id: CAROL.id, role: 'member', status: 'active', nickname: null });
  const carolClose = await roomControl(room({ action: 'close', room_id: r.room_id }, CAROL.jwt, 5), deps);
  assertEquals(carolClose.status, 403);
  const closed = await json(await roomControl(room({ action: 'close', room_id: r.room_id }, ALICE.jwt, 6), deps));
  assertEquals(closed.status, 'closed');
});

test('podcast-create: a new episode goes to the worker; the same request is then served from cache', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const body = { subject_id: IDS.subject, node_ids: [IDS.topic], style: 'overview', length_minutes: 5 };
  const res = await podcastCreate(request('podcast-create', { body, idem: v7(1) }), h.deps);
  assertEquals(res.status, 202);
  const first = await json(res);
  assertEquals(first.cached, false);
  const job = h.enqueued.find((e) => e.queue === 'podcast.generate')!;
  assertEquals(job.data.episode_id, first.episode_id);
  const episode = h.db.rows('podcast_episodes')[0]!;
  assertEquals(episode.owner_user_id, null);
  assertEquals(episode.node_ids, [IDS.topic]);

  const again = await json(await podcastCreate(request('podcast-create', { body, idem: v7(2) }), h.deps));
  assertEquals(again.episode_id, first.episode_id);
  assertEquals(again.cached, true);
  assertEquals(h.enqueued.filter((e) => e.queue === 'podcast.generate').length, 1);

  // Revisão pra prova is personal: its own row, owned by the student.
  const review = await json(await podcastCreate(request('podcast-create', { body: { ...body, style: 'exam_review' }, idem: v7(3) }), h.deps));
  assertEquals(review.cached, false);
  assertEquals(h.db.rows('podcast_episodes').find((e) => e.id === review.episode_id)!.owner_user_id, ALICE.id);

  // Bob cannot make an episode of Alice's subject.
  const bob = await podcastCreate(request('podcast-create', { token: BOB.jwt, body, idem: v7(4) }), h.deps);
  assertEquals(bob.status, 404);
});

const EPISODE = '0190a000-0000-7000-8000-0000000e9150';
const SCRIPT = {
  title: 'Fotossíntese em 5 minutos',
  segments: [
    { id: 'seg1', kind: 'hook', node_ids: [], title: 'Abertura', lines: [{ speaker: 'bia', text: 'Oi, eu sou a Bia!' }], source_pages: [] },
    {
      id: 'seg2',
      kind: 'topic',
      node_ids: [IDS.topic],
      title: 'Clorofila',
      lines: [
        { speaker: 'caio', text: 'A clorofila capta a luz do sol.' },
        { speaker: 'bia', text: 'E é por isso que a folha é verde.' },
      ],
      source_pages: [{ document_id: IDS.doc, page_start: 13, page_end: 13 }],
    },
    { id: 'seg3', kind: 'outro', node_ids: [], title: 'Tchau', lines: [{ speaker: 'caio', text: 'Até a próxima!' }], source_pages: [] },
  ],
};

function seedEpisode(h: Harness): void {
  h.db.seed('podcast_episodes', { id: EPISODE, subject_id: IDS.subject, owner_user_id: null, title: SCRIPT.title, status: 'ready', script: SCRIPT, line_timings: null });
}

const ANSWER = { content: [{ type: 'text', text: 'BIA: Boa pergunta! A clorofila reflete o verde.\nCAIO: Por isso a folha parece verde.' }] };

const fakeTts: TtsProvider = {
  id: 'fake:tts',
  voices: { bia: 'A', caio: 'B' },
  microUsdPerChar: 16,
  synthesize: (req) => Promise.resolve({ audio: silentFrame(), mime: 'audio/mpeg', durationMs: 26, billedChars: req.text.length }),
};

test('podcast-ask: the hosts answer in lines, with cloud audio when TTS is configured', async () => {
  const h = makeHarness(ANSWER);
  await seedWorld(h);
  seedEpisode(h);
  const uploads: string[] = [];
  const { deps } = p2(h, {
    tts: fakeTts,
    uploadObject: (path) => {
      uploads.push(path);
      return Promise.resolve();
    },
    signedUrl: (path) => Promise.resolve(`https://storage.test/${path}`),
  });
  const res = await podcastAsk(request('podcast-ask', { body: { episode_id: EPISODE, position_ms: 4000, question_text: 'Por que a folha é verde?', input_mode: 'text' } }), deps);
  assertEquals(res.status, 200);
  const frames = parseSse(await res.text());
  const done = frames.at(-1)!.data as { result: { lines: Array<{ speaker: string }>; tts_fallback: boolean; answer_audio_url: string; resume_at_ms: number } };
  assertEquals(done.result.lines.map((l) => l.speaker), ['bia', 'caio']);
  assertEquals(done.result.tts_fallback, false);
  assert(done.result.answer_audio_url.includes(`audio/answers/${ALICE.id}/`));
  assertEquals(done.result.resume_at_ms, 1000);
  assertEquals(uploads.length, 1);
  // TTS spend is reserved, settled and logged like a Claude call (ai-pipeline §12).
  assert(h.budget.reserved.some((r) => r.taskId === 'podcast.handTts'));
  assert(h.usage.rows.some((r) => r.task_id === 'podcast.handTts' && r.cost_micro_usd > 0));
  const stored = h.db.rows('podcast_interactions')[0]!;
  assertEquals(stored.segment_id, 'seg2');
  assertEquals(stored.tts_fallback, false);
});

test('podcast-ask: device audio without a provider; 10 questions per episode per day', async () => {
  const h = makeHarness(ANSWER);
  await seedWorld(h);
  seedEpisode(h);
  const { deps } = p2(h);
  const res = await podcastAsk(request('podcast-ask', { body: { episode_id: EPISODE, position_ms: 0, question_text: 'E a raiz?', input_mode: 'voice' } }), deps);
  const done = parseSse(await res.text()).at(-1)!.data as { result: { tts_fallback: boolean; answer_audio_url: string | null } };
  assertEquals(done.result.tts_fallback, true);
  assertEquals(done.result.answer_audio_url, null);

  for (let i = 0; i < 9; i++) h.db.seed('podcast_interactions', { id: v7(900 + i), user_id: ALICE.id, episode_id: EPISODE, created_at: '2026-10-27T14:00:00.000Z' });
  const capped = await podcastAsk(request('podcast-ask', { body: { episode_id: EPISODE, position_ms: 0, question_text: 'Mais uma?', input_mode: 'text' }, idem: v7(2) }), deps);
  assertEquals(capped.status, 429);
  assertEquals((await json(capped)).error.details.open_tutor, true);
});
