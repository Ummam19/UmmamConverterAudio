import { decodeWithFfmpeg } from "@/lib/audio/ffmpeg-decode";
import { resampleChannel, reverseChannel } from "@/lib/audio/resample";
import { estimateWavBytes, outputByteLimit } from "@/lib/audio/speed";
import { channelPeaks, encodeWav } from "@/lib/audio/wav";

export type BusyUpdate = (label: string, ratio: number) => void;

function yieldNow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function durationClose(expected: number, actual: number): boolean {
  if (!(expected > 0) || !(actual > 0)) return false;
  return Math.abs(actual - expected) / expected < 0.08;
}

async function reverseBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  onProgress: (ratio: number) => void,
): Promise<AudioBuffer> {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const frames = buffer.length;
  const chunk = 250_000;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let start = 0; start < frames; start += chunk) {
      const end = Math.min(frames, start + chunk);
      for (let i = start; i < end; i++) dst[frames - 1 - i] = src[i];
      onProgress((c + end / frames) / buffer.numberOfChannels);
      if (end < frames) await yieldNow();
    }
  }
  return out;
}

function offlineSpeed(
  source: AudioBuffer,
  absSpeed: number,
  onProgress: (ratio: number) => void,
): Promise<AudioBuffer> {
  const length = Math.max(1, Math.floor(source.length / absSpeed));
  const offline = new OfflineAudioContext(source.numberOfChannels, length, source.sampleRate);
  const node = offline.createBufferSource();
  node.buffer = source;
  node.playbackRate.value = absSpeed;
  node.connect(offline.destination);
  node.start(0);

  const duration = length / source.sampleRate;
  if (duration > 0.2) {
    const steps = 8;
    for (let i = 1; i < steps; i++) {
      const at = (duration * i) / steps;
      void offline
        .suspend(at)
        .then(() => {
          onProgress(i / steps);
          return offline.resume();
        })
        .catch(() => undefined);
    }
  }

  const timeoutMs = Math.min(55_000, Math.max(8_000, duration * 600 + 3_000));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Render timed out")), timeoutMs);
    offline.startRendering().then(
      (rendered) => {
        clearTimeout(timer);
        onProgress(1);
        resolve(rendered);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Render failed"));
      },
    );
  });
}

async function manualSpeed(
  ctx: BaseAudioContext,
  source: AudioBuffer,
  absSpeed: number,
  onProgress: (ratio: number) => void,
): Promise<AudioBuffer> {
  const inRate = source.sampleRate;
  const outRate = inRate >= 8_000 && inRate <= 96_000 ? inRate : 48_000;
  const outFrames = Math.max(1, Math.round((source.length / inRate / absSpeed) * outRate));
  let buffer: AudioBuffer;
  try {
    buffer = ctx.createBuffer(source.numberOfChannels, outFrames, outRate);
  } catch {
    throw new Error("This sample rate isn't supported on this device.");
  }
  const step = (inRate / outRate) * absSpeed;
  for (let c = 0; c < source.numberOfChannels; c++) {
    const src = source.getChannelData(c);
    const rendered = resampleChannel(src, outFrames, step);
    buffer.getChannelData(c).set(rendered);
    onProgress((c + 1) / source.numberOfChannels);
    await yieldNow();
  }
  return buffer;
}

function tooLargeMessage(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `Converted audio would be about ${mb.toFixed(0)} MB, which is too large for this device. Use a faster speed or a shorter clip.`;
}

export function assertOutputFits(buffer: AudioBuffer, speedAbs: number) {
  const bytes = estimateWavBytes(buffer.length, Math.min(buffer.numberOfChannels, 2), speedAbs);
  if (bytes > outputByteLimit()) throw new Error(tooLargeMessage(bytes));
}

/** Keep mono/stereo. Fold extra channels so the file plays everywhere. */
export function mixToStereo(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels <= 2) return buffer;
  const out = ctx.createBuffer(2, buffer.length, buffer.sampleRate);
  const left = out.getChannelData(0);
  const right = out.getChannelData(1);
  const data: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) data.push(buffer.getChannelData(c));
  const n = data.length;
  for (let i = 0; i < buffer.length; i++) {
    let l = 0;
    let r = 0;
    let ln = 0;
    let rn = 0;
    for (let c = 0; c < n; c++) {
      if (c % 2 === 0) {
        l += data[c][i];
        ln++;
      } else {
        r += data[c][i];
        rn++;
      }
    }
    left[i] = ln ? l / ln : 0;
    right[i] = rn ? r / rn : l / (ln || 1);
  }
  return out;
}

export async function decodeAudioFile(file: File, onProgress: BusyUpdate): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  await ctx.resume();
  onProgress("Reading audio...", 0.08);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength < 16) throw new Error("This file is empty.");

  let decoded: AudioBuffer | null = null;
  try {
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    decoded = null;
  }
  if (!decoded || decoded.length < 1 || !(decoded.duration > 0)) {
    onProgress("Decoding audio...", 0.1);
    const wav = await decodeWithFfmpeg(file, bytes, onProgress);
    try {
      decoded = await ctx.decodeAudioData(wav.slice(0));
    } catch {
      throw new Error("This audio format isn't supported on this device.");
    }
  }
  if (!decoded || decoded.length < 1 || !(decoded.duration > 0)) {
    throw new Error("Couldn't read any audio in this file.");
  }
  const mixed = mixToStereo(ctx, decoded);
  onProgress("Reading audio...", 1);
  return mixed;
}

export async function renderAtSpeed(
  buffer: AudioBuffer,
  speed: number,
  onProgress: (ratio: number) => void,
): Promise<AudioBuffer> {
  const absSpeed = Math.abs(speed);
  if (absSpeed < 0.05) throw new Error("0.0x is silent. Move the slider off zero.");
  assertOutputFits(buffer, absSpeed);
  const ctx = getAudioContext();
  const source =
    speed < 0 ? await reverseBuffer(ctx, buffer, (ratio) => onProgress(ratio * 0.15)) : buffer;
  onProgress(speed < 0 ? 0.15 : 0.05);
  if (Math.abs(absSpeed - 1) < 0.001) {
    onProgress(0.9);
    return source;
  }
  try {
    const rendered = await offlineSpeed(source, absSpeed, (ratio) => onProgress(0.15 + ratio * 0.7));
    if (!durationClose(source.duration / absSpeed, rendered.duration)) {
      throw new Error("mismatch");
    }
    return rendered;
  } catch (error) {
    if (error instanceof Error && /too large|silent|sample rate/i.test(error.message)) throw error;
    return manualSpeed(ctx, source, absSpeed, (ratio) => onProgress(0.15 + ratio * 0.7));
  }
}

export async function bufferToWav(buffer: AudioBuffer, onProgress: (ratio: number) => void): Promise<Blob> {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return encodeWav(channels, buffer.sampleRate, onProgress);
}

export function peaksFromBuffer(buffer: AudioBuffer, bars = 140): number[] {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return channelPeaks(channels, bars);
}

let sharedCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new AudioContext();
  return sharedCtx;
}

export function reversedCopy(buffer: AudioBuffer): AudioBuffer {
  const ctx = getAudioContext();
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.getChannelData(c).set(reverseChannel(buffer.getChannelData(c)));
  }
  return out;
}
