import { useState } from 'react';
import { supabase } from '../../../api/supabase';
import { ActionBar, Banner, Button, Screen, Text, TextField, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { resetAccount } from '../../../features/profile/api';
import { wipeLocalDataAndRestart } from '../../../features/profile/reset';
import { t } from '../../../i18n';
import { messageFor } from '../../../api/messages';

/** Recomeçar do zero: explain → re-auth code → typed ZERAR → everything wiped, login kept, onboarding again. */
export default function ResetAccount() {
  const { email } = useSession();
  const overlay = useOverlay();
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const word = t('reset_account.confirm_word');

  return (
    <Screen
      title={t('reset_account.title')}
      footer={
        <ActionBar>
          {!codeSent ? (
            <Button
              variant="destructive"
              label={t('global.continue')}
              onPress={async () => {
                if (email) await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }).catch(() => undefined);
                setCodeSent(true);
              }}
            />
          ) : (
            <Button
              variant="destructive"
              label={t('reset_account.button')}
              loading={busy}
              disabled={code.length !== 6 || typed.trim().toUpperCase() !== word}
              onPress={async () => {
                setBusy(true);
                try {
                  await resetAccount(code);
                } catch (e) {
                  // The server explains what blocked it (wrong code, Turma owner); nothing was erased.
                  overlay.snack(messageFor(e));
                  setBusy(false);
                  return;
                }
                overlay.snack(t('reset_account.done'));
                await wipeLocalDataAndRestart();
              }}
            />
          )}
        </ActionBar>
      }
    >
      <Banner kind="danger" message={t('reset_account.explain')} />
      <Text tone="secondary">{t('reset_account.kept')}</Text>
      {codeSent ? (
        <>
          <Text>{t('reset_account.reauth')}</Text>
          <TextField label={t('auth.code.label')} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" />
          <TextField label={t('reset_account.type_confirm')} value={typed} onChangeText={setTyped} autoCapitalize="characters" />
        </>
      ) : null}
    </Screen>
  );
}
