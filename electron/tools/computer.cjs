'use strict';
/**
 * 屏幕控制：截图 + 鼠标 + 键盘。
 *
 * ── 为什么零依赖 ──
 * 常见做法是引 robotjs / nut-js，它们是原生模块，要跟着 Electron 的 ABI
 * 重新编译，在 Windows 上还要装 VS Build Tools。对一个「双击就能装」的
 * 应用来说，代价太大。
 *
 * 这里用系统自己就有的东西：
 *   截图  → Electron 内置的 desktopCapturer
 *   输入  → PowerShell + user32.dll 的 P/Invoke
 *
 * 代价是**只支持 Windows**。macOS / Linux 上这几个工具直接拒绝执行，
 * 而不是装作能用 —— 那比不支持更糟。
 *
 * ── 坐标系 ──
 * 截图按物理像素抓（display.size × scaleFactor），SetCursorPos 吃的也是
 * 物理像素，两边对齐。PowerShell 进程默认不是 DPI 感知的，所以脚本第一件事
 * 是调 SetProcessDPIAware()，否则在 125% / 150% 缩放的屏幕上会点偏。
 *
 * ── 授权 ──
 * ctx.grants.screen 为 true 才允许执行。这个授权是会话级的，由模型通过
 * request_access 申请、用户点头之后才有，不落盘。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ok, fail, clip } = require('./common.cjs');

const isWindows = process.platform === 'win32';

function needScreen(ctx) {
  if (!ctx || !ctx.grants || !ctx.grants.screen) {
    return '没有屏幕控制授权。先用 request_access 申请 scope="screen"，用户同意后才能操作屏幕。';
  }
  if (!isWindows) {
    return `屏幕控制目前只实现了 Windows（当前是 ${process.platform}）。这是取舍不是遗漏：` +
      '输入注入用的是 user32.dll，换平台要引原生模块。';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * PowerShell 执行：脚本写成带 BOM 的 UTF-8 文件再跑
 *
 * 不用 -Command 直接传字符串：命令里带中文或引号时，命令行那一层的编码
 * 和转义规则会把人折磨死（跟当初 .bat 那个 byte offset 的坑是同一类问题）。
 * ------------------------------------------------------------------ */
