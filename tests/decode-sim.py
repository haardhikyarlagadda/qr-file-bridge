"""
Decode-capability experiment for QR File Bridge frames.

Pipeline per (chunk size, camera condition):
  1. Encode the real Base45 frame into a QR (cv2 QRCodeEncoder, ECC M)
  2. Render at 'screen' size, then simulate a phone camera:
     downscale to N px, Gaussian blur (focus miss), sensor noise,
     slight perspective tilt
  3. Try to decode with:
       - cv2.QRCodeDetector      (baseline, ~jsQR class)
       - wechat_qrcode           (CNN-based, ~ZXing/native class)
Success rate over 12 randomized trials each.
"""
import cv2, json, numpy as np

frames = json.load(open('/tmp/frames.json'))

wechat = cv2.wechat_qrcode_WeChatQRCode()
basic = cv2.QRCodeDetector()

def make_qr(text):
    enc = cv2.QRCodeEncoder_create()
    m = enc.encode(text)                     # binary module matrix
    return m

def simulate_camera(qr_modules, cam_px, blur_sigma, noise_std, tilt, rng):
    # Render QR at high res on 'screen' with quiet zone
    modules = qr_modules.shape[0]
    scale = max(2, 800 // (modules + 8))
    quiet = 4 * scale
    size = modules * scale + 2 * quiet
    img = np.full((size, size), 255, np.uint8)
    block = np.kron(qr_modules, np.ones((scale, scale), np.uint8))
    img[quiet:quiet+block.shape[0], quiet:quiet+block.shape[1]] = np.where(block > 0, 0, 255)

    # Perspective tilt (hand not perfectly parallel)
    h, w = img.shape
    d = tilt * w
    src = np.float32([[0,0],[w,0],[w,h],[0,h]])
    dst = np.float32([[d*rng.random(),d*rng.random()],
                      [w-d*rng.random(),d*rng.random()],
                      [w-d*rng.random(),h-d*rng.random()],
                      [d*rng.random(),h-d*rng.random()]])
    img = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src,dst),(w,h),
                              borderValue=200)
    # Camera downscale + focus blur + sensor noise
    img = cv2.resize(img, (cam_px, cam_px), interpolation=cv2.INTER_AREA)
    if blur_sigma > 0:
        img = cv2.GaussianBlur(img, (0,0), blur_sigma)
    if noise_std > 0:
        img = np.clip(img.astype(np.float32) +
                      rng.normal(0, noise_std, img.shape), 0, 255).astype(np.uint8)
    return img

def try_decode(img, expected):
    res_w = wechat.detectAndDecode(img)[0]
    ok_w = any(t == expected for t in res_w)
    try:
        t, *_ = basic.detectAndDecode(img)
        ok_b = (t == expected)
    except cv2.error:
        ok_b = False
    return ok_b, ok_w

conditions = [
    ("good:  720px, mild blur",   720, 1.0, 4,  0.01),
    ("mid:   540px, soft focus",  540, 1.6, 6,  0.02),
    ("hard:  420px, blur+noise",  420, 2.2, 9,  0.03),
]

print(f"{'condition':<28}{'chunk':>6}{'chars':>7}{'modules':>9}{'basic':>8}{'wechat':>8}")
rng = np.random.default_rng(7)
results = {}
for name, px, blur, noise, tilt in conditions:
    for chunk, text in frames.items():
        qr = make_qr(text)
        okb = okw = 0
        trials = 12
        for _ in range(trials):
            img = simulate_camera(qr, px, blur, noise, tilt, rng)
            b, w = try_decode(img, text)
            okb += b; okw += w
        results[(name, chunk)] = (okb, okw, trials)
        print(f"{name:<28}{chunk+'B':>6}{len(text):>7}{qr.shape[0]:>9}"
              f"{okb}/{trials:>4}{okw:>5}/{trials}")
