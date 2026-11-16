import { previewPathPrefix } from "@/lib/preview-path-prefix";

type ProgressFn = (label: string, ratio: number) => void;

type FfmpegApi = {
  loaded: boolean;
  load: (config?: { coreURL?: string; wasmURL?: string }) => Promise<boolean>;
  writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
  readFile: (path: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<boolean>;
  exec: (args: string[], timeout?: number) => Promise<number>;
  on: (event: "progress", cb: (ev: { progress: number }) => void) => void;
  off: (event: "progress", cb: (ev: { progress: number }) => void) => void;
};

let ffmpegPromise: Promise<FfmpegApi> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function assetUrl(path: string): string {
  const prefix = previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
  const base = import.meta.env.BASE_URL || "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${normalizedBase}${path.replace(/^\//, "")}`;
}

async function fetchBlobUrl(url: string, mime: string, onRatio: (ratio: number) => void): Promise<string> {
  let response: Response | undefined;
  try {
    const cache = await caches.open("uac-ffmpeg-v1");
    const cached = await cache.match(url);
    if (cached) {
      response = cached;
    } else {
      const net = await fetch(url);
      if (!net.ok) throw new Error(`asset ${net.status}`);
      try {
        await cache.put(url, net.clone());
      } catch {
        /* private mode or opaque response */
      }
      response = net;
    }
  } catch {
    const net = await fetch(url);
    if (!net.ok) throw new Error(`asset ${net.status}`);
    response = net;
  }

  const total = Number(response.headers.get("content-length") || 0);
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    onRatio(1);
    return URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: mime }));
  }
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const copy = new ArrayBuffer(value.byteLength);
      new Uint8Array(copy).set(value);
      chunks.push(copy);
      received += value.byteLength;
      if (total > 0) onRatio(Math.min(1, received / total));
    }
  }
  onRatio(1);
  return URL.createObjectURL(new Blob(chunks, { type: mime }));
}

async function loadFfmpeg(onProgress: ProgressFn): Promise<FfmpegApi> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      onProgress("Loading format support...", 0.02);
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const ffmpeg = new FFmpeg() as unknown as FfmpegApi;
      const coreURL = await fetchBlobUrl(assetUrl("ffmpeg/ffmpeg-core.js"), "text/javascript", () => {});
      const wasmURL = await fetchBlobUrl(assetUrl("ffmpeg/ffmpeg-core.wasm"), "application/wasm", (ratio) => {
        onProgress("Loading format support...", 0.05 + ratio * 0.9);
      });
      await ffmpeg.load({ coreURL, wasmURL });
      onProgress("Loading format support...", 1);
      return ffmpeg;
    })().catch((error: unknown) => {
      ffmpegPromise = null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`ffmpeg-load: ${detail}`);
    });
  }
  return ffmpegPromise;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function extensionOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return ext && ext.length <= 5 ? ext : "bin";
}

/** Decode exotic containers to a 16-bit WAV blob the browser can play. */
export function decodeWithFfmpeg(file: File, bytes: ArrayBuffer, onProgress: ProgressFn): Promise<ArrayBuffer> {
  return enqueue(async () => {
    let ffmpeg: FfmpegApi;
    try {
      ffmpeg = await loadFfmpeg(onProgress);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Extra format support couldn't load. ${detail}`);
    }
    const input = `input.${extensionOf(file.name)}`;
    const output = "out.wav";
    const onExec = ({ progress }: { progress: number }) => {
      if (progress >= 0 && progress <= 1) onProgress("Decoding audio...", progress);
    };
    ffmpeg.on("progress", onExec);
    try {
      onProgress("Decoding audio...", 0);
      await ffmpeg.writeFile(input, new Uint8Array(bytes));
      const code = await ffmpeg.exec(
        ["-i", input, "-vn", "-acodec", "pcm_s16le", output],
        90_000,
      );
      if (code !== 0) throw new Error("bad exit");
      const data = await ffmpeg.readFile(output);
      if (!(data instanceof Uint8Array) || data.byteLength < 44) throw new Error("empty");
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(data);
      return copy;
    } catch {
      throw new Error("This audio format isn't supported on this device.");
    } finally {
      ffmpeg.off("progress", onExec);
      await ffmpeg.deleteFile(input).catch(() => false);
      await ffmpeg.deleteFile(output).catch(() => false);
    }
  });
}
