import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Pill, Text } from '../../components';
import { pageLabel } from '../common/format';
import { t } from '../../i18n';
import { masteryColor, masteryLabel, radius, space, touch, useTheme } from '../../theme';
import type { OutlineNode } from './outline';

interface Props {
  roots: OutlineNode[];
  onPressNode?: (n: OutlineNode) => void;
  onLongPressNode?: (n: OutlineNode) => void;
  mastery?: Map<string, number>;
  /** Hide concepts (subject home shows units → topics). */
  depth?: 2 | 3;
  showSources?: boolean;
  right?: (n: OutlineNode) => React.ReactNode;
}

/** Collapsible units → topics → concepts tree (ING-03, S-MAT-03/06). */
export function OutlineTree({ roots, onPressNode, onLongPressNode, mastery, depth = 2, showSources = true, right }: Props) {
  return (
    <View style={{ gap: space.sm }}>
      {roots.map((u) => (
        <UnitBlock key={u.id} unit={u} onPressNode={onPressNode} onLongPressNode={onLongPressNode} mastery={mastery} depth={depth} showSources={showSources} right={right} />
      ))}
    </View>
  );
}

function UnitBlock({ unit, ...rest }: { unit: OutlineNode } & Omit<Props, 'roots'>) {
  const { colors: c } = useTheme();
  const [open, setOpen] = useState(true);
  return (
    <View style={[styles.unit, { backgroundColor: c.surface1 }]}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        onLongPress={rest.onLongPressNode ? () => rest.onLongPressNode!(unit) : undefined}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${t('outline.unit')}: ${unit.title}`}
        style={styles.unitHeader}
      >
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={20} color={c.textSecondary} />
        <Text variant="heading" style={{ flex: 1 }} tone={unit.excluded ? 'secondary' : 'primary'}>
          {unit.title}
        </Text>
        {unit.excluded ? <Pill icon="eye-off-outline" text={t('outline.excluded')} /> : null}
        {rest.right?.(unit)}
      </Pressable>
      {open
        ? unit.children.map((topic) => (
            <View key={topic.id}>
              <NodeRow node={topic} level={1} {...rest} />
              {rest.depth === 3 ? topic.children.map((concept) => <NodeRow key={concept.id} node={concept} level={2} {...rest} />) : null}
            </View>
          ))
        : null}
    </View>
  );
}

function NodeRow({ node, level, onPressNode, onLongPressNode, mastery, showSources, right }: { node: OutlineNode; level: number } & Omit<Props, 'roots'>) {
  const { colors: c } = useTheme();
  const m = mastery?.get(node.id);
  const source = node.sources[0];
  const statusIcon = node.content_status === 'ready' ? null : node.content_status === 'failed' ? 'alert-circle-outline' : 'hourglass-outline';
  return (
    <Pressable
      onPress={onPressNode ? () => onPressNode(node) : undefined}
      onLongPress={onLongPressNode ? () => onLongPressNode(node) : undefined}
      accessibilityRole={onPressNode ? 'button' : undefined}
      accessibilityLabel={`${level === 1 ? t('outline.topic') : t('outline.concept')}: ${node.title}${node.excluded ? `. ${t('outline.excluded')}` : ''}${m != null ? `. ${masteryLabel(m)}` : ''}`}
      style={({ pressed }) => [styles.row, { paddingLeft: space.lg * level, opacity: node.excluded ? 0.55 : 1 }, pressed && { backgroundColor: c.surface2 }]}
    >
      {m !== undefined ? <View style={[styles.dot, { backgroundColor: masteryColor(m, c), borderColor: c.border }]} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant={level === 1 ? 'body' : 'bodySmall'} style={node.excluded ? { textDecorationLine: 'line-through' } : undefined}>
          {node.title}
        </Text>
        <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
          {showSources && source ? (
            <Text variant="bodySmall" tone="accent">
              {pageLabel(source.page_start, source.page_end)}
            </Text>
          ) : null}
          {node.is_placeholder ? (
            <Text variant="bodySmall" tone="warning">
              {t('outline.placeholder')}
            </Text>
          ) : null}
          {node.excluded ? (
            <Text variant="bodySmall" tone="secondary">
              {t('outline.excluded')}
            </Text>
          ) : null}
        </View>
      </View>
      {statusIcon && level === 1 && !node.excluded ? <Ionicons name={statusIcon} size={18} color={node.content_status === 'failed' ? c.danger : c.textSecondary} accessibilityLabel={node.content_status} /> : null}
      {right?.(node)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  unit: { borderRadius: radius.lg, paddingVertical: space.xs, overflow: 'hidden' },
  unitHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: touch.min, paddingHorizontal: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: touch.min, paddingRight: space.md, paddingVertical: space.xs },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1 },
});
