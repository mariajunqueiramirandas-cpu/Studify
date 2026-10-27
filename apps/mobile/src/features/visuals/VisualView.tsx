// Native renderer for LRN-05 visual specs (LRN-05.3): boxes are regular views (wrapping text, TalkBack, font
// scaling), lines and arrows are SVG. Layout comes from @studify/shared so it is deterministic and tested.
import { cycleLayout, flowchartLayout, hierarchyLayout, timelineOrder, type VisualSpec } from '@studify/shared';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Line, Path, Polygon } from 'react-native-svg';
import { BottomSheet, PageChips, Text } from '../../components';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

const BOX_W = 132;
const BOX_H = 64;
const GAP_X = 20;
const GAP_Y = 44;

type SourcePages = Array<{ document_id: string; page_start: number; page_end: number }>;
interface Item {
  id: string;
  label: string;
  detail?: string | null;
  source_pages?: SourcePages;
}

function Arrow({ x1, y1, x2, y2, color }: { x1: number; y1: number; x2: number; y2: number; color: string }) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 7;
  const p1 = `${x2},${y2}`;
  const p2 = `${x2 - size * Math.cos(angle - Math.PI / 7)},${y2 - size * Math.sin(angle - Math.PI / 7)}`;
  const p3 = `${x2 - size * Math.cos(angle + Math.PI / 7)},${y2 - size * Math.sin(angle + Math.PI / 7)}`;
  return (
    <>
      <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.5} />
      <Polygon points={`${p1} ${p2} ${p3}`} fill={color} />
    </>
  );
}

function Box({ item, x, y, onPress, accent }: { item: Item; x: number; y: number; onPress: (i: Item) => void; accent?: boolean }) {
  const { colors: c } = useTheme();
  return (
    <Pressable
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={item.detail ? `${item.label}. ${item.detail}` : item.label}
      style={{ position: 'absolute', left: x, top: y, width: BOX_W, height: BOX_H, borderRadius: radius.md, borderWidth: 1.5, borderColor: accent ? c.primary : c.border, backgroundColor: accent ? c.primarySoft : c.surface1, alignItems: 'center', justifyContent: 'center', padding: 6 }}
    >
      <Text variant="bodySmall" align="center" numberOfLines={3}>
        {item.label}
      </Text>
    </Pressable>
  );
}

