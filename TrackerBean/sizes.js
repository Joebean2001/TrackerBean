// Folder size on disk. Symlinks/junctions are skipped, so there are no loops.
const fsp = require('fs/promises');
const path = require('path');

async function folderSize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    const files = [];
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.isFile()) files.push(path.join(dir, e.name));
    }
    for (let i = 0; i < files.length; i += 64) {
      const sizes = await Promise.all(files.slice(i, i + 64).map((f) => fsp.stat(f).then((s) => s.size).catch(() => 0)));
      total += sizes.reduce((a, b) => a + b, 0);
    }
  }
  return total;
}

async function driveInfo(root) {
  const s = await fsp.statfs(root);
  return { root, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}
module.exports = { folderSize, driveInfo };
