#!/usr/bin/env node
/**
 * 把 package.json 和文档里的 YOUR-GITHUB-USERNAME 占位符换成真实的 owner/repo。
 *
 *   node scripts/init-repo.mjs <owner> [repo]
 *
 * CI 里其实用不上（electron-builder 在 Actions 里会从 GITHUB_REPOSITORY 自己认），
 * 这个脚本是为了让本地 `npm run release` 和 README 里的链接指对地方。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const [owner, repoArg] = process.argv.slice(2);

if (!owner) {
  console.error('\n用法：node scripts/init-repo.mjs <owner> [repo]');
  console.error('例如：node scripts/init-repo.mjs octocat anyai\n');
  process.exit(1);
}
const repo = repoArg || 'anyai';

const FILES = [
  'package.json',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'docs/CONFIGURATION.md',
  'docs/BUILD.md',
  'docs/ARCHITECTURE.md',
];
let touched = 0;

for (const rel of FILES) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const before = fs.readFileSync(p, 'utf8');
  const after = before
    .replaceAll('YOUR-GITHUB-USERNAME/anyai', `${owner}/${repo}`)
    .replaceAll('YOUR-GITHUB-USERNAME', owner);
  if (after !== before) {
    fs.writeFileSync(p, after);
    console.log(`✓ ${rel}`);
    touched++;
  }
}

console.log(
  touched
    ? `\n改好了 ${touched} 个文件，指向 https://github.com/${owner}/${repo}\n`
    : '\n没找到占位符，可能已经改过了。\n',
);
