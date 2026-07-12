# QR File Bridge — Documentation

Transfer a file between two devices using only a screen and a camera. No
network, no Bluetooth, no cables, no servers. Both devices can be in
airplane mode for the entire transfer.

This document explains how the application was built step by step, how the
code works, how to use it, and what its constraints are.

---

## 1. Design philosophy

The project was originally built top-down: a full protocol stack with
encryption, chunking, windowed ACKs, a service worker, and a multi-module
codebase. It passed every protocol test in Node yet failed on real iPhones,
and the layered architecture made the failure impossible to localize.

So it was rebuilt bottom-up with one rule: **no layer is added until the
layer below it is verified on the actual devices.**

| Step | What it proves | Status |
|---|---|---|
| 1. Handshake | The optical channel works in both directions | ✅ verified on-device |
| 2. Capacity ladder | The real QR density limit of the device pair | ✅ passed at 3300 chars |
| 3. File transfer | Chunking, ACK/retransmit, integrity | ✅ built on 1+2 |
| 4. Encryption | AES-256-GCM over the proven channel | ⏳ next |

The entire application is **one HTML file** (`index.html`) with no build
step, no modules, and no service worker. Every architectural simplification
was a lesson paid for: the service worker silently served stale code on iOS
for multiple debugging rounds, and module/import indirection hid which
decoder was actually running. One file means what you deploy is what runs.

---

## 2. The duplex optical model

The core physical insight that makes the protocol simple: **a phone's screen
and camera are independent devices.** A phone can display a QR code and scan
one at the same time.

```
   SENDER phone                     RECEIVER phone
  ┌─────────────┐                  ┌─────────────┐
  │   screen ───┼──── light ──────►│  camera     │   data frames
  │             │                  │             │
  │   camera ◄──┼──── light ───────┼── screen    │   live ACK
  └─────────────┘                  └─────────────┘
```

Both phones face each other, 15–25 cm apart. The sender's screen plays data
frames; the receiver's screen *permanently* displays its current ACK. Each
camera continuously reads the opposite screen. There is no turn-taking, no
timing choreography, and no "now show me your ACK" mode switching — the two
directions run concurrently, like full-duplex TCP.

---

## 3. Step 1 — the 3-way handshake

**Goal:** prove one QR can travel screen→camera in each direction before
anything else is attempted.

### Protocol

```
SYN       QH1.S.<sid>     sender shows, receiver scans
SYN-ACK   QH1.A.<sid>     receiver shows, sender scans
ACK       QH1.K.<sid>     sender shows, receiver scans → both show ✅
```

`<sid>` is a random 4-hex session ID. Payloads are ≤13 characters, which
fits **QR version 1** — a 21×21 module grid, the physically largest modules
a QR code can have. If these codes don't scan, no denser code ever will,
which makes the handshake a hardware qualifier as much as a feature.

### Key code

The decoder is chosen once, in strict preference order, and the active
choice is displayed on the page:

```js
// 1. Native BarcodeDetector (Android Chrome — hardware assisted)
// 2. ZXing WebAssembly polyfill (iOS Safari — near-native quality)
// 3. jsQR (last resort, weak on dense codes)
if (!("BarcodeDetector" in window)) {
  await import(".../barcode-detector@2/dist/es/side-effects.min.js");
}
detector = new BarcodeDetector({ formats: ["qr_code"] });
await detector.detect(warmupCanvas);   // force the WASM fetch NOW
```

The warm-up `detect()` call matters: it forces the WebAssembly binary to
download at startup rather than mid-scan, and its success is logged — so a
polyfill that fails to load is *visible* instead of silently degrading to
jsQR (the exact failure that went undiagnosed for several rounds in the
original build).

Every decode and error is printed to an on-page log panel, because there
are no dev tools on a phone.

### Why iPhone needed the polyfill

iOS Safari exposes no `BarcodeDetector` API. The iPhone's built-in Camera
app uses Apple's private Vision framework — unavailable to web pages. The
`barcode-detector` polyfill wraps a WebAssembly build of ZXing, giving web
pages a decoder in the same class. This was confirmed working on the target
iPhone by an isolated library test before being relied upon.

---

## 4. Step 2 — the capacity ladder

**Goal:** find the *actual* maximum QR density the device pair can exchange,
instead of designing around spec-sheet numbers.

### Protocol

After a mini-handshake, the sender climbs a ladder of payload sizes:

```
50 → 100 → 200 → 350 → 550 → 800 → 1100 → 1500 → 2000 → 2600 → 3300 chars
```

Each level is one message:

```
DATA       QH1.D.<sid>.<LL>.<body>.<CK4>    checksummed pseudo-random body
LEVEL-ACK  QH1.L.<sid>.<LL>.<OK|BAD>        receiver verifies the checksum
```