function runPowerShell(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const file = path.join(os.tmpdir(), `anyai-input-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    try {
      fs.writeFileSync(file, '﻿' + script, 'utf8');
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: `写临时脚本失败：${e.message}` });
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* 临时文件，删不掉就算了 */
        }
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      },
    );
  });
}

/** 所有输入脚本共用的头：DPI 感知 + user32 声明 */
const PS_HEADER = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AnyAIInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);
}
"@
[void][AnyAIInput]::SetProcessDPIAware()
`;

const MOUSE = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};
const WHEEL = 0x0800;

/* ------------------------------------------------------------------ *
 * 截图
 * ------------------------------------------------------------------ */

async function screenshot(args, ctx) {
  const denied = needScreen(ctx);
  // 截图只是「看」，比点击温和得多，但仍然要授权 —— 屏幕上可能有密码管理器、
  // 私信、银行页面，把它发给模型等于发给模型背后的那个服务商。
  if (denied) return fail(denied);

  const { desktopCapturer, screen } = require('electron');
  try {
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const w = Math.round(display.size.width * scale);
    const h = Math.round(display.size.height * scale);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h },
    });
    if (!sources.length) return fail('拿不到任何屏幕源');

    const src = sources[0];
    const img = src.thumbnail;
    if (img.isEmpty()) return fail('截到的是空图');

    // 回灌给模型的图控制在 1600 宽以内：再大也看不出更多东西，只是烧 token。
    // 但坐标要按原始物理像素给，所以把换算比例明写在返回里。
    const maxW = Math.min(1600, w);
    const shown = maxW < w ? img.resize({ width: maxW }) : img;
    const dataUrl = shown.toDataURL();
    const ratio = w / (shown.getSize().width || maxW);

    return ok(
      [
        `已截取主屏幕。`,
        `物理分辨率 ${w}×${h}（缩放系数 ${scale}）。`,
        ratio > 1.001
          ? `图片被缩小了 ${ratio.toFixed(3)} 倍：在图上量到的坐标要乘以 ${ratio.toFixed(3)} 再传给 computer_click。`
          : '图片是 1:1 的，图上量到的坐标可以直接用。',
        '截图见下一条消息。',
      ].join('\n'),
      {
        summary: `截图 ${w}×${h}`,
        imageDataUrl: dataUrl,
      },
    );
  } catch (e) {
    return fail(`截图失败：${e.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 鼠标
 * ------------------------------------------------------------------ */

async function click(args, ctx) {
  const denied = needScreen(ctx);
  if (denied) return fail(denied);

  const x = Math.round(Number(args.x));
  const y = Math.round(Number(args.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('x / y 必须是数字（物理像素）');

  const button = MOUSE[String(args.button || 'left')] ? String(args.button || 'left') : 'left';
  const double = Boolean(args.double);
  const b = MOUSE[button];

  const script = `${PS_HEADER}
[void][AnyAIInput]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 60
[AnyAIInput]::mouse_event(${b.down}, 0, 0, 0, [IntPtr]::Zero)
[AnyAIInput]::mouse_event(${b.up}, 0, 0, 0, [IntPtr]::Zero)
${
  double
    ? `Start-Sleep -Milliseconds 80
[AnyAIInput]::mouse_event(${b.down}, 0, 0, 0, [IntPtr]::Zero)
[AnyAIInput]::mouse_event(${b.up}, 0, 0, 0, [IntPtr]::Zero)`
    : ''
}
Start-Sleep -Milliseconds 120
$sb = New-Object System.Text.StringBuilder 512
[void][AnyAIInput]::GetWindowTextW([AnyAIInput]::GetForegroundWindow(), $sb, 512)
Write-Output ("前台窗口：" + $sb.ToString())
`;
  const r = await runPowerShell(script);
  if (r.code !== 0) return fail(`点击失败：${clip(r.stderr || r.stdout, 400)}`);
  return ok(`已在 (${x}, ${y}) ${double ? '双击' : '单击'}${button === 'left' ? '' : `（${button} 键）`}。\n${r.stdout.trim()}`, {
    summary: `点击 (${x}, ${y})`,
  });
}

async function moveMouse(args, ctx) {
  const denied = needScreen(ctx);
  if (denied) return fail(denied);
  const x = Math.round(Number(args.x));
  const y = Math.round(Number(args.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('x / y 必须是数字');
  const r = await runPowerShell(`${PS_HEADER}\n[void][AnyAIInput]::SetCursorPos(${x}, ${y})\n`);
  if (r.code !== 0) return fail(`移动失败：${clip(r.stderr, 300)}`);
  return ok(`鼠标已移到 (${x}, ${y})`, { summary: `移动到 (${x}, ${y})` });
}

async function scroll(args, ctx) {
  const denied = needScreen(ctx);
  if (denied) return fail(denied);
  const amount = Math.max(-30, Math.min(30, Number(args.amount) || -3));
  const x = Number(args.x);
  const y = Number(args.y);
  const move =
    Number.isFinite(x) && Number.isFinite(y)
      ? `[void][AnyAIInput]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})\nStart-Sleep -Milliseconds 50`
      : '';
  // 一格 = 120，正数向上
  const script = `${PS_HEADER}
