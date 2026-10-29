import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { realtime } from '../../api/realtime';
import { ActionBar, Banner, Button, Card, Celebrate, Leaderboard, QuestionView, RichContent, Screen, Text, TimerRing, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { battleAnswer, battleControl, battleJoin, type BattleStatus, type QuestionPublic } from '../../features/class/api';
import type { QuestionResponse, QuestionRow } from '../../features/practice/types';
import { t } from '../../i18n';
import { battleJoinLink } from '../../features/common/links';
import { space } from '../../theme';
import { messageFor } from '../../api/messages';

interface BattleState {
  status: BattleStatus;
  current_index: number;
  total: number;
  question?: QuestionPublic;
  opens_at?: string;
  closes_at?: string;
}
interface Reveal {
  index: number;
  correct_response: unknown;
  explanation?: string;
  distribution: Record<string, number> | null;
  leaderboard: { user_id: string; nickname: string; score: number; rank: number }[];
}

/**
 * S-TUR-12 sala de espera → S-TUR-13 pergunta/revelação → S-TUR-14 pódio (SOC-03). Server-timed;
 * correctness only arrives on the channel at reveal time. Big tap targets, one-hand use.
 */
export default function BattleScreen() {
  const { battleId, pin: pinParam, host } = useLocalSearchParams<{ battleId: string; pin?: string; host?: string }>();
  const { userId } = useSession();
  const overlay = useOverlay();
  const [state, setState] = useState<BattleState>({ status: 'lobby', current_index: -1, total: 0 });
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [podium, setPodium] = useState<Reveal['leaderboard'] | null>(null);
  const [players, setPlayers] = useState<{ user_id: string; nickname: string }[]>([]);
  const [answered, setAnswered] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [reconnecting, setReconnecting] = useState(false);
  const isHost = !!host;
  const joined = useRef(false);

  useEffect(() => {
    if (!isHost && !joined.current && pinParam) {
      joined.current = true;
      void battleJoin(pinParam).catch((e: unknown) => overlay.snack(messageFor(e)));
    }
    const channel = realtime.channel(`battle:${battleId}`, { presence: { key: userId ?? 'anon' } });
    channel
      .on('broadcast', { event: 'state' }, ({ payload }) => {
        const s = payload as BattleState;
        setState(s);
        if (s.status === 'question_open') setReveal(null);
      })
      .on('broadcast', { event: 'reveal' }, ({ payload }) => setReveal(payload as Reveal))
      .on('broadcast', { event: 'podium' }, ({ payload }) => setPodium((payload as { leaderboard: Reveal['leaderboard'] }).leaderboard))
      .on('presence', { event: 'sync' }, () => {
        const list = Object.values(channel.presenceState()).flat() as unknown as { user_id: string; nickname: string }[];
        setPlayers(list);
      })
      .subscribe((status) => {
        setReconnecting(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT');
        if (status === 'SUBSCRIBED') void channel.track({ user_id: userId, nickname: '' });
      });
    return () => {
      void realtime.removeChannel(channel);
    };
  }, [battleId, userId, isHost, pinParam, overlay]);

  useEffect(() => {
    if (state.status !== 'question_open') return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [state.status]);

  const control = async (action: 'start' | 'next' | 'end') => {
    try {
      await battleControl({ action, battle_id: battleId });
    } catch (e) {
      overlay.snack(messageFor(e));
    }
  };

  const submit = async (r: QuestionResponse) => {
    if (answered === state.current_index) return;
    setAnswered(state.current_index);
    const res = await battleAnswer(battleId, state.current_index, r).catch(() => ({ accepted: false }));
    if (!res.accepted) overlay.snack(t('battle.time_up'));
  };

  if (podium || state.status === 'podium' || state.status === 'ended') {
    const me = podium?.find((p) => p.user_id === userId);
    return (
      <Screen title={t('battle.podium')} immersive footer={<ActionBar><Button label={t('global.close')} onPress={() => router.back()} /></ActionBar>}>
        {me ? <Celebrate text={t('battle.place', { n: me.rank })} /> : null}
        <Leaderboard rows={(podium ?? []).map((p) => ({ id: p.user_id, name: p.nickname, score: p.score, rank: p.rank }))} meId={userId ?? ''} />
      </Screen>
    );
  }

  if (state.status === 'lobby') {
    return (
      <Screen
        title={t('battle.title')}
        immersive
        footer={
          isHost ? (
            <ActionBar>
              <Button label={t('battle.start')} disabled={players.length < 2} onPress={() => control('start')} />
            </ActionBar>
          ) : undefined
        }
      >
        <Banner kind="neutral" icon="timer-outline" message={t('battle.timer_notice')} />
        {pinParam ? (
          <Card>
            <View style={{ alignItems: 'center', gap: space.md }}>
              <Text variant="display">{t('battle.pin', { pin: pinParam })}</Text>
              {isHost ? (
                <View style={{ padding: space.md, backgroundColor: '#FFFFFF', borderRadius: 12 }}>
                  <QRCode value={battleJoinLink(String(pinParam))} size={180} />
                </View>
              ) : null}
            </View>
          </Card>
        ) : null}
        <Text variant="heading">{t('battle.players', { n: players.length })}</Text>
        {players.length < 2 ? <Text tone="secondary">{t('battle.waiting')}</Text> : null}
      </Screen>
    );
  }

  const q = state.question;
  const closes = state.closes_at ? new Date(state.closes_at).getTime() : now;
  const opens = state.opens_at ? new Date(state.opens_at).getTime() : now - 20_000;
  return (
    <Screen
      title={`${state.current_index + 1}/${state.total}`}
      immersive
      actions={state.status === 'question_open' ? <TimerRing totalMs={Math.max(1, closes - opens)} remainingMs={Math.max(0, closes - now)} /> : null}
      footer={
        isHost && (state.status === 'reveal' || state.status === 'question_closed') ? (
          <ActionBar>
            <Button label={state.current_index + 1 >= state.total ? t('battle.podium') : t('battle.next')} onPress={() => control(state.current_index + 1 >= state.total ? 'end' : 'next')} />
          </ActionBar>
        ) : undefined
      }
    >
      {reconnecting ? <Banner kind="warning" message={t('battle.reconnecting')} /> : null}
      {q ? (
        <QuestionView
          question={q as unknown as QuestionRow}
          response={null}
          onChange={() => undefined}
          submitOnTap={state.status === 'question_open' && answered !== state.current_index ? (r) => void submit(r) : undefined}
          distribution={reveal?.distribution ?? null}
        />
      ) : null}
      {answered === state.current_index && !reveal ? <Text tone="secondary" align="center">{t('battle.answered')}</Text> : null}
      {reveal ? (
        <View style={{ gap: space.md }}>
          {!reveal.distribution ? <Text variant="bodySmall" tone="secondary">{t('battle.distribution_hidden')}</Text> : null}
          {reveal.explanation ? <RichContent variant="reading" text={reveal.explanation} /> : null}
          <Leaderboard rows={reveal.leaderboard.map((p) => ({ id: p.user_id, name: p.nickname, score: p.score, rank: p.rank }))} meId={userId ?? ''} />
        </View>
      ) : null}
    </Screen>
  );
}
