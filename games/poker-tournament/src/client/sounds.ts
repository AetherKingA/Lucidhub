// Table sounds, synthesized with Web Audio (no sound files to load). Each one is a short mix of
// noise bursts (cards, chips, knocks) and tones (chimes).

export type Sound = "turn" | "deal" | "flip" | "fold" | "check" | "call" | "bet" | "raise" | "allIn" | "collect" | "win" | "bigWin" | "warn" | "tick" | "click";

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function audio() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  if (!noise) {
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return ctx;
}

/** A filtered burst of noise: card swishes, chip clicks, knocks on the table. */
function burst(ac: AudioContext, at: number, o: { dur: number; freq: number; q?: number; type?: BiquadFilterType; vol: number; sweepTo?: number }) {
  const src = ac.createBufferSource();
  src.buffer = noise;
  const f = ac.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  f.frequency.setValueAtTime(o.freq, at);
  if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, at + o.dur);
  f.Q.value = o.q ?? 1;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(o.vol, at + Math.min(0.01, o.dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);
  src.connect(f).connect(g).connect(ac.destination);
  src.start(at, Math.random() * 0.5, o.dur + 0.05);
}

function tone(ac: AudioContext, at: number, freq: number, dur: number, vol: number, type: OscillatorType = "sine", glideTo?: number) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(ac.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
}

/** One clay chip landing on others. */
function chip(ac: AudioContext, at: number, vol: number) {
  burst(ac, at, { dur: 0.05, freq: 3200 + Math.random() * 1200, q: 6, vol });
  tone(ac, at, 2400 + Math.random() * 600, 0.04, vol * 0.25, "triangle");
}

/** A few chips tossed in, one after another. */
function chips(ac: AudioContext, at: number, count: number, vol: number) {
  for (let i = 0; i < count; i++) chip(ac, at + i * (0.035 + Math.random() * 0.03), vol * (0.7 + Math.random() * 0.3));
}

/** Plays a sound. `vol` scales it (other players' actions are a bit quieter than yours). */
export function play(sound: Sound, vol = 1, delay = 0) {
  try {
    const ac = audio();
    const t = ac.currentTime + delay;
    const v = (x: number) => Math.max(0.0002, x * vol);
    switch (sound) {
      case "turn":
        tone(ac, t, 660, 0.25, v(0.12));
        tone(ac, t + 0.12, 880, 0.3, v(0.12));
        break;
      case "deal":
        for (let i = 0; i < 4; i++) burst(ac, t + i * 0.09, { dur: 0.08, freq: 2500, sweepTo: 5000, q: 0.8, type: "highpass", vol: v(0.12) });
        break;
      case "flip":
        burst(ac, t, { dur: 0.07, freq: 1800, sweepTo: 4000, q: 0.9, vol: v(0.18) });
        burst(ac, t + 0.05, { dur: 0.03, freq: 900, q: 2, vol: v(0.14) });
        break;
      case "fold":
        burst(ac, t, { dur: 0.22, freq: 3000, sweepTo: 700, q: 0.7, vol: v(0.1) });
        break;
      case "check":
        // Two knocks on the felt.
        for (const dt of [0, 0.13]) {
          burst(ac, t + dt, { dur: 0.08, freq: 220, q: 1.5, type: "lowpass", vol: v(0.5) });
          tone(ac, t + dt, 140, 0.08, v(0.18), "sine", 90);
        }
        break;
      case "call":
        chips(ac, t, 3, v(0.22));
        break;
      case "bet":
        chips(ac, t, 5, v(0.24));
        break;
      case "raise":
        chips(ac, t, 7, v(0.26));
        tone(ac, t + 0.05, 440, 0.18, v(0.05), "triangle", 660);
        break;
      case "allIn":
        // A whole stack pushed in, with a rising swell.
        burst(ac, t, { dur: 0.35, freq: 600, sweepTo: 2500, q: 0.8, vol: v(0.12) });
        chips(ac, t + 0.1, 12, v(0.24));
        tone(ac, t, 220, 0.6, v(0.07), "sawtooth", 440);
        tone(ac, t + 0.3, 523, 0.4, v(0.08), "triangle");
        tone(ac, t + 0.3, 659, 0.4, v(0.06), "triangle");
        break;
      case "collect":
        // Bets swept into the pot.
        burst(ac, t, { dur: 0.25, freq: 1500, sweepTo: 3500, q: 0.6, vol: v(0.07) });
        chips(ac, t + 0.12, 4, v(0.14));
        break;
      case "win":
        chips(ac, t, 6, v(0.2));
        [523, 659, 784].forEach((f, i) => tone(ac, t + 0.1 + i * 0.09, f, 0.35, v(0.08), "triangle"));
        break;
      case "bigWin":
        chips(ac, t, 10, v(0.24));
        [523, 659, 784, 1047].forEach((f, i) => tone(ac, t + 0.1 + i * 0.1, f, 0.45, v(0.11), "triangle"));
        tone(ac, t + 0.5, 1319, 0.7, v(0.08), "sine");
        break;
      case "warn":
        tone(ac, t, 880, 0.12, v(0.12), "square");
        tone(ac, t + 0.18, 880, 0.12, v(0.12), "square");
        break;
      case "tick":
        tone(ac, t, 1200, 0.05, v(0.08), "square");
        break;
      case "click":
        burst(ac, t, { dur: 0.03, freq: 2000, q: 3, vol: v(0.12) });
        break;
    }
  } catch {
    /* no audio */
  }
}
