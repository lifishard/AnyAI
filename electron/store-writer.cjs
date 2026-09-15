'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

function errorFromWire(value) {
  const error = new Error(value?.message || '本地存储写入失败');
  if (value?.code) error.code = value.code;
  return error;
}

/**
 * A single serialized writer for store.json. The main process sends only a
 * key mutation; the worker owns parsing, serialization, external-change
 * detection and atomic backup rotation so a large conversation cannot block
 * Electron's event loop.
 */
function createStoreWriter(file, { workerPath = path.join(__dirname, 'store-writer-worker.cjs'), expectedHash } = {}) {
  let worker;
  let ready;
  let failed;
  let closed = false;
  let nextId = 1;
  let last = Promise.resolve();
  const pending = new Map();

  function rejectPending(error) {
    failed ||= error;
    for (const { reject } of pending.values()) reject(failed);
    pending.clear();
  }

  function start() {
    if (ready) return ready;
    worker = new Worker(workerPath, { workerData: { file, expectedHash } });
    ready = new Promise((resolve, reject) => {
      worker.once('error', (error) => {
        rejectPending(error);
        reject(error);
      });
      worker.once('exit', (code) => {
        if (!closed && !failed) {
          const error = new Error(`本地存储写入线程异常退出（${code}）`);
          rejectPending(error);
          reject(error);
        }
      });
      worker.on('message', (message) => {
        if (message.type === 'ready') { resolve(); return; }
        if (message.type === 'ready-error') {
          const error = errorFromWire(message.error);
          failed = error;
          rejectPending(error);
          reject(error);
          void worker.terminate();
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.type === 'ok') entry.resolve();
        else {
          const error = errorFromWire(message.error);
          rejectPending(error);
          entry.reject(error);
        }
      });
    });
    return ready;
  }

  function mutate({ scope, key, value, delete: remove = false }) {
    if (closed) return Promise.reject(new Error('本地存储写入器已关闭'));
    const task = start().then(() => {
      if (failed) throw failed;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ type: 'mutate', id, scope, key, value, delete: remove }); }
        catch (error) { pending.delete(id); rejectPending(error); reject(error); }
      });
    });
    last = task.catch(() => {});
    return task;
  }

  async function flush() {
    if (!ready) return;
    await ready;
    await last;
    if (failed) throw failed;
  }

  function close() {
    closed = true;
    if(pending.size)rejectPending(new Error('本地写入器在保存完成前被关闭'));
    if (worker) void worker.terminate();
  }

  return { mutate, flush, close };
}

module.exports = { createStoreWriter };
