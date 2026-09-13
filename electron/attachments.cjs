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

const MAX_TEXT = 1024 * 1024; // 1MB
const MAX_IMAGE = 6 * 1024 * 1024; // 6MB，base64 之后约 8MB

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
    if (size > MAX_IMAGE) {
      return { error: `${name} 有 ${(size / 1048576).toFixed(1)}MB，超过 6MB 上限。先压一下。` };
    }
    const b64 = fs.readFileSync(p).toString('base64');
    return {
      kind: 'image',
      name,
      mime: IMAGE_MIME[ext],
      size,
      dataUrl: `data:${IMAGE_MIME[ext]};base64,${b64}`,
    };
  }

  if (size > MAX_TEXT) {
    return { error: `${name} 有 ${(size / 1048576).toFixed(1)}MB，文本附件上限 1MB。` };
  }

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
  for (const p of paths || []) {
    const r = readOne(p);
    out.push(Object.assign({ path: p }, r));
  }
  return out;
}

module.exports = { readFiles, TEXT_EXT, IMAGE_MIME };
