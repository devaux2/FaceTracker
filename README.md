# FaceTracker

Live webcam **face-paint mapping** for installations, photo booths and "magic
mirror" experiences — like the `#SKELFIE` skull mirror. Point a camera at people
and FaceTracker maps an uploaded paint design onto every face in real time,
following each face as it moves, plus text / image / **video** logo overlays.

It runs as a **buildless, dependency-light web app** in Chrome:

- **Control panel** (`control.html`) — your "CRM". Upload paints, stickers and
  overlays, tune the look, and see whether the display is live. Use it on the
  same laptop, or any browser window beside the display.
- **Display** (`display.html`) — the 24/7 screen guests see. Webcam in, painted
  faces out.

The two windows talk to each other automatically (same browser, same computer)
over `BroadcastChannel`, and everything is stored locally in IndexedDB. **No
backend, no build step, no account.**

| | |
|---|---|
| Face tracking | MediaPipe **FaceLandmarker** (468-point mesh, up to 10 faces), loaded from CDN |
| Rendering | WebGL mesh warp (898 triangles) + anchored sticker quads + DOM overlays |
| Storage | IndexedDB (paints, stickers, overlays, settings) with JSON export/import |
| Sync | `BroadcastChannel` (control ⇄ display), live |

---

## Quick start

You need **Google Chrome**, a **webcam**, and (on first load) an **internet
connection** so the face engine can download.

Serve the folder over `http://localhost` — the camera and live sync require a
secure context, which `localhost` provides:

```bash
# macOS / Linux
./scripts/start.sh

# Windows
scripts\start.bat

# …or any static server, e.g.
python3 -m http.server 8000
```

Then:

1. Open **http://localhost:8000/control.html**.
2. Click **Open Display ↗** (allow the camera). Press **F** for full screen.
3. In the control panel → **Paints**, click **Download paint template**, paint
   on it in any image editor, export a **transparent PNG**, and upload it.

Changes in the control panel apply to the display instantly.

> Double-clicking the `.html` files (the `file://` protocol) is **not**
> recommended — Chrome gives each `file://` page a separate origin, so the
> control panel and display can't sync. Always use `localhost`.

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

Launch the display as a borderless, full-screen Chrome window pointed at the
display URL:

```bash
# macOS
open -na "Google Chrome" --args --kiosk --app="http://localhost:8000/display.html"

# Windows
chrome --kiosk --app="http://localhost:8000/display.html"

# Linux
google-chrome --kiosk --app="http://localhost:8000/display.html"
```

Useful extra flags for unattended installs:
`--noerrdialogs --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required`.
You'll still click **Start** once to grant camera access (Chrome remembers the
permission for `localhost` afterwards).

---

## Back up / move your kit

Control panel → **Export** writes a single JSON file containing every paint,
sticker, overlay and setting (images embedded). **Import** restores it on another
machine. Handy for building your kit on a laptop and deploying to the venue PC.

---

## Running fully offline

By default the face engine is fetched from a CDN on first load (then browser-
cached). For a venue without reliable internet, vendor the assets:

1. Download MediaPipe `@mediapipe/tasks-vision` (the `wasm/` folder and the ESM
   bundle) and the model file
   `face_landmarker.task`
   (`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`)
   into a `vendor/` folder.
2. Point `js/config.js` → `MEDIAPIPE.module`, `MEDIAPIPE.wasm` and
   `MEDIAPIPE.model` at the local `vendor/` paths.

Everything else already runs locally.

---

## Project layout

```
index.html / control.html / display.html   pages
css/app.css                                 styles
js/
  config.js          channel name, CDN/model URLs, defaults, landmark anchors
  facemesh-data.js   468 UV coords + 898 triangles (from MediaPipe canonical model)
  store.js           IndexedDB + export/import
  bus.js             BroadcastChannel sync + presence
  tracker.js         MediaPipe FaceLandmarker + multi-face tracking/smoothing
  renderer.js        WebGL mesh-warp + sticker compositor
  overlays.js        DOM text/image/video overlay layer
  template.js        paint-template generator
  display.js         display page wiring
  control.js         control panel wiring
scripts/             one-command launchers (start.sh / .command / .bat)
```

---

## Notes & limitations

- Best in **Chrome/Edge** (WebGL2 + `requestVideoFrameCallback`). Works in
  Firefox/Safari with minor perf differences.
- Animated GIF stickers show their first frame only; use a **video overlay** for
  motion.
- Control ⇄ display sync is same-computer/same-browser by design (no server).
  Controlling from a separate phone/device would need a small WebSocket relay —
  a natural future addition; the messaging is already abstracted in `bus.js`.

## Credits

Face landmark detection and the canonical face-mesh UV/triangulation come from
Google **MediaPipe** (Apache-2.0).
