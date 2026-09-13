'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOTS = ['store.json', 'store.json.prev', 'collaboration-v1.json', 'collaboration-v1.json.prev', 'runtime-v2', 'attachments', 'team-files'];
const DIRS = new Set(['runtime-v2', 'attachments', 'team-files']);
const LIMITS = Object.freeze({ files: 5000, fileBytes: 32 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, bundleBytes: 150 * 1024 * 1024 });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const idPattern = /^[0-9a-f-]{36}$/;
function requireValue(value, message) { if (!value) throw new Error(message); }
function validRelative(value) {
  requireValue(typeof value === 'string' && value.length <= 700, '备份路径无效');
  const parts = value.split('/');
  requireValue(parts.every(p => p && p !== '.' && p !== '..' && !/[<>:"\\|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), '备份路径不安全');
  requireValue(ROOTS.includes(parts[0]) && (parts.length === 1 ? !DIRS.has(parts[0]) : DIRS.has(parts[0])), '备份包含非托管路径');
  return value;
}
const sensitive = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|password|client[_-]?secret|secret|token|cookie|set-cookie)$/i;
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive.test(key)).map(([key, child]) => [key, scrub(child)]));
  return value;
}
function sanitizeStore(bytes, mode) {
  const data = JSON.parse(bytes.toString('utf8'));
  requireValue(data && typeof data === 'object' && data.kv && !Array.isArray(data.kv) && typeof data.kv === 'object' && data.secrets && !Array.isArray(data.secrets) && typeof data.secrets === 'object', 'store.json 结构无效，原文件保留，请选其他备份恢复');
  let omittedCredentials = 0;
  const secrets = Object.create(null);
  for (const [id, rec] of Object.entries(data.secrets)) {
    if (mode === 'local' && rec?.enc === true && typeof rec.v === 'string') secrets[id] = { enc: true, v: rec.v };
    else omittedCredentials++;
  }
  const kv = Object.create(null);
  for (const [key, value] of Object.entries(data.kv)) {
    if (key === 'snc:remote:token' || sensitive.test(key)) { omittedCredentials++; continue; }
    if (typeof value === 'string') {
      try { kv[key] = JSON.stringify(scrub(JSON.parse(value))); } catch { kv[key] = value; }
    } else kv[key] = scrub(value);
  }
  return { bytes: Buffer.from(JSON.stringify({ ...scrub(data), kv, secrets })), omittedCredentials };
}
function metadata(bundle) {
  return { format: bundle.format, schemaVersion: bundle.schemaVersion, id: bundle.id, createdAt: bundle.createdAt, credentialMode: bundle.credentialMode,
    omittedCredentials: bundle.omittedCredentials, files: bundle.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) };
}

