# QR File Bridge

Transfer files between any two devices using **only a screen and a camera**.

The file is compressed, encrypted with AES-256-GCM, cut into chunks, and played
as an **animated QR code sequence** on the sender's screen. The receiver's
camera decodes the frames — in any order — and rebuilds, decrypts, verifies,
and saves the file. No Wi-Fi, no Bluetooth, no NFC, no cables, no servers,
no accounts. Both devices can be in **airplane mode**.

Implements SRS v2.0 (QR-only optical transfer architecture).

## Quick start

This is a static web app — no build step, no dependencies to install.

```bash
# any static server works; camera access needs localhost or HTTPS
python3 -m http.server 8000
# then open http://localhost:8000 on both devices
```

Or deploy the folder as-is to GitHub Pages, Netlify, Cloudflare Pages, or any
static host. After the first load, the service worker caches everything and
the app runs **fully offline** (installable as a PWA).

## How to transfer a file

1. **Both devices**: open the app. Agree on a passphrase out loud (never put
   it in a QR).
2. **Sender**: choose *Send*, pick the file, enter the passphrase, tap
   **Encrypt & start transmitting**. The screen begins looping QR frames.
3. **Receiver**: choose *Receive*, enter the same passphrase, tap **Open
   camera & scan**, and aim at the sender's screen. The frame map fills in
   live; frames arrive in any order and duplicates are ignored.
4. **Missing frames?** Receiver taps **Show ACK QR to sender**; sender taps
   **Scan receiver's ACK**. The sender then replays *only* the missing frames.
5. When complete, the receiver taps **Decrypt & save file**. The file is
   saved only if AES-GCM authentication *and* the whole-file SHA-256 both
   verify. A wrong passphrase saves nothing.

## Wire format

Every QR frame is a Base45-encoded binary frame:

| Field | Size | Notes |
|---|---|---|
| magic | 1 B | `0x51` data · `0x41` ACK |
| sessionId | 4 B | random per transfer |
| frameIndex | 3 B | `0` = manifest |
| totalFrames | 3 B | data-frame count |
| crc32 | 4 B | per-frame integrity |
| payload | ≤ chunk size | ciphertext chunk, or JSON manifest/ACK |

Frame 0 (manifest) carries: filename, sizes, frame count, chunk size,
compression algo, PBKDF2 salt, AES-GCM nonce, and the SHA-256 of the
original file.

**Crypto:** PBKDF2-SHA-256 (100k iterations) → AES-256-GCM. The optical
channel only ever carries ciphertext. Base45 keeps QR codes in alphanumeric
mode (~45% denser than Base64 byte mode).

## Project layout

```
index.html            app shell (Send / Receive)
css/style.css         instrument-panel UI
js/base45.js          Base45 codec (draft-faltstrom-base45)
js/crypto.js          PBKDF2, AES-256-GCM, SHA-256, deflate
js/frame.js           wire format, CRC32, manifest, ACK codec
js/sender.js          encode pipeline, QR pre-render, animated playback, ACK scan
js/receiver.js        camera scan loop, buffering, ACK render, reassembly
sw.js                 service worker — full offline after first load
manifest.webmanifest  PWA install manifest
```

Runtime libraries (loaded from cdnjs, cached offline by the service worker):
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (encode)
and [jsQR](https://github.com/cozmo/jsQR) (decode).

## Tuning

| Setting | Trade-off |
|---|---|
| Chunk size 200–1200 B | bigger = fewer frames but denser QR = harder to scan |
| Frame rate 1–6 fps | faster = quicker transfer but more missed frames |

Defaults (400 B @ 2 fps) work across typical phone cameras at 20–40 cm.
Throughput is inherently modest (~50–500 KB/min depending on settings) — this
is a tool for documents, photos, keys, and configs across an air gap, not for
videos.

## Browser support

Chrome/Edge/Firefox/Safari (recent versions). Requires: `getUserMedia`,
Web Crypto, ES modules. `CompressionStream` is used when available and
skipped gracefully when not. Camera access requires HTTPS or localhost.

## Testing without two devices

Open the app in two browser windows on one machine: *Send* in one, *Receive*
in the other, and point a phone camera… no — simpler: use one laptop as
sender and one phone as receiver, or two phones. A single device can't scan
its own screen.

## License

MIT

## Troubleshooting

**"undefined is not an object (evaluating 'navigator.mediaDevices.getUserMedia')"**
(iPhone/Safari) — the page was loaded over plain `http://`. Browsers expose
the camera API only in a *secure context*: an `https://` URL or `localhost`.
Accessing your dev machine over LAN IP (`http://192.168.x.x:8000`) is **not**
secure. Fix: deploy to any HTTPS host (GitHub Pages works out of the box) or
tunnel your local server through HTTPS (`ngrok http 8000`, Cloudflare Tunnel).
The app now detects this and shows a banner instead of failing cryptically.

**Camera permission denied** — allow camera access for the site in
Settings → Safari (iOS) or the address-bar permissions (desktop), then retry.

**Frames scan slowly on iPhone** — lower the sender frame rate to 1–2 fps
and use the 200–400 B chunk sizes; Safari throttles camera processing.
