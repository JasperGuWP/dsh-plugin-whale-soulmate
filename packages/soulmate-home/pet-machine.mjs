// Desktop-pet sprite state machine — pure logic, zero DOM / zero timers.
// The browser half (client.js) runs an equivalent inline driver because the DSH
// ModuleLoader factory cannot import ESM; timings always come from pet.json so the
// two can never drift on configuration. Keep algorithms in sync when editing.
//
// Two intentional browser-side divergences (video pipeline, PRD §5.3 / 审核 #12):
//   1. once-states (wave/happy/eureka) with a shipped video are driven by the video
//      `ended` event (+ a holdSec+10s watchdog), not the dwell timer.
//   2. walk facing follows the locomotion travel direction (target > start → mirror),
//      overriding this machine's random facing. This mirror stays random (test-only).
//
// Driven externally: machine.update(tMs) advances timing, machine.current() returns
// { state, frame, mirror } for the renderer to blit.

const dwellMs = (st, rand) => {
  const d = st && st.dwellSec;
  if (Array.isArray(d) && d.length) {
    const lo = Number(d[0]) || 0;
    const hi = Number(d[1] || d[0]) || lo;
    return (lo + rand() * Math.max(0, hi - lo)) * 1000;
  }
  const hold = Number(st && st.holdSec) || 0;
  return hold * 1000;
};

export function createPetMachine(manifest, opts = {}) {
  const states = (manifest && manifest.states) || {};
  const rand = typeof opts.random === 'function' ? opts.random : Math.random;
  const clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleepAfterMs = (Number(opts.sleepAfterIdleSec) || Number(manifest?.states?.sleep?.enterAfterIdleSec) || 300) * 1000;

  const m = {
    state: 'idle',
    idx: 0,
    facing: -1, // sprite frames face left; facing 1 means "mirror for right"
    dragging: false,
    enteredAt: clock(),
    switchAt: 0,
    blinkAt: 0,
    lastAct: clock(),
  };

  const enter = (name, t) => {
    m.state = states[name] ? name : 'idle';
    m.idx = 0;
    m.enteredAt = t;
    m.switchAt = t + dwellMs(states[m.state], rand);
    if (m.state === 'walk') m.facing = rand() < 0.5 ? -1 : 1;
    if (m.state === 'idle') m.blinkAt = t + 1200 + rand() * 2600;
  };
  enter('idle', m.enteredAt);

  const event = (name, t = clock()) => {
    m.lastAct = t;
    if (name === 'walk') { enter('walk', t); return; }
    if (name === 'think') { enter('think', t); return; }
    if (name === 'eureka') { enter('eureka', t); return; }
    if (name === 'dragStart') { m.dragging = true; enter('drag', t); return; }
    if (name === 'dragEnd') { m.dragging = false; enter('happy', t); return; }
    if (name === 'turn') { m.facing = -m.facing; return; }
    if (m.state === 'sleep') { enter('happy', t); return; } // wake
    if (name === 'click') enter('wave', t);
    else if (name === 'dblclick') enter('happy', t);
  };

  const update = (t = clock()) => {
    const st = states[m.state] || {};
    if (m.dragging || t < m.switchAt) return;
    if (m.state === 'sleep') return; // sleeps until an event wakes her
    if (m.state === 'think') {
      // thinking persists until eureka / another event; only a safety timeout ends it
      if (t - m.enteredAt >= (Number(states.think?.maxSec) || 120) * 1000) enter('idle', t);
      return;
    }
    const idleFor = t - m.lastAct;
    if ((m.state === 'idle' || m.state === 'sit') && states.sleep && idleFor >= sleepAfterMs) {
      enter('sleep', t);
      return;
    }
    if (st.next && Object.keys(st.next).length) {
      let roll = rand();
      let pick = null;
      for (const [key, p] of Object.entries(st.next)) {
        if (roll < p) { pick = key; break; }
        roll -= p;
      }
      enter(pick || 'idle', t);
      return;
    }
    enter('idle', t);
  };

  const current = (t = clock()) => {
    const st = states[m.state] || {};
    if (m.state === 'walk' && !m.dragging) {
      const fps = Number(st.fps) || 6;
      const walkFrames = st.frames || [];
      if (walkFrames.length) m.idx = Math.floor((t - m.enteredAt) / (1000 / fps)) % walkFrames.length;
    }
    if (m.state === 'think') {
      const fps = Number(st.fps) || 2;
      const thinkFrames = st.frames || [];
      if (thinkFrames.length) m.idx = Math.floor((t - m.enteredAt) / (1000 / fps)) % thinkFrames.length;
    }
    if (m.state === 'idle' && st.blink && t >= m.blinkAt && t < m.blinkAt + (Number(st.blinkSec) || 0.12) * 1000) {
      return { state: 'idle', frame: st.blink, mirror: false, blinking: true };
    }
    if (m.state === 'idle' && t >= m.blinkAt + (Number(st.blinkSec) || 0.12) * 1000) {
      m.blinkAt = t + 1500 + rand() * 2600;
    }
    const frames = st.frames || ['pet-idle-01'];
    return {
      state: m.state,
      frame: frames[m.idx % frames.length],
      mirror: m.state === 'walk' && m.facing === 1,
      blinking: false,
    };
  };

  return { event, update, current, get state() { return m.state; }, get facing() { return m.facing; } };
}