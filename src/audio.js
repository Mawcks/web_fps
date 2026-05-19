/**
 * Synthesized sound effects — Web Audio, no asset files.
 *
 * Every sound is built from oscillators and noise bursts at call time, so the
 * whole audio package ships as a few hundred lines of code. The context is
 * created lazily on the first user gesture (browsers block audio before one).
 *
 * Combat sounds take an optional { pan, gain } so a remote player's gunshot
 * can be placed in the stereo field — quieter and off to one side the further
 * and more to the flank the shooter is.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Sfx {
  constructor() {
    this.ac = null;
    this.master = null;
    this.volume = 0.7;
    this._noiseBuf = null;
  }

  /** Create and resume the audio context — must be called from a user gesture. */
  unlock() {
    if (!this.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.master.gain.value = this.volume;
      // a compressor keeps a fast spray from clipping into harshness
      const comp = this.ac.createDynamicsCompressor();
      this.master.connect(comp);
      comp.connect(this.ac.destination);
      this._noiseBuf = this._makeNoise(0.6);
    }
    if (this.ac.state === 'suspended') this.ac.resume();
  }

  /** Master volume, 0..1. */
  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  get _ready() {
    return !!this.ac && this.ac.state === 'running' && this.volume > 0;
  }

  _makeNoise(seconds) {
    const len = Math.floor(this.ac.sampleRate * seconds);
    const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** A gain (and optional pan) node feeding the master — one per positioned sound. */
  _bus(pan = 0, gain = 1) {
    const g = this.ac.createGain();
    g.gain.value = gain;
    if (pan && this.ac.createStereoPanner) {
      const p = this.ac.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      p.connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  /** A short tone with a fast attack and an exponential decay tail. */
  _tone(freq, dur, opts = {}) {
    const { type = 'sine', gain = 0.3, when = 0, sweepTo = 0, bus = this.master } = opts;
    const ac = this.ac;
    const t = ac.currentTime + when;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  /** A burst of noise through a downward-sweeping lowpass — the body of impacts. */
  _noiseBurst(dur, opts = {}) {
    const { lpFrom = 3000, lpTo = 600, gain = 0.6, when = 0, bus = this.master } = opts;
    const ac = this.ac;
    const t = ac.currentTime + when;
    const src = ac.createBufferSource();
    src.buffer = this._noiseBuf;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(lpFrom, t);
    lp.frequency.exponentialRampToValueAtTime(lpTo, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp);
    lp.connect(g);
    g.connect(bus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** A gunshot — noise crack over a low body. Pass { pan, gain } to place it. */
  shoot({ pan = 0, gain = 1 } = {}) {
    if (!this._ready) return;
    const bus = this._bus(pan, gain);
    this._noiseBurst(0.15, { lpFrom: 3600, lpTo: 470, gain: 0.55, bus });
    this._tone(150, 0.13, { type: 'triangle', gain: 0.38, sweepTo: 56, bus });
  }

  /** Hitmarker confirm — a crisp tick, higher for a headshot, with a kill flourish. */
  hit(headshot, killed) {
    if (!this._ready) return;
    this._tone(headshot ? 1320 : 960, 0.06, { type: 'square', gain: 0.16 });
    if (killed) this._tone(660, 0.16, { type: 'square', gain: 0.14, when: 0.05, sweepTo: 300 });
  }

  /** Took damage — a dull low thud. */
  hurt() {
    if (!this._ready) return;
    this._noiseBurst(0.18, { lpFrom: 850, lpTo: 190, gain: 0.3 });
    this._tone(120, 0.2, { type: 'sine', gain: 0.32, sweepTo: 58 });
  }

  /** Local death — a long downward groan. */
  die() {
    if (!this._ready) return;
    this._tone(300, 0.7, { type: 'sawtooth', gain: 0.26, sweepTo: 68 });
    this._noiseBurst(0.5, { lpFrom: 680, lpTo: 110, gain: 0.16 });
  }

  /** Round start — a calm two-note "get ready". */
  roundStart() {
    if (!this._ready) return;
    this._tone(392, 0.16, { type: 'triangle', gain: 0.22 });
    this._tone(523, 0.32, { type: 'triangle', gain: 0.24, when: 0.16 });
  }

  /** Round over — a rising arpeggio on a win, a falling one on a loss. */
  roundEnd(won) {
    if (!this._ready) return;
    const notes = won ? [523, 659, 784] : [440, 349, 262];
    notes.forEach((f, i) =>
      this._tone(f, 0.3, { type: won ? 'triangle' : 'sine', gain: 0.24, when: i * 0.13 }),
    );
  }

  /** Match over — a longer fanfare on a win, a slow low fall on a loss. */
  matchEnd(won) {
    if (!this._ready) return;
    const notes = won ? [523, 659, 784, 1046] : [330, 262, 196];
    const step = won ? 0.14 : 0.22;
    notes.forEach((f, i) =>
      this._tone(f, won ? 0.4 : 0.6, {
        type: won ? 'triangle' : 'sine',
        gain: 0.24,
        when: i * step,
      }),
    );
    if (won) this._tone(1046, 0.7, { type: 'triangle', gain: 0.18, when: 0.56 });
  }
}
