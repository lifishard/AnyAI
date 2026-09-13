'use strict';
/**
 * 桌面端的本地存储：
 *  - 普通配置 / 会话记录 明文存 userData/store.json
 *  - API Key 走 Electron safeStorage（Windows 用 DPAPI，macOS 用 Keychain，
 *    Linux 用 libsecret），加密后以 base64 存进同一个文件。
 *    系统不提供加密能力时降级为明文，并在 meta 里标记，UI 会提示。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

let filePath = null;
let document = null;
const { createDurableJson } = require('./durable-json.cjs');

/**
 * 应用改名（SenseNova Chat → AnyAI）会让 app.getPath('userData') 指向新目录，
 * 旧的配置、会话、密钥看起来就「凭空消失」了。这里做一次性搬迁。
 *
 * safeStorage 在 macOS / Linux 上依赖应用身份；文件复制不能保证跨名称解密。
 * wickrunAI 启动时保留 AnyAI 的内部身份和数据路径，避免再次触发这类迁移。
 */
const LEGACY_DIRS = ['SenseNova Chat', 'sensenova-chat', 'SenseNova-Chat'];

function migrateFromLegacy(target) {
  if (fs.existsSync(target)) return;
  const parent = path.dirname(path.dirname(target)); // …/Roaming
  for (const name of LEGACY_DIRS) {
    const candidate = path.join(parent, name, 'store.json');
    try {
      if (!fs.existsSync(candidate)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(candidate, target);
      console.log(`[store] 已从旧目录迁移配置：${candidate} → ${target}`);
      return;
    } catch (err) {
      throw new Error(`旧数据迁移失败，已停止写入：${err.message}`);
    }
  }
}

/**
 * Chrome 那份独立配置（登录状态就在里面）也要跟着搬。
 *
 * 不搬的话现象是：更新一次，工具里的浏览器就退成了未登录，所有需要登录态
 * 的页面全都读不了 —— 而用户完全不会把「应用更新」和「浏览器退登」联系起来。
 *
 * 用 rename 而不是拷贝：同一个卷上是原子的、瞬间完成；这个目录动辄几百兆，
 * 拷贝会让启动卡住好几秒。跨卷失败就放弃，不值得为它阻塞启动。
 */
function migrateChromeProfile(userDataDir) {
  const target = path.join(userDataDir, 'chrome-profile');
  if (fs.existsSync(target)) return;
  const parent = path.dirname(userDataDir);
  for (const name of LEGACY_DIRS) {
    const candidate = path.join(parent, name, 'chrome-profile');
    try {
      if (!fs.existsSync(candidate)) continue;
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.renameSync(candidate, target);
      console.log(`[store] 已搬迁 Chrome 配置（含登录态）：${candidate} → ${target}`);
      return;
    } catch (err) {
      console.error('[store] Chrome 配置搬迁失败（登录态可能需要重新登录）:', err);
    }
  }
}

function file() {
  if (!filePath) {
    const dir = app.getPath('userData');
    const target = path.join(dir, 'store.json');
    migrateFromLegacy(target);
    migrateChromeProfile(dir);
    filePath = target;
  }
  return filePath;
}

function read() {
  return doc().read();
}
function doc() {
  if (!document) document = createDurableJson(file(), {
    initial: () => ({ kv: {}, secrets: {} }),
    validate(value) {
      if (!value || !value.kv || !value.secrets || Array.isArray(value.kv) || Array.isArray(value.secrets) || typeof value.kv !== 'object' || typeof value.secrets !== 'object') throw new Error('存储结构不兼容');
    },
  });
  return document;
}
function flush() { /* Mutations now complete durable writes before returning. */ }

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

module.exports = {
  kvGet(key) {
    const v = read().kv[key];
    return v === undefined ? null : v;
  },
  kvSet(key, value) {
    doc().update((data) => { data.kv[key] = value; });
  },
  secretGet(id) {
    const rec = read().secrets[id];
    if (!rec) return null;
    if (rec.enc) {
      try {
        return safeStorage.decryptString(Buffer.from(rec.v, 'base64'));
      } catch (err) {
        throw new Error(`凭据无法解锁，原加密数据已保留：${err.message}`);
      }
    }
    return rec.v;
  },
  secretSet(id, value) {
    const rec = encryptionAvailable()
      ? { enc: true, v: safeStorage.encryptString(value).toString('base64') }
      : { enc: false, v: value };
    doc().update((data) => { data.secrets[id] = rec; });
  },
  secretDelete(id) {
    doc().update((data) => { delete data.secrets[id]; });
  },
  encryptionAvailable,
  flush,
  filePath: file,
};
