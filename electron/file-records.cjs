'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { guardPath } = require('./tools/common.cjs');

function inspectFile(candidate, roots, direction = 'output') {
  const allowed = guardPath(candidate, roots, { mustExist: true });
  const p = fs.realpathSync.native(allowed);
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error(`${p} 不是文件`);
  return { path: p, name: path.basename(p), size: st.size, direction,
    verifiedAt: Date.now(), modifiedAt: st.mtimeMs };
}
function verifyFiles(paths, roots, direction = 'output') {
  const files = [], errors = [];
  for (const p of [...new Set(paths)].slice(0, 30)) {
    try { files.push(inspectFile(p, roots, direction)); }
    catch (err) { errors.push({ path: p, error: err.message }); }
  }
  return { files, errors };
}
module.exports = { inspectFile, verifyFiles };
