// Music, synthesised live with the Web Audio API (no recordings): an original, slow night piece meant to
// sound distant and ancient, like an echo across the cosmos. A simple sung melody passes between a celesta
// and a flute over a soft harp arpeggio, with a drone of open fifths, a far-off choir, a high shimmer and
// a few bells beneath, all sent into a very long reverb and wide echoes.

import { mulberry32 } from './noise.js';

const VOLUME = 0.6;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Open, modal harmony around D (dorian / aeolian, with a lydian Bb), one chord every four bars.
const BEAT = 60 / 66;
const CHORD_SECS = 16 * BEAT;
const CHORDS = [
  { drone: [38, 45], pad: [50, 57, 64, 69] },     // D5 add9
  { drone: [46, 53], pad: [53, 57, 62, 64] },     // Bbmaj7#11
  { drone: [43, 50], pad: [50, 55, 57, 62] },     // G add9
  { drone: [45, 52], pad: [52, 57, 62, 64] },     // A sus4
  { drone: [41, 48], pad: [53, 57, 60, 64, 67] }, // F maj9
  { drone: [40, 47], pad: [52, 55, 60, 62] },     // C sus2 / E
];

// The tune: one four-bar phrase per chord, as [midi note, beats].
const MELODY = [
  [[69, 2], [74, 1], [76, 1], [77, 2], [76, 1], [74, 1], [76, 3], [69, 1], [74, 4]],
  [[77, 2], [76, 1], [74, 1], [69, 2], [74, 2], [76, 1], [77, 1], [81, 2], [76, 4]],
  [[74, 2], [79, 1], [81, 1], [83, 2], [81, 1], [79, 1], [81, 3], [74, 1], [79, 4]],
  [[76, 2], [74, 1], [76, 1], [81, 3], [79, 1], [76, 2], [74, 2], [76, 4]],
  [[72, 1], [77, 1], [79, 1], [81, 1], [84, 3], [81, 1], [79, 2], [77, 1], [76, 1], [77, 2], [81, 2]],
  [[79, 3], [76, 1], [74, 2], [72, 2], [74, 1], [76, 1], [79, 1], [76, 1], [74, 4]],
];
// Who sings it on each pass through the six chords: the celesta, the flute, then a quiet interlude
// where the celesta comes back high and soft only for the last three phrases.
const PASSES = ['celesta', 'flute', 'interlude'];

function tonesIn(chord, lo, hi) {
  const pcs = new Set(chord.pad.map((n) => n % 12));
  const out = [];
  for (let n = lo; n <= hi; n++) if (pcs.has(n % 12)) out.push(n);
  return out;
}