The receiver recomputes the checksum over the body, so a passing level
proves the data arrived *byte-intact*, not merely that "a QR was detected."
The sender measures round-trip time per level; a level with no ACK for 25
seconds is marked FAILED (with Retry / Stop controls). Results end in a
table plus a recommendation converting the max passing char count into a
bytes-per-frame budget and a suggested chunk size.

### Result on the target devices

The pair passed **3300 characters** — effectively the ceiling of the QR
format itself (version 40 at error-correction level M holds 3,391
alphanumeric characters). This proved the earlier failures were never about
decoder capability, and gave the transfer protocol a real budget to design
against.

---

## 5. Step 3 — file transfer

### Wire protocol

All messages use only the QR *alphanumeric* character set
(`0–9 A–Z space $ % * + - . / :`), which encodes ~45% denser than byte
mode. `.` delimits header fields; binary data rides as Base45 in the final
positional field.

```
SYN       QH1.S.<sid>
READY     QH1.A.<sid>
MANIFEST  QH1.M.<sid>.<total5>.<size8hex>.<sha64>.<nameB45><CK4>
DATA      QH1.F.<sid>.<idx5>.<base45><CK4>          idx is 1-based, 5 digits
ACK       QH1.R.<sid>.M.<ranges><CK4>               e.g. 1-40/55/71-90
DONE      QH1.R.<sid>.K
```

Details worth noting:

- **Ranges use `/` as a separator, not `,`** — the comma is not in the QR
  alphanumeric charset. Missing-frame sets compress extremely well as
  ranges: at transfer start, "everything missing" is just `1-497`.
- **The filename is Base45-encoded UTF-8**, so unicode names (and names
  containing dots) survive; the parser reads header fields positionally and
  treats everything after the fourth dot as the name field.
- **Two integrity layers:** every frame carries a 4-hex checksum (`CK4`,
  a 16-bit polynomial hash) that rejects corrupted scans on the spot, and
  the manifest carries the SHA-256 of the whole file, verified before the
  receiver offers the file for saving. A corrupt transfer saves nothing.

### The sender pipeline

```js
bytes  = await file.arrayBuffer()
sha    = SHA-256(bytes)                        // via crypto.subtle
// chunk budget: header "QH1.F.SSSS.IIIII." = 17 chars + 4 checksum = 21
availChars = targetChars - 21
chunkBytes = floor(availChars / 3) * 2         // Base45: 2 bytes → 3 chars
frames[0]  = manifest(total, size, sha, base45(name))
frames[i]  = "QH1.F." + sid + "." + idx5 + "." + base45(chunk_i) + CK4
```

Density options map to real payloads: 550 chars ≈ 355 B/frame, 1100 ≈ 719 B,
2000 ≈ 1318 B (default), 2600 ≈ 1719 B. The default deliberately sits well
under the 3300-char ceiling because animated frames give the camera less
settle time than the static codes the ladder tested.

### The transfer loop

1. Sender shows `SYN`; receiver scans it and puts `READY` on its screen.
2. Sender sees `READY`, initializes `missing = {1..N}`, and starts playing
   `[manifest, ...missing]` in a loop at the chosen frame rate. A ~55 ms
   white blank is inserted between frames so consecutive codes don't blur
   together on camera sensors.
3. The receiver buffers every valid frame (`Map` keyed by index — duplicates
   are free) and keeps its screen showing the **current ACK**, re-rendered
   whenever the missing set changes (and refreshed every 1.5 s regardless).
4. The sender's camera reads each new ACK and rebuilds its rotation to
   *only the still-missing frames*. The first ACK also proves the manifest
   arrived, which drops it from the rotation.
5. When the last frame lands, the receiver's screen switches to the
   persistent `DONE` code; the sender sees it and flips to "FILE DELIVERED."
   The receiver reassembles the chunks in index order, verifies SHA-256,
   and enables **Save file**.

This is selective-repeat ARQ, the same family of mechanism TCP SACK uses —
but with zero explicit round-trip coordination, because the reverse channel
is simply *always on*.

### Supporting features

- **Switch camera (rear ⇄ front):** swaps the `getUserMedia` stream in
  place; the scan loop keeps reading the same `<video>` element, so flipping
  mid-transfer loses nothing. With phones facing each other, one side using
  its front camera often aligns both screen/camera pairs naturally.
- **Receiver scan counter:** `scanned: N QR decodes · U unique frames · D
  duplicates`. This doubles as a channel-efficiency meter: many duplicates
  → the camera outpaces the sender, so raise fps or density; near-zero
  duplicates with slow progress → frames are being missed, so lower them.

---

## 6. How to use the application

### Deploying

The app is a single static file. Any HTTPS static host works:

- **GitHub Pages:** push the repo (public repo on the free plan), then
  Settings → Pages → Deploy from branch → main → root.
- **Netlify Drop:** drag the folder onto https://app.netlify.com/drop.
- **Cloudflare Pages:** connect the repo, no build command, output `/`.

