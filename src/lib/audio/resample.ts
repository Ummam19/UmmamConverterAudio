/** Cubic Hermite resample. `step` is source frames advanced per output frame. */
export function resampleChannel(src: Float32Array, outFrames: number, step: number): Float32Array {
  const out = new Float32Array(outFrames);
  const last = src.length - 1;
  if (last <= 0) {
    out.fill(src[0] ?? 0);
    return out;
  }
  for (let i = 0; i < outFrames; i++) {
    const pos = i * step;
    if (pos <= 0) {
      out[i] = src[0];
      continue;
    }
    if (pos >= last) {
      out[i] = src[last];
      continue;
    }
    const i1 = pos | 0;
    const frac = pos - i1;
    const i0 = i1 > 0 ? i1 - 1 : 0;
    const i2 = i1 + 1 <= last ? i1 + 1 : last;
    const i3 = i2 + 1 <= last ? i2 + 1 : last;
    const y0 = src[i0];
    const y1 = src[i1];
    const y2 = src[i2];
    const y3 = src[i3];
    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    out[i] = ((c3 * frac + c2) * frac + c1) * frac + c0;
  }
  return out;
}

export function reverseChannel(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  const last = src.length - 1;
  for (let i = 0; i < src.length; i++) out[i] = src[last - i];
  return out;
}
