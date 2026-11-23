# Reanimated: per-frame mount cost grows with animated views hidden by `<Activity>`

Minimal reproduction for
[software-mansion/react-native-reanimated#11499](https://github.com/software-mansion/react-native-reanimated/issues/11499).

## Versions

| | |
| --- | --- |
| react-native-reanimated | 4.7.1 |
| react-native-worklets | 0.13.0 |
| react-native | 0.88.1 (New Architecture, the only one) |
| react | 19.3.0 |
| Expo SDK | 58 (blank TypeScript template, `expo prebuild`) |
| Reanimated feature flags | defaults (`IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS: false`) |

Expo SDK 58 ships exactly Reanimated 4.7.1 / Worklets 0.13.0 with React Native 0.88.1.

## What the app does

All of it is in [`App.tsx`](App.tsx).

1. A spinner driven by `withRepeat(withTiming(360), -1)` is visible the whole time, so Reanimated
   commits and mounts the shadow tree on every frame.
2. Next to it, N leaves are mounted inside `<Activity>`: first `mode="visible"`, then switched to
   `mode="hidden"`. Each leaf is wrapped in 6 plain `View`s. Two tree shapes:
   - `grid`: rows of 25 leaves;
   - `flat`: all N leaves are children of one parent (like a long list that is not virtualized).
     `getAncestors` scans each ancestor's children linearly, so here each entry costs about N/2
     steps and a drain costs about N²/2.
   - `animated`: the leaf is an `Animated.View`. Hiding runs `componentWillUnmount`, which calls
     `markNodeAsRemovable()`. The shadow nodes stay in the tree, so the entries are never drained.
   - `plain` (control): the same tree with a plain `View` leaf, which is never marked as removable.
3. While the subtree is hidden, `useFrameCallback` records the UI-thread frame interval for 4 s
   (frames per second, mean and max interval, frames longer than 20 ms). A
   `requestAnimationFrame` counter records the JS frame rate.

The benchmark runs by itself 3 s after launch (`grid`: N = 0, 2000, 4000; `flat`: N = 2000, 4000,
8000; each N as `animated` and as `plain`) and prints one
`[bench] {...}` line per case to the console, and shows the table on screen. Tap
**Run benchmark again** to repeat it.

## Run it

```sh
npm install
npx expo prebuild -p ios
npx expo run:ios --configuration Release   # numbers from a Debug build are not meaningful
```

In a Release build `console.log` goes to the system log. Read it with:

```sh
xcrun simctl spawn booted log stream --level debug --predicate 'eventMessage CONTAINS "[bench]"'
```

## What to look for

If the issue is right, the `animated` rows lose frames as N grows, and the `plain` rows at the same
N do not. Each Reanimated mount calls `ShadowNodeFamily::getAncestors(root)` once per hidden
`Animated.View`, under the registry lock, on the thread that mounts. In Instruments, the time
shows up under `ReanimatedMountHook::shadowTreeDidMount` -> `UpdatesRegistryManager::handleNodeRemovals`
-> `ShadowNodeFamily::getAncestors`.

## Results

Run on 2026-11-23: iOS Simulator (iPhone 17 Pro, iOS 26.5), Release build, on an Apple M4 Max
Mac (macOS 26.2), Xcode 26.6. The simulator is much faster than an iPad, so the N needed to see
dropped frames here is larger than on a device.

The table is the app's own output (4 s window with the subtree hidden). "App CPU" is the mean of
`ps -o %cpu` for the app process, sampled every 0.5 s during the same window (from outside the
app; `ps` on macOS reports a decaying average, so read it as a comparison, not an exact figure).

| shape | leaf | hidden N | UI fps | mean frame ms | max frame ms | frames > 20 ms | app CPU |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| grid | animated | 0 | 60.0 | 16.67 | 16.7 | 0 | 6 % |
| grid | animated | 2000 | 60.0 | 16.67 | 16.7 | 0 | 29 % |
| grid | plain | 2000 | 60.0 | 16.67 | 16.7 | 0 | 5 % |
| grid | animated | 4000 | 60.0 | 16.67 | 16.7 | 0 | 31 % |
| grid | plain | 4000 | 60.0 | 16.67 | 16.7 | 0 | 5 % |
| flat | animated | 2000 | 59.8 | 16.74 | 37.2 | 1 | 37 % |
| flat | plain | 2000 | 60.0 | 16.67 | 16.7 | 0 | 4 % |
| flat | animated | 4000 | 59.5 | 16.81 | 33.3 | 2 | 65 % |
| flat | plain | 4000 | 60.0 | 16.67 | 16.7 | 0 | 5 % |
| **flat** | **animated** | **8000** | **27.8** | **35.82** | **52.3** | **91** | **93 %** |
| flat | plain | 8000 | 59.8 | 16.67 | 16.7 | 0 | 5 % |

The same views as plain `View`s cost nothing while hidden. As `Animated.View`s they cost CPU on
every frame of an unrelated animation, the cost grows with N, and with the `flat` shape the UI
thread drops to about 28 fps at N = 8000. JS stays at 60 fps throughout.

Where the time goes: in an earlier run (same app, `flat` with N = 4000, hidden) we ran
`sample <pid> 3` on the app process. On the main thread, 1382 of 2117 samples (65 %) were in this
path:

```
_dispatch_main_queue_drain
  facebook::react::UIManager::reportMount(int) const
    reanimated::ReanimatedMountHook::shadowTreeDidMount(...)          ReanimatedMountHook.cpp:65
      reanimated::UpdatesRegistryManager::handleNodeRemovals(...)       UpdatesRegistryManager.cpp:87  (1228)
        facebook::react::ShadowNodeFamily::getAncestors(...) const                                     (993+)
```

The same `sample` for the `plain` N = 4000 case: the main thread was idle in
`mach_msg2_trap` for 2373 of 2443 samples, and no frame contained `handleNodeRemovals`.
