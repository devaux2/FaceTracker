# FaceTracker

Live webcam **face-paint mapping** for installations, photo booths and "magic
mirror" experiences — like the `#SKELFIE` skull mirror. Point a camera at people
and FaceTracker maps an uploaded paint design onto every face in real time,
following each face as it moves, plus text / image / **video** logo overlays.

It has two surfaces:

- **Control panel** — your "CRM". Upload paints, stickers and overlays, tune the
  look, and see whether the display is live.
- **Display** — the 24/7 screen guests see. Webcam in, painted faces out.

It ships as a **double-click desktop app** (recommended) and *also* runs as a
plain web app. Everything is stored locally; **no backend, no account**.

| | |
|---|---|
| Face tracking | MediaPipe **FaceLandmarker** (468-point mesh, up to 10 faces) |
| Rendering | WebGL mesh warp (898 triangles) + anchored sticker quads + DOM overlays |
| Storage | IndexedDB (paints, stickers, overlays, settings) with JSON export/import |
| Sync | `BroadcastChannel` (control ⇄ display), live |
| Desktop shell | Electron (Chromium) — works offline, auto-fullscreen, kiosk-ready |

---

## Run it — desktop app (recommended)

This is the easy path for the person operating it: a normal app window, no
terminal, no localhost, camera permission handled for you, and it can run
**fully offline**.