// All methods are synchronous: invoke in the main process, with one writer.
// Stop runners/schedulers before restore and restart before allowing more writes.
function createDataBackup(userData, { io = fs, fault = () => {} } = {}) {
  requireValue(path.isAbsolute(userData), '用户数据目录必须是绝对路径');
  const root = path.resolve(userData), backupRoot = path.join(root, 'backups-v1');
  const active = path.join(backupRoot, 'active-restore.json');
  let restartRequired = false, recoveryError = null;
  function safe(target) {
    const relative = path.relative(root, target);
    requireValue(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), '路径超出用户数据目录');
    let current = root;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      try { requireValue(!io.lstatSync(current).isSymbolicLink(), '备份和恢复禁止符号链接'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return target;
  }
  function exists(file) { safe(file); return io.existsSync(file); }
  function mkdir(dir) { safe(dir); io.mkdirSync(dir, { recursive: true }); }
  function atomic(file, bytes) {
    safe(file); mkdir(path.dirname(file)); const tmp = file + '.' + crypto.randomUUID() + '.tmp'; let fd;
    try { fd = io.openSync(tmp, 'wx', 0o600); io.writeFileSync(fd, bytes); io.fsyncSync(fd); io.closeSync(fd); fd = undefined; io.renameSync(tmp, file); }
    finally { if (fd !== undefined) io.closeSync(fd); if (io.existsSync(tmp)) io.unlinkSync(tmp); }
  }
  function readLimited(file, limit = LIMITS.bundleBytes) {
    safe(file); const stat = io.lstatSync(file); requireValue(stat.isFile() && stat.size <= limit, '备份文件类型或大小超出限制');
    const bytes = io.readFileSync(file); requireValue(bytes.length <= limit, '读取期间文件大小超出限制'); return bytes;
  }
  function walk(base, relative = '', collected = []) {
    if (relative.includes('/')) validRelative(relative);
    safe(base); const stat = io.lstatSync(base);
    requireValue(stat.isDirectory() || stat.isFile(), '托管目录内存在不支持的文件类型');
    if (stat.isFile()) {
      validRelative(relative); requireValue(stat.size <= LIMITS.fileBytes, '单文件超过备份大小限制');
      collected.push(relative); requireValue(collected.length <= LIMITS.files, '备份文件数量超过限制');
    } else {
      for (const name of io.readdirSync(base).sort()) {
        if (name.endsWith('.tmp')) continue;
        walk(path.join(base, name), relative ? relative + '/' + name : name, collected);
      }
    }
    return collected;
  }
  function inventory() {
    const files = [];
    for (const name of ROOTS) {
      const file = path.join(root, name);
      if (!exists(file)) continue;
      const stat = io.lstatSync(file);
      requireValue(DIRS.has(name) ? stat.isDirectory() : stat.isFile(), '托管路径类型不兼容');
      walk(file, name, files);
    }
    return files.sort();
  }
  function validateBundle(input) {
    let bytes;
    if (input && typeof input.id === 'string') {
      requireValue(idPattern.test(input.id), '备份编号无效'); bytes = readLimited(path.join(backupRoot, input.id + '.json'));
    } else {
      requireValue(input && typeof input.bundle === 'string', '请选择备份或提供备份文本');
      requireValue(Buffer.byteLength(input.bundle) <= LIMITS.bundleBytes, '备份体积超过限制'); bytes = Buffer.from(input.bundle);
    }
    const bundle = JSON.parse(bytes.toString('utf8'));
    requireValue(bundle?.format === 'wickrunAI-data-backup' && bundle.schemaVersion === 1 && idPattern.test(bundle.id) && Number.isFinite(Date.parse(bundle.createdAt)) && ['local-encrypted', 'credentials-omitted'].includes(bundle.credentialMode) && Number.isSafeInteger(bundle.omittedCredentials) && bundle.omittedCredentials >= 0, '备份格式或版本不支持');
    requireValue(Array.isArray(bundle.files) && bundle.files.length <= LIMITS.files, '备份文件数量超过限制');
    let totalBytes = 0; const names = new Set(), decoded = [];
    for (const entry of bundle.files) {
      validRelative(entry.path); const key = entry.path.toLowerCase();
      requireValue(!names.has(key), '备份包含重复路径'); names.add(key);
      requireValue(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= LIMITS.fileBytes && typeof entry.data === 'string' && entry.data.length === Math.ceil(entry.size / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(entry.data), '备份文件编码或大小无效');
      totalBytes += entry.size; requireValue(totalBytes <= LIMITS.totalBytes, '备份解码总大小超过限制');
      const content = Buffer.from(entry.data, 'base64');
      requireValue(content.length === entry.size && content.toString('base64') === entry.data && hash(content) === entry.sha256, '备份文件 SHA256 校验失败');
      if (entry.path === 'store.json' || entry.path === 'store.json.prev') {
        const sanitized = sanitizeStore(content, bundle.credentialMode === 'local-encrypted' ? 'local' : 'export');
        requireValue(sanitized.omittedCredentials === 0, '导入备份包含不允许的明文凭据');
        // Imported data must be equally safe, not only exports produced here.
        requireValue(JSON.stringify(JSON.parse(content)) === sanitized.bytes.toString(), '导入备份包含未过滤的认证字段');
      } else if (entry.path === 'collaboration-v1.json') {
        const value = JSON.parse(content); requireValue(value?.schemaVersion === 1 && value.projects && typeof value.projects === 'object' && !Array.isArray(value.projects), '协作备份结构无效');
      }
      decoded.push({ path: entry.path, bytes: content });
    }
    for (const name of names) { const parts = name.split('/'); while (parts.length > 1) { parts.pop(); requireValue(!names.has(parts.join('/')), '备份路径文件与目录冲突'); } }
    requireValue(hash(JSON.stringify(metadata(bundle))) === bundle.manifestSha256, '备份清单 SHA256 校验失败');
    return { bundle, decoded, totalBytes };
  }
  function summary(value) {
    return { id: value.bundle.id, createdAt: value.bundle.createdAt, fileCount: value.bundle.files.length, totalBytes: value.totalBytes,
      credentialMode: value.bundle.credentialMode, omittedCredentials: value.bundle.omittedCredentials, verified: true,
      credentialNotice: '加密凭据仅可能在原设备及原系统身份解锁；跨设备需要重新登录。用户附件和对话内容仍可能包含敏感信息。' };
  }
  function journalLocation(id) { requireValue(idPattern.test(id), '恢复事务编号无效'); return path.join(backupRoot, 'restore-' + id); }
  function readJournal(id) {
    const dir = journalLocation(id), journal = JSON.parse(readLimited(path.join(dir, 'journal.json'), 8 * 1024 * 1024));
    requireValue(journal.id === id && ['prepared', 'applying', 'committed', 'rolled_back'].includes(journal.phase) && Array.isArray(journal.entries) && journal.entries.length === ROOTS.length && journal.entries.every((entry, i) => entry.root === ROOTS[i] && typeof entry.hadOriginal === 'boolean') && Array.isArray(journal.beforeFiles) && journal.beforeFiles.length <= LIMITS.files, '恢复事务日志损坏，需要保留现场人工恢复');
    for (const file of journal.beforeFiles) { validRelative(file.path); requireValue(/^[a-f0-9]{64}$/.test(file.sha256), '恢复原件校验信息损坏'); }
    return { dir, journal };
  }
  function saveJournal(dir, journal) { atomic(path.join(dir, 'journal.json'), JSON.stringify(journal)); }
  function inspectTree(file) {
    safe(file); const stat = io.lstatSync(file); requireValue(stat.isFile() || stat.isDirectory(), '恢复路径类型无效');
    if (stat.isDirectory()) for (const name of io.readdirSync(file)) inspectTree(path.join(file, name));
  }
  function move(from, to) { safe(from); safe(to); inspectTree(from); mkdir(path.dirname(to)); io.renameSync(from, to); }
  function rollback(dir, journal) {
    // Preserve both the original data and any partial replacement. Never delete
    // an existing user-data tree to complete or undo a transaction.
    for (const entry of journal.entries) {
      const live = path.join(root, entry.root), before = path.join(dir, 'before', entry.root);
      if (exists(before)) {
        for (const file of journal.beforeFiles.filter(file => file.path === entry.root || file.path.startsWith(entry.root + '/'))) {
          requireValue(hash(readLimited(path.join(dir, 'before', file.path), LIMITS.fileBytes)) === file.sha256, '恢复前原件校验失败，保留现场');
        }
        if (exists(live)) move(live, path.join(dir, 'rejected', crypto.randomUUID(), entry.root));
        move(before, live);
      } else if (!entry.hadOriginal && exists(live)) move(live, path.join(dir, 'rejected', crypto.randomUUID(), entry.root));
      fault('rollback-root', { root: entry.root });
    }
    journal.phase = 'rolled_back'; saveJournal(dir, journal);
    if (exists(active)) io.unlinkSync(active);
  }
  function recoverPending() {
    if (!exists(active)) return;
    const pointer = JSON.parse(readLimited(active, 1000)); const { dir, journal } = readJournal(pointer.id);
    if (journal.phase === 'committed' || journal.phase === 'rolled_back') { io.unlinkSync(active); return; }
    rollback(dir, journal);
  }
  try { recoverPending(); } catch (error) { recoveryError = error.message; }
  function ready() { requireValue(!restartRequired, '恢复已完成，请先重新启动应用'); requireValue(!recoveryError, '中断恢复未完成：' + recoveryError); requireValue(!exists(active), '存在未完成恢复事务'); }

  // Restoring bytes creates new managed directory identities. Rebind only the
  // exact work trees declared in the verified archive, inside this transaction.
  // External project roots and their identities are deliberately never changed.
  function rebindRestoredFileSessions(selected) {
    const manifest = new Map(selected.decoded.map(item => [item.path, item]));
    const main = manifest.get('team-files/sessions.json');
    if (!main) return;
    const rebound = new Map();
    const split = value => String(value || '').replace(/\\/g, '/').split('/');
    function checkedManifest(relative) {
      const item = manifest.get(relative); requireValue(item, '恢复身份记录缺少已校验清单');
      const file = path.join(root, relative);
      requireValue(hash(readLimited(file, LIMITS.fileBytes)) === hash(item.bytes), '恢复身份重绑前文件已变化');
      return { item, file };
    }
    function rebindIndex(relative, isMain) {
      const { item, file } = checkedManifest(relative), value = JSON.parse(item.bytes.toString('utf8'));
      requireValue(value?.version === 1 && value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions), '恢复隔离记录结构无效');
      for (const [id, record] of Object.entries(value.sessions)) {
        const suffix = split(record.isolatedRoot).slice(-3);
        requireValue(idPattern.test(id) && record.id === id && suffix[0] === 'team-files' && suffix[1] === id && suffix[2] === 'work' && record.isolatedIdentity, '恢复隔离目录身份或托管布局无效');
        const prefix = `team-files/${id}/work/`, work = path.join(root, 'team-files', id, 'work');
        for (const name of manifest.keys()) if (name.startsWith(prefix)) checkedManifest(name);
        // Empty work trees have no file entries; the verified session record is
        // their declaration. The constructed destination cannot name any root
        // outside this managed session, even for an imported archive.
        mkdir(work); safe(work);
        const stat = io.statSync(work); requireValue(stat.isDirectory(), '恢复隔离路径不是目录');
        record.isolatedRoot = work;
        record.isolatedIdentity = { realPath: io.realpathSync.native(work), dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: stat.birthtimeMs };
        record.restoredFromBackup = selected.bundle.id;
        if (isMain) rebound.set(id, record);
      }
      atomic(file, JSON.stringify(value));
    }
    rebindIndex('team-files/sessions.json', true);
    if (manifest.has('team-files/sessions.json.prev')) rebindIndex('team-files/sessions.json.prev', false);
    for (const [relative] of manifest) {
      const match = /^team-files\/([0-9a-f-]{36})\/(?:merge|merge-history-[0-9a-f-]{36})\.json(?:\.prev)?$/.exec(relative);
      if (!match || !rebound.has(match[1])) continue;
      const { item, file } = checkedManifest(relative), journal = JSON.parse(item.bytes.toString('utf8')), suffix = split(journal.rollbackRoot).slice(-3);
      requireValue(journal.id === match[1] && suffix[0] === 'team-files' && suffix[1] === match[1] && /^pre-merge-[0-9a-f-]{36}$/.test(suffix[2]), '恢复合并日志的托管备份路径无效');
      journal.rollbackRoot = path.join(root, 'team-files', match[1], suffix[2]);
      atomic(file, JSON.stringify(journal));
    }
    for (const relative of ['collaboration-v1.json', 'collaboration-v1.json.prev']) {
      if (!manifest.has(relative)) continue;
      const { item, file } = checkedManifest(relative), value = JSON.parse(item.bytes.toString('utf8'));
      for (const project of Object.values(value.projects || {})) for (const entry of project.files || []) {
        const record = rebound.get(entry.id);
        if (record && record.projectId === project.id && record.taskId === entry.taskId && record.memberId === entry.memberId) entry.isolatedRoot = record.isolatedRoot;
      }
      atomic(file, JSON.stringify(value));
    }
    fault('managed-identities-rebound', {});
  }

  return {
    get recoveryError(){return recoveryError;},
    status() {
      const problems = [];
      for (const name of ['store.json', 'collaboration-v1.json']) {
        try { const file = path.join(root, name); if (exists(file)) JSON.parse(readLimited(file, LIMITS.fileBytes)); }
        catch (error) { problems.push({ file: name, error: error.message }); }
      }
      return { format: 'wickrunAI-data-backup', recoveryAvailable: true, recoveryError, restartRequired, problems, limits: LIMITS,
        managedRoots: [...ROOTS], attachments: '当前附件内联在会话中；可选 attachments 目录也纳入备份，不读取外部原路径。' };
    },
    list() {
      if (!exists(backupRoot)) return [];
      const names = io.readdirSync(backupRoot);
      const bundles = names.filter(name => idPattern.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).map(name => {
        const id = name.slice(0, -5);
        try { return summary(validateBundle({ id })); } catch (error) { return { id, verified: false, error: error.message }; }
      });
      const history = names.filter(name => name.startsWith('restore-') && idPattern.test(name.slice(8))).map(name => {
        const id = name.slice(8);
        try { const { journal } = readJournal(id); return { id, kind: 'before-restore', createdAt: journal.createdAt, phase: journal.phase, recoveryOnly: true, fileCount: journal.beforeFiles.length }; }
        catch (error) { return { id, kind: 'before-restore', recoveryOnly: true, error: error.message }; }
      });
      return [...bundles, ...history].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    create({ mode = 'local' } = {}) {
      ready(); requireValue(['local', 'export'].includes(mode), '备份模式无效');
      const paths = inventory(), originals = [], files = []; let totalBytes = 0, omittedCredentials = 0;
      for (const name of paths) {
        const raw = readLimited(path.join(root, name), LIMITS.fileBytes); originals.push({ name, sha: hash(raw) }); let bytes = raw;
        if (name === 'store.json' || name === 'store.json.prev') {
          const sanitized = sanitizeStore(raw, mode); bytes = sanitized.bytes; omittedCredentials += sanitized.omittedCredentials;
        }
        totalBytes += bytes.length; requireValue(totalBytes <= LIMITS.totalBytes && bytes.length <= LIMITS.fileBytes, '备份大小超过限制');
        files.push({ path: name, size: bytes.length, sha256: hash(bytes), data: bytes.toString('base64') });
      }
      fault('snapshot-read', {});
      requireValue(JSON.stringify(paths) === JSON.stringify(inventory()) && originals.every(item => hash(readLimited(path.join(root, item.name), LIMITS.fileBytes)) === item.sha), '快照期间数据已变化，请暂停运行后重试');
      const bundle = { format: 'wickrunAI-data-backup', schemaVersion: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), credentialMode: mode === 'local' ? 'local-encrypted' : 'credentials-omitted', omittedCredentials, files };
      bundle.manifestSha256 = hash(JSON.stringify(metadata(bundle))); const text = JSON.stringify(bundle);
      requireValue(Buffer.byteLength(text) <= LIMITS.bundleBytes, '备份体积超过限制');
      const verified = validateBundle({ bundle: text }); atomic(path.join(backupRoot, bundle.id + '.json'), text);
      return { ...summary(verified), ...(mode === 'export' ? { bundle: text } : {}) };
    },
    preview(input) { return { ...summary(validateBundle(input)), replacesManagedData: true, restartRequired: true }; },
    restore(input) {
      ready(); const selected = validateBundle(input), id = crypto.randomUUID(), dir = journalLocation(id);
      // Preflight every current managed tree, even damaged JSON. Damaged bytes
      // remain recoverable in the before directory and are never exported.
      const entries = ROOTS.map(name => { const file = path.join(root, name), hadOriginal = exists(file); if (hadOriginal) inspectTree(file); return { root: name, hadOriginal }; });
      const beforeFiles = inventory().map(name => ({ path: name, sha256: hash(readLimited(path.join(root, name), LIMITS.fileBytes)) }));
      const journal = { id, backupId: selected.bundle.id, phase: 'prepared', createdAt: new Date().toISOString(), entries, beforeFiles };
      mkdir(dir);
      for (const item of selected.decoded) atomic(path.join(dir, 'after', item.path), item.bytes);
      saveJournal(dir, journal); atomic(active, JSON.stringify({ id }));
      try {
        journal.phase = 'applying'; saveJournal(dir, journal);
        for (const entry of entries) {
          if (entry.hadOriginal) move(path.join(root, entry.root), path.join(dir, 'before', entry.root));
          fault('original-moved', { root: entry.root });
        }
        // Only start replacement after the complete original snapshot is held.
        for (const entry of entries) {
          const staged = path.join(dir, 'after', entry.root);
          if (exists(staged)) move(staged, path.join(root, entry.root));
          fault('replacement-installed', { root: entry.root });
        }
        rebindRestoredFileSessions(selected);
        journal.phase = 'committed'; saveJournal(dir, journal); io.unlinkSync(active);
        restartRequired = true;
        return { restored: true, restartRequired: true, backupId: selected.bundle.id, beforeRestoreId: id, retainedHistory: true };
      } catch (error) {
        try { rollback(dir, journal); } catch (rollbackError) { recoveryError = rollbackError.message; throw new Error('恢复失败，自动回滚未完成。必须停止写入并重启恢复入口：' + recoveryError); }
        throw new Error('恢复失败，原数据已还原：' + error.message);
      }
    },
  };
}
module.exports = { createDataBackup, LIMITS };
