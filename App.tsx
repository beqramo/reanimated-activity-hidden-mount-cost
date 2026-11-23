import { Activity, memo, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Animated, {
  Easing,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

// ---------------------------------------------------------------------------
// What this app shows
//
// 1. A spinner driven by withRepeat(withTiming(...), -1) stays visible, so
//    Reanimated commits + mounts the shadow tree every frame
//    (IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS is false by default).
// 2. Next to it, N leaf views are mounted inside <Activity>, first visible and
//    then switched to mode="hidden". Hiding runs componentWillUnmount on every
//    Animated.View, which calls markNodeAsRemovable(). The shadow nodes stay in
//    the tree, so the entries are never drained.
// 3. ReanimatedMountHook::shadowTreeDidMount calls handleNodeRemovals() on
//    every mount, which calls ShadowNodeFamily::getAncestors(root) for every
//    entry. We measure UI-thread frame times with useFrameCallback while the
//    spinner runs.
//
// Control: the same N leaves as plain <View> (never marked as removable).
// ---------------------------------------------------------------------------

const NEST = 6; // wrapper Views between a row and each leaf (adds depth)
const SETTLE_MS = 1500;
const MEASURE_MS = 4000;
const COUNTS: Record<'grid' | 'flat', number[]> = {
  grid: [2000, 4000],
  flat: [2000, 4000, 8000],
};

// 'grid': rows of 25 siblings. 'flat': every leaf is a sibling of every other
// leaf (one parent, like a long non-virtualized list). getAncestors() scans
// the children of each ancestor linearly, so 'flat' costs ~N/2 per entry.
type Shape = 'grid' | 'flat';
type Kind = 'animated' | 'plain';
type Mode = 'visible' | 'hidden';

type Result = {
  shape: Shape;
  kind: Kind;
  hidden: number;
  uiFps: number;
  uiAvgMs: number;
  uiMaxMs: number;
  uiFramesOver20ms: number;
  jsFps: number;
};

function Nest({ depth, children }: { depth: number; children: React.ReactNode }) {
  if (depth === 0) return <>{children}</>;
  return (
    <View style={styles.nest}>
      <Nest depth={depth - 1}>{children}</Nest>
    </View>
  );
}

const Leaf = memo(function Leaf({ kind }: { kind: Kind }) {
  return (
    <Nest depth={NEST}>
      {kind === 'animated' ? (
        <Animated.View style={styles.leaf} />
      ) : (
        <View style={styles.leaf} />
      )}
    </Nest>
  );
});

const Grid = memo(function Grid({
  count,
  kind,
  shape,
}: {
  count: number;
  kind: Kind;
  shape: Shape;
}) {
  if (shape === 'flat') {
    const cells: React.ReactNode[] = [];
    for (let i = 0; i < count; i++) cells.push(<Leaf key={i} kind={kind} />);
    return <View style={styles.flat}>{cells}</View>;
  }
  const ROW_WIDTH = 25;
  const rows: React.ReactNode[] = [];
  for (let r = 0; r * ROW_WIDTH < count; r++) {
    const cells: React.ReactNode[] = [];
    for (let c = 0; c < ROW_WIDTH && r * ROW_WIDTH + c < count; c++) {
      cells.push(<Leaf key={c} kind={kind} />);
    }
    rows.push(
      <View key={r} style={styles.row}>
        {cells}
      </View>
    );
  }
  return <View>{rows}</View>;
});

function Spinner() {
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 1000, easing: Easing.linear }),
      -1,
      false
    );
  }, [rotation]);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  return <Animated.View style={[styles.spinner, style]} />;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const [count, setCount] = useState(0);
  const [kind, setKind] = useState<Kind>('animated');
  const [shape, setShape] = useState<Shape>('grid');
  const [mode, setMode] = useState<Mode>('visible');
  const [status, setStatus] = useState('idle');
  const [results, setResults] = useState<Result[]>([]);
  const running = useRef(false);

  // UI-thread frame statistics, accumulated in the frame callback.
  const measuring = useSharedValue(false);
  const frames = useSharedValue(0);
  const sumMs = useSharedValue(0);
  const maxMs = useSharedValue(0);
  const over20 = useSharedValue(0);

  useFrameCallback((info) => {
    'worklet';
    if (!measuring.value) return;
    const dt = info.timeSincePreviousFrame;
    if (dt === null) return;
    frames.value += 1;
    sumMs.value += dt;
    if (dt > maxMs.value) maxMs.value = dt;
    if (dt > 20) over20.value += 1;
  });

  const measure = useCallback(async (): Promise<Omit<Result, 'shape' | 'kind' | 'hidden'>> => {
    frames.value = 0;
    sumMs.value = 0;
    maxMs.value = 0;
    over20.value = 0;
    let jsFrames = 0;
    let jsRunning = true;
    const tick = () => {
      if (!jsRunning) return;
      jsFrames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    measuring.value = true;
    await sleep(MEASURE_MS);
    measuring.value = false;
    jsRunning = false;
    await sleep(50);
    const n = frames.value;
    return {
      uiFps: Math.round((n / MEASURE_MS) * 1000 * 10) / 10,
      uiAvgMs: n ? Math.round((sumMs.value / n) * 100) / 100 : 0,
      uiMaxMs: Math.round(maxMs.value * 10) / 10,
      uiFramesOver20ms: over20.value,
      jsFps: Math.round((jsFrames / MEASURE_MS) * 1000 * 10) / 10,
    };
  }, [frames, sumMs, maxMs, over20, measuring]);

  const runOne = useCallback(
    async (sh: Shape, k: Kind, n: number) => {
      // Unmount whatever is there, then mount N leaves visible, then hide them.
      setMode('visible');
      setCount(0);
      await sleep(500);
      setShape(sh);
      setKind(k);
      setCount(n);
      setStatus(`${sh} ${k} ${n}: mounting visible`);
      await sleep(SETTLE_MS + 2 * n); // big trees take a while to mount
      setMode('hidden');
      setStatus(`${sh} ${k} ${n}: hidden, settling`);
      await sleep(SETTLE_MS + n / 2);
      setStatus(`${sh} ${k} ${n}: measuring ${MEASURE_MS} ms`);
      console.log(`[bench] measure-start ${sh} ${k} ${n}`);
      const m = await measure();
      const result: Result = { shape: sh, kind: k, hidden: n, ...m };
      console.log(`[bench] ${JSON.stringify(result)}`);
      setResults((prev) => [...prev, result]);
    },
    [measure]
  );

  const runAll = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setResults([]);
    await runOne('grid', 'animated', 0);
    for (const sh of ['grid', 'flat'] as const) {
      for (const n of COUNTS[sh]) {
        await runOne(sh, 'animated', n);
        await runOne(sh, 'plain', n);
      }
    }
    setMode('visible');
    setCount(0);
    setStatus('done');
    console.log('[bench] done');
    running.current = false;
  }, [runOne]);

  // Run once on launch so the numbers show up without touching the app.
  useEffect(() => {
    const t = setTimeout(runAll, 3000);
    return () => clearTimeout(t);
  }, [runAll]);

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <View style={styles.header}>
        <Spinner />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Activity hidden × Reanimated mount cost</Text>
          <Text style={styles.small}>{status}</Text>
          <Pressable onPress={runAll} style={styles.button}>
            <Text style={styles.buttonText}>Run benchmark again</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.table}>
        <Text style={styles.mono}>{'shape kind      hidden  uiFps  avgMs  maxMs  >20ms  jsFps'}</Text>
        {results.map((r, i) => (
          <Text key={i} style={styles.mono}>
            {r.shape.padEnd(5)} {r.kind.padEnd(9)} {String(r.hidden).padStart(6)} {String(r.uiFps).padStart(6)}{' '}
            {String(r.uiAvgMs).padStart(6)} {String(r.uiMaxMs).padStart(6)}{' '}
            {String(r.uiFramesOver20ms).padStart(6)} {String(r.jsFps).padStart(6)}
          </Text>
        ))}
      </View>
      <View style={styles.gridBox}>
        <Activity mode={mode}>
          <Grid count={count} kind={kind} shape={shape} />
        </Activity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 60, paddingHorizontal: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  spinner: { width: 48, height: 48, backgroundColor: '#6a5acd', borderRadius: 8 },
  title: { fontSize: 15, fontWeight: '600' },
  small: { fontSize: 12, color: '#555', marginTop: 2 },
  button: { marginTop: 6, alignSelf: 'flex-start', backgroundColor: '#222', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  buttonText: { color: '#fff', fontSize: 12 },
  table: { marginTop: 12 },
  mono: { fontFamily: 'Menlo', fontSize: 10 },
  gridBox: { flex: 1, overflow: 'hidden', marginTop: 8 },
  row: { flexDirection: 'row' },
  flat: { flexDirection: 'row', flexWrap: 'wrap' },
  nest: { padding: 0 },
  leaf: { width: 4, height: 4, margin: 1, backgroundColor: '#9ad' },
});
