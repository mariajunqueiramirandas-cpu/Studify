import { useState } from 'react';
import { supabase } from '../../../api/supabase';
import { ActionBar, Banner, Button, Screen, SwitchRow, Text, TextField, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { deleteAccount } from '../../../features/profile/api';
import { t } from '../../../i18n';

/** S-PERF-12 Excluir conta: explain → re-auth code → typed EXCLUIR (SP-14, UF-22). */
export default function DeleteAccount() {
  const { email, signOut } = useSession();
  const overlay = useOverlay();
  const [shared, setShared] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const word = t('delete_account.confirm_word');

  return (
    <Screen
      title={t('delete_account.title')}
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
              label={t('delete_account.button')}
              loading={busy}
              disabled={code.length !== 6 || typed.trim() !== word}
              onPress={async () => {
                setBusy(true);
                try {
                  await deleteAccount(code, shared);
                  overlay.snack(t('delete_account.done'));
                  await signOut('global');
                } catch {
                  overlay.snack(t('auth.code.invalid'));
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}
        </ActionBar>
      }
    >
      <Banner kind="danger" message={t('delete_account.explain')} />
      <SwitchRow label={t('delete_account.shared_choice')} hint={t('delete_account.shared_note')} value={shared} onChange={setShared} />
      {codeSent ? (
        <>
          <Text>{t('delete_account.reauth')}</Text>
          <TextField label={t('auth.code.label')} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" />
          <TextField label={t('delete_account.type_confirm')} value={typed} onChangeText={setTyped} autoCapitalize="characters" />
        </>
      ) : null}
    </Screen>
  );
}
