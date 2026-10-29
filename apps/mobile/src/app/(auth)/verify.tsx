import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { supabase } from '../../api/supabase';
import { ActionBar, Button, CodeField, IconTile, Screen, Text } from '../../components';
import { t } from '../../i18n';
import { space } from '../../theme';

/** S-AUTH-02 Código de verificação: 6-digit OTP; the magic link lands on /auth/callback. */
export default function Verify() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(60);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const verify = async (value = code) => {
    if (value.length !== 6 || !email) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({ email, token: value, type: 'email' });
    setBusy(false);
    // AuthGate routes to onboarding or Hoje once the session exists.
    if (err) setError(t('auth.code.invalid'));
  };

  const resend = async () => {
    if (!email) return;
    setCooldown(60);
    const res = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: 'studify://auth/callback' } }).catch(() => null);
    setError(res?.error?.status === 429 ? t('auth.code.rate_limited') : null);
  };

  return (
    <Screen
      title=""
      footer={
        <ActionBar>
          <Button label={t('auth.code.verify')} onPress={() => verify()} disabled={code.length !== 6} loading={busy} />
          <Button variant="text" label={cooldown > 0 ? t('auth.code.resend_in', { s: cooldown }) : t('auth.code.resend')} disabled={cooldown > 0} onPress={resend} />
        </ActionBar>
      }
    >
      <IconTile icon="mail-unread-outline" size={56} />
      <View style={{ gap: space.xs }}>
        <Text variant="title">{t('auth.code.title')}</Text>
        <Text tone="secondary">{t('auth.code.generic')}</Text>
        {email ? (
          <Text variant="label" tone="accent">
            {email}
          </Text>
        ) : null}
      </View>
      <CodeField
        label={t('auth.code.label')}
        value={code}
        onChange={(digits) => {
          setCode(digits);
          if (digits.length === 6) void verify(digits);
        }}
        autoFocus
        error={error}
      />
    </Screen>
  );
}
