function writeStr(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export async function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const numCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  if (numCh < 1 || frames < 1) throw new Error("Nothing to encode.");
  const dataSize = frames * numCh * 2;
  let buffer: ArrayBuffer;
  try {
    buffer = new ArrayBuffer(44 + dataSize);
  } catch {
    throw new Error("The converted file is too large for this device. Try a faster speed or a shorter clip.");
  }
  const view = new DataView(buffer);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const chunk = 200_000;
  let offset = 44;
  for (let start = 0; start < frames; start += chunk) {
    const end = Math.min(frames, start + chunk);
    for (let i = start; i < end; i++) {
      for (let c = 0; c < numCh; c++) {
        const x = channels[c][i] || 0;
        const s = x < -1 ? -1 : x > 1 ? 1 : x;
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    onProgress?.(end / frames);
    if (end < frames) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function channelPeaks(channels: Float32Array[], bars: number): number[] {
  const length = channels[0]?.length ?? 0;
  if (!length) return [];
  const count = Math.max(24, Math.min(bars, length));
  const block = Math.floor(length / count) || 1;
  const step = Math.max(1, Math.floor(block / 48));
  const out = new Array<number>(count);
  let max = 0;
  for (let i = 0; i < count; i++) {
    const start = i * block;
    const end = Math.min(length, start + block);
    let peak = 0;
    for (let j = start; j < end; j += step) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += Math.abs(channels[c][j] || 0);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > max) max = peak;
  }
  const norm = max > 0.0001 ? max : 1;
  for (let i = 0; i < count; i++) out[i] = out[i] / norm;
  return out;
}
