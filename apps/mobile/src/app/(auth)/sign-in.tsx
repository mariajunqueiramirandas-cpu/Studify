import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { supabase } from '../../api/supabase';
import { ActionBar, Banner, Button, CapiScene, Screen, Spacer, Text, TextField, useOnline, useOverlay } from '../../components';
import { classifyGoogleError, signInWithGoogle, googleAvailable } from '../../features/auth/google';
import { t } from '../../i18n';
import { sitePage } from '../../features/common/links';
import { space } from '../../theme';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** S-AUTH-01 Entrar (PLT-02): Google or e-mail. No passwords. */
export default function SignIn() {
  const online = useOnline();
  const overlay = useOverlay();
  const [mode, setMode] = useState<'choose' | 'email'>('choose');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const sendCode = async () => {
    setBusy(true);
    try {
      // Same e-mail carries the magic link and the 6-digit code (mobile-app.md §12).
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true, emailRedirectTo: 'studify://auth/callback' } });
      // Generic response otherwise so e-mails can't be enumerated (security §3). The rate limit says nothing
      // about the address, and without it a repeat request looks sent when no e-mail went out.
      if (error?.status === 429) overlay.snack(t('auth.code.rate_limited'));
    } catch {
      // Network failures get the same generic response.
    } finally {
      setBusy(false);
      router.push({ pathname: '/verify', params: { email: email.trim().toLowerCase() } });
    }
  };

  const google = async () => {
    setBusy(true);
    try {
      await signInWithGoogle();
    } catch (error) {
      const failure = classifyGoogleError(error);
      if (failure === 'misconfigured') overlay.snack(t('auth.google_misconfigured'));
      else if (failure === 'play_services') overlay.snack(t('auth.google_play_services'));
      else if (failure === 'failed') overlay.snack(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      root
      hideOfflineBanner
      footer={
        <ActionBar>
          {mode === 'choose' ? (
            <>
              <Button label={t('auth.google')} icon="logo-google" onPress={google} disabled={!online || !googleAvailable()} loading={busy} />
              <Button variant="secondary" label={t('auth.email')} icon="mail-outline" onPress={() => setMode('email')} disabled={!online} />
            </>
          ) : (
            <>
              <Button label={t('auth.send_code')} onPress={sendCode} disabled={!online || !EMAIL_RE.test(email.trim())} loading={busy} />
              <Button variant="text" label={t('global.back')} onPress={() => setMode('choose')} />
            </>
          )}
          <Button variant="text" compact label={t('auth.privacy_link')} onPress={() => void Linking.openURL(sitePage('privacidade'))} />
        </ActionBar>
      }
    >
      <Spacer size={space.xl} />
      <View style={{ alignItems: 'center', gap: space.md }}>
        <CapiScene scene="hello" size={200} />
        <Text variant="display" align="center" style={{ fontSize: 40, lineHeight: 44 }}>
          Studify
        </Text>
        <Text variant="heading" tone="secondary" align="center">
          {t('auth.title')}
        </Text>
      </View>
      <Spacer />
      {!online ? <Banner kind="warning" message={t('auth.offline')} /> : null}
      {mode === 'email' ? (
        <TextField
          label={t('auth.email_label')}
          placeholder={t('auth.email_placeholder')}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          autoFocus
          onSubmitEditing={() => EMAIL_RE.test(email.trim()) && sendCode()}
        />
      ) : null}
      {mode === 'choose' && !googleAvailable() ? <Text variant="bodySmall" tone="secondary" align="center">{t('auth.google_unavailable')}</Text> : null}
    </Screen>
  );
}
