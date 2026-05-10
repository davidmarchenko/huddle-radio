import type { AudioClip } from "../shared/contracts";

/**
 * Push-to-talk audio capture for the "Cue host" button (W18) and the
 * upcoming broadcast-audio sampler. Returns an AudioClip ready to
 * POST to /api/asr/transcribe.
 *
 * Why MediaRecorder over the Web Audio API:
 *   - MediaRecorder emits compressed chunks (webm/opus by default,
 *     ~12 kbps) so a 10-second clip is ~15 KB base64 — well under
 *     the 8 MB Next.js bodySizeLimit.
 *   - Native VAD is handled by the model; we just open the mic,
 *     record until the user releases the button, and ship the blob.
 *
 * Returns a handle with stop()/cancel(). stop() resolves with the
 * AudioClip; cancel() releases the stream without returning a clip.
 */

export type MicRecording = {
  /** Stop recording and return the captured clip. */
  stop(): Promise<AudioClip>;
  /** Discard the recording without returning anything; safe to call multiple times. */
  cancel(): void;
  /** Wall-clock start so the UI can show recording duration. */
  startedAt: number;
};

const CAPTURE_OPTIONS: MediaRecorderOptions[] = [
  // Prefer the Opus codec the OpenAI/Nvidia ASR pipeline ingests
  // natively; fall back if the browser is older or on Safari.
  { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 24000 },
  { mimeType: "audio/webm", audioBitsPerSecond: 24000 },
  { mimeType: "audio/ogg;codecs=opus", audioBitsPerSecond: 24000 },
  { mimeType: "audio/mp4", audioBitsPerSecond: 24000 },
  {}
];

function pickRecorderOptions(): MediaRecorderOptions {
  if (typeof MediaRecorder === "undefined") return {};
  for (const candidate of CAPTURE_OPTIONS) {
    if (!candidate.mimeType) return candidate;
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) return candidate;
  }
  return {};
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Audio FileReader failed."));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("Audio FileReader produced non-string result."));
    };
    reader.readAsDataURL(blob);
  });
}

export type StartMicOptions = {
  /** Override the source label shown on the cue in the UI (e.g. "Push-to-talk"). */
  label?: string;
  /**
   * Hard cap on recording length. Default 20s — clip stays under the
   * Nvidia gateway's per-request audio budget and the route handler's
   * maxDuration. After this the recorder auto-stops; the resolver
   * still fires.
   */
  maxDurationMs?: number;
};

export async function startMicRecording(options: StartMicOptions = {}): Promise<MicRecording> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture isn't supported in this browser.");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder isn't supported in this browser.");
  }

  // Vocal capture: 16 kHz mono is enough for ASR and produces the
  // smallest payload — but most browsers ignore the constraint and
  // return 48 kHz. The model down-samples anyway.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1
    }
  });

  const recorderOptions = pickRecorderOptions();
  const recorder = new MediaRecorder(stream, recorderOptions);
  const chunks: BlobPart[] = [];
  const startedAt = Date.now();
  const maxDurationMs = options.maxDurationMs ?? 20000;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });

  recorder.start(1000);

  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, maxDurationMs);

  let cancelled = false;
  const releaseTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  const stop = async (): Promise<AudioClip> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const finished = new Promise<void>((resolve) => {
      if (recorder.state === "inactive") {
        resolve();
        return;
      }
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
    await finished;
    releaseTracks();
    const mimeType = recorder.mimeType || recorderOptions.mimeType || "audio/webm";
    const blob = new Blob(chunks, { type: mimeType });
    const dataUrl = await blobToDataUrl(blob);
    return {
      id: crypto.randomUUID(),
      capturedAt: new Date(startedAt).toISOString(),
      source: "microphone",
      mimeType,
      dataUrl,
      durationMs: Date.now() - startedAt,
      label: options.label
    };
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Recorder may already be stopping; ignore.
      }
    }
    releaseTracks();
  };

  return { stop, cancel, startedAt };
}
