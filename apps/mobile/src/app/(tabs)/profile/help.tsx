import { useState } from 'react';
import { Linking } from 'react-native';
import { BottomSheet, Button, Card, ListItem, Screen, TextField, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { sendFeedback } from '../../../features/profile/api';
import { PUBLIC_BASE_URL } from '../../../features/common/links';
import { t } from '../../../i18n';

const BASE = PUBLIC_BASE_URL;

/** S-PERF-15 Ajuda e sobre (SP-13, SP-15, PLT-06.5 feedback). */
export default function Help() {
  const { userId } = useSession();
  const overlay = useOverlay();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  return (
    <Screen title={t('help.title')}>
      <Card>
        <ListItem icon="document-text-outline" title={t('help.privacy_notice')} onPress={() => void Linking.openURL(`${BASE}/privacidade`)} />
        <ListItem icon="reader-outline" title={t('help.terms')} onPress={() => void Linking.openURL(`${BASE}/termos`)} />
        <ListItem icon="download-outline" title={t('help.install_help')} onPress={() => void Linking.openURL(`${BASE}/instalar`)} />
        <ListItem icon="chatbox-ellipses-outline" title={t('help.feedback')} onPress={() => setOpen(true)} />
      </Card>
      <BottomSheet
        visible={open}
        onClose={() => setOpen(false)}
        title={t('help.feedback')}
        footer={
          <Button
            label={t('flag.send')}
            disabled={!body.trim()}
            onPress={async () => {
              await sendFeedback(userId!, body.trim()).catch(() => undefined);
              setOpen(false);
              setBody('');
              overlay.snack(t('help.feedback_sent'));
            }}
          />
        }
      >
        <TextField value={body} onChangeText={setBody} multiline placeholder={t('help.feedback_placeholder')} accessibilityLabel={t('help.feedback')} maxLength={2000} />
      </BottomSheet>
    </Screen>
  );
}
