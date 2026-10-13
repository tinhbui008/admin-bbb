# BBB Chat Emoji Reactions Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a BigBlueButton 3.0 HTML plugin that adds an emoji button next to the Reactions bar; when anyone picks an emoji it floats up over the Public Chat panel (Facebook-LIVE style) and is broadcast in real time to everyone in the room.

**Architecture:** A standalone React plugin loaded by the BBB HTML5 client via manifest. An `ActionsBarButton` opens an `emoji-mart` picker. Selecting an emoji calls `pushEntry` on a plugin **Data Channel** (`pushPermission: all`); every client subscribes with `useDataChannel(NEW_ITEMS)` and renders each incoming emoji as a CSS float-up animation inside a transparent, click-through `FloatingWindow` overlay positioned over the chat column. Pure logic (rate-limiting, concurrent-cap/dedup) lives in framework-free modules covered by unit tests; SDK-integrated pieces are verified manually in a live room.

**Tech Stack:** TypeScript, React 18, `bigbluebutton-html-plugin-sdk` `0.0.103` (`requiredSdkVersion ~0.0.73`), webpack 5 + ts-loader + babel, `@emoji-mart/react` + `@emoji-mart/data`, vitest (unit tests).

**Reference spec:** `docs/superpowers/specs/2026-07-21-bbb-chat-emoji-reactions-plugin-design.md`

---

## Project Location & Conventions

This is a **new, standalone project**, separate from the `BBB-Admin-Nihaoma` dashboard repo.