${move}
[AnyAIInput]::mouse_event(${WHEEL}, 0, 0, ${amount * 120}, [IntPtr]::Zero)
`;
  const r = await runPowerShell(script);
  if (r.code !== 0) return fail(`滚动失败：${clip(r.stderr, 300)}`);
  return ok(`已滚动 ${amount} 格（${amount < 0 ? '向下' : '向上'}）`, { summary: `滚动 ${amount}` });
}

/* ------------------------------------------------------------------ *
 * 键盘
 *
 * SendKeys 有自己的一套转义规则：{}()+^%~[] 都是元字符，原样发会被当成
 * 指令而不是字面量。不转义的话，输入一段带括号的文本就会出鬼。
 * ------------------------------------------------------------------ */

function escapeSendKeys(text) {
  return String(text).replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

async function typeText(args, ctx) {
  const denied = needScreen(ctx);
  if (denied) return fail(denied);
  const text = String(args.text ?? '');
  if (!text) return fail('text 不能为空');
  if (text.length > 4000) return fail('一次最多输入 4000 个字符，分几次来');

  // SendKeys 对非 ASCII 的支持依赖当前输入法状态，中文这类直接走剪贴板 + Ctrl+V
  const useClipboard = /[^\x00-\x7F]/.test(text) || Boolean(args.via_clipboard);

  const script = useClipboard
    ? `${PS_HEADER}
Add-Type -AssemblyName System.Windows.Forms
$text = [System.IO.File]::ReadAllText("__TEXTFILE__", [System.Text.Encoding]::UTF8)
Set-Clipboard -Value $text
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait("^v")
Write-Output "（经剪贴板粘贴）"
`
    : `${PS_HEADER}
Add-Type -AssemblyName System.Windows.Forms
$text = [System.IO.File]::ReadAllText("__TEXTFILE__", [System.Text.Encoding]::UTF8)
[System.Windows.Forms.SendKeys]::SendWait($text)
`;

  // 文本走文件而不是拼进脚本：省掉一整类引号转义问题
  const textFile = path.join(os.tmpdir(), `anyai-text-${Date.now()}.txt`);
  try {
    fs.writeFileSync(textFile, useClipboard ? text : escapeSendKeys(text), 'utf8');
  } catch (e) {
    return fail(`写临时文件失败：${e.message}`);
  }

  const r = await runPowerShell(script.replace(/__TEXTFILE__/g, textFile.replace(/\\/g, '\\\\')));
  try {
    fs.unlinkSync(textFile);
  } catch {
    /* 忽略 */
  }

  if (r.code !== 0) return fail(`输入失败：${clip(r.stderr || r.stdout, 400)}`);
  return ok(`已输入 ${text.length} 个字符${useClipboard ? '（经剪贴板，会覆盖剪贴板内容）' : ''}`, {
    summary: `输入「${clip(text, 24)}」`,
  });
}

/** 把 "ctrl+shift+s" 这种翻译成 SendKeys 的写法 */
const KEY_MAP = {
  ctrl: '^', control: '^', alt: '%', shift: '+', win: '^{ESC}',
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
  backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', insert: '{INSERT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', space: ' ',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
};

async function pressKey(args, ctx) {
  const denied = needScreen(ctx);
  if (denied) return fail(denied);

  const combo = String(args.key || '').trim().toLowerCase();
  if (!combo) return fail('key 不能为空，例如 "ctrl+s"、"enter"、"alt+tab"');

  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  let mods = '';
  let main = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control' || p === 'alt' || p === 'shift') {
      mods += KEY_MAP[p];
    } else if (KEY_MAP[p]) {
      main = KEY_MAP[p];
    } else if (p.length === 1) {
      main = escapeSendKeys(p);
    } else {
      return fail(`不认识的按键：${p}`);
    }
  }
  if (!main) return fail('组合键里缺少主键，例如 ctrl+s 里的 s');

  const script = `${PS_HEADER}
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${mods}${main}")
`;
  const r = await runPowerShell(script);
  if (r.code !== 0) return fail(`按键失败：${clip(r.stderr, 300)}`);
  return ok(`已按下 ${combo}`, { summary: `按键 ${combo}` });
}

module.exports = { screenshot, click, moveMouse, scroll, typeText, pressKey };
