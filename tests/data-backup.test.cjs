'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createDataBackup, LIMITS } = require('../electron/data-backup.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wickrun-backup-test-'));
  t.after(() => { assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(dir).startsWith('wickrun-backup-test-')); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function write(root, name, value) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
function seed(root, label = 'old') {
  write(root, 'store.json', { kv: { conversation: JSON.stringify({ text: label, dataUrl: 'data:fixture-inline-attachment' }), 'snc:remote:token': 'fixture-local-token' }, secrets: { encrypted: { enc: true, v: 'Zml4dHVyZQ==' }, plain: { enc: false, v: 'fixture-plain-key' } } });
  write(root, 'collaboration-v1.json', { schemaVersion: 1, projects: { fixture: { name: label } } });
  write(root, 'runtime-v2/runs/one.json', { id: label }); write(root, 'attachments/a.txt', label + ' attachment');
}
function current(root) {
  return Object.fromEntries(['store.json', 'collaboration-v1.json', 'runtime-v2/runs/one.json', 'attachments/a.txt'].map(name => [name, fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8') : null]));
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function resign(bundle) {
  const metadata = { format: bundle.format, schemaVersion: bundle.schemaVersion, id: bundle.id, createdAt: bundle.createdAt, credentialMode: bundle.credentialMode, omittedCredentials: bundle.omittedCredentials, files: bundle.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) };
  bundle.manifestSha256 = digest(JSON.stringify(metadata)); return JSON.stringify(bundle);
}
test('local snapshot covers all managed data and retains encrypted credentials only', t => {
  const dir = fixture(t); seed(dir); const api = createDataBackup(dir), saved = api.create();
  assert.equal(saved.fileCount, 4); assert.equal(saved.omittedCredentials, 2); assert.equal(api.preview({ id: saved.id }).verified, true);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'backups-v1', saved.id + '.json')));
  const store = JSON.parse(Buffer.from(doc.files.find(x => x.path === 'store.json').data, 'base64'));
  assert.deepEqual(store.secrets, { encrypted: { enc: true, v: 'Zml4dHVyZQ==' } });
  assert.equal(store.kv['snc:remote:token'], undefined); assert.match(store.kv.conversation, /fixture-inline-attachment/);
  assert.equal(api.list()[0].verified, true);
});
test('portable export omits credentials and nested known authentication fields', t => {
  const dir = fixture(t); seed(dir);
  const store = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'))); store.kv.settings = JSON.stringify({ apiKey: 'fixture-private', extraHeaders: { Authorization: 'fixture-private' }, name: 'keep' }); write(dir, 'store.json', store);
  const result = createDataBackup(dir).create({ mode: 'export' }); const bundle = JSON.parse(result.bundle);
  const data = Buffer.from(bundle.files.find(x => x.path === 'store.json').data, 'base64').toString();
  assert.equal(data.includes('fixture-private'), false); assert.equal(data.includes('fixture-plain-key'), false); assert.equal(data.includes('Zml4dHVyZQ=='), false);
  assert.deepEqual(JSON.parse(data).secrets, {});
});
test('restore replaces complete managed scope, retains originals, requires restart', t => {
  const dir = fixture(t); seed(dir, 'old'); const api = createDataBackup(dir), backup = api.create();
  seed(dir, 'new'); write(dir, 'runtime-v2/runs/extra.json', { extra: true }); const previous = current(dir);
  const result = api.restore({ id: backup.id }); assert.equal(result.restored, true); assert.equal(result.restartRequired, true);
  assert.equal(fs.existsSync(path.join(dir, 'runtime-v2/runs/extra.json')), false);
  const before = path.join(dir, 'backups-v1', 'restore-' + result.beforeRestoreId, 'before'); assert.deepEqual(current(before), previous);
  assert.throws(() => api.create(), /重新启动/);
  const restarted = createDataBackup(dir); assert.equal(restarted.status().recoveryError, null); assert.equal(restarted.list().some(x => x.kind === 'before-restore'), true);
});
test('failure after first replacement restores exact original bytes across all files', t => {
  const dir = fixture(t); seed(dir, 'old'); const saved = createDataBackup(dir).create(); seed(dir, 'new'); const previous = current(dir);
  let once = true; const api = createDataBackup(dir, { fault(point) { if (once && point === 'replacement-installed') { once = false; throw Error('injected write failure'); } } });
  assert.throws(() => api.restore({ id: saved.id }), /原数据已还原/); assert.deepEqual(current(dir), previous); assert.equal(api.status().recoveryError, null);
});
test('failure while moving originals rolls back without dropping unprocessed roots', t => {
  const dir = fixture(t); seed(dir, 'old'); const saved = createDataBackup(dir).create(); seed(dir, 'new'); const previous = current(dir);
  let once = true; const api = createDataBackup(dir, { fault(point) { if (once && point === 'original-moved') { once = false; throw Error('injected move failure'); } } });
  assert.throws(() => api.restore({ id: saved.id }), /原数据已还原/); assert.deepEqual(current(dir), previous);
});
test('interrupted rollback persists journal and next startup finishes recovery', t => {
  const dir = fixture(t); seed(dir, 'old'); const saved = createDataBackup(dir).create(); seed(dir, 'new'); const previous = current(dir);
  const api = createDataBackup(dir, { fault(point) { if (point === 'replacement-installed' || point === 'rollback-root') throw Error('injected interruption'); } });
  assert.throws(() => api.restore({ id: saved.id }), /自动回滚未完成/); assert.ok(api.status().recoveryError);
  assert.equal(fs.existsSync(path.join(dir, 'backups-v1/active-restore.json')), true);
  const next = createDataBackup(dir); assert.equal(next.status().recoveryError, null); assert.deepEqual(current(dir), previous);
  assert.equal(fs.existsSync(path.join(dir, 'backups-v1/active-restore.json')), false);
});
test('corrupt primary does not block recovery entry and its original bytes survive', t => {
  const dir = fixture(t); seed(dir); const saved = createDataBackup(dir).create(); write(dir, 'store.json', '{broken');
  const api = createDataBackup(dir); assert.equal(api.status().problems.length, 1); assert.equal(api.list()[0].verified, true); assert.equal(api.preview({ id: saved.id }).verified, true);
  const result = api.restore({ id: saved.id }); assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'store.json'))));
  assert.equal(fs.readFileSync(path.join(dir, 'backups-v1', 'restore-' + result.beforeRestoreId, 'before/store.json'), 'utf8'), '{broken');
});
test('payload and manifest corruption rejected without changing current state', t => {
  const dir = fixture(t); seed(dir); const api = createDataBackup(dir), exported = api.create({ mode: 'export' }); const previous = current(dir);
  const bundle = JSON.parse(exported.bundle); bundle.files[0].data = Buffer.from('evil').toString('base64');
  assert.throws(() => api.restore({ bundle: JSON.stringify(bundle) })); assert.deepEqual(current(dir), previous);
  const other = JSON.parse(exported.bundle); other.createdAt = '2001-01-01T00:00:00Z'; assert.throws(() => api.preview({ bundle: JSON.stringify(other) }), /清单/);
});
test('traversal, alternate streams, case duplicates, reserved names and unbounded payload are rejected', t => {
  const dir = fixture(t); seed(dir); const api = createDataBackup(dir), text = api.create({ mode: 'export' }).bundle;
  for (const invalid of ['../outside', 'runtime-v2/../outside', 'attachments/a:stream', 'attachments/CON.txt', 'attachments/x.', 'C:/outside', 'attachments\\outside']) {
    const bundle = JSON.parse(text); bundle.files[0].path = invalid; assert.throws(() => api.preview({ bundle: resign(bundle) }));
  }
  const duplicate = JSON.parse(text); duplicate.files.push({ ...duplicate.files.find(x => x.path === 'attachments/a.txt'), path: 'attachments/A.txt' }); assert.throws(() => api.preview({ bundle: resign(duplicate) }), /重复/);
  const bomb = JSON.parse(text); bomb.files[0].size = LIMITS.fileBytes + 1; assert.throws(() => api.preview({ bundle: resign(bomb) }), /大小/);
});
test('symlink managed directories and backup directory are never followed', t => {
  const dir = fixture(t), outside = fixture(t); seed(dir); write(outside, 'untouched.txt', 'fixture');
  fs.renameSync(path.join(dir, 'attachments'), path.join(dir, 'attachments-original'));
  fs.symlinkSync(outside, path.join(dir, 'attachments'), 'junction');
  assert.throws(() => createDataBackup(dir).create(), /符号链接/); assert.equal(fs.readFileSync(path.join(outside, 'untouched.txt'), 'utf8'), 'fixture');
  fs.unlinkSync(path.join(dir, 'attachments')); fs.symlinkSync(outside, path.join(dir, 'backups-v1'), 'junction');
  assert.ok(createDataBackup(dir).status().recoveryError); assert.throws(() => createDataBackup(dir).create());
});
test('external change during snapshot is detected instead of reporting a consistent backup', t => {
  const dir = fixture(t); seed(dir); const api = createDataBackup(dir, { fault(point) { if (point === 'snapshot-read') write(dir, 'attachments/a.txt', 'changed'); } });
  assert.throws(() => api.create(), /数据已变化/); assert.deepEqual(api.list(), []);
});
test('backup preparation write failure leaves live originals untouched', t => {
  const dir = fixture(t); seed(dir); const saved = createDataBackup(dir).create(); seed(dir, 'new'); const previous = current(dir);
  const io = Object.create(fs); io.renameSync = (a, b) => { if (b.includes(path.sep + 'after' + path.sep)) throw Error('disk failure'); return fs.renameSync(a, b); };
  assert.throws(() => createDataBackup(dir, { io }).restore({ id: saved.id }), /disk failure/); assert.deepEqual(current(dir), previous);
});
test('real process crash between replacements recovers original state at next startup', t => {
  const dir = fixture(t); seed(dir, 'old'); const saved = createDataBackup(dir).create(); seed(dir, 'new'); const previous = current(dir);
  const script = "const {createDataBackup}=require(process.argv[1]); const api=createDataBackup(process.argv[2],{fault(point){if(point==='replacement-installed')process.exit(73)}});api.restore({id:process.argv[3]});";
  const crashed = spawnSync(process.execPath, ['-e', script, path.resolve(__dirname, '../electron/data-backup.cjs'), dir, saved.id], { shell: false, windowsHide: true, encoding: 'utf8' });
  assert.equal(crashed.status, 73, crashed.stderr); assert.equal(fs.existsSync(path.join(dir, 'backups-v1/active-restore.json')), true);
  const recovered = createDataBackup(dir); assert.equal(recovered.status().recoveryError, null); assert.deepEqual(current(dir), previous);
});
test('actual installation rename failure rolls back every managed root', t => {
  const dir = fixture(t); seed(dir, 'old'); const saved = createDataBackup(dir).create(); seed(dir, 'new'); const previous = current(dir);
  let once = true; const io = Object.create(fs); io.renameSync = (from, to) => {
    if (once && from.includes(path.sep + 'after' + path.sep) && to === path.join(dir, 'collaboration-v1.json')) { once = false; throw Object.assign(Error('simulated EIO'), { code: 'EIO' }); }
    return fs.renameSync(from, to);
  };
  assert.throws(() => createDataBackup(dir, { io }).restore({ id: saved.id }), /原数据已还原/); assert.deepEqual(current(dir), previous);
});
test('team file sessions, isolated work and merge journals are backed up and restored together', t => {
  const dir = fixture(t),source=fixture(t); seed(dir);write(source,'output.txt','before');
  const {createTeamFiles}=require('../electron/team-files.cjs');
  const session=createTeamFiles(dir).create({projectId:'p',taskId:'r',memberId:'m',root:source},[source]);
  const mergePath=`team-files/${session.id}/merge.json`;
  write(dir,mergePath,{id:session.id,state:'prepared',files:[],rollbackRoot:path.join(dir,'team-files',session.id,'pre-merge-'+crypto.randomUUID())});
  const api = createDataBackup(dir), saved = api.create(); assert.equal(saved.fileCount, 7);
  fs.writeFileSync(path.join(session.isolatedRoot,'output.txt'),'after');
  api.restore({ id: saved.id });
  assert.equal(fs.readFileSync(path.join(session.isolatedRoot,'output.txt'),'utf8'),'before');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,mergePath))).state,'prepared');
  const restored=createTeamFiles(dir);assert.equal(restored.get(session.id).recoveryRequired,true);
  assert.equal(restored.recover(session.id).recoveryRequired,false);
});
