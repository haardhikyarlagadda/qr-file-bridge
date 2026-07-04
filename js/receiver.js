// receiver.js — the receive side.
// camera → decode frames → buffer → ACK missing → reassemble → decrypt → save.

import { decrypt, decompress, sha256hex } from "./crypto.js";
import { openCamera } from "./camera.js";
import {
  MAGIC_DATA, decodeFrame, decodeManifest, encodeAck,
  ACK_COMPLETE, ACK_MISSING,
} from "./frame.js";

/* global qrcode, jsQR */

export class Receiver {
  constructor(ui) {
    this.ui = ui;        // callbacks: onStatus, onProgress, onManifest, onComplete
    this.reset();
  }

  reset() {
    this.sessionId = null;
    this.manifest = null;
    this.chunks = new Map();   // frameIndex (1-based) → Uint8Array
    this.totalFrames = 0;      // data frames, excludes manifest
    this.stream = null;
    this.scanning = false;
  }

  get receivedCount() { return this.chunks.size; }

  get missingFrames() {
    if (!this.manifest) return [];
    const missing = [];
    for (let i = 1; i <= this.totalFrames; i++)
      if (!this.chunks.has(i)) missing.push(i);
    return missing;
  }

  get isComplete() {
    return this.manifest !== null && this.chunks.size === this.totalFrames;
  }

  /** Continuous camera scan loop. Runs until stop() or transfer completion. */
  async startScanning(videoEl, canvasEl) {
    this.stream = await openCamera({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    videoEl.srcObject = this.stream;
    await videoEl.play();
    this.scanning = true;
    const ctx = canvasEl.getContext("2d", { willReadFrequently: true });

    const loop = () => {
      if (!this.scanning) return;
      if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        canvasEl.width = videoEl.videoWidth;
        canvasEl.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0);
        const img = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (code) this._ingest(code.data);
      }
      if (this.isComplete) { this.ui.onComplete(); return; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.scanning = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }

  _ingest(text) {
    const frame = decodeFrame(text);
    if (!frame || frame.magic !== MAGIC_DATA) return;

    // Lock onto the first session we see; ignore frames from other sessions.
    if (this.sessionId === null) this.sessionId = frame.sessionId;
    if (frame.sessionId !== this.sessionId) return;

    // Heartbeat: fires for EVERY valid frame of this session, duplicates
    // included — it tells the UI "the camera is locked on", which is
    // distinct from "we learned something new".
    this.ui.onSignal?.(frame.frameIndex);

    if (frame.frameIndex === 0) {
      if (!this.manifest) {
        this.manifest = decodeManifest(frame.payload);
        this.totalFrames = this.manifest.totalFrames;
        this.ui.onManifest(this.manifest);
      }
    } else {
      if (this.chunks.has(frame.frameIndex)) return; // duplicate — drop
      this.chunks.set(frame.frameIndex, frame.payload);
    }
    this.ui.onProgress(this.receivedCount, this.totalFrames, frame.frameIndex);
  }

  /** Render the ACK QR (missing list, or COMPLETE) onto a canvas for the sender to scan. */
  renderAckQR(canvas) {
    if (this.sessionId === null) return false;
    const status = this.isComplete ? ACK_COMPLETE : ACK_MISSING;
    const data = encodeAck(this.sessionId, status, this.missingFrames);
    const qr = qrcode(0, "M");
    qr.addData(data, "Alphanumeric");
    qr.make();
    const modules = qr.getModuleCount();
    const scale = Math.max(2, Math.floor(560 / (modules + 8)));
    const quiet = 4 * scale;
    const size = modules * scale + quiet * 2;
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000";
    for (let r = 0; r < modules; r++)
      for (let c = 0; c < modules; c++)
        if (qr.isDark(r, c)) ctx.fillRect(quiet + c * scale, quiet + r * scale, scale, scale);
    return true;
  }

  /**
   * Reassemble, decrypt, decompress, verify, and hand back a downloadable file.
   * Reports staged progress via ui.onBuild(label, pct):
   * reassemble 0→40 (real per-chunk progress), decrypt →70,
   * decompress →85, verify →95, done 100.
   */
  async assemble(passphrase) {
    if (!this.isComplete) throw new Error("Transfer incomplete — frames still missing.");
    const m = this.manifest;
    const build = (label, pct) => { this.ui.onBuild?.(label, pct); this.ui.onStatus(label); };

    build("Reassembling chunks…", 0);
    const ciphertext = new Uint8Array(
      [...this.chunks.keys()].reduce((n, k) => n + this.chunks.get(k).length, 0)
    );
    let off = 0;
    const yieldEvery = Math.max(1, Math.floor(this.totalFrames / 20));
    for (let i = 1; i <= this.totalFrames; i++) {
      const c = this.chunks.get(i);
      ciphertext.set(c, off);
      off += c.length;
      if (i % yieldEvery === 0) {
        build(`Reassembling chunks… ${i} / ${this.totalFrames}`, (i / this.totalFrames) * 40);
        await new Promise(r => setTimeout(r)); // let the progress bar paint
      }
    }

    build("Decrypting (AES-256-GCM)…", 45);
    let compressed;
    try {
      compressed = await decrypt(ciphertext, passphrase, m.salt, m.nonce);
    } catch {
      throw new Error("Decryption failed — wrong passphrase or corrupted data. Nothing was saved.");
    }

    build("Decompressing…", 70);
    const plain = await decompress(compressed, m.compAlgo);

    build("Verifying SHA-256…", 85);
    const digest = await sha256hex(plain);
    if (digest !== m.sha256)
      throw new Error("Integrity check failed — SHA-256 mismatch. Nothing was saved.");

    build("Build complete", 100);
    return { name: m.name, bytes: plain, sha256: digest };
  }
}
