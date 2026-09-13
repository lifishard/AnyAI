'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** One main-process writer. Never treat an existing unreadable file as new data. */
function createDurableJson(file, { initial, validate = () => {}, io = fs } = {}) {
  let cache;
  let loadedHash;
  const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
  function read() {
    if (cache !== undefined) return structuredClone(cache);
    let raw;
    try { raw = io.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A missing primary with a backup indicates interrupted recovery, not first use.
      if (io.existsSync(file + '.prev')) throw new Error('主数据文件缺失，已有备份；请恢复备份后重试。');
      const value = initial(); validate(value); return value;
    }
    let value;
    try { value = JSON.parse(raw); validate(value); }
    catch (error) { throw new Error(`数据读取失败，原文件已保留：${file} (${error.message})`); }
    cache = value;
    loadedHash = hash(raw);
    return structuredClone(cache);
  }
  function write(value) {
    validate(value);
    const text = JSON.stringify(value);
    // Validate the current disk data before replacing it, including on a first write.
    read();
    if (cache !== undefined) {
      let current;
      try { current = hash(io.readFileSync(file, 'utf8')); } catch (error) { cache = undefined; loadedHash = undefined; throw error; }
      if (current !== loadedHash) { cache = undefined; loadedHash = undefined; throw new Error('数据文件被其他程序改动，已停止覆盖；请重新读取后合并修改。'); }
    }
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      fd = io.openSync(tmp, 'wx', 0o600);
      io.writeFileSync(fd, text, 'utf8'); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      if (io.existsSync(file)) {
        const prevTmp = tmp + '.prev';
        io.copyFileSync(file, prevTmp);
        const backupFd = io.openSync(prevTmp, 'r+');
        try { io.fsyncSync(backupFd); } finally { io.closeSync(backupFd); }
        io.renameSync(prevTmp, file + '.prev');
      }
      io.renameSync(tmp, file);
      cache = JSON.parse(text);
      loadedHash = hash(text);
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      try { io.unlinkSync(tmp); } catch { /* no unfinished temp */ }
      try { io.unlinkSync(tmp + '.prev'); } catch { /* no unfinished backup temp */ }
    }
    return structuredClone(cache);
  }
  return { read, write, update(fn) { const value = read(); fn(value); return write(value); },
    invalidate() { cache = undefined; loadedHash = undefined; }, file };
}
module.exports = { createDurableJson };
