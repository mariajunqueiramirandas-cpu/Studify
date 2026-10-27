import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { Linking, Share, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { ActionBar, Button, Card, Screen, Text, useOverlay } from '../../../../components';
import { formatInviteCode } from '../../../../features/auth/onboarding';
import { rotateInvite, useClassGroup, useInvite } from '../../../../features/class/api';
import { longDate } from '../../../../features/common/format';
import { classInviteLink } from '../../../../features/common/links';
import { t } from '../../../../i18n';
import { space, useTheme } from '../../../../theme';

/** S-TUR-06 Convidar: code, QR, WhatsApp, copy link (SOC-01.3–01.4, SOC-09.5). */
export default function Invite() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const cg = useClassGroup(classGroupId);
  const invite = useInvite(classGroupId);
  const overlay = useOverlay();
  const { colors } = useTheme();
  const code = invite.data?.code ?? '';
  const link = code ? classInviteLink(code) : '';
  const message = t('class.invite.whatsapp', { name: cg.data?.group?.name ?? '', link, code: formatInviteCode(code) });

  return (
    <Screen
      title={t('class.invite.title')}
      footer={
        <ActionBar>
          <Button
            icon="logo-whatsapp"
            label={t('class.invite.share_whatsapp')}
            disabled={!code}
            onPress={async () => {
              const url = `whatsapp://send?text=${encodeURIComponent(message)}`;
              if (await Linking.canOpenURL(url)) await Linking.openURL(url);
              else await Share.share({ message });
            }}
          />
          <Button
            variant="secondary"
            icon="copy-outline"
            label={t('class.invite.copy_link')}
            disabled={!code}
            onPress={async () => {
              await Clipboard.setStringAsync(link);
              overlay.snack(t('class.invite.copied'));
            }}
          />
        </ActionBar>
      }
    >
      <Card>
        <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.md }}>
          <Text variant="label" tone="secondary">
            {t('class.invite.code')}
          </Text>
          <Text variant="display" accessibilityLabel={code.split('').join(' ')}>
            {formatInviteCode(code) || '—'}
          </Text>
          {link ? (
            <View style={{ padding: space.md, backgroundColor: '#FFFFFF', borderRadius: 12 }}>
              <QRCode value={link} size={200} color="#111827" backgroundColor="#FFFFFF" />
            </View>
          ) : null}
          {invite.data?.expires_at ? (
            <Text variant="bodySmall" tone="secondary">
              {t('class.invite.expires', { date: longDate(invite.data.expires_at) })}
            </Text>
          ) : null}
        </View>
      </Card>
      {cg.data?.isMod ? (
        <Button
          variant="text"
          icon="refresh-outline"
          label={t('class.invite.new_code')}
          onPress={async () => {
            if (!(await overlay.confirm({ title: t('class.invite.new_code') }))) return;
            await rotateInvite(classGroupId).catch(() => overlay.snack(t('error.permission')));
            void invite.refetch();
          }}
        />
      ) : null}
      {void colors}
    </Screen>
  );
}
