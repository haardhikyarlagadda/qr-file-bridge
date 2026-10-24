# QR File Bridge

Transfer a file between two phones using **only screens and cameras**.
No network, no Bluetooth, no cables — both devices can be in airplane mode.

Built incrementally, each step verified on real devices before the next:

1. ✅ 3-way optical handshake (SYN / SYN-ACK / ACK)
2. ✅ Capacity ladder — target devices passed at **3300 chars/frame** (QR v40-class)
3. ✅ **File transfer** (this page) — chunked frames, live ACK screen, retransmit, SHA-256 verify
4. ✅ Optional AES-256-GCM encryption (PBKDF2-SHA256, 600k iterations) — filename sealed inside the ciphertext

## How a transfer works

Both phones open the page and face each other ~15–25 cm apart. Each screen
talks to the other phone's camera — full duplex, no mode switching:

- **Sender screen**: plays data frames as an animated QR sequence
- **Receiver screen**: always shows its current ACK (missing-frame ranges),
  refreshed live; the sender's camera reads it and keeps only missing
  frames in rotation
- Completion: receiver shows a persistent DONE code; sender stops;
  receiver verifies SHA-256 and offers the file for saving. A corrupt
  transfer saves nothing.

## Wire protocol (QR alphanumeric charset, '.'-delimited header)

```
SYN       QH1.S.<sid>
READY     QH1.A.<sid>
MANIFEST  QH1.M.<sid>.<total5>.<size8hex>.<sha64>.<P|E>.<salt>.<nonce>.<nameB45><CK4>
DATA      QH1.F.<sid>.<idx5>.<base45><CK4>
ACK       QH1.R.<sid>.M.<ranges e.g. 1-40/55/71-90><CK4>
DONE      QH1.R.<sid>.K
```

Every frame carries a 4-hex checksum; the received bytes are verified against
the SHA-256 in the manifest. For encrypted transfers (`E`) that hash, the size
and the name field cover the ciphertext only — the real filename travels
inside the encrypted payload, so nothing about the file is readable from the QR codes. Base45 keeps QR codes in alphanumeric mode
(~45% denser than Base64 byte mode).

Density options: 550 / 1100 / 2000 (default) / 2600 chars per frame
(≈355 / 719 / 1318 / 1719 bytes of file data per frame).

## Run

Serve `index.html` over HTTPS (camera requirement) — GitHub Pages,
Netlify Drop, Cloudflare Pages all work. One file, no build step.
The protocol simulation (`40 assertions`) runs the exact page logic in
Node including a 10% frame-drop + ACK + retransmit cycle.

Previous full implementation and diagnostics live in `legacy/`.

## License

MIT
