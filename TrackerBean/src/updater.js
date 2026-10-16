// Wraps electron-updater so the rest of the app only sees a small status object.
// `autoUpdater` is passed in so this file can be tested without Electron.
function createUpdater({ autoUpdater, onChange = () => {}, enabled }) {
  const state = { status: enabled ? 'idle' : 'disabled', version: null, percent: 0, error: null, checkedAt: null };
  const set = (patch) => { Object.assign(state, patch); onChange(); };
  if (enabled) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // if you ignore the button, it installs when you next quit
    autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (i) => set({ status: 'downloading', version: i.version, percent: 0 }));
    autoUpdater.on('update-not-available', () => set({ status: 'current', checkedAt: Date.now() }));
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version, percent: 100 }));
    autoUpdater.on('error', (e) => set({ status: 'error', error: String((e && e.message) || e).slice(0, 200), checkedAt: Date.now() }));
  }
  const busy = () => ['checking', 'downloading', 'ready'].includes(state.status);
  return {
    state,
    check() { if (enabled && !busy()) Promise.resolve(autoUpdater.checkForUpdates()).catch(() => { /* reported via the error event */ }); },
    install() { if (state.status === 'ready') autoUpdater.quitAndInstall(true, true); }, // silent install, then reopen
  };
}
module.exports = { createUpdater };
