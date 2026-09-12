'use strict';
/**
 * 主进程只剩这一个解析需求：从错误响应体里挖出人能看懂的一句话。
 *
 * SSE 切分、tool_calls 累积、字段归一化都在 src/lib/sse.ts，
 * Electron / Android / 浏览器三端共用那一份，这里不重复实现。
 */
function extractErrorMessage(payload, fallback) {
  if (typeof payload === 'string') return payload.slice(0, 800) || fallback;
  if (!payload || typeof payload !== 'object') return fallback;
  const err = payload.error && typeof payload.error === 'object' ? payload.error : payload;
  const msg = err.message || payload.message || err.msg || payload.msg || '';
  const code =
    err.code !== undefined
      ? String(err.code)
      : payload.code !== undefined
        ? String(payload.code)
        : '';
  if (msg) return code ? `${msg} (code ${code})` : String(msg);
  try {
    return JSON.stringify(payload).slice(0, 800);
  } catch {
    return fallback;
  }
}

module.exports = { extractErrorMessage };
