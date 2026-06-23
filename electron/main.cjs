// FaceTracker — Electron main process.
// Serves the web app over loopback http and opens it in native windows (Control
// + a fullscreen Display). Camera permission is auto-granted. Auto-updates are
// pulled from the project's public GitHub Releases via electron-updater.
const { app, BrowserWindow, screen, session, systemPreferences, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const { listen } = require('./static-server.cjs');

let autoUpdater = null;
if (app.isPackaged) {
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.warn('electron-updater unavailable:', e);
  }
}

const APP_ROOT = path.join(__dirname, '..');
const ICON_PATH = path.join(APP_ROOT, 'build', 'icon.png');
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
    icon: ICON_PATH,
    backgroundColor: '#0c0d12',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  controlWin.loadURL(url('control.html'));
  controlWin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.includes('display.html')) openDisplayWindow();
    return { action: 'deny' };
  });
  controlWin.on('closed', () => (controlWin = null));
}

function openDisplayWindow() {
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
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadURL(url('display.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  displayWin = win;
  win.on('closed', () => (displayWin = null));
}

function grantMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  ses.setPermissionCheckHandler(() => true);
}

// ---- auto-update ----------------------------------------------------------
function broadcastUpdate(payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('updates:event', payload);
}

function setupUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const events = ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded'];
  for (const ev of events) autoUpdater.on(ev, (data) => broadcastUpdate({ event: ev, data }));
  autoUpdater.on('error', (err) => broadcastUpdate({ event: 'error', data: String((err && err.message) || err) }));
  autoUpdater.checkForUpdates().catch(() => {});
}

ipcMain.handle('updates:check', async () => {
  if (!autoUpdater) return { ok: false, reason: 'dev' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});
ipcMain.handle('updates:install', () => {
  if (autoUpdater) {
    try {
      autoUpdater.quitAndInstall();
    } catch {}
  }
});
ipcMain.handle('app:openExternal', (_e, u) => {
  if (typeof u === 'string' && /^https:\/\//.test(u)) shell.openExternal(u);
});

// ---- lifecycle ------------------------------------------------------------
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  grantMediaPermissions();
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('camera');
    } catch {}
  }
  ({ server, port } = await listen(APP_ROOT));
  createControlWindow();
  openDisplayWindow();
  setupUpdater();

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