**For the operator (after you've given them the built app):**
Double-click **FaceTracker**. The control panel opens; click **Open Display** and
the display fills the second screen (or press **F** to go full screen on one).
That's it.

**To build the app once (on a machine with Node 18+ installed):**

```bash
npm install                  # one time
npm run vendor:mediapipe     # optional: bundle the face engine to run offline
npm start                    # run it right now to try it

npm run dist                 # build the installer: .dmg / .exe / AppImage
```

`npm run dist` produces an installer in `release/` for **the OS you run it on**
(build on a Mac for `.dmg`, on Windows for `.exe`). Hand that single file to your
client. (Want installers for all three OSes automatically? See *Building
installers in CI* below.)

> First launch downloads the face engine unless you ran `vendor:mediapipe`.
> After the first run it's cached, so internet isn't needed again. Unsigned apps
> prompt once: macOS → right-click → **Open**; Windows → **More info → Run
> anyway**.

## Run it — web app (no install)

Serve the folder over `http://localhost` (the camera + live sync need a secure
origin, which `localhost` provides — double-clicking the `.html` files won't
work):

```bash
./scripts/start.sh         # macOS / Linux
scripts\start.bat          # Windows
python3 -m http.server 8000   # …or any static server
```

Open **http://localhost:8000/control.html**, click **Open Display ↗**, allow the
camera, press **F**. In **Paints**, click **Add sample skull paint** to see it
working immediately.

---

## Authoring content

### Face paints (full-face mesh)
The most immersive option — the image warps to follow the whole face.

1. **Download the template** (Paints tab). It shows the face-mesh layout with the
   eyes, nose, mouth and jaw marked.
2. Open it in any editor (Photoshop, Procreate, Figma, GIMP, Photopea…), paint on
   a **new layer**, then **hide the guide** and export a **transparent PNG** at
   the same square size.
3. Upload it. Whatever you paint at a spot on the template lands at the matching
   spot on every face.

Choose how paints are applied (Paints tab):
- **Single active paint** — everyone gets the same design.
- **Random paint per face** — each detected face is assigned a random design
  from the ones you mark "in rotation" (great for crowds, like the example).

### Stickers (anchored PNGs)
Pin a PNG to a face feature — across the eyes, forehead, nose, mouth, chin or the
whole face — with scale, offset, rotation and opacity. Stickers track the face
but don't warp, so they're quick to make (e.g. a crown, glasses, a logo badge).

### Overlays (text / image / video logos)
Full-screen layer on top of the feed:
- **Text** — captions / hashtags with colour, background, size, position.
- **Image** — a PNG/JPG logo, positioned and scaled.
- **Video** — a looping, muted video logo (MP4/WebM).

Position everything in the live preview (Overlays tab).

---

## Display settings

Camera selection · mirror (selfie view) · colour look (none / grayscale / noir /
sepia / **duotone** with custom colours, for that black-&-white skelfie feel) ·
max faces (1–10) · smoothing · GPU/CPU detector · background colour · FPS readout
· mesh wireframe debug.

**Display keyboard shortcuts:** `F` full screen · `I` info/FPS · `D` mesh debug.

---

## Kiosk / always-on mode

**Desktop app:** the display auto-starts (no "Start" click) and goes full screen
on a second monitor automatically. To launch on boot, add the built app to your
OS login items / startup folder.

**Web app:** launch the display as a borderless full-screen Chrome window:

```bash
# macOS / Windows / Linux (adjust the chrome command per OS)
chrome --kiosk --app="http://localhost:8000/display.html"
```

Extra flags for unattended web installs:
`--noerrdialogs --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required`.

---

## Building installers in CI (all OSes at once)

Build for macOS, Windows and Linux from one push with GitHub Actions (a matrix
running `npm ci && npm run vendor:mediapipe && npm run dist` on
`macos-latest` / `windows-latest` / `ubuntu-latest`, uploading `release/*` as
artifacts). Ask and I'll drop in the workflow. For shipping to clients without
the "unidentified developer" prompt you'd add code-signing certs as repo secrets.

---

## Back up / move your kit

Control panel → **Export** writes a single JSON file containing every paint,
sticker, overlay and setting (images embedded). **Import** restores it on another
machine. Handy for building your kit on a laptop and deploying to the venue PC.

---

## Running fully offline

In the **desktop app**, just run `npm run vendor:mediapipe` before building. It
copies the MediaPipe engine and downloads the model into `vendor/`; the preload
detects them and the app loads everything locally — no internet at runtime.

For the **web app**, do the same `vendor:mediapipe` step (or place the files in
`vendor/` manually) and set `window.FT_CONFIG = { mediapipeVendorBase: '/vendor' }`
before the scripts load. `js/config.js` already prefers the local copy when that
is set.

---

## Project layout

```
index.html / control.html / display.html   web pages (shared by web + desktop)
css/app.css                                 styles
js/
  config.js          MediaPipe/CDN config (+ FT_CONFIG overrides), defaults, anchors
  facemesh-data.js   468 UV coords + 898 triangles (from MediaPipe canonical model)
  store.js           IndexedDB + export/import
  bus.js             BroadcastChannel sync + presence
  tracker.js         MediaPipe FaceLandmarker + multi-face tracking/smoothing
  renderer.js        WebGL mesh-warp + sticker compositor
  overlays.js        DOM text/image/video overlay layer
  template.js        paint-template + sample-paint generator
  display.js         display page wiring
  control.js         control panel wiring
electron/
  main.cjs           desktop shell: serves the app on loopback, opens windows
  preload.cjs        exposes FT_CONFIG (electron flag + offline vendor base)
  static-server.cjs  tiny static file server (also serves files from the asar)
scripts/
  vendor-mediapipe.cjs   bundle the face engine for offline use
  start.sh / .command / .bat   web-app launchers
```

---

## Notes & limitations

- The desktop app uses Chromium, so the camera, WebGL2 and per-frame timing are
  consistent on every machine. The web app is best in **Chrome/Edge**.
- Animated GIF stickers show their first frame only; use a **video overlay** for
  motion.
- Control ⇄ display sync is same-machine by design (no server). Controlling from
  a separate phone/device would need a small WebSocket relay — a natural future
  addition; the messaging is already abstracted in `bus.js`.

## Credits

Face landmark detection and the canonical face-mesh UV/triangulation come from
Google **MediaPipe** (Apache-2.0).
