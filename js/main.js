// main.js — UI orchestration. Wires the Sender and Receiver engines to the DOM.

import { Sender, ACK_COMPLETE } from "./sender.js";
import { Receiver } from "./receiver.js";

const $ = id => document.getElementById(id);

// ── Utilities ────────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

function fmtTime(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* wake lock is best-effort */ }
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
  sender.stop(); receiver.stop(); keepAwake(false); show("home");
});

// ═══════════════════════════════════════ SENDER ══════════════════════════════

const sender = new Sender({
  onStatus: t => { $("send-status").textContent = t; },
  onFrame: (canvas, idx, total, pos, playlistLen) => {
    const stage = $("qr-stage");
    stage.innerHTML = "";
    if (canvas) stage.appendChild(canvas);
    $("send-frame-label").textContent = `frame ${idx} / ${total - 1}`;
    $("send-loop-label").textContent = `slot ${pos + 1} of ${playlistLen}`;
  },
});

let prepared = null;

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
    prepared = await sender.prepare(file, pass, chunkSize, fps);
    $("send-status").textContent =
      `Ready: ${prepared.totalFrames} frames (${fmtBytes(prepared.ciphertextBytes)} ciphertext). ` +
      `Estimated loop time ${fmtTime(prepared.estSeconds)}.`;
    $("send-setup").classList.add("hidden");
    $("send-live").classList.remove("hidden");
    keepAwake(true);
    sender.play();
  } catch (e) {
    $("send-status").textContent = `Error: ${e.message}`;
    $("btn-prepare").disabled = false;
  }
};

$("btn-pause").onclick = () => {
  if (sender.playing) { sender.stop(); $("btn-pause").textContent = "Resume"; }
  else { sender.play(); $("btn-pause").textContent = "Pause"; }
};

let ackAbort = null;
$("btn-scan-ack").onclick = async () => {
  if (ackAbort) { ackAbort.abort(); return; }
  ackAbort = new AbortController();
  $("btn-scan-ack").textContent = "Stop ACK scan";
  $("ack-cam-wrap").classList.remove("hidden");
  sender.stop();
  $("btn-pause").textContent = "Resume";

  try {
    const ack = await sender.scanAck($("ack-video"), $("ack-canvas"), ackAbort.signal);
    if (ack) {
      if (ack.status === ACK_COMPLETE) {
        $("send-status").textContent = "Receiver confirmed: transfer complete.";
        $("send-live").classList.add("done");
      } else {
        $("send-status").textContent = `Receiver is missing ${ack.missing.length} frame(s) — retransmitting only those.`;
        sender.retransmit(ack.missing);
        $("btn-pause").textContent = "Pause";
      }
    }
  } catch (e) {
    $("send-status").textContent = `Camera error: ${e.message}`;
  } finally {
    ackAbort = null;
    $("btn-scan-ack").textContent = "Scan receiver's ACK";
    $("ack-cam-wrap").classList.add("hidden");
  }
};

$("btn-full-loop").onclick = () => {
  sender.playlist = sender.frames.map((_, i) => i);
  sender.play();
  $("btn-pause").textContent = "Pause";
  $("send-status").textContent = "Looping the full frame sequence.";
};

// ═══════════════════════════════════════ RECEIVER ════════════════════════════

const grid = $("frame-grid");
let gridCells = [];

// ── Scan heartbeat: proves the camera is locked on, even between new frames ──
const scan = { times: [], lastSeen: 0, lastIdx: null, timer: null };

function setScanPill(state, text) {
  $("scan-dot").dataset.state = state;   // off | idle | live
  $("scan-text").textContent = text;
}

function scanHeartbeat(frameIdx) {
  const now = Date.now();
  scan.lastSeen = now;
  scan.lastIdx = frameIdx;
  scan.times.push(now);
  while (scan.times.length && now - scan.times[0] > 3000) scan.times.shift();
  // flash the viewfinder border on every capture
  const vf = document.querySelector("#panel-receive .viewfinder");
  if (vf) { vf.classList.remove("flash"); void vf.offsetWidth; vf.classList.add("flash"); }
}

