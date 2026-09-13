'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Separate durable task records: writing a chat bubble is not a checkpoint. */
function createRunStore(root) {
  const hash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
  const location = (kind, id) => path.join(root, kind, `${hash(id)}.json`);
  function atomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.prev`);
    fs.renameSync(tmp, file);
  }
  function read(file) {
    for (const p of [file, `${file}.prev`]) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* try the last committed record */ }
    }
    return null;
  }
  return {
    save(record) {
      if (!record?.id || !record.conversationId || !record.answerId || !Array.isArray(record.state?.working)) {
        throw new Error('执行记录不完整，已暂停以避免丢失进度');
      }
      if (read(location('runs', record.id))?.deleted) return;
      atomic(location('runs', record.id), record);
    },
    list() {
      const dir = path.join(root, 'runs');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
        .map((f) => read(path.join(dir, f))).filter((r) => r?.id && !r.deleted);
    },
    remove(id) { atomic(location('runs', id), { id, deleted: true }); },
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
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
        .map((f) => read(path.join(dir, f))).filter((e) => e && (!runId || e.runId === runId))
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