- Create it at: `E:\Dev\bbb-chat-emoji-plugin\`
- All paths below are **relative to that project root** unless stated otherwise.
- Target server for deployment: `liveclass.meego.study` (BBB 3.0.31).

## Verified SDK Facts (from `bigbluebutton-html-plugin-sdk` branch `v0.0.x`)

These are copied from real samples — do not re-derive:

- **Entry point:** `index.tsx` reads `uuid`/`pluginName` from `document.currentScript` attributes and renders the component into `document.getElementById(uuid)`.
- **Init inside component:** `BbbPluginSdk.initialize(uuid); const pluginApi = BbbPluginSdk.getPluginApi(uuid);`
- **Actions bar:** `new ActionsBarButton({ icon: { iconName: 'happy' }, tooltip, onClick, position: ActionsBarPosition.RIGHT, dataTest })` then `pluginApi.setActionsBarItems([...])`.
- **Data channel hook:** `const { data, pushEntry, deleteEntry } = pluginApi.useDataChannel<T>('channel-name', DataChannelTypes.NEW_ITEMS)`. `pushEntry` may be `undefined` before ready — always guard. Response shape: `data.data` is `DataChannelEntryResponseType<T>[]`, each `{ entryId, createdBy, payloadJson: T, createdAt, ... }`.
- **Data channel declaration (manifest):** `"dataChannels": [{ "name": "...", "pushPermission": [...], "replaceOrDeletePermission": [...] }]`. Permission values are role strings (`"moderator"`, `"presenter"`, `"viewer"`). Use all three to mean "everyone".
- **FloatingWindow (IMPORTANT constraint):** constructor props are exactly `{ id?, top, left, movable, backgroundColor, boxShadow, zIndex?, dataTest?, contentFunction }`. **There is NO `width`/`height` and NO `pointer-events` prop.** Size and click-through must be set by CSS *inside* `contentFunction`. `contentFunction: (element) => { const root = ReactDOM.createRoot(element); root.render(<X/>); return root; }`. Register with `pluginApi.setFloatingWindows([fw])`.
- **Build:** webpack, output `filename: '<Name>.js'`, `libraryTarget: 'umd'`. `manifest.json` is copied into `dist/` via `copy-webpack-plugin`.
- **Deploy/register:** host `dist/<Name>.js` + `manifest.json` on HTTPS; register with `pluginManifests=[{"url":".../manifest.json"}]` either per-room (create call) or globally in bbb-web properties.

## File Structure

```
bbb-chat-emoji-plugin/
├── package.json              # deps, build/test scripts
├── tsconfig.json             # TS config (from SDK sample)
├── webpack.config.js         # bundle config, output ChatEmojiPlugin.js
├── vitest.config.ts          # unit-test config (node env)
├── manifest.json             # plugin name, entrypoint, dataChannels
├── src/
│   ├── index.tsx             # entry: render ChatEmojiPlugin into #<uuid>
│   ├── chat-emoji-plugin/
│   │   ├── component.tsx      # main: button + picker + data channels + overlay wiring
│   │   └── types.ts          # Props + EmojiPayload type
│   ├── components/
│   │   ├── emoji-picker/
│   │   │   └── component.tsx  # emoji-mart Picker wrapper
│   │   └── floating-overlay/
│   │       └── component.tsx  # renders active emojis + CSS float-up animation
│   └── lib/
│       ├── rate-limiter.ts            # pure: per-user min-interval gate (TESTED)
│       ├── floating-emoji-queue.ts    # pure: dedup + concurrent cap reducer (TESTED)
│       └── __tests__/
│           ├── rate-limiter.test.ts
│           └── floating-emoji-queue.test.ts
```

**Responsibilities:**
- `lib/*` — framework-free logic, unit-tested, no BBB/React imports.
- `components/emoji-picker` — presentational picker; knows nothing about data channels.
- `components/floating-overlay` — presentational animation layer; given a list of active emojis, renders + reports when each finishes.
- `chat-emoji-plugin/component.tsx` — the only file that touches `pluginApi` (button, data channels, floating window). Orchestrates the pure libs + presentational components.

---

## Task 0: Spike — Validate the FloatingWindow overlay approach

**Goal:** De-risk R1/R2 from the spec BEFORE building features. Confirm a transparent, click-through, chat-sized `FloatingWindow` is achievable; if not, lock the fallback (fixed corner region).

**Files:**
- This task produces a throwaway branch/commit; final code lands in later tasks.

- [ ] **Step 1: Scaffold minimum to load a FloatingWindow** — do Task 1 Steps 1–6 first (project skeleton that builds and loads), then return here. (Task 0 depends on Task 1 skeleton; it is listed first only because its *finding* shapes Task 7.)

- [ ] **Step 2: Render a visible transparent overlay box**

In `src/chat-emoji-plugin/component.tsx`, temporarily register a FloatingWindow whose content is a sized, click-through div with a semi-visible border so you can see its bounds:

```tsx
const fw = new FloatingWindow({
  id: 'chat-emoji-overlay',
  top: window.innerHeight * 0.25,
  left: window.innerWidth - 360,
  movable: false,
  backgroundColor: 'transparent',
  boxShadow: 'none',
  zIndex: 3,
  contentFunction: (element: HTMLElement) => {
    const root = ReactDOM.createRoot(element);
    root.render(
      <div style={{
        width: 320, height: '60vh',
        pointerEvents: 'none',
        outline: '2px dashed rgba(255,0,0,0.6)', // TEMPORARY, remove after spike
        position: 'relative', overflow: 'hidden',
      }} />,
    );
    return root;
  },
});
pluginApi.setFloatingWindows([fw]);
```

- [ ] **Step 3: Verify in a live room**

Load the plugin in a real BBB room (see Task 9 deploy, or dev-server). Confirm all THREE:
1. The dashed box renders with a **transparent** background (chat text shows through).
2. You can **click chat/UI through** the box (`pointer-events: none` works).
3. The box overlaps the Public Chat column acceptably.

Record findings in the commit message.

- [ ] **Step 4: Decide positioning strategy**

- If all three pass → **Strategy A**: position overlay over the chat column using `top`/`left` computed from viewport (as above), re-evaluated on window resize.
- If click-through or transparency fails, or the SDK constrains the window → **Strategy B (fallback)**: fixed bottom-right corner region, `left: window.innerWidth - 340`, `top: window.innerHeight - 420`, size `300x360`. Same animation, smaller area.

Write the chosen strategy as a comment at the top of `floating-overlay/component.tsx` in Task 7.

- [ ] **Step 5: Remove the temporary dashed outline and commit the spike finding**

```bash
git add -A
git commit -m "spike: validate FloatingWindow transparent click-through overlay; choose Strategy A/B"
```

---

## Task 1: Scaffold the plugin project (builds + loads, no features)

**Files:**
- Create: `package.json`, `tsconfig.json`, `webpack.config.js`, `manifest.json`, `src/index.tsx`, `src/chat-emoji-plugin/component.tsx`, `src/chat-emoji-plugin/types.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "bbb-chat-emoji-plugin",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.tsx",
  "scripts": {
    "build-bundle": "webpack --mode production",
    "start": "webpack serve --mode development",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@emoji-mart/data": "^1.2.1",
    "@emoji-mart/react": "^1.1.1",
    "bigbluebutton-html-plugin-sdk": "0.0.103",
    "emoji-mart": "^5.6.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@babel/core": "^7.21.8",
    "@babel/preset-env": "^7.21.5",
    "@babel/preset-react": "^7.18.6",
    "@types/node": "^20.3.1",
    "@types/react": "^18.2.13",
    "@types/react-dom": "^18.2.6",
    "babel-loader": "^9.1.2",
    "copy-webpack-plugin": "^12.0.2",
    "css-loader": "^6.7.4",
    "style-loader": "^3.3.3",
    "ts-loader": "^9.4.3",
    "typescript": "^5.1.3",
    "vitest": "^1.6.0",
    "webpack": "^5.83.1",
    "webpack-cli": "^5.1.1",
    "webpack-dev-server": "^4.15.1"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (from SDK sample, plus test glob)

```json
{
  "compilerOptions": {
    "outDir": "./dist-tsc/",
    "noImplicitAny": true,
    "module": "es6",
    "target": "es5",
    "jsx": "react",
    "allowJs": true,
    "moduleResolution": "node",
    "esModuleInterop": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `webpack.config.js`**

```js
/* eslint-disable @typescript-eslint/no-var-requires */
const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require('path');

