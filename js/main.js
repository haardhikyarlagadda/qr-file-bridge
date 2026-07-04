// main.js — UI orchestration for the TCP-style optical protocol.
//
// Sender:   prepare → handshake (SYN = manifest QR + ACK-watch camera on)
//           → windows advance automatically as ACKs arrive → done on FIN.
// Receiver: scan session code (no passphrase yet) → passphrase prompt
//           → READY ACK (SYN-ACK) → auto-ACK cadence during data
//           → persistent COMPLETE ACK (FIN) → build & save.

import { Sender } from "./sender.js";
import { Receiver } from "./receiver.js";

const $ = id => document.getElementById(id);

// ── Utilities ────────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* best-effort */ }
}

// ── Mode switching ───────────────────────────────────────────────────────────

const panels = { home: $("panel-home"), send: $("panel-send"), receive: $("panel-receive") };
function show(name) {
  Object.values(panels).forEach(p => p.classList.remove("active"));
  panels[name].classList.add("active");
  document.body.dataset.mode = name;
}
$("btn-mode-send").onclick = () => show("send");
$("btn-mode-receive").onclick = () => show("receive");
document.querySelectorAll(".btn-back").forEach(b => b.onclick = () => {
  sender.stop(); receiver.stop(); stopScanTicker(); stopAutoAck(); keepAwake(false); show("home");
});

// ═══════════════════════════════════════ SENDER ══════════════════════════════

let ackFacing = "user"; // front camera by default: phones face each other

const sender = new Sender({
  onStatus: t => { $("send-status").textContent = t; },
  onFrame: (canvas, idx, total, pos, playlistLen) => {
    const stage = $("qr-stage");
    stage.innerHTML = "";
    if (canvas) stage.appendChild(canvas);
    $("send-frame-label").textContent = `frame ${idx} / ${total - 1}`;
    $("send-loop-label").textContent = `window slot ${pos + 1} of ${playlistLen}`;
  },
  onPhase: (phase, detail) => {
    const badge = $("send-phase");
    badge.dataset.phase = phase;
    badge.textContent =
      phase === "handshake" ? "handshake — waiting for receiver"
      : phase === "sending" ? "sending — window mode"
      : "complete";
    $("send-status").textContent = detail;
    if (phase === "done") {
      $("send-live").classList.add("done");
      keepAwake(false);
    }
  },
  onAck: () => { /* phase handler covers the messaging */ },
});

$("send-file").onchange = () => {
  const f = $("send-file").files[0];
  $("send-file-label").textContent = f ? `${f.name} — ${fmtBytes(f.size)}` : "Choose a file";
  $("btn-prepare").disabled = !f;
};

$("btn-prepare").onclick = async () => {
  const file = $("send-file").files[0];
  const pass = $("send-pass").value;
  if (!file) return;
  if (!pass) { $("send-status").textContent = "Enter a passphrase first — the receiver needs the same one."; return; }

  const chunkSize = parseInt($("send-chunk").value, 10);
  const fps = parseInt($("send-fps").value, 10);
  $("btn-prepare").disabled = true;

  try {
    const p = await sender.prepare(file, pass, chunkSize, fps);
    $("send-setup").classList.add("hidden");
    $("send-live").classList.remove("hidden");
    keepAwake(true);
    sender.showHandshake();
    $("send-status").textContent =
      `${p.totalFrames} data frames ready (${fmtBytes(p.ciphertextBytes)} ciphertext). ` +
      `Showing the session code — have the receiver scan it.`;
    try {
      await sender.startAckWatch($("ack-video"), $("ack-canvas"), ackFacing);
    } catch (e) {
      $("send-status").textContent =
        `ACK camera unavailable (${e.message}) — the transfer can't advance without it. ` +
        `Check camera permissions and reload.`;
    }
  } catch (e) {
    $("send-status").textContent = `Error: ${e.message}`;
    $("btn-prepare").disabled = false;
  }
};

$("btn-pause").onclick = () => {
  if (sender.playing) { sender.stop(false); $("btn-pause").textContent = "Resume"; }
  else { sender.play(); $("btn-pause").textContent = "Pause"; }
};

$("btn-flip-cam").onclick = async () => {
  ackFacing = ackFacing === "user" ? "environment" : "user";
  try {
    await sender.startAckWatch($("ack-video"), $("ack-canvas"), ackFacing);
    $("send-status").textContent = `ACK camera: ${ackFacing === "user" ? "front" : "rear"}.`;
  } catch (e) {
    $("send-status").textContent = `Camera error: ${e.message}`;
  }
};

