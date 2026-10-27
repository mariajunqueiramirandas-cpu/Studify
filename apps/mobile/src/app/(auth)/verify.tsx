import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { supabase } from '../../api/supabase';
import { ActionBar, Button, Screen, Text, TextField } from '../../components';
import { t } from '../../i18n';

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
    await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: 'studify://auth/callback' } }).catch(() => undefined);
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
      <Text variant="title">{t('auth.code.title')}</Text>
      <Text tone="secondary">{t('auth.code.generic')}</Text>
      <TextField
        label={t('auth.code.label')}
        value={code}
        onChangeText={(v) => {
          const digits = v.replace(/\D/g, '').slice(0, 6);
          setCode(digits);
          if (digits.length === 6) void verify(digits);
        }}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        autoFocus
        error={error}
        style={{ fontSize: 28, letterSpacing: 8, textAlign: 'center' }}
      />
    </Screen>
  );
}
