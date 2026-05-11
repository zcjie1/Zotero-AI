export { registerPrefsScripts };

function registerPrefsScripts(_window: Window) {
  ensureDefaultPrefs();
  // This function is called when the preferences pane loads.
  // We can handle additional preference UI logic here if needed.
  // For now, the preferences XHTML handles data binding automatically.
}

function ensureDefaultPrefs(): void {
  const key = `${addon.data.config.prefsPrefix}.maxFigures`;
  if (Zotero.Prefs.get(key, true) === undefined) {
    Zotero.Prefs.set(key, 5, true);
  }
}