// ═══════════════════════════════════════ RECEIVER ════════════════════════════

const grid = $("frame-grid");
let gridCells = [];

// ── Scan heartbeat ───────────────────────────────────────────────────────────
const scan = { times: [], lastSeen: 0, lastForeign: 0, lastIdx: null, timer: null };

function setScanPill(state, text) {
  $("scan-dot").dataset.state = state;
  $("scan-text").textContent = text;
}

function scanHeartbeat(frameIdx) {
  const now = Date.now();
  scan.lastSeen = now;
  scan.lastIdx = frameIdx;
  scan.times.push(now);
  while (scan.times.length && now - scan.times[0] > 3000) scan.times.shift();
  const vf = document.querySelector("#panel-receive .viewfinder");
  if (vf) { vf.classList.remove("flash"); void vf.offsetWidth; vf.classList.add("flash"); }
}

function startScanTicker() {
  stopScanTicker();
  scan.timer = setInterval(() => {
    if (!receiver.scanning) { setScanPill("off", "camera off"); return; }
    const now = Date.now();
    if (scan.lastSeen !== 0 && now - scan.lastSeen <= 1500) {
      const rate = (scan.times.length / 3).toFixed(1);
      setScanPill("live", `locked on · frame #${scan.lastIdx} · ${rate}/s`);
    } else if (scan.lastForeign !== 0 && now - scan.lastForeign <= 1500) {
      setScanPill("idle", "QR detected but unreadable — move closer, hold steady");
    } else {
      setScanPill("idle", receiver.phase === "handshake"
        ? "searching for a session code…"
        : "searching… align the camera with the sender's screen");
    }
  }, 400);
}
function stopScanTicker() { if (scan.timer) { clearInterval(scan.timer); scan.timer = null; } }

// ── Auto-ACK cadence (TCP-style) ─────────────────────────────────────────────
// The receiver's screen periodically shows the current ACK while its camera
// keeps scanning. Triggers: right after START (READY), whenever no new frame
// has arrived for a moment (window likely finished / stalled), and
// persistently on COMPLETE.
const ack = { timer: null, shownAt: 0, hideAt: 0 };
const ACK_SHOW_MS = 4000;
const ACK_MIN_GAP_MS = 6000;
const IDLE_BEFORE_ACK_MS = 2500;

function showAckOverlay(persist = false) {
  if (!receiver.renderAckQR($("ack-out"))) return;
  const wrap = $("ack-out-wrap");
  wrap.classList.remove("hidden");
  const miss = receiver.missingFrames.length;
  $("ack-out-label").textContent = receiver.isComplete
    ? "COMPLETE — the sender will stop automatically."
    : miss === receiver.totalFrames
      ? "READY — waiting for the first window."
      : `ACK — have ${receiver.receivedCount}/${receiver.totalFrames}, requesting ${miss} missing.`;
  ack.shownAt = Date.now();
  ack.hideAt = persist ? Infinity : ack.shownAt + ACK_SHOW_MS;
}

function startAutoAck() {
  stopAutoAck();
  ack.timer = setInterval(() => {
    const now = Date.now();
    const wrap = $("ack-out-wrap");
    if (!wrap.classList.contains("hidden") && now >= ack.hideAt) wrap.classList.add("hidden");
    if (receiver.phase !== "receiving") return;
    const idle = now - scan.lastSeen;
    const sinceAck = now - ack.shownAt;
    if (idle >= IDLE_BEFORE_ACK_MS && sinceAck >= ACK_MIN_GAP_MS) showAckOverlay();
  }, 500);
}
function stopAutoAck() { if (ack.timer) { clearInterval(ack.timer); ack.timer = null; } }

