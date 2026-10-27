// Capi on results screens (spec 13 §5.1): celebrating after a good result, curious otherwise. Hidden when the
// student turned the mascot off.
import { View } from 'react-native';
import { Capi } from '../../components';
import { useCapi } from './capi';

export function CapiCheer({ happy, size = 88 }: { happy: boolean; size?: number }) {
  const capi = useCapi();
  if (!capi.visible) return null;
  return (
    <View style={{ alignItems: 'center' }}>
      <Capi stage={capi.stage} mood={happy ? 'celebrating' : 'curious'} accessories={capi.accessories} size={size} />
    </View>
  );
}
