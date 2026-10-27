import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../i18n';
import { radius, space, useTheme } from '../theme';
import { Button } from './Button';
import { Text } from './Text';

// ---------- Bottom sheet ----------

interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
}

export function BottomSheet({ visible, onClose, title, children, footer, scroll = true }: SheetProps) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay }]} onPress={onClose} accessibilityLabel={t('global.close')} />
        <View style={[styles.sheet, { backgroundColor: c.bg, paddingBottom: insets.bottom + space.lg }]} accessibilityViewIsModal>
          <View style={[styles.handle, { backgroundColor: c.border }]} />
          {title ? (
            <Text variant="title" accessibilityRole="header" style={{ marginBottom: space.sm }}>
              {title}
            </Text>
          ) : null}
          {scroll ? (
            <ScrollView style={{ maxHeight: 520 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.md, paddingBottom: space.sm }}>
              {children}
            </ScrollView>
          ) : (
            <View style={{ gap: space.md }}>{children}</View>
          )}
          {footer ? <View style={{ gap: space.sm, marginTop: space.md }}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------- Dialog ----------

interface DialogOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Typed confirmation for irreversible actions (ux §5.6). */
  typedConfirmation?: string;
}

interface SnackOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

interface OverlayApi {
  confirm: (opts: DialogOptions) => Promise<boolean>;
  snack: (opts: SnackOptions | string) => void;
  /** Undo snackbar for reversible actions (5 s, ux §5.6). */
  undo: (message: string, onUndo: () => void) => void;
}

const OverlayContext = createContext<OverlayApi | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const [dialog, setDialog] = useState<(DialogOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const [snackState, setSnackState] = useState<SnackOptions | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anim = useRef(new Animated.Value(0)).current;

  const confirm = useCallback(
    (opts: DialogOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setDialog({ ...opts, resolve });
      }),
    [],
  );

  const snack = useCallback(
    (opts: SnackOptions | string) => {
      const o = typeof opts === 'string' ? { message: opts } : opts;
      if (timer.current) clearTimeout(timer.current);
      setSnackState(o);
      AccessibilityInfo.announceForAccessibility(o.message);
      Animated.timing(anim, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      timer.current = setTimeout(() => {
        Animated.timing(anim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => setSnackState(null));
      }, o.durationMs ?? 4000);
    },
    [anim],
  );

  const undo = useCallback(
    (message: string, onUndo: () => void) => snack({ message, actionLabel: t('global.undo'), onAction: onUndo, durationMs: 5000 }),
    [snack],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const close = (value: boolean) => {
    dialog?.resolve(value);
    setDialog(null);
  };
  const typedOk = !dialog?.typedConfirmation || typed.trim() === dialog.typedConfirmation;

  return (
    <OverlayContext.Provider value={{ confirm, snack, undo }}>
      {children}
      <Modal visible={!!dialog} transparent animationType="fade" onRequestClose={() => close(false)} statusBarTranslucent>
        <View style={[styles.dialogBackdrop, { backgroundColor: c.overlay }]}>
          <View style={[styles.dialog, { backgroundColor: c.bg }]} accessibilityViewIsModal accessibilityRole="alert">
            <Text variant="heading">{dialog?.title}</Text>
            {dialog?.message ? <Text tone="secondary">{dialog.message}</Text> : null}
            {dialog?.typedConfirmation ? (
              <TextInput
                value={typed}
                onChangeText={setTyped}
                autoCapitalize="characters"
                accessibilityLabel={dialog.typedConfirmation}
                style={[styles.input, { borderColor: c.border, color: c.textPrimary }]}
                placeholder={dialog.typedConfirmation}
                placeholderTextColor={c.textSecondary}
              />
            ) : null}
            <View style={styles.dialogActions}>
              <Button variant="text" label={dialog?.cancelLabel ?? t('global.cancel')} onPress={() => close(false)} />
              <Button
                variant={dialog?.destructive ? 'destructive' : 'primary'}
                label={dialog?.confirmLabel ?? t('global.confirm')}
                disabled={!typedOk}
                onPress={() => close(true)}
                compact
              />
            </View>
          </View>
        </View>
      </Modal>
      {snackState ? (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.snackWrap, { bottom: insets.bottom + 72, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }]}
        >
          <View style={[styles.snack, { backgroundColor: c.textPrimary }]} accessibilityLiveRegion="polite">
            <Text variant="bodySmall" style={{ color: c.bg, flex: 1 }}>
              {snackState.message}
            </Text>
            {snackState.actionLabel ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={10}
                onPress={() => {
                  snackState.onAction?.();
                  setSnackState(null);
                }}
              >
                <Text variant="label" style={{ color: c.primarySoft }}>
                  {snackState.actionLabel}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </Animated.View>
      ) : null}
    </OverlayContext.Provider>
  );
}

export function useOverlay(): OverlayApi {
  const ctx = useContext(OverlayContext);
  if (!ctx) throw new Error('useOverlay must be used inside OverlayProvider');
  return ctx;
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.lg, gap: space.sm },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: space.sm },
  dialogBackdrop: { flex: 1, justifyContent: 'center', padding: space.xl },
  dialog: { borderRadius: radius.lg, padding: space.xl, gap: space.md },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.sm },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 48, fontSize: 16 },
  snackWrap: { position: 'absolute', left: space.lg, right: space.lg },
  snack: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});
