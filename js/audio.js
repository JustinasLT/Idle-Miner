"use strict";
// Sounds and music, generated live with the Web Audio API (no audio files to load). The two switches live in
// Settings and are remembered per device. Browsers only allow audio after a tap/click, so everything starts on the first one.
const Sound = (() => {
  const KEY = "idleMiner_audio_v1";
  const prefs = { sfx: true, music: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { /* storage blocked */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* */ } };
  let ctx = null, sfxBus = null, musicBus = null, timer = 0, beat = 0, unlocked = false;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      sfxBus = ctx.createGain(); sfxBus.gain.value = 0.5; sfxBus.connect(ctx.destination);
      musicBus = ctx.createGain(); musicBus.gain.value = 0.11; musicBus.connect(ctx.destination);
    } catch { ctx = null; }
    return ctx;
  }
  // one note with a soft attack/decay envelope
  function note(freq, t, dur, type, vol, bus, glideTo) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.02, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + dur + 0.05);
  }
  const SFX = {
    click: (t) => note(520, t, 0.05, "square", 0.05, sfxBus),
    coin: (t) => { note(988, t, 0.08, "square", 0.12, sfxBus); note(1319, t + 0.07, 0.16, "square", 0.12, sfxBus); },
    claim: (t) => [523, 659, 784, 1047].forEach((f, i) => note(f, t + i * 0.07, 0.18, "triangle", 0.2, sfxBus)),
    upgradeOk: (t) => { [392, 523, 659, 784].forEach((f, i) => note(f, t + i * 0.08, 0.2, "triangle", 0.22, sfxBus)); note(1047, t + 0.34, 0.45, "sine", 0.18, sfxBus); },
    upgradeFail: (t) => { note(220, t, 0.25, "sawtooth", 0.12, sfxBus, 90); note(110, t + 0.12, 0.3, "square", 0.1, sfxBus, 55); },
    levelUp: (t) => [523, 659, 784, 1047, 1319].forEach((f, i) => note(f, t + i * 0.09, 0.28, "triangle", 0.2, sfxBus)),
    error: (t) => note(160, t, 0.18, "square", 0.1, sfxBus, 110),
  };
  function play(name) {
    if (!prefs.sfx || !unlocked || !ensure() || !SFX[name]) return;
    if (ctx.state === "suspended") ctx.resume();
    SFX[name](ctx.currentTime + 0.01);
  }

  // Music: a slow, calm pentatonic arpeggio over a four-chord bass line, scheduled one beat at a time.
  const SCALE = [220, 261.63, 293.66, 329.63, 392, 440, 523.25];
  const BASS = [110, 87.31, 130.81, 98];
  const PATTERN = [0, 2, 4, 2, 3, 5, 4, 2, 1, 3, 4, 6, 4, 3, 2, 1];
  function musicBeat() {
    if (!ctx || !prefs.music || ctx.state !== "running") return;
    const t = ctx.currentTime + 0.05, i = beat++;
    note(SCALE[PATTERN[i % PATTERN.length]], t, 0.7, "triangle", 0.5, musicBus);
    if (i % 4 === 0) note(BASS[Math.floor(i / 4) % BASS.length], t, 1.8, "sine", 0.8, musicBus);
    if (i % 16 === 8) note(SCALE[4] * 2, t, 1.2, "sine", 0.15, musicBus);
  }
  function startMusic() {
    if (!prefs.music || !unlocked || timer || !ensure()) return;
    if (ctx.state === "suspended") ctx.resume();
    timer = setInterval(musicBeat, 520);
  }
  function stopMusic() { clearInterval(timer); timer = 0; }

  // first tap/click anywhere unlocks audio
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (!ensure()) return;
    ctx.resume();
    startMusic();
  }
  function init() {
    ["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, unlock, { once: true, capture: true }));
    // a soft tick on every button (only when sounds are on)
    document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("button")) play("click"); }, true);
    // no music in a hidden tab (idle games stay open for hours)
    document.addEventListener("visibilitychange", () => { if (!ctx) return; if (document.hidden) ctx.suspend(); else if (unlocked) ctx.resume(); });
  }
  return {
    init, play, prefs,
    setSfx(on) { prefs.sfx = !!on; save(); },
    setMusic(on) { prefs.music = !!on; save(); if (on) startMusic(); else stopMusic(); },
  };
})();