const receiver = new Receiver({
  onStatus: t => { $("recv-status").textContent = t; },
  onSignal: idx => scanHeartbeat(idx),
  onForeign: () => { scan.lastForeign = Date.now(); },
  onBuild: (label, pct) => {
    const w = $("build-wrap");
    w.classList.remove("hidden");
    if (pct === 0) w.classList.remove("ok", "fail");
    $("build-label").textContent = label;
    $("build-pct").textContent = Math.round(pct) + "%";
    $("build-bar").style.width = pct + "%";
  },
  onManifest: m => {
    // SYN received — surface the session and ask for the passphrase.
    $("session-card").classList.remove("hidden");
    $("recv-meta").textContent =
      `${m.name} — ${fmtBytes(m.origSize)}, ${m.totalFrames} frames @ ${m.chunkSize} B`;
    $("recv-step-hint").textContent = "Step 2 — enter the passphrase the sender told you, then start.";
    $("recv-status").textContent = "Session code scanned. Enter the passphrase to continue.";
    $("recv-pass").focus();

    grid.innerHTML = "";
    gridCells = [];
    const cap = Math.min(m.totalFrames, 2000);
    for (let i = 0; i < cap; i++) {
      const d = document.createElement("i");
      grid.appendChild(d);
      gridCells.push(d);
    }
  },
  onProgress: (got, total, lastIdx) => {
    $("recv-count").textContent = total ? `${got} / ${total}` : `${got} / ?`;
    const pct = total ? Math.round((got / total) * 100) : 0;
    $("recv-bar").style.width = pct + "%";
    $("recv-pct").textContent = pct + "%";
    if (lastIdx > 0 && lastIdx <= gridCells.length) gridCells[lastIdx - 1].classList.add("on");
  },
  onComplete: () => {
    receiver.stop();
    stopScanTicker();
    setScanPill("live", "all frames captured");
    $("recv-status").textContent = "All frames received. The COMPLETE ACK is showing — the sender will stop. Now save the file.";
    $("btn-save").disabled = false;
    showAckOverlay(true); // persistent FIN
  },
});

// Step 1 — scan the session code (SYN). No passphrase needed yet.
$("btn-start-scan").onclick = async () => {
  $("btn-start-scan").disabled = true;
  $("recv-live").classList.remove("hidden");
  keepAwake(true);
  try {
    await receiver.startScanning($("recv-video"), $("recv-canvas"));
    startScanTicker();
    setScanPill("idle", "searching for a session code…");
    $("recv-status").textContent = "Point the camera at the sender's session code.";
  } catch (e) {
    setScanPill("off", "camera unavailable");
    $("recv-status").textContent = `Camera error: ${e.message}`;
    $("btn-start-scan").disabled = false;
  }
};

// Step 2 — passphrase entered; answer READY (SYN-ACK) and receive.
$("btn-begin").onclick = () => {
  if (!$("recv-pass").value) {
    $("recv-status").textContent = "Enter the passphrase first — you'll need it to decrypt the file.";
    return;
  }
  try {
    receiver.beginReceiving();
  } catch (e) {
    $("recv-status").textContent = e.message;
    return;
  }
  $("session-card").classList.add("hidden");
  $("recv-transfer").classList.remove("hidden");
  $("recv-step-hint").textContent =
    "Step 3 — keep both screens facing each other's cameras. ACKs are exchanged automatically.";
  $("recv-status").textContent = "READY sent. Receiving…";
  showAckOverlay();   // SYN-ACK: tell the sender to start window 1
  startAutoAck();
};

// Manual ACK (fallback if timing feels off)
$("btn-show-ack").onclick = () => showAckOverlay(receiver.isComplete);

$("btn-save").onclick = async () => {
  try {
    $("btn-save").disabled = true;
    const out = await receiver.assemble($("recv-pass").value);
    const blob = new Blob([out.bytes]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = out.name;
    a.click();
    URL.revokeObjectURL(a.href);
    $("build-label").textContent = `Saved ${out.name}`;
    $("build-wrap").classList.add("ok");
    $("recv-status").textContent =
      `Saved ${out.name} (${fmtBytes(out.bytes.length)}). SHA-256 verified: ${out.sha256.slice(0, 16)}…`;
    stopAutoAck();
    keepAwake(false);
  } catch (e) {
    $("build-wrap").classList.add("fail");
    $("build-label").textContent = "Build failed";
    $("recv-status").textContent = e.message;
    $("btn-save").disabled = false;
  }
};

// ── Secure-context check ─────────────────────────────────────────────────────
if (!window.isSecureContext) {
  const warn = document.createElement("div");
  warn.className = "https-warn";
  warn.textContent =
    "⚠ This page is not HTTPS, so the camera is disabled by the browser. " +
    "Open the app from an https:// URL (e.g. GitHub Pages) or localhost.";
  document.querySelector("main").prepend(warn);
}

// ── PWA ──────────────────────────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => { /* best-effort */ });
}
