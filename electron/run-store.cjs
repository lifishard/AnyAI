'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Separate durable task records: writing a chat bubble is not a checkpoint. */
function createRunStore(root, { io = fs } = {}) {
  const hash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
  const location = (kind, id) => path.join(root, kind, `${hash(id)}.json`);
  // A run is written by this process only. Keep the tombstone decision in
  // memory so streaming checkpoints do not parse the whole run on every
  // update. The first write still reads both the primary and its backup.
  const runDisposition = new Map();
  function atomic(file, value) {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const prev = `${file}.prev`;
    const fd = io.openSync(tmp, 'w', 0o600);
    try { io.writeFileSync(fd, JSON.stringify(value)); io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
    // Rotate on the same volume instead of copying the complete old record.
    // If the process stops between the two renames, read() can still recover
    // the previous committed record from .prev.
    let rotated = false;
    try {
      if (io.existsSync(file)) {
        try { io.unlinkSync(prev); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        io.renameSync(file, prev);
        rotated = true;
      }
      io.renameSync(tmp, file);
    } catch (error) {
      // Best-effort restoration keeps the primary available when a replace
      // fails after rotation. The normal reader also accepts .prev alone.
      if (rotated) {
        try { if (!io.existsSync(file)) io.renameSync(prev, file); } catch { /* retain .prev for recovery */ }
      }
      throw error;
    } finally {
      try { io.unlinkSync(tmp); } catch { /* no unfinished temp */ }
    }
  }
  function read(file) {
    for (const p of [file, `${file}.prev`]) {
      try { return JSON.parse(io.readFileSync(p, 'utf8')); } catch { /* try the last committed record */ }
    }
    return null;
  }
  function committedFiles(dir) {
    if (!io.existsSync(dir)) return [];
    const names = new Set();
    for (const name of io.readdirSync(dir)) {
      if (name.endsWith('.json')) names.add(name);
      else if (name.endsWith('.json.prev')) names.add(name.slice(0, -'.prev'.length));
    }
    return [...names].map((name) => path.join(dir, name));
  }
  return {
    save(record) {
      if (!record?.id || !record.conversationId || !record.answerId || !Array.isArray(record.state?.working)) {
        throw new Error('执行记录不完整，已暂停以避免丢失进度');
      }
      const runFile = location('runs', record.id);
      let disposition = runDisposition.get(record.id);
      if (disposition === undefined) {
        disposition = read(runFile)?.deleted ? 'deleted' : 'active';
        runDisposition.set(record.id, disposition);
      }
      if (disposition === 'deleted') return;
      atomic(runFile, record);
    },
    list() {
      const dir = path.join(root, 'runs');
      return committedFiles(dir).map((file) => read(file)).filter((r) => r?.id && !r.deleted);
    },
    remove(id) { atomic(location('runs', id), { id, deleted: true }); runDisposition.set(id, 'deleted'); },
    job(runId, callId) { return read(location('jobs', `${runId}:${callId}`)); },
    saveJob(runId, callId, value) { atomic(location('jobs', `${runId}:${callId}`), value); },
    saveResult(runId, callId, text) {
      const id = hash(`${runId}:${callId}`);
      atomic(location('results', id), { text: String(text), runId, at: Date.now() });
      return id;
    },
    readResult(id, offset = 0, limit = 8000) {
      const value = read(location('results', id));
      if (!value) throw new Error('找不到这份工具结果，请检查执行记录是否仍在本机');
      const start = Math.max(0, Number(offset) || 0);
      const count = Math.max(1, Math.min(16000, Number(limit) || 8000));
      return { text: value.text.slice(start, start + count), total: value.text.length,
        nextOffset: start + count < value.text.length ? start + count : null };
    },
    saveExchange(exchange) {
      if (!exchange?.requestId) throw new Error('缺少请求编号');
      atomic(location('exchanges', exchange.requestId), exchange);
    },
    exchanges(runId) {
      const dir = path.join(root, 'exchanges');
      return committedFiles(dir).map((file) => read(file)).filter((e) => e && (!runId || e.runId === runId))
        .sort((a, b) => a.at - b.at).slice(-100);
    },
  };
}
let cached;
function runtimeStore() {
  if (!cached) cached = createRunStore(path.join(require('electron').app.getPath('userData'), 'runtime-v2'));
  return cached;
}
module.exports = { createRunStore, runtimeStore };
