// camera.js — one place to open the camera, with clear failures.
// iOS Safari (and all modern browsers) expose navigator.mediaDevices ONLY in
// a secure context: an https:// page or localhost. Over plain http:// on a
// LAN IP, the API is simply undefined — this helper turns that into a
// human-readable instruction instead of a cryptic TypeError.

export async function openCamera(constraints) {
  if (!window.isSecureContext) {
    throw new Error(
      "Camera blocked: this page is not HTTPS. Browsers only allow camera " +
      "access on https:// or localhost. Host the app on an HTTPS URL " +
      "(e.g. GitHub Pages) and reopen it."
    );
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(
      "Camera API unavailable in this browser. On iPhone use Safari, " +
      "and make sure the page is served over HTTPS."
    );
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Ask for continuous autofocus where supported (helps close-range QR
    // scanning; silently ignored on browsers that don't expose focusMode).
    try {
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.();
      if (caps?.focusMode?.includes?.("continuous")) {
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      }
    } catch { /* best-effort */ }
    return stream;
  } catch (e) {
    if (e.name === "NotAllowedError")
      throw new Error("Camera permission denied. Allow camera access in your browser settings and retry.");
    if (e.name === "NotFoundError")
      throw new Error("No camera found on this device.");
    if (e.name === "NotReadableError")
      throw new Error("Camera is in use by another app. Close it and retry.");
    throw new Error(`Camera error: ${e.message || e.name}`);
  }
}