/** Pinch-zoom lives in the screen (ZoomableView); this view is the drawing at its natural size. */
export function VisualView({ spec, subjectId }: { spec: VisualSpec; subjectId: string | null }) {
  const { colors: c } = useTheme();
  const [open, setOpen] = useState<Item | null>(null);
  const sheet = (
    <BottomSheet visible={open !== null} onClose={() => setOpen(null)} title={open?.label ?? ''}>
      {open?.detail ? <Text>{open.detail}</Text> : null}
      <PageChips sources={open?.source_pages} subjectId={subjectId} />
    </BottomSheet>
  );

  if (spec.type === 'flowchart' || spec.type === 'hierarchy') {
    const placed = spec.type === 'flowchart' ? flowchartLayout(spec) : hierarchyLayout(spec);
    const maxX = Math.max(...placed.map((p) => p.x));
    const maxY = Math.max(...placed.map((p) => p.y));
    const width = (maxX + 1) * (BOX_W + GAP_X) + GAP_X;
    const height = (maxY + 1) * (BOX_H + GAP_Y) + GAP_Y;
    const pos = new Map(placed.map((p) => [p.id, { x: GAP_X + p.x * (BOX_W + GAP_X), y: GAP_Y / 2 + p.y * (BOX_H + GAP_Y) }]));
    const edges = spec.type === 'flowchart' ? spec.edges : spec.nodes.filter((n) => n.parent_id).map((n) => ({ from: n.parent_id!, to: n.id, label: null }));
    return (
      <ScrollView horizontal contentContainerStyle={{ padding: space.sm }}>
        <View style={{ width, height }}>
          <Svg width={width} height={height} style={{ position: 'absolute' }}>
            {edges.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              if (b.y <= a.y) {
                // A loop back in a process: curve around the right side.
                const sx = a.x + BOX_W;
                const sy = a.y + BOX_H / 2;
                const tx = b.x + BOX_W;
                const ty = b.y + BOX_H / 2;
                const bend = Math.max(sx, tx) + GAP_X;
                return <Path key={i} d={`M${sx},${sy} C${bend},${sy} ${bend},${ty} ${tx + 6},${ty}`} stroke={c.textSecondary} strokeWidth={1.5} fill="none" strokeDasharray="4 3" />;
              }
              return <Arrow key={i} x1={a.x + BOX_W / 2} y1={a.y + BOX_H} x2={b.x + BOX_W / 2} y2={b.y - 2} color={c.textSecondary} />;
            })}
          </Svg>
          {spec.nodes.map((n, i) => (
            <Box key={n.id} item={n} x={pos.get(n.id)!.x} y={pos.get(n.id)!.y} onPress={setOpen} accent={i === 0} />
          ))}
        </View>
        {sheet}
      </ScrollView>
    );
  }

  if (spec.type === 'cycle') {
    const n = spec.nodes.length;
    const r = Math.max(110, (n * (BOX_W * 0.75)) / (2 * Math.PI));
    const size = 2 * r + BOX_W + 2 * GAP_X;
    const cx = size / 2;
    const cy = size / 2;
    const pts = cycleLayout(n).map((p) => ({ x: cx + r * p.x, y: cy + r * p.y }));
    return (
      <View style={{ alignItems: 'center' }}>
        <View style={{ width: size, height: size }}>
          <Svg width={size} height={size} style={{ position: 'absolute' }}>
            {pts.map((p, i) => {
              const q = pts[(i + 1) % n]!;
              const mx = (p.x + q.x) / 2;
              const my = (p.y + q.y) / 2;
              // Arrow from 60% to 80% of the chord, pushed outwards a little.
              const ox = (mx - cx) * 0.15;
              const oy = (my - cy) * 0.15;
              return <Arrow key={i} x1={p.x + (q.x - p.x) * 0.35 + ox} y1={p.y + (q.y - p.y) * 0.35 + oy} x2={p.x + (q.x - p.x) * 0.65 + ox} y2={p.y + (q.y - p.y) * 0.65 + oy} color={c.primary} />;
            })}
          </Svg>
          {spec.nodes.map((node, i) => (
            <Box key={node.id} item={node} x={pts[i]!.x - BOX_W / 2} y={pts[i]!.y - BOX_H / 2} onPress={setOpen} accent={i === 0} />
          ))}
        </View>
        {sheet}
      </View>
    );
  }

  if (spec.type === 'timeline') {
    return (
      <View style={{ gap: space.md, paddingLeft: space.lg }}>
        <View style={{ position: 'absolute', left: space.lg + 5, top: 6, bottom: 6, width: 2, backgroundColor: c.border }} />
        {timelineOrder(spec.events).map((e) => (
          <Pressable key={e.id} onPress={() => setOpen({ id: e.id, label: e.title, detail: e.detail, source_pages: e.source_pages })} accessibilityRole="button" style={{ flexDirection: 'row', gap: space.md }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.primary, marginTop: 4 }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="label" tone="accent">
                {e.date_label}
              </Text>
              <Text variant="bodySmall">{e.title}</Text>
            </View>
          </Pressable>
        ))}
        {sheet}
      </View>
    );
  }

  // comparison_table
  const colW = 150;
  return (
    <ScrollView horizontal>
      <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: radius.md, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', backgroundColor: c.primarySoft }}>
          <View style={{ width: colW * 0.8, padding: space.sm }}>
            <Text variant="label">{t('visual.criterion')}</Text>
          </View>
          {spec.columns.map((col) => (
            <View key={col.id} style={{ width: colW, padding: space.sm }}>
              <Text variant="label">{col.label}</Text>
            </View>
          ))}
        </View>
        {spec.rows.map((r, i) => (
          <Pressable key={r.criterion} onPress={() => setOpen({ id: r.criterion, label: r.criterion, source_pages: r.source_pages })} style={{ flexDirection: 'row', backgroundColor: i % 2 ? c.surface1 : c.bg }}>
            <View style={{ width: colW * 0.8, padding: space.sm }}>
              <Text variant="label">{r.criterion}</Text>
            </View>
            {r.cells.map((cell, j) => (
              <View key={j} style={{ width: colW, padding: space.sm }}>
                <Text variant="bodySmall">{cell}</Text>
              </View>
            ))}
          </Pressable>
        ))}
      </View>
      {sheet}
    </ScrollView>
  );
}
