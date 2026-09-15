'use strict';
/**
 * 让用户挑文件/图片带进对话。读取在主进程做 —— 渲染进程没有 fs。
 */
const fs = require('node:fs');
const path = require('node:path');

const TEXT_EXT = new Set([
  '.ics', '.ical', '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv', '.json', '.jsonl',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.php', '.lua',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.r', '.m', '.jl',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.xml', '.svg',
  '.gitignore', '.dockerfile', '.makefile',
]);

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

// Keep these limits in step with src/lib/attachment-limits.ts.  The renderer
// and native clients use the same values when they accept pasted/remote files.
const MIB = 1024 * 1024;
const MAX_TEXT = 25 * MIB;
const MAX_IMAGE = 20 * MIB;
const MAX_BATCH = 100 * MIB;

function limitLabel(bytes) {
  return `${Math.round(bytes / MIB)}MB`;
}

function validateAttachmentSize(kind, size, name = '附件') {
  const max = kind === 'image' ? MAX_IMAGE : MAX_TEXT;
  if (!Number.isFinite(size) || size < 0) return `${name} 大小无效。`;
  if (size <= max) return undefined;
  return `${name} 有 ${(size / MIB).toFixed(1)}MB，超过${kind === 'image' ? '图片' : '文本'}附件 ${limitLabel(max)} 上限。请分批或压缩后重试。`;
}

function validateAttachmentBatch(totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) return '附件总大小无效。';
  if (totalBytes <= MAX_BATCH) return undefined;
  return `本次附件合计 ${(totalBytes / MIB).toFixed(1)}MB，超过 ${limitLabel(MAX_BATCH)} 总上限。请分批添加。`;
}

function readOne(p) {
  const name = path.basename(p);
  const ext = path.extname(p).toLowerCase();
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch (e) {
    return { error: `读不到 ${name}：${e.message}` };
  }

  if (IMAGE_MIME[ext]) {
    const error = validateAttachmentSize('image', size, name);
    if (error) return { error };
    const b64 = fs.readFileSync(p).toString('base64');
    return {
      kind: 'image',
      name,
      mime: IMAGE_MIME[ext],
      size,
      dataUrl: `data:${IMAGE_MIME[ext]};base64,${b64}`,
    };
  }

  const sizeError = validateAttachmentSize('text', size, name);
  if (sizeError) return { error: sizeError };

  const looksText = TEXT_EXT.has(ext) || TEXT_EXT.has(name.toLowerCase()) || ext === '';
  const buf = fs.readFileSync(p);

  // 出现 NUL 字节基本就是二进制，别硬塞给模型
  if (!looksText || buf.includes(0)) {
    return { error: `${name} 不是文本也不是支持的图片格式，带不进对话。` };
  }

  return {
    kind: 'text',
    name,
    mime: 'text/plain',
    size,
    text: buf.toString('utf8'),
  };
}

function readFiles(paths) {
  const out = [];
  let batchBytes = 0;
  for (const p of paths || []) {
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      // readOne returns the detailed, user-facing read error below.
    }
    if (size && validateAttachmentBatch(batchBytes + size)) {
      out.push({
        path: p,
        error: `本次选择的附件已超过 ${limitLabel(MAX_BATCH)} 总上限，未读取 ${path.basename(p)}。请分批添加。`,
      });
      continue;
    }
    const r = readOne(p);
    out.push(Object.assign({ path: p }, r));
    if (!r.error) batchBytes += size;
  }
  return out;
}

module.exports = {
  readFiles,
  TEXT_EXT,
  IMAGE_MIME,
  MIB,
  MAX_TEXT,
  MAX_IMAGE,
  MAX_BATCH,
  limitLabel,
  validateAttachmentSize,
  validateAttachmentBatch,
};
