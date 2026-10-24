// Records voice notes with a live level meter. The waveform is built from
// the levels captured while recording, so nothing has to be decoded afterwards.

const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/aac', 'audio/webm'];
export const MAX_VOICE_SECONDS = 5 * 60;

export function voiceSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export class VoiceRecorder {
  constructor({ onLevel, onTick, onLimit } = {}) {
    this.onLevel = onLevel;
    this.onTick = onTick;
    this.onLimit = onLimit;
    this.levels = [];
    this.chunks = [];
    this.stream = null;
    this.recorder = null;
    this.ctx = null;
    this.timer = null;
    this.startedAt = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    const mimeType = PREFERRED_TYPES.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
    this.recorder.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
    this.startedAt = performance.now();

    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      this.timer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
        this.levels.push(level);
        this.onLevel?.(level);
        const secs = this.elapsed();
        this.onTick?.(secs);
        if (secs >= MAX_VOICE_SECONDS) this.onLimit?.();
      }, 80);
    } catch {
      // No analyser available: still record, just without the meter.
      this.timer = setInterval(() => {
        const secs = this.elapsed();
        this.onTick?.(secs);
        if (secs >= MAX_VOICE_SECONDS) this.onLimit?.();
      }, 250);
    }
  }

  elapsed() {
    return (performance.now() - this.startedAt) / 1000;
  }

  /** Stops and returns { blob, duration, waveform } (or null if too short). */
  stop() {
    return new Promise(resolve => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        this.cleanup();
        resolve(null);
        return;
      }
      const secs = this.elapsed();
      this.recorder.onstop = () => {
        const type = (this.recorder.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(this.chunks, { type });
        this.cleanup();
        if (secs < 0.7 || blob.size < 1200) {
          resolve(null);
          return;
        }
        resolve({ blob, duration: Math.max(1, Math.round(secs)), waveform: downsample(this.levels, 48) });
      };
      this.recorder.stop();
    });
  }

  cancel() {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.onstop = null;
        this.recorder.stop();
      }
    } catch {
      /* already stopped */
    }
    this.cleanup();
  }

  cleanup() {
    clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

function downsample(levels, n) {
  if (!levels.length) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * levels.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / n));
    const slice = levels.slice(start, end);
    out.push(Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(3)));
  }
  return out;
}
