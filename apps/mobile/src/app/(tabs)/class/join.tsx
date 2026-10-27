import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { callFunction } from '../../../api/functions';
import { ActionBar, Banner, Button, Screen, Text, TextField, useOnline } from '../../../components';
import { formatInviteCode, isValidInviteCode, normalizeInviteCode } from '../../../features/auth/onboarding';
import { useMyClassGroups } from '../../../features/class/api';
import { errorCode } from '../../../features/common/query';
import { t } from '../../../i18n';
import { radius } from '../../../theme';

const ERRORS: Record<string, string> = {
  invite_invalid: 'onb.invite.invalid',
  invite_expired: 'onb.invite.invalid',
  invite_used_up: 'onb.invite.invalid',
  class_full: 'class.full',
  rate_limited: 'error.rate_limited',
  banned: 'error.permission',
};

/** S-TUR-03 Entrar numa turma: code field + QR scan (SOC-01.2–01.5). Deep link `class/join?code=`. */
export default function JoinClass() {
  const params = useLocalSearchParams<{ code?: string }>();
  const online = useOnline();
  const groups = useMyClassGroups();
  const [code, setCode] = useState(normalizeInviteCode(params.code ?? ''));
  const [scanning, setScanning] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);

  const join = async (value = code) => {
    setBusy(true);
    setError(null);
    try {
      // join-class wraps the RPC and records failed attempts for the 5/hour limit (SOC-01.14).
      const res = await callFunction<{ code: string }, { class_group_id: string; status: 'active' | 'pending' }>('join-class', { code: value });
      void groups.refetch();
      if (res.status === 'pending') setPending(true);
      else router.replace(`/class/${res.class_group_id}`);
    } catch (e) {
      setError(t(ERRORS[errorCode(e)] ?? 'error.generic'));
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <Screen title={t('class.join')} footer={<ActionBar><Button label={t('global.done')} onPress={() => router.replace('/class')} /></ActionBar>}>
        <Banner kind="success" message={t('class.join_pending')} />
      </Screen>
    );
  }

  return (
    <Screen
      title={t('class.join')}
      footer={
        <ActionBar>
          <Button label={t('class.join_button')} loading={busy} disabled={!isValidInviteCode(code) || !online} onPress={() => join()} />
          <Button
            variant="text"
            icon="qr-code-outline"
            label={t('class.scan_qr')}
            onPress={async () => {
              if (!perm?.granted) {
                const r = await requestPerm();
                if (!r.granted) return;
              }
              setScanning(true);
            }}
          />
        </ActionBar>
      }
    >
      <Text tone="secondary">{t('class.join_hint')}</Text>
      {error ? <Banner kind="danger" message={error} /> : null}
      <TextField value={formatInviteCode(code)} onChangeText={(v) => setCode(normalizeInviteCode(v))} placeholder={t('onb.invite.placeholder')} autoCapitalize="characters" autoCorrect={false} accessibilityLabel={t('onb.invite.label')} style={{ fontSize: 24, letterSpacing: 4, textAlign: 'center' }} />
      {scanning ? (
        <View style={{ height: 320, borderRadius: radius.lg, overflow: 'hidden' }}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              const match = /(?:\/c\/|code=)([A-Za-z0-9-]{8,9})/.exec(data);
              const scanned = normalizeInviteCode(match?.[1] ?? data);
              if (isValidInviteCode(scanned)) {
                setScanning(false);
                setCode(scanned);
                void join(scanned);
              }
            }}
          />
        </View>
      ) : null}
    </Screen>
  );
}
