'use strict';
const { exec } = require('node:child_process');
const { ok, fail, guardPath, firstRoot, clip } = require('./common.cjs');

/**
 * 执行 shell 命令。
 *
 * 这是整套工具里最危险的一个：cwd 会被限制在工作目录内，但命令本身能干什么
 * 不做语法层面的拦截（黑名单式的命令过滤基本都能被绕过，给人虚假的安全感）。
 * 真正的闸门是执行前的人工确认 —— 默认开着，别关。
 */
function runCommand(args, ctx) {
  return new Promise((resolve) => {
    let cwd;
    try {
      cwd = args.cwd
        ? guardPath(args.cwd, ctx.workspaceRoots, { mustExist: true })
        : firstRoot(ctx.workspaceRoots);
    } catch (e) {
      resolve(fail(e));
      return;
    }

    const command = String(args.command || '').trim();
    if (!command) {
      resolve(fail('command 不能为空'));
      return;
    }

    const timeout = Math.min(600000, Math.max(1000, Number(args.timeout_ms) || 120000));

    exec(
      command,
      {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: Object.assign({}, process.env, { NO_COLOR: '1', FORCE_COLOR: '0' }),
      },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        const timedOut = Boolean(err && err.killed);

        const parts = [`$ ${command}`, `（cwd: ${cwd}，退出码 ${code}${timedOut ? '，超时被杀' : ''}）`];
        if (stdout && stdout.trim()) parts.push(`--- stdout ---\n${stdout.trim()}`);
        if (stderr && stderr.trim()) parts.push(`--- stderr ---\n${stderr.trim()}`);
        if (!stdout.trim() && !stderr.trim()) parts.push('（没有任何输出）');

        const body = clip(parts.join('\n\n'), 60000);
        // 退出码非 0 也算「工具执行成功」—— 模型需要看到失败输出才能修
        resolve(ok(body, { summary: `执行 ${command.slice(0, 50)}（退出码 ${code}）` }));
      },
    );
  });
}

module.exports = { runCommand };
