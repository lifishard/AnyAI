'use strict';
/**
 * 把一整件活儿转包给本机的 Claude Code。
 *
 * 用 headless 模式 `claude -p <prompt>` 起子进程，它会自己读写文件、跑命令、
 * 用 git，最后把结果打到 stdout。权限由 Claude Code 自己那套管，我们这边只负责
 * 限制 cwd 和超时。
 *
 * Windows 上 `claude` 是个 .cmd 垫片，必须 shell:true 才能 spawn 起来。
 */
const { spawn } = require('node:child_process');
const { ok, fail, guardPath, firstRoot, clip } = require('./common.cjs');

function splitArgs(s) {
  // 简单的空格切分，支持成对引号
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

function claudeCode(args, ctx) {
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

    const prompt = String(args.prompt || '').trim();
    if (!prompt) {
      resolve(fail('prompt 不能为空'));
      return;
    }

    const bin = (ctx.claudeBin || '').trim() || 'claude';
    const extra = splitArgs(ctx.claudeExtraArgs);
    const argv = ['-p', prompt, ...extra];
    const timeout = Math.min(3600000, Math.max(10000, Number(ctx.claudeTimeoutMs) || 600000));

    let child;
    try {
      child = spawn(bin, argv, {
        cwd,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: Object.assign({}, process.env, { NO_COLOR: '1', FORCE_COLOR: '0' }),
      });
    } catch (e) {
      resolve(fail(`起不来 Claude Code：${e.message}。确认本机装了 claude CLI，或在设置里填绝对路径。`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }, timeout);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024);
    });

    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const hint =
        e.code === 'ENOENT'
          ? `找不到可执行文件 "${bin}"。装一下 Claude Code，或者在 设置 → 工具 → Claude Code 里填它的绝对路径。`
          : e.message;
      resolve(fail(hint));
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      if (!stdout.trim() && code !== 0) {
        resolve(
          fail(
            `Claude Code 退出码 ${code}，没有输出。\n${stderr.slice(0, 1200) || '（stderr 也是空的）'}\n` +
              '常见原因：claude CLI 没登录，或者当前权限模式不允许它动手。',
          ),
        );
        return;
      }

      const parts = [`Claude Code 在 ${cwd} 执行完毕（退出码 ${code}）。`, '--- 它的回报 ---', stdout.trim() || '（无）'];
      if (stderr.trim()) parts.push(`--- stderr ---\n${stderr.trim().slice(0, 2000)}`);

      resolve(
        ok(clip(parts.join('\n\n'), 60000), {
          summary: `Claude Code 完成（退出码 ${code}）`,
        }),
      );
    });
  });
}

module.exports = { claudeCode };
