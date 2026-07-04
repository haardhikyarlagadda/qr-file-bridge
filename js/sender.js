// sender.js — the transmit side, TCP-style over light.
//
// Phases:
//   handshake — screen shows only Frame 0 (the manifest, i.e. the SYN).
//               The receiver scans it, enters the passphrase, and answers
//               with a READY ACK (the SYN-ACK).
//   sending   — frames go out in windows of W. The sender's camera watches
//               the receiver's screen continuously; every ACK carries the
//               cumulative base + missing ranges (like TCP SACK), and the
//               playlist becomes the first W still-missing frames.
//   done      — a COMPLETE ACK (the FIN) stops the show.
//
// The screen never stops playing while the camera scans — display and
// capture are independent, so ACKs need no mode switching.

import { compress, encrypt, sha256hex } from "./crypto.js";
import { openCamera } from "./camera.js";
import {
  MAGIC_DATA, MAGIC_ACK, encodeFrame, encodeManifest, decodeFrame, decodeAck,
  ACK_COMPLETE, ACK_MISSING, ACK_READY,
} from "./frame.js";

/* global qrcode, jsQR */

export const WINDOW_SIZE = 24; // frames per window before waiting on an ACK

export class Sender {
  constructor(ui) {
    // ui callbacks: onStatus, onFrame, onPhase(phase, detail), onAck(ack)
    this.ui = ui;
    this.frames = [];
    this.qrCache = [];
    this.playlist = [0];
    this.sessionId = 0;
    this.phase = "idle";     // idle | handshake | sending | done
    this.playing = false;
    this.fps = 2;
    this.timer = null;
    this.pos = 0;
    this.ackStream = null;
    this.ackWatching = false;
    this._lastAckKey = "";
    this._lastAckAt = 0;
  }

  /** Full encode pipeline; resolves when all QR canvases are cached. */
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
    if (total > 0xffffff) throw new Error("File needs more than 16.7M frames — raise the chunk size.");

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
        await new Promise(r => setTimeout(r));
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

    return {
      sessionId: this.sessionId,
      totalFrames: total,
      ciphertextBytes: ciphertext.length,
    };
  }

  _renderQR(data) {
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

  // ── Phase control ──────────────────────────────────────────────────────────

  /** SYN: loop only the manifest frame until the receiver answers READY. */
  showHandshake() {
    this.phase = "handshake";
    this.playlist = [0];
    this.play();
    this.ui.onPhase("handshake", "Waiting for the receiver to scan the session code…");
  }

  /** Apply an ACK from the receiver — the heart of the sliding window. */
  _handleAck(ack) {
    // Debounce: the receiver shows each ACK for a few seconds, so the
    // camera decodes the same one repeatedly.
    const key = JSON.stringify(ack);
    const now = Date.now();
    if (key === this._lastAckKey && now - this._lastAckAt < 2500) return;
    this._lastAckKey = key;
    this._lastAckAt = now;

    this.ui.onAck?.(ack);

    if (ack.status === ACK_COMPLETE) {
      this.phase = "done";
      this.stop();
      this.ui.onPhase("done", "Receiver confirmed: all frames delivered.");
      return;
    }

    if (ack.status === ACK_READY || ack.status === ACK_MISSING) {
      // Window = the first W frames the receiver still lacks. A READY with
      // no chunks yet means missing = [1..N], so the same rule covers both.
      const missing = ack.missing.length
        ? ack.missing
        : Array.from({ length: this.frames.length - 1 }, (_, i) => i + 1);
      const win = missing.filter(i => i >= 1 && i < this.frames.length).slice(0, WINDOW_SIZE);
      if (win.length === 0) return;
      this.phase = "sending";
      this.playlist = win;
      this.play();
      const done = (this.frames.length - 1) - missing.length;
      this.ui.onPhase("sending",
        `Receiver has ${done}/${this.frames.length - 1} — sending window of ${win.length} (from frame ${win[0]}).`);
    }
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  play() {
    this.stop(false);
    this.playing = true;
    this.pos = 0;
    const frameMs = 1000 / this.fps;
    const blankMs = Math.min(50, frameMs * 0.15);

    const tick = () => {
      if (!this.playing) return;
      const idx = this.playlist[this.pos];
      this.ui.onFrame(this.qrCache[idx], idx, this.frames.length, this.pos, this.playlist.length);
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

  stop(stopAckWatch = true) {
    this.playing = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (stopAckWatch) this.stopAckWatch();
  }

  // ── Continuous ACK watch (runs alongside playback) ─────────────────────────

  /**
   * Open a camera and keep decoding ACK QRs for the whole session.
   * With the phones facing each other, the sender's FRONT camera sees the
   * receiver's screen while the sender's own screen keeps playing frames.
   */
  async startAckWatch(videoEl, canvasEl, facingMode = "user") {
    this.stopAckWatch();
    this.ackStream = await openCamera({ video: { facingMode }, audio: false });
    videoEl.srcObject = this.ackStream;
    await videoEl.play();
    this.ackWatching = true;
    const ctx = canvasEl.getContext("2d", { willReadFrequently: true });

    let detector = null;
    await (window.__bdReady ?? Promise.resolve()); // ZXing polyfill on iOS
    if ("BarcodeDetector" in window) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code"))
          detector = new BarcodeDetector({ formats: ["qr_code"] });
      } catch { /* jsQR below */ }
    }

    const loop = async () => {
      if (!this.ackWatching) return;
      if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        canvasEl.width = videoEl.videoWidth;
        canvasEl.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0);
        let text = null;
        if (detector) {
          try {
            const codes = await detector.detect(canvasEl);
            if (codes.length) text = codes[0].rawValue;
          } catch { /* transient */ }
        }
        if (text === null) {
          const img = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code) text = code.data;
        }
        if (text !== null) {
          const frame = decodeFrame(text);
          if (frame && frame.magic === MAGIC_ACK && frame.sessionId === this.sessionId) {
            this._handleAck(decodeAck(frame.payload));
          }
        }
      }
      setTimeout(loop, 150);
    };
    loop();
  }

  stopAckWatch() {
    this.ackWatching = false;
    if (this.ackStream) {
      this.ackStream.getTracks().forEach(t => t.stop());
      this.ackStream = null;
    }
  }
}
