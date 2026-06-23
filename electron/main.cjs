// FaceTracker — Electron main process.
// Serves the existing web app over loopback http and opens it in native
// windows: a Control window, and a Display window (fullscreen on a second
// monitor if one is connected). Camera permission is granted automatically so
// the operator never sees a prompt.
const { app, BrowserWindow, screen, session, systemPreferences, Menu } = require('electron');
const path = require('path');
const { listen } = require('./static-server.cjs');

const APP_ROOT = path.join(__dirname, '..');
let server = null;
let port = 0;
let controlWin = null;
let displayWin = null;

const url = (p) => `http://127.0.0.1:${port}/${p}`;

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 720,
    minHeight: 560,
    title: 'FaceTracker — Control',
    backgroundColor: '#0c0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlWin.loadURL(url('control.html'));

  // The control panel calls window.open('display.html'); intercept it and make
  // a proper Display window instead (placed on the external screen if present).
  controlWin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.includes('display.html')) openDisplayWindow();
    return { action: 'deny' };
  });

  controlWin.on('closed', () => (controlWin = null));
}

function openDisplayWindow() {
  // Only ever one display window — focus it if it already exists.
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.focus();
    return;
  }
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const external = displays.find((d) => d.id !== primary.id);
  const target = external || primary;
  const hasExternal = !!external;

  const win = new BrowserWindow({
    x: target.bounds.x + (hasExternal ? 0 : 60),
    y: target.bounds.y + (hasExternal ? 0 : 60),
    width: hasExternal ? target.bounds.width : 1280,
    height: hasExternal ? target.bounds.height : 720,
    fullscreen: hasExternal,
    backgroundColor: '#000000',
    title: 'FaceTracker — Display',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(url('display.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  displayWin = win;
  win.on('closed', () => (displayWin = null));
}

function grantMediaPermissions() {
  const ses = session.defaultSession;
  // Auto-approve camera/fullscreen requests for our loopback origin.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(true));
  ses.setPermissionCheckHandler(() => true);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  grantMediaPermissions();

  // On macOS, proactively trigger the one-time OS camera permission dialog.
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('camera');
    } catch {}
  }

  ({ server, port } = await listen(APP_ROOT));
  createControlWindow();
  openDisplayWindow(); // bring the live display up immediately so it's clearly working

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (server) server.close();
});
