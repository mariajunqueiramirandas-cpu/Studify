import { Linking } from 'react-native';
import { Banner, Button, Card, Screen, Text } from '../../../components';
import { t } from '../../../i18n';

/** S-PERF-10 Bem-estar — Phase 1 ships the help card (CVV 188); WEL-03 nudges are Phase 5. */
export default function Wellbeing() {
  return (
    <Screen title={t('wellbeing.title')}>
      <Card>
        <Text variant="heading">{t('wellbeing.help_title')}</Text>
        <Text>{t('help.card')}</Text>
        <Button icon="call-outline" label="Ligar 188" onPress={() => void Linking.openURL('tel:188')} />
        <Button variant="secondary" icon="chatbubbles-outline" label="cvv.org.br" onPress={() => void Linking.openURL('https://cvv.org.br')} />
      </Card>
      <Banner kind="neutral" message={t('burnout.late', { defaultValue: 'Dormir bem ajuda a lembrar tudo amanhã 🌙' })} />
    </Screen>
  );
}
