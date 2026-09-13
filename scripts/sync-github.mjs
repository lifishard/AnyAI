#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStatus, scanText, scanWorkingFiles } from './sync-checks.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), checkOnly = args.includes('--check-only');
const git = values => execFileSync('git', values, { cwd: root, encoding: 'utf8', maxBuffer: 64*1024*1024 });
const fail = message => { console.error(`\n✗ ${message}`); process.exitCode = 1; };
function push() {
  const branch = git(['branch','--show-current']).trim();
  if (!branch) throw new Error('当前不在分支上，请先切回要同步的分支。');
  execFileSync('git',['push','-u','origin',branch],{cwd:root,stdio:'inherit'});
  console.log(`✓ 已同步到 ${branch}`);
}
try {
  git(['rev-parse','--is-inside-work-tree']);
  const files = parseStatus(git(['status','--porcelain=v1','-z']));
  console.log(`待提交改动：${files.length} 个文件${checkOnly ? '；本次只检查' : ''}`);
  execFileSync(process.execPath,['scripts/check-lite.mjs'],{cwd:root,stdio:'inherit'});
  if (!args.includes('--skip-typecheck')) {
    if (!fs.existsSync(path.join(root,'node_modules/typescript/bin/tsc'))) throw new Error('缺少依赖，请先运行 npm install。');
    execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit'],{cwd:root,stdio:'inherit'});
  }
  // Read-only preflight preserves the user's index, including partially staged files.
  const candidates = git(['ls-files','-co','--exclude-standard','-z']).split('\0').filter(Boolean);
  const hits = scanWorkingFiles(root,candidates);
  if (hits.length) throw new Error('发现疑似密钥（未改动暂存区）：\n'+hits.slice(0,20).map(h=>`  ${h.file}:${h.line} — ${h.kind}（内容隐藏）`).join('\n'));
  if (checkOnly) console.log('✓ 推送前检查通过；未暂存、提交或推送。');
  else {
    git(['remote','get-url','origin']);
    if (files.length) {
      git(['add','-A']);
      // A failed scan must block the commit. Never treat an unreadable diff as clean.
      const diff = git(['diff','--cached','--unified=0']);
      const additions = diff.split('\n').filter(l=>l.startsWith('+')&&!l.startsWith('+++')).join('\n');
      if (scanText(additions,'暂存区').length) throw new Error('暂存区出现疑似密钥，未提交；暂存状态已保留，请检查。');
      const staged = git(['diff','--cached','--name-only','-z']).split('\0').filter(Boolean);
      if (staged.length) git(['commit','-m',args.find(a=>!a.startsWith('--')) || `更新 AnyAI ${JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version}`]);
    }
    // A previous attempt may have committed successfully and failed only at push.
    push();
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  if (!checkOnly) console.error('本地提交与文件均保留。修复报错后可再次运行本脚本；若远端有新提交，请先处理同步冲突。');
}
