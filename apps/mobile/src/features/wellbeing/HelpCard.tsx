// WEL-03.5 "Precisa conversar?": CVV 188 (free, 24 h), the cvv.org.br chat and SAMU 192.
import { HELP_CARD } from '@studify/shared';
import { Linking } from 'react-native';
import { Button, Card, Text } from '../../components';
import { t } from '../../i18n';

export function HelpCard() {
  return (
    <Card tone="soft">
      <Text variant="heading">{t('wellbeing.help_title')}</Text>
      <Text>{t('help.card')}</Text>
      <Button icon="call-outline" label={t('wellbeing.call_cvv', { phone: HELP_CARD.cvvPhone })} onPress={() => void Linking.openURL(`tel:${HELP_CARD.cvvPhone}`)} />
      <Button variant="secondary" icon="chatbubbles-outline" label={t('wellbeing.chat_cvv')} onPress={() => void Linking.openURL(HELP_CARD.cvvChatUrl)} />
      <Button variant="text" icon="medkit-outline" label={t('wellbeing.call_samu', { phone: HELP_CARD.samuPhone })} onPress={() => void Linking.openURL(`tel:${HELP_CARD.samuPhone}`)} />
    </Card>
  );
}