module.exports = {
  entry: './src/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'ChatEmojiPlugin.js',
    library: 'ChatEmojiPlugin',
    libraryTarget: 'umd',
    publicPath: '/',
    globalObject: 'this',
  },
  devServer: {
    allowedHosts: 'all',
    port: 4720,
    host: '0.0.0.0',
    hot: false,
    liveReload: false,
    client: { overlay: false },
    onBeforeSetupMiddleware: (devServer) => {
      if (!devServer) throw new Error('webpack-dev-server is not defined');
      devServer.app.get('/manifest.json', (req, res) => {
        res.sendFile(path.resolve(__dirname, 'manifest.json'));
      });
    },
  },
  module: {
    rules: [
      { test: /\.(js|jsx)$/, exclude: /node_modules/, use: { loader: 'babel-loader' } },
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
      { test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ },
    ],
  },
  resolve: { extensions: ['.js', '.jsx', '.tsx', '.ts'] },
  plugins: [
    new CopyWebpackPlugin({ patterns: [{ from: 'manifest.json', to: './' }] }),
  ],
};
```

Also create `.babelrc`:

```json
{ "presets": ["@babel/preset-env", "@babel/preset-react"] }
```

- [ ] **Step 4: Create `manifest.json`** (data channels added in Task 6; base for now)

```json
{
  "requiredSdkVersion": "~0.0.73",
  "name": "ChatEmojiPlugin",
  "javascriptEntrypointUrl": "ChatEmojiPlugin.js",
  "localesBaseUrl": ""
}
```

- [ ] **Step 5: Create `src/chat-emoji-plugin/types.ts`**

```ts
export interface ChatEmojiPluginProps {
  pluginName: string;
  pluginUuid: string;
}

/** Payload pushed onto the emoji data channel. */
export interface EmojiPayload {
  emoji: string;   // unicode emoji character, e.g. "❤️"
  sender: string;  // display name of the sender
}
```

- [ ] **Step 6: Create `src/index.tsx` and a minimal `component.tsx`**

`src/index.tsx`:

```tsx
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import ChatEmojiPlugin from './chat-emoji-plugin/component';

const uuid = document.currentScript?.getAttribute('uuid') || 'root';
const pluginName = document.currentScript?.getAttribute('pluginName') || 'plugin';

const root = ReactDOM.createRoot(document.getElementById(uuid) as HTMLElement);
root.render(<ChatEmojiPlugin {...{ pluginUuid: uuid, pluginName }} />);
```

`src/chat-emoji-plugin/component.tsx`:

```tsx
import * as React from 'react';
import { BbbPluginSdk, PluginApi } from 'bigbluebutton-html-plugin-sdk';
import { ChatEmojiPluginProps } from './types';

function ChatEmojiPlugin({ pluginUuid: uuid }: ChatEmojiPluginProps): React.ReactNode {
  BbbPluginSdk.initialize(uuid);
  const pluginApi: PluginApi = BbbPluginSdk.getPluginApi(uuid);
  // Feature wiring added in later tasks.
  void pluginApi;
  return null;
}

export default ChatEmojiPlugin;
```

- [ ] **Step 7: Install and build**

Run: `npm install` then `npm run build-bundle`
Expected: `dist/ChatEmojiPlugin.js` and `dist/manifest.json` are produced, no webpack errors.

- [ ] **Step 8: Commit**

```bash
git init
git add -A
git commit -m "chore: scaffold BBB chat-emoji plugin (builds, loads, no features)"
```

---

## Task 2: Add the emoji Actions-bar button

**Files:**
- Modify: `src/chat-emoji-plugin/component.tsx`

- [ ] **Step 1: Register an ActionsBarButton in a useEffect**

Replace the body of `ChatEmojiPlugin` with:

```tsx
import * as React from 'react';
import { useEffect } from 'react';
import {
  BbbPluginSdk, PluginApi, ActionsBarButton, ActionsBarPosition,
  pluginLogger,
} from 'bigbluebutton-html-plugin-sdk';
import { ChatEmojiPluginProps } from './types';

function ChatEmojiPlugin({ pluginUuid: uuid }: ChatEmojiPluginProps): React.ReactNode {
  BbbPluginSdk.initialize(uuid);
  const pluginApi: PluginApi = BbbPluginSdk.getPluginApi(uuid);

  useEffect(() => {
    const emojiButton = new ActionsBarButton({
      icon: { iconName: 'happy' },
      tooltip: 'Thả emoji lên chat',
      onClick: () => {
        pluginLogger.info('Chat-emoji button clicked');
      },
      position: ActionsBarPosition.RIGHT,
      dataTest: 'chatEmojiButton',
    });
    pluginApi.setActionsBarItems([emojiButton]);
  }, []);

  return null;
}

export default ChatEmojiPlugin;
```

- [ ] **Step 2: Build**

Run: `npm run build-bundle`
Expected: builds clean.

- [ ] **Step 3: Manual verify in a room** (deploy via Task 9 or dev-server)

Expected: a "happy face" button appears on the right of the actions bar; clicking it logs `Chat-emoji button clicked` in the browser console.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add emoji actions-bar button"
```

---

## Task 3: RateLimiter (pure logic, TDD)

