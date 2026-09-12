#!/usr/bin/env node
/**
 * 一键同步到 GitHub：检查 → 提交 → 推送。
 *
 *   node scripts/sync-github.mjs ["提交说明"]
 *   node scripts/sync-github.mjs --skip-typecheck   跳过 tsc（赶时间时用）
 *   node scripts/sync-github.mjs --force            跳过密钥扫描（别用）
 *
 * ── 为什么不做成「保存即自动推」 ──
 *
 * 想过，不做，三个理由：
 *
 *   1. **密钥**。哪天顺手把 key 粘进某个文件，自动推会在你反应过来之前把它
 *      发到公开仓库。公开仓库的 secret 几分钟内就会被爬虫抓走，改历史也没用 ——
 *      那个 key 已经废了。人工点一下，就多了一个能中止的时刻。
 *   2. **历史**。一堆「auto commit 14:32」的提交等于没有历史：出问题时
 *      没法 bisect，也没法 review 某次改动。
 *   3. **CI**。每次保存都触发一遍三平台构建，几分钟的 Actions 额度就这么烧掉了。
 *
 * 所以这个脚本是「你决定推的时候，它替你把该做的都做完」，而不是替你决定。
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const message = args.find((a) => !a.startsWith('--'));

const git = (cmdArgs, opts = {}) =>
  execFileSync('git', cmdArgs, { cwd: root, encoding: 'utf8', ...opts }).trim();

const say = (s = '') => console.log(s);
const die = (s) => {
  console.error(`\n✗ ${s}\n`);
  process.exit(1);
};

/* ------------------------------------------------------------------ *
 * 0. 基本前提
 * ------------------------------------------------------------------ */

try {
  git(['rev-parse', '--is-inside-work-tree']);
} catch {
  die('这个目录不是 git 仓库。先跑一次 git init，或者确认你在项目根目录下。');
}

let remote = '';
try {
  remote = git(['remote', 'get-url', 'origin']);
} catch {
  die('没有配置 origin 远端。跑一次：\n    git remote add origin https://github.com/<你>/<仓库>.git');
}

const status = git(['status', '--porcelain']);
if (!status) {
  say('\n没有任何改动，不用推。\n');
  process.exit(0);
}

const changedFiles = status
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter(Boolean);

say(`\n仓库：${remote}`);
say(`改动：${changedFiles.length} 个文件\n`);
for (const f of changedFiles.slice(0, 12)) say(`  ${f}`);
if (changedFiles.length > 12) say(`  …还有 ${changedFiles.length - 12} 个`);

/* ------------------------------------------------------------------ *
 * 1. 代码检查
 * ------------------------------------------------------------------ */

say('\n[1/4] 代码检查');
try {
  execSync('node scripts/check-lite.mjs', { cwd: root, stdio: 'inherit' });
} catch {
  die('低级错误检查没过（上面有明细）。修完再推 —— 推上去 CI 一样会红。');
}

if (!flag('--skip-typecheck') && fs.existsSync(path.join(root, 'node_modules', 'typescript'))) {
  say('[2/4] 类型检查（tsc，慢一点，--skip-typecheck 可跳过）');
  try {
    execSync('npm run typecheck', { cwd: root, stdio: 'inherit' });
  } catch {
    die('类型检查没过。CI 里这一步是阻断的，现在不修，推上去还是红。');
  }
} else {
  say('[2/4] 跳过类型检查');
}

/* ------------------------------------------------------------------ *
 * 2. 密钥扫描
 *
 * 这一步是这个脚本存在的主要理由。在 git add 之后、commit 之前扫暂存区 ——
 * 发现可疑就整个撤回暂存，什么都不提交。
 * ------------------------------------------------------------------ */

say('[3/4] 暂存并扫描密钥');
git(['add', '-A']);

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI 风格的 API Key'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub classic token'],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}/, 'GitHub fine-grained token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Access Key ID'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, '私钥文件内容'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API Key'],
  [/\btvly-[A-Za-z0-9]{20,}/, 'Tavily API Key'],
];

