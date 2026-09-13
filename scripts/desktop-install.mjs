import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function desktopInstallTarget(root, version, fallback = false) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('安装版本格式无效');
  const dir = path.join(root, 'release', version);
  const target = fallback ? path.join(dir, 'win-unpacked', 'wickrunAI.exe')
    : path.join(dir, `wickrunAI-${version}-win-x64-setup.exe`);
  const fd = fs.openSync(target, 'r');
  try { const header = Buffer.alloc(2); fs.readSync(fd, header, 0, 2, 0); if (header.toString() !== 'MZ') throw new Error('安装程序格式无效，未启动'); }
  finally { fs.closeSync(fd); }
  return target;
}

export async function launchDesktopInstall(target, spawnProcess = spawn) {
  const child = spawnProcess(target, [], { cwd: path.dirname(target), shell: false, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  child.unref();
}
