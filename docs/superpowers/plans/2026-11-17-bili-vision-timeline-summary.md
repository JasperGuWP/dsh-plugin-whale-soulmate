# B 站画面理解时间线总结 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After watching a Bilibili video, produce a vision-based timeline takeaway (overview + chapters + opinion + engagement phrase) for the surf card, with optional external ASR when subtitles are missing.

**Architecture:** New `vision-summary.mjs` selects ≤16 frames (live preferred, else storyboard), builds a multimodal prompt, calls an injectable `visionSummarize` callback, and formats takeaway. Optional `asr-client.mjs` POSTs to user-configured endpoint only when transcript is empty. Wired in `watchAndRecordVideo` after live frames; engage patches summary with `｜已点赞…`. Soft-fallback to `composeVideoTakeaway` on any failure.

**Tech Stack:** Node ESM, existing live-frames + subtitle-align, host-injected vision callback, injectable fetch for ASR.

## Global Constraints

- Density presets: `15 / 20 / 30 / 45 / 60 / 90 / 120` via existing `biliLiveFrameEverySec`
- Vision frame hard cap: **16**
- No bundled Whisper/ffmpeg; ASR is external endpoint only
- Soft-fallback never blocks watch/surf
- Do not commit unless user asks
- Chinese UI copy

## File map

| File | Role |
|---|---|
| `packages/soulmate-bili/vision-summary.mjs` | pick frames, prompt, parse, format takeaway, action phrase |
| `packages/soulmate-bili/asr-client.mjs` | POST to `biliAsrEndpoint` |
| `packages/soulmate-bili/index.mjs` | wire after live frames in `watchAndRecordVideo` |
| `packages/soulmate-bili/engage.mjs` | append `｜已点赞…` after engage |
| `packages/soulmate-core/state.mjs` + `plugin-config.mjs` | new extension keys |
| `browser/panel-forms.mjs` (+ draft/panel save) | UI toggles |
| `test/vision-summary.test.mjs` | unit tests |

## Contracts (钉死)

### Vision callback

```js
// options.visionSummarize({ model?, prompt, images: [{ tSec, url, label? }] })
// → { text: string } | throws
// images[].url: https?://… or data:image/…;base64,…
```

### ASR endpoint

```http
POST {biliAsrEndpoint}
Content-Type: application/json
Authorization: Bearer {biliAsrApiKey}   # if key set

{ "bvid": "BVxxx", "audioUrl": "https://…", "durationSec": 120 }
```

Response (either form):

```json
{ "segments": [{ "startSec": 0, "endSec": 12, "text": "…" }] }
```
or `{ "text": "full transcript" }`

### Frame thinning

1. Build candidate times `0, everySec, 2*everySec, … < duration` (at least 1).
2. Map each time to nearest available live/storyboard frame with a URL.
3. If candidates > 16, keep indices `round(i * (n-1) / 15)` for i=0..15 (unique).

---

### Task 1: vision-summary core (TDD)

**Files:**
- Create: `packages/soulmate-bili/vision-summary.mjs`
- Test: `test/vision-summary.test.mjs`

- [ ] **Step 1:** Tests for `pickVisionFrames`, `formatVisionTakeaway`, `appendEngagePhrase`, `parseVisionTimelineText`
- [ ] **Step 2:** Implement until green
- [ ] **Step 3:** `composeVisionTimelineSummary` with mock `visionSummarize` → `ok:live` / `skip:no-frames` / `skip:vision-error`

### Task 2: ASR client (TDD)

**Files:**
- Create: `packages/soulmate-bili/asr-client.mjs`
- Test: `test/asr-client.test.mjs`

- [ ] **Step 1:** Tests: unconfigured → `skip:unconfigured`; mock fetch success → segments joined; error → `skip:error`
- [ ] **Step 2:** Implement `transcribeViaEndpoint({ endpoint, apiKey, bvid, audioUrl, durationSec, fetchImpl })`

### Task 3: Wire watch + engage

**Files:**
- Modify: `packages/soulmate-bili/index.mjs` (`watchAndRecordVideo`)
- Modify: `packages/soulmate-bili/engage.mjs` (`afterSurfWatch` patch summary with actions)

- [ ] **Step 1:** After live frames, if `biliVisionSummary !== false`, call vision summary (ASR only if transcript empty)
- [ ] **Step 2:** On success set `digest.takeaway` + `channels.visionSummary`; on fail keep text takeaway + mark「未看画面」 optionally in opinion
- [ ] **Step 3:** After engage, `summary = appendEngagePhrase(summary, actions)` then `patchSurfLogActions`

### Task 4: Config + panel

**Files:**
- Modify: `state.mjs`, `plugin-config.mjs`, `panel-forms.mjs`, `panel-draft.mjs`, `panel.mjs`

- [ ] **Step 1:** Defaults: `biliVisionSummary: true`, `biliVisionModel: ''`, `biliAsrEndpoint: ''`, `biliAsrApiKey: ''` (key may live in credentials if panel already has secret pattern — prefer credentials.im-style under `extensions` private or credentials.json `bili.asrApiKey`)
- [ ] **Step 2:** Panel: checkbox「画面理解总结」; show density note (reuse slider); ASR endpoint input +「已配置/未配置」hint

### Task 5: Integration test + ship

- [ ] **Step 1:** Extend `test/surf-engage.test.mjs` for `｜已点赞`
- [ ] **Step 2:** Run related tests green
- [ ] **Step 3:** Bump `0.2.111`, pack, overlay desktop `node_modules`

## Spec coverage

| Spec item | Task |
|---|---|
| Vision primary + meta | 1, 3 |
| Live then storyboard | 1 |
| Density presets + ≤16 | 1 |
| Soft fallback + codes | 1, 3 |
| ASR when no subtitles | 2, 3 |
| Engage phrase in summary | 3 |
| Panel hints | 4 |