let staged = '';
try {
  staged = execFileSync('git', ['diff', '--cached', '--unified=0'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch {
  staged = '';
}

const addedLines = staged
  .split('\n')
  .filter((l) => l.startsWith('+') && !l.startsWith('+++'));

const hits = [];
for (const line of addedLines) {
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(line)) {
      hits.push({ label, sample: line.slice(1, 90) });
      break;
    }
  }
}

if (hits.length && !flag('--force')) {
  git(['reset']); // 撤回暂存，什么都没提交
  console.error('\n✗ 暂存区里发现疑似密钥，已经全部撤回暂存，没有提交任何东西：\n');
  for (const h of hits.slice(0, 5)) {
    console.error(`  ${h.label}`);
    console.error(`    ${h.sample}`);
  }
  console.error(
    '\n把它挪进 .gitignore 里的文件、或者改成从环境变量读。\n' +
      '确认是误报（比如占位符写得太像真的）再加 --force。\n' +
      '提醒一句：密钥一旦推进公开仓库就算泄露了，改历史也救不回来 —— 那把 key 要作废重发。\n',
  );
  process.exit(1);
}
if (hits.length) say(`  ⚠ 有 ${hits.length} 处疑似密钥，但你加了 --force，继续`);
else say('  没有发现可疑内容');

/* ------------------------------------------------------------------ *
 * 3. 提交并推送
 * ------------------------------------------------------------------ */

/** 没给提交说明时，按改了哪些地方拼一句像样的 */
function autoMessage() {
  const areas = new Set();
  for (const f of changedFiles) {
    if (f.startsWith('src/components/')) areas.add('界面');
    else if (f.startsWith('src/lib/')) areas.add(path.basename(f, path.extname(f)));
    else if (f.startsWith('electron/')) areas.add('原生层');
    else if (f.startsWith('docs/') || f.endsWith('.md')) areas.add('文档');
    else if (f.startsWith('.github/')) areas.add('CI');
    else if (f.startsWith('scripts/')) areas.add('构建脚本');
    else areas.add(path.basename(f));
  }
  const list = [...areas].slice(0, 4).join('、');
  return `更新 ${list}${areas.size > 4 ? ` 等 ${areas.size} 处` : ''}`;
}

const msg = message || autoMessage();
say(`\n[4/4] 提交并推送`);
say(`  提交说明：${msg}`);

try {
  git(['commit', '-m', msg]);
} catch (e) {
  const out = String(e.stdout ?? '') + String(e.stderr ?? '');
  if (/nothing to commit/i.test(out)) {
    say('  没有需要提交的内容（可能都被 .gitignore 挡掉了）');
    process.exit(0);
  }
  die(`提交失败：\n${out.slice(0, 600)}`);
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
try {
  // 第一次推要建立上游关联，之后直接 push
  const hasUpstream = (() => {
    try {
      git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
      return true;
    } catch {
      return false;
    }
  })();
  execSync(hasUpstream ? 'git push' : `git push -u origin ${branch}`, {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  die(
    '推送失败。常见原因：\n' +
      '  · 远端有你本地没有的提交 → 先 git pull --rebase 再跑一次\n' +
      '  · 凭据过期 → Windows 的「凭据管理器」里删掉 github.com 那条，下次推会重新登录\n' +
      '  · 网络/代理问题 → 直接在命令行跑一次 git push 看完整报错\n' +
      `\n提交已经在本地了（分支 ${branch}），不用重做，解决后再 push 一次即可。`,
  );
}

const short = git(['rev-parse', '--short', 'HEAD']);
say(`\n✓ 已推送 ${short} 到 ${branch}`);
say(`  ${remote.replace(/\.git$/, '')}/commits/${branch}\n`);
say('想发版本的话：');
say('  npm version 1.0.1 --no-git-tag-version');
say('  node scripts/sync-github.mjs "v1.0.1"');
say('  git tag v1.0.1 && git push --tags     ← 这一步会触发三平台打包\n');
