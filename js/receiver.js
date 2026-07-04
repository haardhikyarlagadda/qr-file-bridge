// receiver.js — the receive side, TCP-style over light.
//
// Phases:
//   handshake — camera scans until Frame 0 (the manifest / SYN) is decoded.
//               The UI then prompts for the passphrase.
//   receiving — after the user confirms, the screen shows a READY ACK
//               (SYN-ACK). From then on the camera keeps decoding data
//               frames while the screen auto-refreshes ACK QRs carrying
//               the cumulative base + missing ranges (SACK).
//   complete  — a persistent COMPLETE ACK (FIN) tells the sender to stop;
//               build (decrypt/verify/save) runs on the buffered chunks.

import { decrypt, decompress, sha256hex } from "./crypto.js";
import { openCamera } from "./camera.js";
import {
  MAGIC_DATA, decodeFrame, decodeManifest, encodeAck,
  ACK_COMPLETE, ACK_MISSING, ACK_READY,
} from "./frame.js";

/* global qrcode, jsQR */

export class Receiver {
  constructor(ui) {
    // ui callbacks: onStatus, onProgress, onManifest, onComplete,
    //               onSignal(frameIdx), onForeign, onBuild(label, pct)
    this.ui = ui;
    this.reset();
  }

  reset() {
    this.sessionId = null;
    this.manifest = null;
    this.chunks = new Map();
    this.totalFrames = 0;
    this.stream = null;
    this.scanning = false;
    this.phase = "idle"; // idle | handshake | receiving | complete
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

  /** Cumulative ack: the lowest frame index not yet received. */
  get ackBase() {
    if (!this.manifest) return 0;
    for (let i = 1; i <= this.totalFrames; i++)
      if (!this.chunks.has(i)) return i;
    return this.totalFrames + 1;
  }

  /**
   * Open the camera and scan continuously. In handshake phase, decoding the
   * manifest fires onManifest (UI prompts for the passphrase); data frames
   * arriving early are buffered anyway — nothing is wasted.
   */
  async startScanning(videoEl, canvasEl) {
    this.phase = this.phase === "idle" ? "handshake" : this.phase;
    this.stream = await openCamera({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    videoEl.srcObject = this.stream;
    await videoEl.play();
    this.scanning = true;
    const ctx = canvasEl.getContext("2d", { willReadFrequently: true });

    let detector = null;
    if ("BarcodeDetector" in window) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code"))
          detector = new BarcodeDetector({ formats: ["qr_code"] });
      } catch { /* jsQR below */ }
    }

    const scanOnce = async () => {
      if (videoEl.readyState !== videoEl.HAVE_ENOUGH_DATA) return;
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      const side = Math.floor(Math.min(vw, vh) * 0.92);
      const sx = (vw - side) >> 1, sy = (vh - side) >> 1;
      canvasEl.width = side;
      canvasEl.height = side;
      ctx.drawImage(videoEl, sx, sy, side, side, 0, 0, side, side);

      let text = null;
      if (detector) {
        try {
          const codes = await detector.detect(canvasEl);
          if (codes.length) text = codes[0].rawValue;
        } catch { /* transient */ }
      }
      if (text === null) {
        const img = ctx.getImageData(0, 0, side, side);
        const code = jsQR(img.data, side, side, { inversionAttempts: "dontInvert" });
        if (code) text = code.data;
      }
      if (text !== null && !this._ingest(text)) this.ui.onForeign?.();
    };

    const loop = async () => {
      if (!this.scanning) return;
      await scanOnce();
      if (this.isComplete && this.phase !== "complete") {
        this.phase = "complete";
        this.ui.onComplete();
        return;
      }
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

  /** Returns true if the decoded text was a valid frame of this session. */
  _ingest(text) {
    const frame = decodeFrame(text);
    if (!frame || frame.magic !== MAGIC_DATA) return false;

    if (this.sessionId === null) this.sessionId = frame.sessionId;
    if (frame.sessionId !== this.sessionId) return false;

    this.ui.onSignal?.(frame.frameIndex);

    if (frame.frameIndex === 0) {
      if (!this.manifest) {
        this.manifest = decodeManifest(frame.payload);
        this.totalFrames = this.manifest.totalFrames;
        this.ui.onManifest(this.manifest);
      }
    } else {
      if (this.chunks.has(frame.frameIndex)) return true; // duplicate
      this.chunks.set(frame.frameIndex, frame.payload);
    }
    this.ui.onProgress(this.receivedCount, this.totalFrames, frame.frameIndex);
    return true;
  }

  /** Move from handshake to the data phase (after passphrase entry). */
  beginReceiving() {
    if (!this.manifest) throw new Error("Scan the session code first.");
    this.phase = "receiving";
  }

  /**
   * Render the current ACK onto a canvas:
   *   no chunks yet   → READY   (SYN-ACK)
   *   partial         → MISSING (base + SACK ranges)
   *   everything      → COMPLETE (FIN)
   */
  renderAckQR(canvas) {
    if (this.sessionId === null || !this.manifest) return false;
    const status = this.isComplete ? ACK_COMPLETE
      : this.chunks.size === 0 ? ACK_READY
      : ACK_MISSING;
    const data = encodeAck(this.sessionId, status, this.missingFrames, this.ackBase);
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

  /** Reassemble, decrypt, decompress, verify. Reports ui.onBuild(label, pct). */
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
        await new Promise(r => setTimeout(r));
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
