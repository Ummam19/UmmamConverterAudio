export const SPEED_MIN = -5;
export const SPEED_MAX = 5;
export const SPEED_STEP = 0.1;

export function snapSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const snapped = Math.round(value / SPEED_STEP) * SPEED_STEP;
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, snapped));
  const rounded = Math.round(clamped * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatSpeed(speed: number): string {
  const n = snapSpeed(speed);
  return `${n.toFixed(1)}x`;
}

export function modeLabel(speed: number): string {
  if (speed === 0) return "Silent";
  if (speed < 0) return "Reverse";
  if (speed < 1) return "Slower";
  if (speed > 1) return "Faster";
  return "Normal";
}

export function speedRatio(speed: number): number {
  return (snapSpeed(speed) - SPEED_MIN) / (SPEED_MAX - SPEED_MIN);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds + 1e-6);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

export function safeBaseName(filename: string): string {
  const noExt = filename.replace(/\.[^./\\]+$/, "");
  const cleaned = noExt.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 80) || "audio";
}

export function outputFileName(filename: string, speed: number): string {
  return `${safeBaseName(filename)}_${snapSpeed(speed).toFixed(1)}x.wav`;
}

/** Upper bound on the WAV we are willing to hold in memory on this device. */
export function outputByteLimit(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (typeof mem === "number") {
    if (mem <= 2) return 72 * 1024 * 1024;
    if (mem <= 4) return 160 * 1024 * 1024;
    return 420 * 1024 * 1024;
  }
  return mobile ? 96 * 1024 * 1024 : 420 * 1024 * 1024;
}

export function estimateWavBytes(frames: number, channels: number, speedAbs: number): number {
  const outFrames = Math.max(1, Math.floor(frames / speedAbs));
  return 44 + outFrames * channels * 2;
}