export class Soundscape {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try { this.muted = localStorage.getItem('moonlit-shallows-muted') === '1'; } catch { /* storage unavailable */ }
  }

  // Must be called from a user gesture (or it waits for the next one).
  start() {
    if (this.ctx) return;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === 'suspended') {
      const resume = () => { ctx.resume(); removeEventListener('pointerdown', resume); removeEventListener('keydown', resume); };
      addEventListener('pointerdown', resume);
      addEventListener('keydown', resume);
    }

    const comp = new DynamicsCompressorNode(ctx, { threshold: -20, knee: 14, ratio: 2.5, attack: 0.05, release: 0.8 });
    comp.connect(ctx.destination);
    this.master = new GainNode(ctx, { gain: 0 });
    this.master.connect(comp);
    this.master.gain.setValueAtTime(0, ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(this.muted ? 0 : VOLUME, ctx.currentTime + 10);

    // the space: a 12 s dark reverb, fed also by wide ping-pong echoes
    this.reverb = new ConvolverNode(ctx, { buffer: this.impulse(12) });
    this.reverb.connect(this.master);
    this.echoIn = new GainNode(ctx, { gain: 1 });
    const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    const dl = new DelayNode(ctx, { delayTime: 0.83, maxDelayTime: 2 });
    const dr = new DelayNode(ctx, { delayTime: 1.27, maxDelayTime: 2 });
    const dampL = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1700 });
    const dampR = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1500 });
    this.echoIn.connect(dl);
    dl.connect(dampL).connect(new GainNode(ctx, { gain: 0.5 })).connect(dr);
    dr.connect(dampR).connect(new GainNode(ctx, { gain: 0.5 })).connect(dl);
    dampL.connect(merge, 0, 0);
    dampR.connect(merge, 0, 1);
    const echoOut = new GainNode(ctx, { gain: 0.55 });
    merge.connect(echoOut);
    echoOut.connect(this.master);
    echoOut.connect(this.reverb);

    // each voice chooses how near it sounds: dry (close), echoes, reverb (far away)
    const bus = (dry, echo, verb) => {
      const g = new GainNode(ctx, { gain: 1 });
      if (dry) g.connect(new GainNode(ctx, { gain: dry })).connect(this.master);
      if (echo) g.connect(new GainNode(ctx, { gain: echo })).connect(this.echoIn);
      if (verb) g.connect(new GainNode(ctx, { gain: verb })).connect(this.reverb);
      return g;
    };
    this.low = bus(0.25, 0, 0.5);       // drone
    this.far = bus(0.12, 0.15, 1.0);    // choir, shimmer, wind
    this.echoing = bus(0.1, 0.8, 0.9);  // bells
    this.song = bus(0.5, 0.3, 0.55);    // the melody and its harp: nearer, but still in the same vast space

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    this.step = 0;
    this.nextChord = ctx.currentTime + 0.3;
    this.timer = setInterval(() => this.schedule(), 500);
  }

  setMuted(muted) {
    this.muted = muted;
    try { localStorage.setItem('moonlit-shallows-muted', muted ? '1' : '0'); } catch { /* storage unavailable */ }
    if (!this.ctx) return;
    const g = this.master.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(muted ? 0 : VOLUME, t + 1.5);
  }

  // A long dark stereo tail that loses its highs as it fades.
  impulse(seconds) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        lp += ((Math.random() * 2 - 1) - lp) * (0.45 - 0.4 * t);
        d[i] = lp * Math.pow(1 - t, 3.0) * Math.min(1, i / (ctx.sampleRate * 0.08));
      }
    }
    return buf;
  }

  schedule() {
    const ahead = this.ctx.currentTime + 4;
    while (this.nextChord < ahead) {
      this.playChord(this.step, this.nextChord);
      this.nextChord += CHORD_SECS;
      this.step++;
    }
  }

  playChord(step, t0) {
    const chord = CHORDS[step % CHORDS.length];
    const rng = mulberry32(step * 7919 + 29);
    const dur = CHORD_SECS;

    // root and a pure 3:2 fifth (the tempered fifth's overtones beat slowly against the root's)
    const root = midi(chord.drone[0]);
    this.drone(root, t0, dur + 6, 0.014);
    this.drone(root * 1.5, t0, dur + 6, 0.009);
    chord.pad.forEach((n, i) => this.choir(midi(n), t0 + i * 0.6, dur + 6, 0.013));
    const high = tonesIn(chord, 81, 93);
    this.shimmer(midi(high[Math.floor(rng() * high.length)]), t0 + 2 + rng() * 4, dur, 0.01);

    // a few bells, far apart, ringing into the echoes
    const bells = tonesIn(chord, 76, 96);
    const nb = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < nb; k++) this.bell(midi(bells[Math.floor(rng() * bells.length)]), t0 + 1 + rng() * (dur - 3), 0.05);

    // the melody, after one chord of introduction
    if (step > 0) {
      const m = step - 1, pass = PASSES[Math.floor(m / CHORDS.length) % PASSES.length], phrase = MELODY[m % CHORDS.length];
      const sing = pass !== 'interlude' || m % CHORDS.length >= 3;
      if (sing) {
        let t = t0;
        for (const [n, beats] of phrase) {
          const at = t + (rng() - 0.5) * 0.03, len = beats * BEAT;
          if (pass === 'flute') this.flute(midi(n), at, len, 0.065);
          else if (pass === 'celesta') this.celesta(midi(n), at, len, 0.13);
          else this.celesta(midi(n + 12), at, len, 0.06);
          t += len;
        }
      }
      // a soft harp walking up and down the chord, one note a beat
      const soft = pass === 'interlude' ? 0.6 : 1;
      const arp = tonesIn(chord, 55, 74);
      const shape = [0, 1, 2, 3, 4, 3, 2, 1];
      for (let b = 0; b < 16; b++) {
        const k = shape[b % shape.length] % arp.length;
        this.harp(midi(arp[k]), t0 + b * BEAT + 0.02 * rng(), (b % 4 === 0 ? 0.045 : 0.028) * soft);
      }
    }

    // now and then, a wind passing far across space
    if (rng() < 0.35) this.wind(t0 + rng() * 6, 18 + rng() * 6, 0.03);
  }

  swell(t, attack, peak, release, end, out) {
    const g = new GainNode(this.ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, Math.max(t + attack, end - release));
    g.gain.linearRampToValueAtTime(0, end);
    g.connect(out);
    return g;
  }

  osc(type, f, t, end, out, detune = 0) {
    const o = new OscillatorNode(this.ctx, { type, frequency: f, detune });
    o.connect(out);
    o.start(t);
    o.stop(end + 0.1);
    return o;
  }

  // A low hum: a sine plus a soft filtered saw.
  drone(f, t, dur, vol) {
    const end = t + dur;
    const g = this.swell(t, 6, vol, 6, end, this.low);
    this.osc('sine', f, t, end, g);
    const lp = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 260, Q: 0.7 });
    lp.connect(new GainNode(this.ctx, { gain: 0.35 })).connect(g);
    this.osc('sawtooth', f, t, end, lp);
  }

  // A distant choir "aah": a saw through vowel formants (no detuned copies: they beat in slow pulses).
  choir(f, t, dur, vol) {
    const end = t + dur;
    const g = this.swell(t, 5, vol, 7, end, this.far);
    const sum = new GainNode(this.ctx, { gain: 1 });
    for (const [freq, q, gain] of [[700, 5, 1], [1150, 6, 0.6], [2600, 8, 0.15]]) {
      sum.connect(new BiquadFilterNode(this.ctx, { type: 'bandpass', frequency: freq, Q: q }))
        .connect(new GainNode(this.ctx, { gain })).connect(g);
    }
    this.osc('sawtooth', f, t, end, sum);
  }

  // High, faint sines that slowly fade in and out, like starlight.
  shimmer(f, t, dur, vol) {
    const end = t + dur;
    const g = this.swell(t, 6, vol, 6, end, this.far);
    this.osc('sine', f, t, end, g);
    const octave = new GainNode(this.ctx, { gain: 0.3 });
    octave.connect(g);
    this.osc('sine', f * 2, t, end, octave);
  }

  // FM bell with an inharmonic modulator; a long ring.
  bell(f, t, vol) {
    const ctx = this.ctx, decay = 7;
    const amp = new GainNode(ctx, { gain: 0 });
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vol, t + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    amp.connect(this.echoing);
    const car = new OscillatorNode(ctx, { type: 'sine', frequency: f });
    const mod = new OscillatorNode(ctx, { type: 'sine', frequency: f * 3.53 });
    const depth = new GainNode(ctx, { gain: f * 1.2 });
    depth.gain.setValueAtTime(f * 1.2, t);
    depth.gain.exponentialRampToValueAtTime(f * 0.02, t + 2.5);
    mod.connect(depth).connect(car.frequency);
    car.connect(amp);
    for (const o of [car, mod]) { o.start(t); o.stop(t + decay + 0.05); }
  }

  // Celesta: a struck glassy tone, bright at the strike and ringing on, like a music box under the stars.
  celesta(f, t, len, vol) {
    const ctx = this.ctx, decay = Math.max(2.5, len + 1.5);
    const amp = new GainNode(ctx, { gain: 0 });
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vol, t + 0.004);
    amp.gain.exponentialRampToValueAtTime(vol * 0.35, t + 0.5);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    amp.connect(this.song);
    const bright = new GainNode(ctx, { gain: 0.5 });
    bright.gain.setValueAtTime(0.5, t);
    bright.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    bright.connect(amp);
    const parts = [[f, 1, amp], [f * 2, 0.35, amp], [f * 4.02, 1, bright]];
    for (const [freq, gain, out] of parts) {
      const o = new OscillatorNode(ctx, { type: 'sine', frequency: freq });
      o.connect(new GainNode(ctx, { gain })).connect(out);
      o.start(t);
      o.stop(t + decay + 0.05);
    }
  }

  // Harp: a soft plucked triangle, its brightness closing quickly.
  harp(f, t, vol) {
    const ctx = this.ctx, decay = 2.2;
    const amp = new GainNode(ctx, { gain: 0 });
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vol, t + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: f * 6, Q: 0.5 });
    lp.frequency.setValueAtTime(f * 6, t);
    lp.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.8);
    lp.connect(amp).connect(this.song);
    const o = new OscillatorNode(ctx, { type: 'triangle', frequency: f });
    o.connect(lp);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  // A breathy flute, singing the melody legato.
  flute(f, t, dur, vol) {
    const ctx = this.ctx, end = t + dur + 0.6;
    const g = this.swell(t, 0.12, vol, 0.5, end, this.song);
    const o = this.osc('sine', f, t, end, g);
    const vib = new GainNode(ctx, { gain: 0 });
    vib.gain.setValueAtTime(0, t);
    vib.gain.linearRampToValueAtTime(f * 0.005, t + Math.min(2, dur * 0.7));
    const l = new OscillatorNode(ctx, { type: 'sine', frequency: 4.2 });
    l.connect(vib).connect(o.frequency);
    l.start(t);
    l.stop(end + 0.1);
    const breath = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true });
    breath.connect(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: f * 2, Q: 3 }))
      .connect(new GainNode(ctx, { gain: 0.25 })).connect(g);
    breath.start(t, Math.random() * 2);
    breath.stop(end + 0.1);
  }

  // Noise through a slowly sweeping resonant band: wind across a very large space.
  wind(t, dur, vol) {
    const ctx = this.ctx, end = t + dur;
    const g = this.swell(t, dur * 0.4, vol, dur * 0.5, end, this.far);
    const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 220, Q: 7 });
    bp.frequency.setValueAtTime(220, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + dur * 0.5);
    bp.frequency.exponentialRampToValueAtTime(300, end);
    const src = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true });
    src.connect(bp).connect(g);
    src.start(t);
    src.stop(end + 0.1);
  }
}
