#!/usr/bin/env node
/**
 * 打包桌面版。
 *
 * 为什么这段逻辑在 Node 里而不是直接写进 .bat：
 * cmd.exe 是按「字节偏移」逐行读批处理文件的，`chcp 65001` 之后偏移量的计算会和
 * 文件里多字节字符的实际长度对不上，从那一行往后整个文件都被切错位 —— 表现就是
 * echo 的中文被拆成一截一截当命令执行。所以 .bat 里一个非 ASCII 字符都不能有。
 *
 * 两个设计选择：
 *  1. 类型检查失败阻断打包，避免生成检查未通过的版本。
 *  2. NSIS 安装包打不出来时自动退到免安装版 —— Windows 上普通用户没有创建符号
 *     链接的权限，electron-builder 解压 winCodeSign（里面带着 macOS 的 .dylib
 *     软链）必挂。免安装版走不到那一步，照样能用。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { pruneReleases } from './release-retention.mjs';
import { desktopInstallTarget, launchDesktopInstall } from './desktop-install.mjs';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const options = new Set(process.argv.slice(2));
const checkOnly = options.has('--check-only');
const installAfterBuild = isWin && options.has('--install') && !options.has('--no-install') && !checkOnly;
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('打包版本格式无效');
const outputDir = `release/${version}`;
const buildOptions = ['--publish', 'never', `--config.directories.output=${outputDir}`];

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = () => line('='.repeat(56));

/** 边打印边收集输出 —— 长步骤要让人看到进度，出错了又得能回头分析原因 */
function runTee(cmd, args) {
  return new Promise((resolve) => {
    // npm/npx are Windows command shims and need a shell, while
    // process.execPath may live under "Program Files" and must be launched
    // directly so the path is not split at its first space.
    const shell = isWin && !path.isAbsolute(cmd);
    const child = spawn(cmd, args, {
      cwd: root,
      shell,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let out = '';
    child.stdout?.on('data', (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.stderr?.on('data', (d) => {
      const s = d.toString();
      out += s;
      process.stderr.write(s);
    });
    child.on('error', (e) => resolve({ ok: false, out, error: e }));
    child.on('close', (code) => resolve({ ok: code === 0, status: code, out }));
  });
}

function runQuiet(cmd, args) {
  const shell = isWin && !path.isAbsolute(cmd);
  const r = spawnSync(cmd, args, {
    cwd: root,
    shell,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return { ok: !r.error && r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 一个最小的交互问答 —— 只在打包前确认要不要杀进程时用 */
function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (d) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(String(d));
    };
    process.stdin.on('data', onData);
  });
}

const platformFlag = () =>
  process.platform === 'darwin' ? '--mac' : process.platform === 'linux' ? '--linux' : '--win';

rule();
line('  wickrunAI — 打包桌面版');
rule();
line();

/* ---------------- 1. 依赖 ---------------- */

if (!fs.existsSync(path.join(root, 'node_modules'))) {
  if (checkOnly) {
    line('[1/5] 检查模式需要现有依赖；未执行安装。');
    line('      请先运行 npm install，再重试 --check-only。');
    process.exit(1);
  }
  line('[1/5] 安装依赖，第一次会慢一点…');
  line();
  const r = await runTee('npm', ['install']);
  if (!r.ok) {
    line();
    line('✗ npm install 失败。往上翻看报错。');
    process.exit(1);
  }
} else {
  line('[1/5] 依赖已经装过，跳过。');
}
line();

/* ---------------- 2. 回归测试与类型检查 ---------------- */

line('[2/5] 回归测试…');
const testFiles = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.cjs'))
  .map((name) => path.join('tests', name));
const tests = await runTee(process.execPath, ['--test', ...testFiles]);
if (!tests.ok) {
  line();
  line('✗ 回归测试未通过，停止打包；现有安装包保留。');
  process.exit(1);
}
line();

line('[3/5] 类型检查…');
const tc = runQuiet('npx', ['tsc', '--noEmit']);
if (tc.ok) {
  line('      通过。');
} else {
  const errors = tc.out.split('\n').filter((l) => l.includes('error TS'));
  line(`      有 ${errors.length} 处类型错误：`);
  line();
  for (const e of errors.slice(0, 40)) line(`        ${e.trim()}`);
  if (errors.length > 40) line(`        …还有 ${errors.length - 40} 处`);
  line();
  if (!errors.length) line(tc.out || '无法运行类型检查。');
  line('      类型检查未通过，停止打包；现有安装包保留。');
  process.exit(1);
}
line();

if (checkOnly) {
  rule();
  line('  检查完成：未打包、未安装、未构建产物、未打开产物，也未清理旧版本。');
  rule();
  process.exit(0);
}

/* ---------------- 3. 前端构建 ---------------- */

line('[4/5] 构建前端…');
line();
const vb = await runTee('npx', ['vite', 'build']);
if (!vb.ok) {
  line();
  line('✗ 前端构建失败 —— 这个是真挂了，不是类型问题。往上翻看报错。');
  process.exit(1);
}
line();

/* ---------------- 4. 打安装包 ---------------- */

/**
 * 打包前先看看应用是不是还开着。
 *
 * NSIS 要把 release/win-unpacked 整个塞进安装包，而正在运行的 wickrunAI.exe
 * 把自己和 resources/elevate.exe 锁着，electron-builder 只会一直刷
 * 「output file is locked for writing (maybe by virus scanner)」——
 * 那句提示会把人往杀毒软件上带，其实九成是自己没关。
 */
function runningInstances() {
  if (!isWin) return [];
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq wickrunAI.exe', '/NH'], {
    encoding: 'utf8',
    shell: true,
  });
  const out = r.stdout || '';
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^wickrunAI\.exe/i.test(l));
}

const running = runningInstances();
if (running.length) {
  line();
  rule();
  line('  wickrunAI 还开着，先关掉');
  rule();
  line();
  line(`  检测到 ${running.length} 个正在运行的 wickrunAI.exe。`);
  line('  正在运行的程序会把自己的 exe 锁住，打包时会一直卡在');
  line('  「output file is locked for writing」—— 那句提示会甩锅给杀毒软件，');
  line('  但九成情况就是应用自己没关。');
  line();
  line('  关掉窗口（托盘里也看一眼）再跑一次。');
  line('  或者现在就让我关：');
  line();

  const ans = await ask('  要现在结束这些进程吗？[y/N] ');
  if (/^y(es)?$/i.test(ans.trim())) {
    spawnSync('taskkill', ['/IM', 'wickrunAI.exe', '/F'], { shell: true, stdio: 'inherit' });
    await new Promise((r) => setTimeout(r, 1200));
    line('  已结束，继续打包。');
    line();
  } else {
    line('  那先退出，关掉之后再跑一次。');
    process.exit(1);
  }
}

line('[5/5] 打安装包，大概 1–3 分钟…');
line();

let installerOk = true;
let usedFallback = false;

const eb = await runTee('npx', ['electron-builder', platformFlag(), ...buildOptions]);

if (!eb.ok) {
  installerOk = false;
  const symlinkIssue =
    /cannot create symbolic link|required privilege is not held|winCodeSign/i.test(eb.out);

  line();
  rule();
  if (symlinkIssue) {
    line('  安装包没打成 —— 是 Windows 的符号链接权限问题');
    rule();
    line();
    line('  electron-builder 要解压一个叫 winCodeSign 的签名工具包，里面混进了');
    line('  macOS 用的 libcrypto.dylib / libssl.dylib，这两个是符号链接。');
    line('  Windows 上创建符号链接需要 SeCreateSymbolicLinkPrivilege 特权，');
    line('  普通用户默认没有，7z 解压到那两个文件就失败了。');
    line();
    line('  跟网络和杀毒都没关系 —— 你看日志，下载每次都成功，挂在解压。');
    line();
    line('  彻底解决（二选一，之后就能打出正常安装包）：');
    line('    A. 打开开发者模式：设置 → 系统 → 开发者选项 → 开发人员模式 打开');
    line('       这会把创建符号链接的权限给到普通用户，一次设置永久有效');
    line('    B. 用管理员身份跑一次这个脚本');
    line();
    line('  现在先退到免安装版，功能完全一样，只是没有安装程序。');
  } else {
    line('  安装包没打成');
    rule();
    line();
    line('  退到免安装版试试。');
  }
  line();

  const dirBuild = await runTee('npx', ['electron-builder', platformFlag(), '--dir', ...buildOptions]);
  if (dirBuild.ok) {
    usedFallback = true;
  } else {
    line();
    line('✗ 免安装版也没打出来。上面的报错贴给我。');
    process.exit(1);
  }
}

/* ---------------- 结果 ---------------- */

const releaseDir = path.join(root, outputDir);
if (!usedFallback && !options.has('--no-cleanup')) {
  try { const retention = pruneReleases(path.join(root, 'release'), version); line(`保留版本：${retention.keep.join('、')}；已清理 ${retention.remove.length-retention.skipped.length} 项旧产物。`); if(retention.skipped.length)line(`仍在运行的旧产物暂留：${retention.skipped.join('、')}`); }
  catch (error) { line(`安装包已生成，旧产物清理未完成：${error.message}`); }
}
line();
rule();
line('  打包完成');
rule();
line();

if (usedFallback) {
  // 免安装版：exe 在 win-unpacked 里，自己建一个桌面快捷方式
  const unpacked = path.join(releaseDir, isWin ? 'win-unpacked' : 'linux-unpacked');
  let exe = '';
  try {
    const hit = fs.readdirSync(unpacked).find((f) => /^wickrunAI\.exe$/i.test(f));
    if (hit) exe = path.join(unpacked, hit);
  } catch {
    /* 下面统一处理 */
  }

  if (exe && isWin) {
    const desktop = path.join(os.homedir(), 'Desktop');
    const lnk = path.join(desktop, '灯芯AI.lnk');
    const ps = [
      '$W = New-Object -ComObject WScript.Shell',
      `$S = $W.CreateShortcut('${lnk}')`,
      `$S.TargetPath = '${exe}'`,
      `$S.WorkingDirectory = '${unpacked}'`,
      `$S.IconLocation = '${exe},0'`,
      '$S.Save()',
    ].join('; ');

    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8',
    });

    if (r.status === 0 && fs.existsSync(lnk)) {
      line('  已经在桌面建好快捷方式：灯芯AI');
      line('  双击就能用，不需要安装，也不用再开命令行。');
    } else {
      line('  快捷方式没建成，手动拖一个：');
      line(`    ${exe}`);
      line('  （右键 → 发送到 → 桌面快捷方式）');
    }
    line();
    line('  注意：这个 exe 依赖同目录下的其它文件，别单独把它移走 ——');
    line('  要挪就整个 win-unpacked 文件夹一起挪，然后重建快捷方式。');
  } else {
    line(`  应用在这里：${unpacked}`);
  }
} else if (fs.existsSync(releaseDir)) {
  const installers = fs
    .readdirSync(releaseDir)
    .filter((f) => /\.(exe|dmg|AppImage|deb)$/i.test(f));

  if (installers.length) {
    line(`  本次 ${version} 产物：${releaseDir}`);
    line();
    for (const f of installers) {
      const size = (fs.statSync(path.join(releaseDir, f)).size / 1048576).toFixed(0);
      const kind = /portable/i.test(f)
        ? '免安装，直接双击跑'
        : '安装版，双击装，会自动建桌面快捷方式';
      line(`    ${f}  (${size} MB)`);
      line(`      ${kind}`);
    }
    line();
    line('  装完就是个正常桌面应用，不用再开命令行。');
  } else {
    line(`  没找到安装包，自己看一眼：${releaseDir}`);
  }
}

line();
try {
  const open = usedFallback ? path.join(releaseDir, 'win-unpacked') : releaseDir;
  if (options.has('--no-open') || installAfterBuild) { /* The installer or verification mode owns the next step. */ }
  else if (isWin && !installAfterBuild) spawnSync('explorer', [open], { shell: true });
  else if (process.platform === 'darwin') spawnSync('open', [open]);
  else spawnSync('xdg-open', [open]);
} catch {
  /* 打不开就算了，路径已经打出来了 */
}
line();

if (installAfterBuild) {
  try {
    const target = desktopInstallTarget(root, version, usedFallback);
    await launchDesktopInstall(target);
    line(usedFallback ? '安装包未生成，已打开免安装版。' : `已打开 ${version} 安装向导；按向导完成安装即可。`);
  } catch (error) {
    line(`安装程序未能打开：${error.message}`);
    process.exitCode = 1;
  }
}
