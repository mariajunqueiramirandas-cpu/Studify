import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ErrorState, Screen, SkeletonList } from '../../components';
import { battleJoin } from '../../features/class/api';
import { t } from '../../i18n';

/** Deep link `studify://class/battle/join?pin=` and `/b/{pin}` → join, then open the battle (SOC-03.3). */
export default function JoinBattle() {
  const { pin } = useLocalSearchParams<{ pin?: string }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!pin) return;
    battleJoin(pin)
      .then((r) => router.replace({ pathname: '/battle/[battleId]', params: { battleId: r.battle_id, pin } }))
      .catch(() => setError(true));
  }, [pin]);
  if (!pin) return <Redirect href="/battle/new" />;
  return <Screen title={t('battle.title')}>{error ? <ErrorState message={t('error.not_found')} /> : <SkeletonList rows={2} />}</Screen>;
}