**HTTPS is mandatory.** Browsers only expose the camera API
(`navigator.mediaDevices`) in secure contexts. A plain `http://` URL on a
LAN IP will show "camera API unavailable" on iPhone. `localhost` works for
same-machine development only.

### Running a transfer

1. Open the page on both phones (same URL).
2. **Sender:** tap *SEND a file* → choose the file → pick density and frame
   rate (defaults are sensible) → *Start sending*. A session QR appears.
3. **Receiver:** tap *RECEIVE a file* → the camera opens → point it at the
   sender's session QR.
4. From the moment the receiver joins, **hold the phones facing each other,
   15–25 cm apart**, each camera seeing the other's screen. Everything else
   is automatic: frames flow one way, ACKs flow the other, and the sender's
   rotation shrinks to whatever is still missing.
5. When done, the receiver verifies the SHA-256 and shows **Save file**;
   the sender shows FILE DELIVERED.

### Physical tips

- Maximize screen brightness on both phones; disable auto-lock.
- Avoid direct glare on either screen (tilt a few degrees if needed).
- Fill a good portion of the camera frame with the QR, but keep the whole
  code inside view — closer is not always better once focus hunts.
- Use *Switch camera* if the geometry is awkward; front cameras work.
- Watch the duplicate counter to tune density/fps for your conditions.

---

## 7. Constraints and limitations

**Physics of the channel**

- Throughput is bounded by `frame_payload × fps`. At the 2000-char default
  and 2 fps that is ≈ 2.6 KB/s (~155 KB/min); the practical ceiling with
  Max density and 5 fps in good conditions is roughly 0.5 MB/min. This is a
  tool for documents, photos, keys, and configuration files across an air
  gap — not for videos.
- Transfer requires continuous line of sight, adequate light, steady hands
  or stands, and both screens active for the whole duration.
- Ambient light, screen glare, camera focus behavior, and screen-refresh
  moiré all affect the usable density; that's why density is user-selectable
  and why the capacity ladder exists.

**Format and protocol limits**

- A QR code tops out at 3,391 alphanumeric chars (v40, ECC M); the app's
  Max density (2600) keeps margin below that.
- The frame index is 5 digits → at most 99,999 frames per transfer. At the
  default density that is ~125 MB theoretical; in practice transfer *time*
  becomes the limit long before frame count does.
- One transfer session at a time per page; a stray QR from another session
  is ignored (session ID filtering) but two simultaneous transfers in one
  camera's view will slow both.

**Platform constraints**

- **HTTPS required** for camera access (iOS is strict; there is no
  workaround).
- iOS Safari has no native `BarcodeDetector`; the ZXing WASM polyfill loads
  from a CDN on first visit, so the *first* page load needs internet. After
  that the transfer itself uses no network. (A future step can inline or
  self-host the polyfill for fully offline first-load.)
- The whole file is held in memory on both sides; very large files are
  bounded by mobile browser memory limits well before the frame-count cap.
- Keeping the screen awake is the user's responsibility in this build
  (disable auto-lock); the Wake Lock API is a planned addition.

**Security (current state)**

- Frames currently carry **plaintext** (Base45 is an encoding, not
  encryption). Anyone who can film the sender's screen can reconstruct the
  file. Integrity is protected (per-frame checksum + whole-file SHA-256),
  confidentiality is not yet.
- Step 4 ports the already protocol-tested AES-256-GCM + PBKDF2 layer from
  `legacy/js/crypto.js`, restoring the original security model: encrypt
  before chunking, so the optical channel only ever carries ciphertext and
  the shared passphrase never appears in any QR.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "camera API unavailable" | Page not HTTPS | Use the https:// deployment URL |
| Decoder line says "jsQR (fallback)" | Polyfill failed to load (log shows why) | Check first-load internet; reload |
| Receiver never joins | Session QR not in view / glare | Fill frame with the QR; tilt against glare |
| Scan counter climbing, unique frames stuck | Duplicates only — sender not rotating | Check sender's camera can see the receiver's ACK screen |
| Progress stalls near the end | Last few frames missed repeatedly | Hold steadier; lower fps; the ACK loop will re-request them |
| SHA-256 mismatch | Extremely unlikely (per-frame checksums) | Retry transfer; nothing was saved |

The on-page log (bottom of the screen, newest first) records every decode,
camera event, and error with timestamps — it is the primary debugging tool
and needs no developer console.

---

## 9. Repository layout

```
index.html      the entire application (handshake heritage + capacity
                ladder heritage + file transfer)
README.md       quick overview and protocol summary
DOCUMENTATION.md  this document
legacy/         the original multi-module implementation: encryption
                (crypto.js — protocol-tested, to be ported in step 4),
                frame codec, tests, and diagnostic pages
LICENSE         MIT
```

The git history tells the full story: SRS-driven v1 and v2 builds, the iOS
debugging sequence, the restart decision, and each verified step since.
