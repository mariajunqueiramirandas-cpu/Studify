/// <reference types="jest" />
jest.mock('../../../lib/kv', () => ({ getKv: () => ({ getString: () => undefined, set: () => undefined, remove: () => undefined }) }));
jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {}, useSpeechRecognitionEvent: () => undefined }));
jest.mock('expo-notifications', () => ({}));
jest.mock('../../../api/supabase', () => ({ supabase: {} }));
jest.mock('react-native-reanimated', () => ({ __esModule: true, default: { View: 'View' }, useAnimatedStyle: () => ({}), useSharedValue: (v: unknown) => ({ value: v }), withTiming: (v: unknown) => v }));
jest.mock('react-native-gesture-handler', () => ({ Gesture: {}, GestureDetector: ({ children }: { children: unknown }) => children }));

import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Popover, TermCard, Text } from '../../../components';
import { ThemeProvider } from '../../../theme';
import { TrailOptions } from '../TrailOptions';

const wrap = (node: ReactNode) => (
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <ThemeProvider reduceMotion>{node}</ThemeProvider>
  </SafeAreaProvider>
);

const options = [
  { id: 'A', text: 'Pé musculoso' },
  { id: 'B', text: 'Manto' },
  { id: 'C', text: 'Rádula' },
  { id: 'D', text: 'Massa visceral' },
];
const rationales = options.map((o) => ({ id: o.id, rationale: `Sobre ${o.text}.` }));

describe('Trilha alternatives (TRL-01)', () => {
  it('selects before the answer and opens the why of the pick and the right one after it', async () => {
    const onSelect = jest.fn();
    const { rerender } = await render(wrap(<TrailOptions options={options} selected={null} onSelect={onSelect} reveal={null} />));
    await fireEvent.press(screen.getByLabelText('C. Rádula'));
    expect(onSelect).toHaveBeenCalledWith('C');
    expect(screen.queryByText('Sobre Manto.')).toBeNull();

    await rerender(wrap(<TrailOptions options={options} selected="C" onSelect={onSelect} reveal={{ correct: 'B', picked: 'C', rationales }} />));
    expect(screen.getByText('Sobre Manto.')).toBeTruthy();
    expect(screen.getByText('Sobre Rádula.')).toBeTruthy();
    expect(screen.queryByText('Sobre Pé musculoso.')).toBeNull();

    // The others open on a tap, and no longer change the answer.
    await fireEvent.press(screen.getByLabelText('A. Pé musculoso'));
    expect(screen.getByText('Sobre Pé musculoso.')).toBeTruthy();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('floats a term card next to the tapped word', async () => {
    const onClose = jest.fn();
    await render(
      wrap(
        <Popover visible anchor={{ x: 40, y: 120, width: 60, height: 22 }} onClose={onClose}>
          <TermCard term="manto" onClose={onClose}>
            <Text>Dobra do corpo do molusco.</Text>
          </TermCard>
        </Popover>,
      ),
    );
    expect(screen.getByText('manto')).toBeTruthy();
    expect(screen.getByText('Dobra do corpo do molusco.')).toBeTruthy();
    const closers = screen.getAllByLabelText('Fechar');
    await fireEvent.press(closers[closers.length - 1]!);
    expect(onClose).toHaveBeenCalled();
  });
});
