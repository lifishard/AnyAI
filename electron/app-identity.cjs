'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Public branding is independent of the installed app's storage identity.
// Electron 34 uses app.getName() for macOS Keychain and Linux secret storage.
// Changing it would leave existing encrypted keys unreadable.
function configureIdentity(app) {
  const current = app.getPath('userData');
  const session = app.getPath('sessionData');
  const defaultPath = path.join(app.getPath('appData'), app.getName());
  const isDefault = path.resolve(current) === path.resolve(defaultPath);
  app.setName('anyai');
  if (isDefault) {
    const stablePath = path.join(app.getPath('appData'), 'anyai');
    fs.mkdirSync(stablePath, { recursive: true });
    app.setPath('userData', stablePath);
    if (path.resolve(session) === path.resolve(current)) app.setPath('sessionData', stablePath);
  }
  app.setAboutPanelOptions({ applicationName: 'wickrunAI · 灯芯AI' });
}

module.exports = { configureIdentity };
