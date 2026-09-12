'use strict';
const path = require('node:path');
const fs = require('node:fs');

/** 工具返回值的统一形状 */
function ok(content, extra) {
  return Object.assign({ ok: true, content: String(content ?? '') }, extra || {});
}
function fail(error) {
  return { ok: false, content: '', error: String(error && error.message ? error.message : error) };
}

/**
 * 路径守卫。
 * 文件类工具只允许在用户显式配置的工作目录里动手 —— 没配就一律拒绝，
 * 而不是默认放行整个磁盘。realpath 解引用之后再比，避免用符号链接绕出去。
 */
function guardPath(p, roots, { mustExist = false } = {}) {
  if (!roots || roots.length === 0) {
    throw new Error('还没有配置工作目录。请到 设置 → 工具 → 工作目录 里添加一个，工具才能访问本地文件。');
  }
  if (!p || typeof p !== 'string') throw new Error('缺少 path 参数');

  const target = path.resolve(p);
  if (mustExist && !fs.existsSync(target)) throw new Error(`路径不存在：${target}`);

  const real = (x) => {
    try {
      return fs.realpathSync.native(x);
    } catch {
      return path.resolve(x);
    }
  };

  // 目标可能还不存在（写新文件），那就拿它最近的已存在祖先来解引用
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realTarget = path.join(real(probe), path.relative(probe, target));

  const inside = roots.some((rootRaw) => {
    const root = real(path.resolve(rootRaw));
    const rel = path.relative(root, realTarget);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });

  if (!inside) {
    throw new Error(
      `路径 ${target} 不在允许的工作目录内。当前允许：${roots.join(' , ') || '（无）'}`,
    );
  }
  return target;
}

function firstRoot(roots) {
  if (!roots || !roots.length) {
    throw new Error('还没有配置工作目录。请到 设置 → 工具 → 工作目录 里添加一个。');
  }
  return roots[0];
}

/** 带超时的 fetch */
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function clip(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…（内容已截断，原文共 ${s.length} 字符）`;
}

module.exports = { ok, fail, guardPath, firstRoot, fetchWithTimeout, clip };
