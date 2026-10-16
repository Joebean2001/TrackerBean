// Tiny JSON file store. Saves are atomic (write temp file, then rename).
const fs = require('fs');
const quest = require('./quest');
const path = require('path');

const DEFAULTS = () => ({
  games: [],      // { id, name, exes:[...], installPath, added }
  sessions: [],   // { id, gameId, start, end, lastSeen, open }
  settings: { closeToTray: true, startWithWindows: false, scanFolders: [], clipsFolder: '', montageDir: '' },
  journal: [],    // { id, gameId, mood, text, images:[file], left, createdAt }
  goals: [],      // { id, type, title, target, period, gameId, start, end, created, doneAt, done }
  bingo: null,    // { squares:[{text,done}], createdAt }
  quest: quest.defaults(),
  cs2: { token: '', cfgPort: null }, // CS2 match data: key shared with the game, port written into its config
  profile: { name: '', accounts: [], friends: [], cache: {} }, // Steam profile + friends (see src/social.js)
});

class Store {
  constructor(file) {
    this.file = file;
    this.data = DEFAULTS();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...DEFAULTS(), ...saved, settings: { ...DEFAULTS().settings, ...(saved.settings || {}) }, quest: { ...quest.defaults(), ...(saved.quest || {}) }, cs2: { ...DEFAULTS().cs2, ...(saved.cs2 || {}) }, profile: { ...DEFAULTS().profile, ...(saved.profile || {}) } };
    } catch (e) { /* first run or unreadable file: start fresh */ }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
module.exports = Store;
