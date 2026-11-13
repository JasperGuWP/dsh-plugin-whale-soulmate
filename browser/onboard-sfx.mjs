// Tiny WebAudio effects for the onboarding balloons — same recipes as the approved
// reference (boing on select, pop on empty confirm, chime on save). Sound starts ON,
// one visible chip in the card header mutes everything; preference persists.
const MUTE_KEY = 'dsh-soulmate-onboard-muted';

let AC = null;
let master = null;
let muted = false;
try { muted = window.localStorage.getItem(MUTE_KEY) === '1'; } catch (_) { /* storage blocked */ }

function audio() {
  if (!AC) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    AC = new Ctx();
    master = AC.createGain();
    master.gain.value = 0.5;
    master.connect(AC.destination);
  }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}

const sfx = {
  boing() {
    if (muted) return;
    const c = audio();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    const t = c.currentTime;
    o.type = 'sine';
    o.frequency.setValueAtTime(340, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.22);
  },
  pop() {
    if (muted) return;
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.12);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = 0.3;
    src.connect(g);
    g.connect(master);
    src.start(t);
    const o = c.createOscillator();
    const g2 = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
    g2.gain.setValueAtTime(0.18, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g2);
    g2.connect(master);
    o.start(t);
    o.stop(t + 0.1);
  },
  chime() {
    if (muted) return;
    const c = audio();
    if (!c) return;
    ;[660, 990].forEach((f, i) => {
      const t = c.currentTime + i * 0.09;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 0.45);
    })
  },
};

function isMuted() { return muted; }

function setMuted(next) {
  muted = Boolean(next);
  try { window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (_) { /* ignore */ }
  if (!muted) sfx.chime();
}

// Browsers gate AudioContext behind a user gesture; warm it on first pointerdown.
function armAudio() {
  const warm = () => { audio(); };
  window.addEventListener('pointerdown', warm, { once: true });
  return () => window.removeEventListener('pointerdown', warm);
}

module.exports = { sfx, isMuted, setMuted, armAudio };
