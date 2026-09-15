const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const attachments = require('../electron/attachments.cjs');
const remote = require('../electron/remote-server.cjs');
const { loader } = require('./load-ts.cjs');
const shared = loader()(path.join(__dirname, '..', 'src', 'lib', 'attachment-limits.ts'));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wickrun-attachments-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('attachment limits replace the old 1MB text cap and keep shared policy explicit', () => {
  assert.deepEqual(shared.ATTACHMENT_LIMITS, {
    textBytes: attachments.MAX_TEXT,
    imageBytes: attachments.MAX_IMAGE,
    batchBytes: attachments.MAX_BATCH,
  });
  assert.equal(shared.validateAttachmentSize('text', 2 * attachments.MIB), undefined);
  assert.match(shared.validateAttachmentBatch(shared.ATTACHMENT_LIMITS.batchBytes + 1), /100MB/);
  assert.equal(attachments.MAX_TEXT, 25 * attachments.MIB);
  assert.equal(attachments.MAX_IMAGE, 20 * attachments.MIB);
  assert.equal(attachments.MAX_BATCH, 100 * attachments.MIB);
  assert.equal(remote.MAX_REMOTE_BODY, attachments.MAX_BATCH);
  assert.equal(attachments.validateAttachmentSize('text', 2 * attachments.MIB), undefined);
  assert.match(attachments.validateAttachmentSize('text', attachments.MAX_TEXT + 1, 'large.txt'), /25MB/);
  assert.match(attachments.validateAttachmentSize('image', attachments.MAX_IMAGE + 1, 'large.png'), /20MB/);
  assert.equal(attachments.validateAttachmentBatch(attachments.MAX_BATCH), undefined);
  assert.match(attachments.validateAttachmentBatch(attachments.MAX_BATCH + 1), /100MB/);
});

test('file picker accepts text above the former 1MB limit and rejects over-bound files clearly', (t) => {
  const dir = tempDir(t);
  const accepted = path.join(dir, 'two-megabytes.txt');
  const tooLarge = path.join(dir, 'too-large.txt');
  fs.writeFileSync(accepted, Buffer.alloc(2 * attachments.MIB, 0x78));
  fs.writeFileSync(tooLarge, Buffer.alloc(attachments.MAX_TEXT + 1, 0x78));

  const [ok, bad] = attachments.readFiles([accepted, tooLarge]);
  assert.equal(ok.kind, 'text');
  assert.equal(ok.size, 2 * attachments.MIB);
  assert.equal(ok.text.length, 2 * attachments.MIB);
  assert.match(bad.error, /25MB/);
  assert.doesNotMatch(bad.error, /1MB/);
});

test('a batch over 100MB reports the offending item before reading it', (t) => {
  const dir = tempDir(t);
  const files = Array.from({ length: 4 }, (_, i) => path.join(dir, `part-${i}.txt`));
  const rejectedPath = path.join(dir, 'rejected.txt');
  // Four valid 25MB files fill the 100MB batch budget. The fifth file is then
  // rejected during the size preflight, before its contents are read.
  for (const file of files) fs.writeFileSync(file, Buffer.alloc(attachments.MAX_TEXT, 0x78));
  fs.writeFileSync(rejectedPath, Buffer.alloc(2 * attachments.MIB, 0x78));
  const results = attachments.readFiles([...files, rejectedPath]);
  assert.equal(results[0].kind, 'text');
  const rejected = results.at(-1);
  assert.match(rejected.error, /100MB/);
  assert.match(rejected.error, /分批/);
  assert.equal(rejected.text, undefined);
});