function startScanTicker() {
  stopScanTicker();
  scan.timer = setInterval(() => {
    if (!receiver.scanning) { setScanPill("off", "camera off"); return; }
    const idle = Date.now() - scan.lastSeen;
    if (scan.lastSeen === 0 || idle > 1500) {
      setScanPill("idle", "searching… align the camera with the sender's screen");
    } else {
      const rate = (scan.times.length / 3).toFixed(1);
      setScanPill("live", `locked on · frame #${scan.lastIdx} · ${rate}/s`);
    }
  }, 400);
}
function stopScanTicker() { if (scan.timer) { clearInterval(scan.timer); scan.timer = null; } }

const receiver = new Receiver({
  onStatus: t => { $("recv-status").textContent = t; },
  onSignal: idx => scanHeartbeat(idx),
  onBuild: (label, pct) => {
    const w = $("build-wrap");
    w.classList.remove("hidden");
    if (pct === 0) w.classList.remove("ok", "fail");
    $("build-label").textContent = label;
    $("build-pct").textContent = Math.round(pct) + "%";
    $("build-bar").style.width = pct + "%";
  },
  onManifest: m => {
    $("recv-meta").textContent =
      `${m.name} — ${fmtBytes(m.origSize)} original, ${m.totalFrames} frames @ ${m.chunkSize} B`;
    grid.innerHTML = "";
    gridCells = [];
    const cap = Math.min(m.totalFrames, 2000); // visual cap; counts stay exact
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
    $("recv-status").textContent = "All frames received. Show the ACK to the sender, then save the file.";
    $("btn-save").disabled = false;
    $("btn-show-ack").click(); // auto-show COMPLETE ack
  },
});

$("btn-start-scan").onclick = async () => {
  const pass = $("recv-pass").value;
  if (!pass) { $("recv-status").textContent = "Enter the sender's passphrase first."; return; }
  $("btn-start-scan").disabled = true;
  $("recv-live").classList.remove("hidden");
  keepAwake(true);
  try {
    await receiver.startScanning($("recv-video"), $("recv-canvas"));
    startScanTicker();
    setScanPill("idle", "searching… align the camera with the sender's screen");
    $("recv-status").textContent = "Scanning… aim the camera at the sender's screen.";
  } catch (e) {
    setScanPill("off", "camera unavailable");
    $("recv-status").textContent = `Camera error: ${e.message}`;
    $("btn-start-scan").disabled = false;
  }
};

$("btn-show-ack").onclick = () => {
  const wrap = $("ack-out-wrap");
  if (receiver.renderAckQR($("ack-out"))) {
    wrap.classList.remove("hidden");
    const miss = receiver.missingFrames.length;
    $("ack-out-label").textContent = receiver.isComplete
      ? "COMPLETE — sender can stop."
      : `Requesting ${miss} missing frame(s). Point this at the sender's camera.`;
    // Hold, then return to scanning if not complete
    setTimeout(() => {
      wrap.classList.add("hidden");
      if (!receiver.isComplete && !receiver.scanning) $("btn-start-scan").disabled = false;
    }, 6000);
  } else {
    $("recv-status").textContent = "No session yet — scan at least one frame first.";
  }
};

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
    keepAwake(false);
  } catch (e) {
    $("build-wrap").classList.add("fail");
    $("build-label").textContent = "Build failed";
    $("recv-status").textContent = e.message;
    $("btn-save").disabled = false;
  }
};

// ── Secure-context check (camera won't exist over plain http) ───────────────
if (!window.isSecureContext) {
  const warn = document.createElement("div");
  warn.className = "https-warn";
  warn.textContent =
    "⚠ This page is not HTTPS, so the camera is disabled by the browser. " +
    "Open the app from an https:// URL (e.g. GitHub Pages) or localhost.";
  document.querySelector("main").prepend(warn);
}

// ── PWA: offline after first load ────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => { /* offline install is best-effort */ });
}