**Files:**
- Create: `src/lib/rate-limiter.ts`
- Test: `src/lib/__tests__/rate-limiter.test.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Write the failing test**

`src/lib/__tests__/rate-limiter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  it('allows the first call', () => {
    const rl = new RateLimiter(500);
    expect(rl.tryConsume(1000)).toBe(true);
  });

  it('blocks a second call within the interval', () => {
    const rl = new RateLimiter(500);
    rl.tryConsume(1000);
    expect(rl.tryConsume(1300)).toBe(false);
  });

  it('allows again once the interval has elapsed', () => {
    const rl = new RateLimiter(500);
    rl.tryConsume(1000);
    expect(rl.tryConsume(1500)).toBe(true);
  });

  it('does not update the timestamp when blocked', () => {
    const rl = new RateLimiter(500);
    rl.tryConsume(1000);       // allowed, last=1000
    rl.tryConsume(1200);       // blocked, last stays 1000
    expect(rl.tryConsume(1450)).toBe(false); // 1450-1000=450 < 500 → still blocked
    expect(rl.tryConsume(1501)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../rate-limiter`.

- [ ] **Step 4: Implement `src/lib/rate-limiter.ts`**

```ts
/**
 * Minimal per-instance rate gate. One instance guards the local user's pushes.
 * Framework-free and deterministic: caller supplies `now` (ms).
 */
export class RateLimiter {
  private lastAllowedAt: number | null = null;

  constructor(private readonly minIntervalMs: number) {}

  tryConsume(now: number): boolean {
    if (this.lastAllowedAt !== null && now - this.lastAllowedAt < this.minIntervalMs) {
      return false;
    }
    this.lastAllowedAt = now;
    return true;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/rate-limiter.ts src/lib/__tests__/rate-limiter.test.ts vitest.config.ts
git commit -m "feat: add RateLimiter with unit tests"
```

---

## Task 4: FloatingEmojiQueue reducer (pure logic, TDD)

**Goal:** Given the currently-active emojis and a batch of incoming data-channel entries, return the next active list — deduped by `entryId`, capped at `maxConcurrent`.

**Files:**
- Create: `src/lib/floating-emoji-queue.ts`
- Test: `src/lib/__tests__/floating-emoji-queue.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/__tests__/floating-emoji-queue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reconcileActiveEmojis, ActiveEmoji, IncomingEntry } from '../floating-emoji-queue';

const entry = (id: string, emoji = '❤️'): IncomingEntry => ({
  entryId: id, payloadJson: { emoji, sender: 'A' },
});

describe('reconcileActiveEmojis', () => {
  it('adds new incoming entries to the active list', () => {
    const next = reconcileActiveEmojis([], [entry('1'), entry('2')], 30);
    expect(next.map((e) => e.id)).toEqual(['1', '2']);
    expect(next[0].emoji).toBe('❤️');
  });

  it('ignores entries whose id is already active (dedup)', () => {
    const active: ActiveEmoji[] = [{ id: '1', emoji: '❤️', sender: 'A' }];
    const next = reconcileActiveEmojis(active, [entry('1'), entry('2')], 30);
    expect(next.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('caps the list at maxConcurrent, dropping the oldest', () => {
    const active: ActiveEmoji[] = [
      { id: 'a', emoji: '❤️', sender: 'A' },
      { id: 'b', emoji: '❤️', sender: 'A' },
    ];
    const next = reconcileActiveEmojis(active, [entry('c'), entry('d')], 3);
    expect(next.map((e) => e.id)).toEqual(['b', 'c', 'd']);
  });

  it('returns the same reference when there is nothing new', () => {
    const active: ActiveEmoji[] = [{ id: '1', emoji: '❤️', sender: 'A' }];
    const next = reconcileActiveEmojis(active, [entry('1')], 30);
    expect(next).toBe(active);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../floating-emoji-queue`.

- [ ] **Step 3: Implement `src/lib/floating-emoji-queue.ts`**

```ts
export interface ActiveEmoji {
  id: string;      // == entryId, used as React key
  emoji: string;
  sender: string;
}

export interface IncomingEntry {
  entryId: string;
  payloadJson: { emoji: string; sender: string };
}

/**
 * Pure reducer: merge new data-channel entries into the active list.
 * - dedups by id (entryId)
 * - appends new ones in order
 * - caps total length at maxConcurrent, dropping oldest
 * - returns the SAME array reference if nothing changed (cheap render bailout)
 */
export function reconcileActiveEmojis(
  active: ActiveEmoji[],
  incoming: IncomingEntry[],
  maxConcurrent: number,
): ActiveEmoji[] {
  const activeIds = new Set(active.map((e) => e.id));
  const additions: ActiveEmoji[] = [];
  for (const entry of incoming) {
    if (!activeIds.has(entry.entryId)) {
      activeIds.add(entry.entryId);
      additions.push({
        id: entry.entryId,
        emoji: entry.payloadJson.emoji,
        sender: entry.payloadJson.sender,
      });
    }
  }
  if (additions.length === 0) return active;
  const merged = [...active, ...additions];
  return merged.length > maxConcurrent
    ? merged.slice(merged.length - maxConcurrent)
    : merged;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests in this file; 8 total with Task 3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/floating-emoji-queue.ts src/lib/__tests__/floating-emoji-queue.test.ts
git commit -m "feat: add FloatingEmojiQueue reducer with unit tests"
```

---

## Task 5: Emoji picker component (emoji-mart)

**Goal:** A presentational picker toggled by the button. Emits the chosen native emoji via a callback. No BBB knowledge.

**Files:**
- Create: `src/components/emoji-picker/component.tsx`
- Modify: `src/chat-emoji-plugin/component.tsx`

- [ ] **Step 1: Create the picker component**

`src/components/emoji-picker/component.tsx`:

```tsx
import * as React from 'react';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

export interface EmojiPickerProps {
  onSelect: (native: string) => void;
  onClose: () => void;
}

/** Floating emoji-mart picker anchored bottom-right, above the actions bar. */
function EmojiPicker({ onSelect, onClose }: EmojiPickerProps): React.ReactElement {
  return (
    <div
      style={{
        position: 'fixed', bottom: 70, right: 16, zIndex: 9999,
      }}
      data-test="chatEmojiPicker"
    >
      <div
        style={{ position: 'fixed', inset: 0, zIndex: -1 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <Picker
        data={data}
        onEmojiSelect={(e: { native: string }) => onSelect(e.native)}
        previewPosition="none"
        skinTonePosition="none"
        maxFrequentRows={1}
      />
    </div>
  );
}

export default EmojiPicker;
```

- [ ] **Step 2: Mount the picker from the plugin, toggled by button state**

Update `src/chat-emoji-plugin/component.tsx` to hold open/close state and render the picker into its own React tree (the plugin root can render normal DOM). Replace the file with:

```tsx
import * as React from 'react';
import { useEffect, useState } from 'react';
import {
  BbbPluginSdk, PluginApi, ActionsBarButton, ActionsBarPosition,
} from 'bigbluebutton-html-plugin-sdk';
import { ChatEmojiPluginProps } from './types';
import EmojiPicker from '../components/emoji-picker/component';

function ChatEmojiPlugin({ pluginUuid: uuid }: ChatEmojiPluginProps): React.ReactNode {
  BbbPluginSdk.initialize(uuid);
  const pluginApi: PluginApi = BbbPluginSdk.getPluginApi(uuid);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const emojiButton = new ActionsBarButton({
      icon: { iconName: 'happy' },
      tooltip: 'Thả emoji lên chat',
      onClick: () => setPickerOpen((prev) => !prev),
      position: ActionsBarPosition.RIGHT,
      dataTest: 'chatEmojiButton',
    });
    pluginApi.setActionsBarItems([emojiButton]);
  }, []);

  const handleSelect = (native: string) => {
    setPickerOpen(false);
    // Task 6 wires this to pushEntry.
    // eslint-disable-next-line no-console
    console.log('picked emoji', native);
  };

  return pickerOpen
    ? <EmojiPicker onSelect={handleSelect} onClose={() => setPickerOpen(false)} />
    : null;
}

export default ChatEmojiPlugin;
```

- [ ] **Step 3: Build**

Run: `npm run build-bundle`
Expected: builds clean (emoji-mart bundles into the output).

- [ ] **Step 4: Manual verify**

Expected: clicking the button toggles the emoji picker (bottom-right). Selecting an emoji closes it and logs `picked emoji <native>`. Clicking outside closes it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add emoji-mart picker toggled by actions-bar button"
```

---

## Task 6: Wire the emoji data channel (broadcast + receive)

**Goal:** On pick, rate-limit then `pushEntry` the emoji; subscribe with `NEW_ITEMS` and log incoming entries from all users. Everyone can push.

**Files:**
- Modify: `manifest.json`
- Modify: `src/chat-emoji-plugin/component.tsx`

- [ ] **Step 1: Declare the data channel in `manifest.json`**

```json
{
  "requiredSdkVersion": "~0.0.73",
  "name": "ChatEmojiPlugin",
  "javascriptEntrypointUrl": "ChatEmojiPlugin.js",
  "localesBaseUrl": "",
  "dataChannels": [
    {
      "name": "chat-emoji",
      "pushPermission": ["moderator", "presenter", "viewer"],
      "replaceOrDeletePermission": ["moderator"]
    }
  ]
}
```

> Note: listing all three roles = "everyone can push". If your SDK build rejects `"viewer"`, try `["all"]`; verify by watching for a manifest error in the client console on load.

- [ ] **Step 2: Add the data channel hook, rate limiter, and current user name**

Update `src/chat-emoji-plugin/component.tsx`:

```tsx
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  BbbPluginSdk, PluginApi, ActionsBarButton, ActionsBarPosition, DataChannelTypes,
} from 'bigbluebutton-html-plugin-sdk';
import { ChatEmojiPluginProps, EmojiPayload } from './types';
import EmojiPicker from '../components/emoji-picker/component';
import { RateLimiter } from '../lib/rate-limiter';

const RATE_LIMIT_MS = 500;

function ChatEmojiPlugin({ pluginUuid: uuid }: ChatEmojiPluginProps): React.ReactNode {
  BbbPluginSdk.initialize(uuid);
  const pluginApi: PluginApi = BbbPluginSdk.getPluginApi(uuid);
  const [pickerOpen, setPickerOpen] = useState(false);
  const rateLimiterRef = useRef(new RateLimiter(RATE_LIMIT_MS));

  const currentUser = pluginApi.useCurrentUser();
  const { data: incoming, pushEntry } = pluginApi
    .useDataChannel<EmojiPayload>('chat-emoji', DataChannelTypes.NEW_ITEMS);

  useEffect(() => {
    const emojiButton = new ActionsBarButton({
      icon: { iconName: 'happy' },
      tooltip: 'Thả emoji lên chat',
      onClick: () => setPickerOpen((prev) => !prev),
      position: ActionsBarPosition.RIGHT,
      dataTest: 'chatEmojiButton',
    });
    pluginApi.setActionsBarItems([emojiButton]);
  }, []);

  // TEMP verification for this task — replaced by the overlay in Task 7.
  useEffect(() => {
    if (incoming?.data?.length) {
      // eslint-disable-next-line no-console
      console.log('incoming emoji entries', incoming.data.map((e) => e.payloadJson));
    }
  }, [incoming]);

  const handleSelect = (native: string) => {
    setPickerOpen(false);
    if (!pushEntry) return;
    if (!rateLimiterRef.current.tryConsume(Date.now())) return;
    pushEntry({
      emoji: native,
      sender: currentUser?.data?.name ?? 'Someone',
    });
  };

  return pickerOpen
    ? <EmojiPicker onSelect={handleSelect} onClose={() => setPickerOpen(false)} />
    : null;
}

export default ChatEmojiPlugin;
```

> `pluginApi.useCurrentUser()` returns a graphql wrapper; the display name is at `.data.name`. If your SDK version exposes it differently, log `currentUser` once and adjust the path — do not guess in production.

- [ ] **Step 3: Build**

Run: `npm run build-bundle`
Expected: builds clean.

- [ ] **Step 4: Manual verify cross-user broadcast**

Open the room in **two browser tabs** (two users) in the same meeting. Pick an emoji in tab A. Expected: tab B's console logs `incoming emoji entries [{ emoji, sender }]`. Verify rapid picks are throttled to ~1 per 0.5s in the sender tab.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: broadcast picked emoji over data channel with rate limiting"
```

---

## Task 7: Floating overlay with float-up animation

**Goal:** Render active emojis inside the transparent `FloatingWindow` overlay, each floating up and fading, removed on animation end. Uses the Task 4 reducer + Task 0 strategy.

**Files:**
- Create: `src/components/floating-overlay/component.tsx`
- Modify: `src/chat-emoji-plugin/component.tsx`

- [ ] **Step 1: Create the overlay component**

`src/components/floating-overlay/component.tsx`:

```tsx
import * as React from 'react';
import { ActiveEmoji } from '../../lib/floating-emoji-queue';

// Positioning strategy chosen in Task 0 spike: A (over chat column) or B (bottom-right corner).
// The container is sized + click-through here because FloatingWindow itself has no size/pointer-events props.

const CONTAINER_STYLE: React.CSSProperties = {
  width: 320,
  height: '60vh',
  position: 'relative',
  overflow: 'hidden',
  pointerEvents: 'none',
};

const KEYFRAMES = `
@keyframes chatEmojiFloatUp {
  0%   { transform: translateY(0) scale(0.8); opacity: 0; }
  15%  { opacity: 1; }
  100% { transform: translateY(-42vh) scale(1.15); opacity: 0; }
}`;

export interface FloatingOverlayProps {
  emojis: ActiveEmoji[];
  onEmojiDone: (id: string) => void;
}

function FloatingOverlay({ emojis, onEmojiDone }: FloatingOverlayProps): React.ReactElement {
  return (
    <div style={CONTAINER_STYLE} data-test="chatEmojiOverlay">
      <style>{KEYFRAMES}</style>
      {emojis.map((e) => (
        <span
          key={e.id}
          onAnimationEnd={() => onEmojiDone(e.id)}
          style={{
            position: 'absolute',
            bottom: 0,
            // deterministic horizontal spread from the id so it doesn't jump on re-render
            left: `${10 + (hashToPercent(e.id) * 0.8)}%`,
            fontSize: 34,
            lineHeight: 1,
            willChange: 'transform, opacity',
            animation: 'chatEmojiFloatUp 2.6s ease-out forwards',
          }}
        >
          {e.emoji}
        </span>
      ))}
    </div>
  );
}

/** Stable 0..100 value derived from the entry id, for horizontal placement. */
function hashToPercent(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 100;
  return h;
}

export default FloatingOverlay;
```

- [ ] **Step 2: Wire the overlay into the plugin via FloatingWindow**

The overlay's active list is React state in the plugin, fed by the reducer. Because `FloatingWindow.contentFunction` renders into a detached element with its own React root, we render a small bridge component there that reads the active list. Simplest robust approach: keep the `FloatingWindow` mounted once, and have its content be a component that subscribes to the same data channel and manages its own active list. Update `src/chat-emoji-plugin/component.tsx`:

```tsx
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import {
  BbbPluginSdk, PluginApi, ActionsBarButton, ActionsBarPosition,
  DataChannelTypes, FloatingWindow,
} from 'bigbluebutton-html-plugin-sdk';
import { ChatEmojiPluginProps, EmojiPayload } from './types';
import EmojiPicker from '../components/emoji-picker/component';
import FloatingOverlay from '../components/floating-overlay/component';
import { RateLimiter } from '../lib/rate-limiter';
import { reconcileActiveEmojis, ActiveEmoji } from '../lib/floating-emoji-queue';

const RATE_LIMIT_MS = 500;
const MAX_CONCURRENT = 30;

/** Overlay content: owns the active-emoji list, subscribes to the channel. */
function OverlayContent({ pluginApi }: { pluginApi: PluginApi }): React.ReactElement {
  const { data: incoming } = pluginApi
    .useDataChannel<EmojiPayload>('chat-emoji', DataChannelTypes.NEW_ITEMS);
  const [active, setActive] = useState<ActiveEmoji[]>([]);

  useEffect(() => {
    const entries = incoming?.data ?? [];
    setActive((prev) => reconcileActiveEmojis(prev, entries, MAX_CONCURRENT));
  }, [incoming]);

  const handleDone = (id: string) => setActive((prev) => prev.filter((e) => e.id !== id));

  return <FloatingOverlay emojis={active} onEmojiDone={handleDone} />;
}

function ChatEmojiPlugin({ pluginUuid: uuid }: ChatEmojiPluginProps): React.ReactNode {
  BbbPluginSdk.initialize(uuid);
  const pluginApi: PluginApi = BbbPluginSdk.getPluginApi(uuid);
  const [pickerOpen, setPickerOpen] = useState(false);
  const rateLimiterRef = useRef(new RateLimiter(RATE_LIMIT_MS));

  const currentUser = pluginApi.useCurrentUser();
  const { pushEntry } = pluginApi
    .useDataChannel<EmojiPayload>('chat-emoji', DataChannelTypes.NEW_ITEMS);

  useEffect(() => {
    const emojiButton = new ActionsBarButton({
      icon: { iconName: 'happy' },
      tooltip: 'Thả emoji lên chat',
      onClick: () => setPickerOpen((prev) => !prev),
      position: ActionsBarPosition.RIGHT,
      dataTest: 'chatEmojiButton',
    });
    pluginApi.setActionsBarItems([emojiButton]);

    // Strategy A (Task 0). For Strategy B use the corner coordinates from the spike.
    const overlay = new FloatingWindow({
      id: 'chat-emoji-overlay',
      top: window.innerHeight * 0.25,
      left: window.innerWidth - 360,
      movable: false,
      backgroundColor: 'transparent',
      boxShadow: 'none',
      zIndex: 3,
      contentFunction: (element: HTMLElement) => {
        const root = ReactDOM.createRoot(element);
        root.render(<OverlayContent pluginApi={pluginApi} />);
        return root;
      },
    });
    pluginApi.setFloatingWindows([overlay]);
  }, []);

  const handleSelect = (native: string) => {
    setPickerOpen(false);
    if (!pushEntry) return;
    if (!rateLimiterRef.current.tryConsume(Date.now())) return;
    pushEntry({ emoji: native, sender: currentUser?.data?.name ?? 'Someone' });
  };

  return pickerOpen
    ? <EmojiPicker onSelect={handleSelect} onClose={() => setPickerOpen(false)} />
    : null;
}

export default ChatEmojiPlugin;
```

- [ ] **Step 3: Build**

Run: `npm run build-bundle`
Expected: builds clean.

- [ ] **Step 4: Manual verify the effect**

Two tabs in one meeting. Pick emoji in tab A. Expected: in BOTH tabs an emoji floats up from the bottom of the overlay region (over/near the chat column per Task 0 strategy) and fades out in ~2.6s. Spam several quickly; confirm no more than ~30 render at once and chat stays clickable underneath.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: render floating emoji animation over chat via FloatingWindow overlay"
```

---

## Task 8: Moderator enable/disable toggle

**Goal:** A moderator can turn the effect off for the room. When off: viewers can't push and incoming emojis are ignored.

**Files:**
- Modify: `manifest.json`
- Modify: `src/chat-emoji-plugin/component.tsx`

- [ ] **Step 1: Add a moderator-only control channel to `manifest.json`**

Add a second entry to `dataChannels`:

```json
{
  "name": "chat-emoji-enabled",
  "pushPermission": ["moderator"],
  "replaceOrDeletePermission": ["moderator"]
}
```

- [ ] **Step 2: Read enabled-state and gate push/receive; add a toggle for moderators**

In `src/chat-emoji-plugin/component.tsx`:

1. Determine if the current user is a moderator (log `currentUser?.data` once to confirm the role field; it is commonly `currentUser.data.role === 'MODERATOR'`).
2. Subscribe to the control channel with `LATEST_ITEM`; treat missing/empty as **enabled** (default on):

```tsx
// add DataChannelTypes already imported
const { data: enabledData, pushEntry: pushEnabled } = pluginApi
  .useDataChannel<{ enabled: boolean }>('chat-emoji-enabled', DataChannelTypes.LATEST_ITEM);
const isEnabled = enabledData?.data?.length
  ? enabledData.data[enabledData.data.length - 1].payloadJson.enabled
  : true;
const isModerator = currentUser?.data?.role === 'MODERATOR';
```

3. In the actions-bar `useEffect`, when `isModerator`, register a **second** button to toggle:

```tsx
const items = [emojiButton];
if (isModerator) {
  items.push(new ActionsBarButton({
    icon: { iconName: isEnabled ? 'unmute' : 'mute' },
    tooltip: isEnabled ? 'Tắt hiệu ứng emoji cho phòng' : 'Bật hiệu ứng emoji cho phòng',
    onClick: () => { if (pushEnabled) pushEnabled({ enabled: !isEnabled }); },
    position: ActionsBarPosition.RIGHT,
    dataTest: 'chatEmojiToggle',
  }));
}
pluginApi.setActionsBarItems(items);
```

   Add `isEnabled`, `isModerator`, `pushEnabled` to that `useEffect` dependency array.

4. Gate sending in `handleSelect`: `if (!isEnabled) return;` before rate-limit.
5. Gate rendering: pass `isEnabled` into `OverlayContent` (as a prop) and short-circuit — when disabled, clear active list:

```tsx
useEffect(() => {
  if (!enabled) { setActive([]); return; }
  const entries = incoming?.data ?? [];
  setActive((prev) => reconcileActiveEmojis(prev, entries, MAX_CONCURRENT));
}, [incoming, enabled]);
```

   Since the FloatingWindow content root is created once, re-create the FloatingWindow when `isEnabled` changes by adding `isEnabled` to the main `useEffect` deps and passing `enabled={isEnabled}` into `<OverlayContent .../>`.

- [ ] **Step 3: Build**

Run: `npm run build-bundle`
Expected: builds clean.

- [ ] **Step 4: Manual verify**

Two tabs: one moderator, one viewer. Moderator clicks toggle OFF → viewer's emoji button does nothing and no emojis render; moderator toggle ON → works again. Confirm default state (fresh room, no toggle pushed) is ON.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: moderator enable/disable toggle for emoji effect"
```

---

## Task 9: Deploy to the BBB server and register the plugin

**Goal:** Host the built bundle on `liveclass.meego.study` and register it so all rooms load it.

**Files:**
- Server: nginx static dir + bbb-web properties (on the BBB host, not this repo).

- [ ] **Step 1: Production build**

Run: `npm run build-bundle`
Expected: `dist/ChatEmojiPlugin.js` + `dist/manifest.json`. Set `javascriptEntrypointUrl` in `manifest.json` to the final hosted URL of the JS file, e.g. `https://liveclass.meego.study/plugins/chat-emoji/ChatEmojiPlugin.js`, then rebuild so the copied manifest is correct.

- [ ] **Step 2: Copy the bundle to the server's static web root**

On the server:

```bash
sudo mkdir -p /var/www/bigbluebutton-default/plugins/chat-emoji
# from your machine, scp the two files:
# scp dist/ChatEmojiPlugin.js dist/manifest.json user@liveclass.meego.study:/tmp/
sudo cp /tmp/ChatEmojiPlugin.js /tmp/manifest.json /var/www/bigbluebutton-default/plugins/chat-emoji/
```

Verify both are reachable over HTTPS:
```bash
curl -I https://liveclass.meego.study/plugins/chat-emoji/manifest.json
curl -I https://liveclass.meego.study/plugins/chat-emoji/ChatEmojiPlugin.js
```
Expected: `HTTP/2 200` for both.

- [ ] **Step 3: Register the plugin globally in bbb-web**

Edit `/etc/bigbluebutton/bbb-web.properties` (create if absent — it overrides `/usr/share/bbb-web/WEB-INF/classes/bigbluebutton.properties`). Add:

```properties
pluginManifests=[{"url":"https://liveclass.meego.study/plugins/chat-emoji/manifest.json"}]
```

Then restart:
```bash
sudo bbb-conf --restart
```

> If you only want to test in ONE room first, skip the properties change and instead pass `pluginManifests=[{"url":"..."}]` on the API create call (URL-encoded, with checksum). Global registration is the production path.

- [ ] **Step 4: Full manual test matrix (in a real room)**

Verify each, hard-refresh (Ctrl+Shift+R) first:
- [ ] Emoji button appears next to Reactions.
- [ ] Picker opens/closes; full emoji set available.
- [ ] Picking an emoji floats it up over the chat area for **all** participants.
- [ ] Rate limit (~1 / 0.5s) holds.
- [ ] Concurrent cap (~30) holds under spam; chat remains clickable.
- [ ] Moderator toggle disables/enables for the room; default is ON.
- [ ] Chat panel open/closed/resized behaves per Task 0 strategy (no stuck box, no click-block).

- [ ] **Step 5: Tag the release**

```bash
git tag v0.1.0
git commit --allow-empty -m "release: chat-emoji plugin v0.1.0 deployed to liveclass.meego.study"
```

---

## Notes for the executor

- **Manual-verification tasks are real gates**, not optional. The SDK-integrated behavior (data channel, FloatingWindow) cannot be unit-tested; the two-tab test is the acceptance test.
- **Do not guess SDK field paths** for `useCurrentUser()` (name/role). Log the object once against your live 0.0.x build and confirm before relying on `.data.name` / `.data.role`.
- If FloatingWindow transparency/click-through failed in Task 0, you are on **Strategy B**; use the corner coordinates and skip chat-column positioning entirely.
- Keep `lib/` free of React/BBB imports so the unit tests stay fast and deterministic.
```
