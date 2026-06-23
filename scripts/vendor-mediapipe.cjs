// Copies the MediaPipe face engine into ./vendor so the desktop app runs fully
// offline. Run once after `npm install`:  npm run vendor:mediapipe
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision');
const OUT = path.join(ROOT, 'vendor', 'tasks-vision');
const MODEL_OUT = path.join(ROOT, 'vendor', 'face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        fs.rmSync(dest, { force: true });
        reject(err);
      });
  });
}

(async () => {
  if (!fs.existsSync(PKG)) {
    console.error('Could not find node_modules/@mediapipe/tasks-vision.\nRun `npm install` first.');
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });

  // The ESM bundle (file name has varied across versions).
  const bundle = ['vision_bundle.mjs', 'vision_bundle.js'].find((f) => fs.existsSync(path.join(PKG, f)));
  if (!bundle) {
    console.error('Could not find vision_bundle.mjs in the tasks-vision package.');
    process.exit(1);
  }
  fs.copyFileSync(path.join(PKG, bundle), path.join(OUT, 'vision_bundle.mjs'));

  // The wasm/loader folder.
  fs.cpSync(path.join(PKG, 'wasm'), path.join(OUT, 'wasm'), { recursive: true });
  console.log('Copied tasks-vision (bundle + wasm) -> vendor/tasks-vision');

  // The model.
  console.log('Downloading face_landmarker.task (~3.8 MB)…');
  await download(MODEL_URL, MODEL_OUT);
  console.log('Saved model -> vendor/face_landmarker.task');
  console.log('\nDone. The desktop app will now run fully offline.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
