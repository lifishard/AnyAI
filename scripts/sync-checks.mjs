import fs from 'node:fs';
import path from 'node:path';

const patterns = [
  [/\bsk-[A-Za-z0-9]{20,}/, 'API Key'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Access Key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, '私钥'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API Key'],
  [/\btvly-[A-Za-z0-9]{20,}/, 'Tavily API Key'],
];

/** Never return credential contents, including nearby source text. */
export function scanText(text, file) {
  return text.split('\n').flatMap((line, i) => {
    const hit = patterns.find(([pattern]) => pattern.test(line));
    return hit ? [{ file, line: i + 1, kind: hit[1] }] : [];
  });
}
export function scanWorkingFiles(root, files) {
  return [...new Set(files)].flatMap(file => {
    const target = path.resolve(root, file);
    if (!fs.existsSync(target)) return [];
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) return [];
    if (stat.size > 32 * 1024 * 1024) throw new Error(`文件过大，无法完成扫描：${file}`);
    return scanText(fs.readFileSync(target, 'utf8'), file);
  });
}

export function parseStatus(raw) {
  const entries = raw.split('\0'), files = [];
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    const status = entries[i].slice(0, 2);
    files.push(entries[i].slice(3));
    if (/[RC]/.test(status)) i++; // -z emits destination first, then the original name.
  }
  return files;
}
