'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exec, execFile } = require('node:child_process');
const { ok, fail, guardPath, firstRoot, clip } = require('./common.cjs');

/**
 * 执行 shell 命令。
 *
 * 这是整套工具里最危险的一个：cwd 会被限制在工作目录内，但命令本身能干什么
 * 不做语法层面的拦截（黑名单式的命令过滤基本都能被绕过，给人虚假的安全感）。
 * 真正的闸门是执行前的人工确认 —— 默认开着，别关。
 */
/* ------------------------------------------------------------------ *
 * 提权执行（Windows）
 *
 * 做法：写一个临时 .ps1，用 Start-Process -Verb RunAs 拉起来。
 * 这会**弹出系统的 UAC 对话框**，由用户亲手点「是」。
 *
 * 这里不存在也不该存在「绕过 UAC」的实现 —— 那类手法（计划任务、COM 提升、
 * fodhelper 劫持之类）正是恶意软件在做的事。UAC 是这台机器上唯一一道由
 * 操作系统而不是本应用把守的闸门，它必须留着。
 *
 * 提权进程的输出拿不回管道（它是另一个会话里的新进程），所以重定向到
 * 临时文件再读回来。
 * ------------------------------------------------------------------ */
async function runElevated(command, cwd, timeoutMs) {
  if (process.platform !== 'win32') {
    return fail(
      `提权执行目前只实现了 Windows（当前是 ${process.platform}）。` +
        'macOS / Linux 请自己在终端里用 sudo 跑，本应用不代劳。',
    );
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = os.tmpdir();
  const cmdFile = path.join(dir, `anyai-elev-${stamp}.txt`);
  const outFile = path.join(dir, `anyai-elev-${stamp}.out`);
  const errFile = path.join(dir, `anyai-elev-${stamp}.err`);
  const codeFile = path.join(dir, `anyai-elev-${stamp}.code`);
  const runner = path.join(dir, `anyai-elev-${stamp}.ps1`);
  const q = (p) => p.replace(/'/g, "''");

  // 被提权执行的那一段：从文件读命令，输出重定向到文件，最后写退出码
  const inner = `$ErrorActionPreference = 'Continue'
$cmd = [System.IO.File]::ReadAllText('${q(cmdFile)}', [System.Text.Encoding]::UTF8)
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory '${q(cwd)}' -RedirectStandardOutput '${q(outFile)}' -RedirectStandardError '${q(errFile)}' -WindowStyle Hidden -Wait -PassThru
[System.IO.File]::WriteAllText('${q(codeFile)}', [string]$p.ExitCode)
`;
  const innerFile = path.join(dir, `anyai-elev-${stamp}-inner.ps1`);

  // 外层：只负责触发 UAC
  const outer = `$ErrorActionPreference = 'Stop'
try {
  Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${q(innerFile)}' -Verb RunAs -WindowStyle Hidden -Wait
} catch {
  Write-Error ('ELEVATION_DENIED: ' + $_.Exception.Message)
  exit 2
}
`;

  const cleanup = () => {
    for (const f of [cmdFile, outFile, errFile, codeFile, runner, innerFile]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* 临时文件，删不掉就算了 */
      }
    }
  };

  try {
    fs.writeFileSync(cmdFile, command, 'utf8');
    fs.writeFileSync(innerFile, '\ufeff' + inner, 'utf8');
    fs.writeFileSync(runner, '\ufeff' + outer, 'utf8');
  } catch (e) {
    cleanup();
    return fail(`写临时脚本失败：${e.message}`);
  }

  const result = await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });

  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  const stdout = read(outFile);
  const stderr = read(errFile);
  const codeRaw = read(codeFile).trim();
  cleanup();

  if (/ELEVATION_DENIED/.test(result.stderr)) {
    return fail('UAC 提权被拒绝或取消了 —— 系统弹窗上点的是「否」，或者这台机器的策略不允许提权。');
  }
  if (!codeRaw && !stdout && !stderr) {
    return fail(
      `提权执行没有产生任何结果。${clip(result.stderr, 300) || '（powershell 也没有报错）'}`,
    );
  }

  const parts = [
    `$ ${command}`,
    `（以管理员身份执行，cwd: ${cwd}，退出码 ${codeRaw || '未知'}）`,
  ];
  if (stdout.trim()) parts.push(`--- stdout ---\n${stdout.trim()}`);
  if (stderr.trim()) parts.push(`--- stderr ---\n${stderr.trim()}`);
  if (!stdout.trim() && !stderr.trim()) parts.push('（没有任何输出）');

  return ok(clip(parts.join('\n\n'), 60000), {
    summary: `管理员执行 ${command.slice(0, 40)}（退出码 ${codeRaw || '?'}）`,
  });
}

function runCommand(args, ctx) {
  if (args && args.elevated) {
    if (!ctx || !ctx.grants || !ctx.grants.admin) {
      return Promise.resolve(
        fail(
          '没有管理员授权。先用 request_access 申请 scope="admin" 并说明理由，' +
            '用户同意之后这次会话里才能用 elevated。注意即使拿到授权，每条提权命令' +
            '仍然会单独弹确认，并且系统还会再弹一次 UAC。',
        ),
      );
    }
    let cwd;
    try {
      cwd = args.cwd
        ? guardPath(args.cwd, ctx.workspaceRoots, { mustExist: true })
        : firstRoot(ctx.workspaceRoots);
    } catch (e) {
      return Promise.resolve(fail(e));
    }
    const command = String(args.command || '').trim();
    if (!command) return Promise.resolve(fail('command 不能为空'));
    const timeout = Math.min(600000, Math.max(1000, Number(args.timeout_ms) || 120000));
    return runElevated(command, cwd, timeout);
  }

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

module.exports = { runCommand, runElevated };
