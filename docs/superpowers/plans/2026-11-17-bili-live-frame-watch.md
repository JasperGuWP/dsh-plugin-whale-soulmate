# B 站轻量真看 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Optional login+ffmpeg live frame sampling (user-picked interval, densest 15s/frame) merged into bili digest; soft-fallback when unavailable.

**Architecture:** New `packages/soulmate-bili/live-frames.mjs` owns ffmpeg probe, playurl pick, and extraction. `digestBiliVideo` optionally calls it. Config/UI expose enable + everySec. Auth status reports ffmpegReady.

**Tech Notes:** Spec `docs/superpowers/specs/2026-11-17-bili-live-frame-watch-design.md`. No bundled ffmpeg. Frames under `home.rootDir/cache/live-frames/<bvid>/`.

## File map

- `packages/soulmate-bili/live-frames.mjs` (new)
- `packages/soulmate-bili/index.mjs` — wire into digest + exports
- `packages/soulmate-bili/auth/credentials.mjs` — status fields
- `packages/soulmate-core/state.mjs` + `plugin-config.mjs` — extensions
- `browser/panel-forms.mjs` + draft/save — UI
- `test/bili-live-frames.test.mjs` (new)

## Tasks

1. TDD helpers: clamp everySec, frame budget, ffmpegReady mock
2. Implement live-frames.mjs
3. Wire digestBiliVideo + auth status + config/UI
4. Tests green → bump pack install
