# FaceTracker

Live webcam **face-paint mapping** for installations, photo booths and "magic
mirror" experiences — like the `#SKELFIE` skull mirror. It detects every face in
the camera feed and warps an uploaded paint design onto each one in real time,
plus text / image / looping-video logo overlays.

It runs as a **desktop app you double-click**, with two windows:

- **Control** — upload paints, stickers and overlays, and tune the look.
- **Display** — the full-screen output guests see.

Everything is stored locally. No server, no account, and it can run fully offline.

---

## Quick start

1. Install **Node.js 18+** → https://nodejs.org (one time).
2. In this folder, run:

   ```bash
   npm install
   npm start
   ```

That's it. Two windows open — **Control** and a live **Display** showing your
webcam. In **Control → Paints**, click **Add sample skull paint** and watch it
map onto your face.

> You never open the `.html` files directly — `npm start` runs the whole app.

---

## Give it to your client (a double-click installer)

**Easiest:** every push to `main` builds the Windows + macOS installers in CI and
publishes them here:

**https://github.com/devaux2/FaceTracker/releases/latest**

Download the `.exe` (Windows) or `.dmg` (macOS) and run it.

Or build locally: `npm run dist` → installer in `release/` (builds for the OS you
run it on).

For the operator it's just: open **FaceTracker** → the Control panel and a
full-screen Display come up, camera and all. On a setup with two screens the
Display fills the second monitor automatically; add it to your OS startup items
for unattended 24/7 use.

> The app is unsigned, so the **first** launch needs one click to allow it:
> macOS → right-click the app → **Open**; Windows → **More info → Run anyway**.

---

## Updates

Installed apps **auto-update**: on launch they check GitHub Releases, download a
newer version in the background, and install it on restart (there's also a
**Check for updates** button in the control panel → Help). To ship an update,
just push to `main` — CI builds and publishes a new version (`1.0.<run number>`)
and every installed copy picks it up.

> Auto-update reads the **public** releases, so the repository must be public
> (Settings → General → Change visibility). Windows updates work unsigned;
> **macOS** auto-update additionally requires an Apple Developer signing
> certificate.

---

## Run offline (optional)

By default the face engine downloads once on first run and is cached afterwards.
To bundle it so the app never needs internet, run this **before** `npm start` or
`npm run dist`:

```bash
npm run vendor:mediapipe
```

It copies the MediaPipe engine and model into `vendor/`; the app then loads
everything locally.

---

## Creating content

### Face paints (warp onto the whole face)
1. **Paints tab → Download paint template.** It shows the face-mesh layout with
   eyes, nose, mouth and jaw marked.
2. Paint on it in any editor (Photoshop, Procreate, Figma, GIMP, Photopea…) on a
   new layer, hide the guide, and export a **transparent PNG** at the same square
   size.
3. Upload it — whatever you paint at a spot on the template lands at the matching
   spot on every face.

Apply paints two ways (Paints tab):
- **Single active paint** — everyone gets the same design.
- **Random paint per face** — each face gets a random design from the ones you
  mark "in rotation" (great for crowds, like the skelfie example).

### Stickers (anchored PNGs)
Pin a PNG to a feature — eyes, forehead, nose, mouth, chin or whole face — with
scale, offset, rotation and opacity. Stickers follow the face but don't warp, so
they're quick to make (crown, glasses, a logo badge).

### Overlays (text / image / video logos)
A layer on top of the feed: **text** captions/hashtags, an **image** logo, or a
**looping video** logo (MP4/WebM). Position everything in the live preview.

---

## Display settings & shortcuts

Camera · mirror (selfie view) · colour look (none / grayscale / noir / sepia /
**duotone** with custom colours, for the black-&-white skelfie feel) · max faces
(1–10) · smoothing · GPU/CPU detector · background colour · FPS readout · mesh
wireframe debug.

**On the Display:** `F` full screen · `I` info/FPS · `D` mesh debug.

**Back up / move a setup:** Control → **Export** writes one JSON file with every
paint, sticker, overlay and setting; **Import** restores it on another machine.

---

## How it's built

```
control.html / display.html / index.html   web UI (shared by desktop + browser)
css/app.css                                 styles
js/
  config.js          MediaPipe config (+ FT_CONFIG overrides), defaults, anchors
  facemesh-data.js   468 UV coords + 898 triangles (MediaPipe canonical model)
  store.js           IndexedDB + export/import
  bus.js             BroadcastChannel sync + presence (control <-> display)
  tracker.js         MediaPipe FaceLandmarker + multi-face tracking/smoothing
  renderer.js        WebGL mesh-warp + sticker compositor
  overlays.js        DOM text/image/video overlay layer
  template.js        paint-template + sample-paint generator
  display.js         display page wiring
  control.js         control panel wiring
electron/
  main.cjs           desktop shell: serves the app on loopback, opens windows
  preload.cjs        exposes FT_CONFIG (electron flag + offline vendor base)
  static-server.cjs  tiny static file server (also serves from the packaged app)
scripts/
  vendor-mediapipe.cjs   bundle the face engine for offline use
```

The desktop shell serves the web UI over loopback `http` and opens it in native
Chromium windows, so the camera, WebGL warp, storage and live sync behave
identically everywhere.

<details>
<summary>Run in a plain browser instead (for development)</summary>

The same files run as a web app. Serve the folder over `http://localhost`
(needed for camera + sync — opening the files directly won't work):

```bash
python3 -m http.server 8000   # or any static server
```

Then open `http://localhost:8000/`. The desktop app is the supported way to ship
it; this is just handy for quick edits with browser dev tools.
</details>

---

## Notes

- Multi-face tracking keeps a stable identity per face (so each keeps its paint)
  and smooths landmark jitter.
- Animated GIF stickers show their first frame only — use a **video overlay** for
  motion.
- Control ⇄ Display sync is same-machine by design. Driving it from a separate
  phone/device would need a small relay; the messaging is already abstracted in
  `js/bus.js`, so it's a clean future addition.

## Credits

Face landmark detection and the canonical face-mesh UV/triangulation come from
Google **MediaPipe** (Apache-2.0).
