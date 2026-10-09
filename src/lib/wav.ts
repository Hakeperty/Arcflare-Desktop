// Turning a microphone recording into a clip the TTS models can clone from:
// mono, 24 kHz, 16-bit PCM WAV, with the silence before and after cut off.
// The recorder hands us compressed audio (webm/opus); every cloning model
// reads WAV, and the engine measures a WAV's length from its header.

export const TAKE_RATE = 24000;

/** Decode a recorded blob to mono samples at TAKE_RATE. */
export async function decodeToMono(blob: Blob, rate = TAKE_RATE): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(buf.duration * rate));
    const off = new OfflineAudioContext(1, frames, rate);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0).slice();
  } finally {
    ctx.close().catch(() => {});
  }
}

/**
 * Cut leading and trailing silence, keeping a little air around the speech.
 * Measured over 20 ms windows, so a click doesn't count as speech.
 */
export function trimSilence(x: Float32Array, rate = TAKE_RATE, threshold = 0.012, padSeconds = 0.15): Float32Array {
  const win = Math.round(rate * 0.02);
  const loud = (i: number) => {
    let sum = 0;
    const end = Math.min(x.length, i + win);
    for (let j = i; j < end; j++) sum += x[j] * x[j];
    return Math.sqrt(sum / Math.max(1, end - i)) > threshold;
  };
  let start = 0;
  while (start < x.length && !loud(start)) start += win;
  let end = x.length;
  while (end > start && !loud(Math.max(start, end - win))) end -= win;
  if (end <= start) return x;
  const pad = Math.round(rate * padSeconds);
  return x.slice(Math.max(0, start - pad), Math.min(x.length, end + pad));
}

/** Scale so the loudest sample sits just under full scale, if it is quiet. */
export function normalize(x: Float32Array, target = 0.9): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak < 1e-4 || peak >= target) return x;
  const g = target / peak;
  return x.map((v) => v * g);
}

/** 16-bit PCM mono WAV. */
export function encodeWav(x: Float32Array, rate = TAKE_RATE): ArrayBuffer {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + x.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** What to say about a clip's length before cloning from it (matches the engine). */
export function clipAdvice(seconds: number | null | undefined): string | null {
  if (seconds == null || !isFinite(seconds)) return null;
  if (seconds < 3) return "shorter than 3 s — most models need more to copy a voice";
  if (seconds < 5) return "short — 5 to 30 s of one speaker clones best";
  if (seconds > 30) return "longer than 30 s — trim it to the clearest 5-30 s";
  return null;
}
