// sender.js — the transmit side.
// file → compress → AES-256-GCM → chunk → Base45 frames → animated QR playback.
// The only outbound channel is light from the screen.

import { compress, encrypt, sha256hex } from "./crypto.js";
import { openCamera } from "./camera.js";
import {
  MAGIC_DATA, encodeFrame, encodeManifest, decodeFrame, decodeAck,
  MAGIC_ACK, ACK_COMPLETE,
} from "./frame.js";

/* global qrcode, jsQR */

export class Sender {
  constructor(ui) {
    this.ui = ui;           // callbacks: onStatus, onFrame, onProgress, onDone
    this.frames = [];       // Base45 strings, index-aligned (0 = manifest)
    this.qrCache = [];      // pre-rendered <canvas> per frame
    this.playlist = [];     // indices currently being cycled
    this.sessionId = 0;
    this.playing = false;
    this.fps = 2;
    this.timer = null;
    this.pos = 0;
  }

  /** Run the full encode pipeline. Resolves when frames + QR canvases are ready. */
  async prepare(file, passphrase, chunkSize, fps) {
    this.fps = fps;
    this.sessionId = crypto.getRandomValues(new Uint32Array(1))[0];

    this.ui.onStatus("Reading file…");
    const raw = new Uint8Array(await file.arrayBuffer());
    const digest = await sha256hex(raw);

    this.ui.onStatus("Compressing…");
    const { data: compressed, algo } = await compress(raw);

    this.ui.onStatus("Encrypting (AES-256-GCM)…");
    const { ciphertext, nonce, salt } = await encrypt(compressed, passphrase);

    this.ui.onStatus("Chunking & encoding frames…");
    const total = Math.ceil(ciphertext.length / chunkSize);
    if (total > 0xffffff) throw new Error("File needs more than 16.7M frames — reduce size or raise chunk size.");

    const manifest = encodeManifest({
      name: file.name, origSize: raw.length, compSize: compressed.length,
      totalFrames: total, chunkSize, compAlgo: algo,
      salt, nonce, sha256: digest,
    });

    this.frames = new Array(total + 1);
    this.frames[0] = encodeFrame(MAGIC_DATA, this.sessionId, 0, total, manifest);
    for (let i = 0; i < total; i++) {
      const chunk = ciphertext.slice(i * chunkSize, (i + 1) * chunkSize);
      this.frames[i + 1] = encodeFrame(MAGIC_DATA, this.sessionId, i + 1, total, chunk);
      if (i % 200 === 0) {
        this.ui.onStatus(`Encoding frames… ${i}/${total}`);
        await new Promise(r => setTimeout(r)); // keep UI responsive
      }
    }

    this.ui.onStatus("Pre-rendering QR codes…");
    this.qrCache = new Array(this.frames.length);
    for (let i = 0; i < this.frames.length; i++) {
      this.qrCache[i] = this._renderQR(this.frames[i]);
      if (i % 100 === 0) {
        this.ui.onStatus(`Rendering QR… ${i}/${this.frames.length}`);
        await new Promise(r => setTimeout(r));
      }
    }

    this.playlist = this.frames.map((_, i) => i);
    return {
      sessionId: this.sessionId,
      totalFrames: total + 1,
      ciphertextBytes: ciphertext.length,
      estSeconds: Math.ceil((total + 1) / this.fps),
    };
  }

  _renderQR(data) {
    // Type 0 = auto-pick the smallest QR version that fits; ECC M balances
    // density against camera-noise tolerance.
    const qr = qrcode(0, "M");
    qr.addData(data, "Alphanumeric");
    qr.make();
    const modules = qr.getModuleCount();
    const scale = Math.max(2, Math.floor(640 / (modules + 8)));
    const quiet = 4 * scale;
    const size = modules * scale + quiet * 2;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000";
    for (let r = 0; r < modules; r++)
      for (let c = 0; c < modules; c++)
        if (qr.isDark(r, c)) ctx.fillRect(quiet + c * scale, quiet + r * scale, scale, scale);
    return canvas;
  }

  /** Start (or restart) the animated loop over the current playlist. */
  play() {
    this.stop();
    this.playing = true;
    this.pos = 0;
    const frameMs = 1000 / this.fps;
    const blankMs = Math.min(50, frameMs * 0.15);

    const tick = () => {
      if (!this.playing) return;
      const idx = this.playlist[this.pos];
      this.ui.onFrame(this.qrCache[idx], idx, this.frames.length, this.pos, this.playlist.length);
      // brief blank between frames to stop camera motion-blur blending
      this.timer = setTimeout(() => {
        if (!this.playing) return;
        this.ui.onFrame(null, idx, this.frames.length, this.pos, this.playlist.length);
        this.timer = setTimeout(() => {
          this.pos = (this.pos + 1) % this.playlist.length;
          tick();
        }, blankMs);
      }, frameMs - blankMs);
    };
    tick();
  }

  stop() {
    this.playing = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Narrow the playlist to only the frames the receiver reported missing. */
  retransmit(missing) {
    const valid = missing.filter(i => i >= 0 && i < this.frames.length);
    if (valid.length === 0) return false;
    this.playlist = [0, ...valid.filter(i => i !== 0)]; // always resend manifest
    this.play();
    return true;
  }

  /**
   * Open the camera and watch for an ACK QR from the receiver's screen.
   * Resolves { status, missing } once a valid ACK for this session is seen.
   */
  async scanAck(videoEl, canvasEl, signal) {
    const stream = await openCamera({
      video: { facingMode: "environment" }, audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    const ctx = canvasEl.getContext("2d", { willReadFrequently: true });

    try {
      while (!signal.aborted) {
        if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
          canvasEl.width = videoEl.videoWidth;
          canvasEl.height = videoEl.videoHeight;
          ctx.drawImage(videoEl, 0, 0);
          const img = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code) {
            const frame = decodeFrame(code.data);
            if (frame && frame.magic === MAGIC_ACK && frame.sessionId === this.sessionId) {
              return decodeAck(frame.payload);
            }
          }
        }
        await new Promise(r => setTimeout(r, 120));
      }
      return null;
    } finally {
      stream.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
  }
}

export { ACK_COMPLETE };
