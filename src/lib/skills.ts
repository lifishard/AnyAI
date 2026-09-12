import { getTransport } from './transport';
import { uid } from './store';

/* ------------------------------------------------------------------ *
 * 技能（Skill）
 *
 * 一个技能 = 一段写好的指令，用 `/名字` 唤起，唤起时作为额外的 system
 * 消息注入这一轮。就这么简单 —— 技能是提示词，不是可执行代码，所以不需要
 * 沙箱，也不会有「装一个技能把你电脑搞了」这种事。
 *
 * 格式跟 Anthropic 的 SKILL.md 一致：YAML frontmatter 给 name / description，
 * 正文是指令本体。GitHub 上现成的技能仓库可以直接装。
 * ------------------------------------------------------------------ */

const K_SKILLS = 'snc:skills:v1';

export interface Skill {
  id: string;
  /** 斜杠命令用的名字，只能是字母数字和连字符 */
  name: string;
  description: string;
  /** 指令正文，注入时就是这一段 */
  body: string;
  /** 从哪来的：手写 / GitHub 仓库地址 */
  source: string;
  enabled: boolean;
  installedAt: number;
  /** 唤起次数，用来把常用的排前面 */
  uses: number;
}

export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^\w一-龥-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill'
  );
}

/** 解析 SKILL.md：YAML frontmatter + 正文 */
export function parseSkillMd(md: string, fallbackName = ''): Omit<Skill, 'id' | 'installedAt' | 'uses' | 'enabled' | 'source'> {
  let name = fallbackName;
  let description = '';
  let body = md;

  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    // 只挑我们认识的两个字段，不引 YAML 库 —— frontmatter 里花活再多也不关我们的事
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(name|description)\s*:\s*(.*)$/i);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1].toLowerCase() === 'name') name = v;
      else description = v;
    }
  }

  if (!name) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) name = h1[1].trim();
  }
  if (!description) {
    const firstLine = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    description = (firstLine ?? '').slice(0, 160);
  }

  return { name: slugify(name), description, body: body.trim() };
}

export function toSkillMd(s: Skill): string {
  return `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`;
}

/* ---------------- 存储 ---------------- */

export async function loadSkills(): Promise<Skill[]> {
  try {
    const raw = await getTransport().kvGet(K_SKILLS);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as Skill[]) : [];
  } catch {
    return [];
  }
}

export async function saveSkills(list: Skill[]): Promise<void> {
  await getTransport().kvSet(K_SKILLS, JSON.stringify(list));
}

export function makeSkill(
  partial: Partial<Skill> & { name: string; body: string },
): Skill {
  return {
    id: uid('sk'),
    name: slugify(partial.name),
    description: partial.description ?? '',
    body: partial.body,
    source: partial.source ?? '手写',
    enabled: partial.enabled ?? true,
    installedAt: Date.now(),
    uses: 0,
  };
}

/* ---------------- 斜杠唤起 ---------------- */

/**
 * 输入框里正在打的是不是一个斜杠命令？
 * 规则：光标前的这一行以 / 开头，且 / 后面还没有空格。
 */
export function slashQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  if (!line.startsWith('/')) return null;
  const q = line.slice(1);
  if (/\s/.test(q)) return null;
  return q;
}

export function matchSkills(skills: Skill[], q: string): Skill[] {
  const needle = q.trim().toLowerCase();
  return skills
    .filter((s) => s.enabled)
    .filter(
      (s) =>
        !needle ||
        s.name.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle),
    )
    .sort((a, b) => {
      // 名字前缀命中的排最前，其次按使用频次
      const ap = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return b.uses - a.uses;
    })
    .slice(0, 12);
}

/* ---------------- 从 GitHub 安装 ---------------- */

export interface GithubTarget {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}

/**
 * 认这几种写法：
 *   owner/repo
 *   owner/repo/path/to/skill
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main/skills/foo
 */
export function parseGithubTarget(input: string): GithubTarget | null {
  let s = input.trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  s = s.replace(/\.git$/, '');
  s = s.replace(/^\/+|\/+$/g, '');
  if (!s) return null;

  const parts = s.split('/');
  if (parts.length < 2) return null;
  const [owner, repo, ...rest] = parts;

  let ref: string | undefined;
  let path = '';
  if (rest[0] === 'tree' || rest[0] === 'blob') {
    ref = rest[1];
    path = rest.slice(2).join('/');
  } else {
    path = rest.join('/');
  }
  return { owner, repo, path, ref };
}

interface GhEntry {
  type: string;
  name: string;
  path: string;
  content?: string;
  encoding?: string;
}

async function ghJson(pathAndQuery: string, ctxLike: unknown): Promise<unknown> {
  const res = await getTransport().callTool(
    'github_api',
    { method: 'GET', path: pathAndQuery },
    ctxLike as never,
  );
  if (!res.ok) throw new Error(res.error ?? 'GitHub 请求失败');
  try {
    return JSON.parse(res.content);
  } catch {
    throw new Error('GitHub 返回的不是 JSON');
  }
}

/**
 * 取文件原文。
 *
 * 走 raw 模式而不是 contents API 的 base64：一个 32KB 的 SKILL.md 经 base64
 * 会变成 43K 字符，超过工具返回值的限额被截断，然后表现成「仓库里没这个文件」。
 * raw 拿到的就是文本，没有这一层。
 */
async function ghRaw(pathAndQuery: string, ctxLike: unknown): Promise<string> {
  const res = await getTransport().callTool(
    'github_api',
    { method: 'GET', path: pathAndQuery, raw: true },
    ctxLike as never,
  );
  if (!res.ok) throw new Error(res.error ?? 'GitHub 请求失败');
  return res.content;
}

/** 这个错误是「文件不存在」还是「请求根本没成功」—— 两者不能混为一谈 */
function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /HTTP 404/.test(msg);
}

/** 这份 md 看起来像不像一个技能 */
function looksLikeSkill(md: string): boolean {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  return /^\s*(name|description)\s*:/im.test(fm[1]);
}

/** 文件名优先级：SKILL.md 最优先，其次是几个常见叫法 */
function nameRank(fileName: string): number {
  const n = fileName.toLowerCase();
  if (n === 'skill.md') return 0;
  if (n === 'agent.md' || n === 'agents.md' || n === 'prompt.md') return 1;
  if (n === 'readme.md') return 9; // 最后才考虑
  return 5;
}

/**
 * 到仓库里找技能。
 *
 * 找的顺序：给定路径本身 → 该路径下的 md 文件 → 下一层每个目录 →
 * 仓库根的 skills/ 和 .claude/skills/。不做深递归，免得把整个仓库爬一遍。
 *
 * **文件名不限定 SKILL.md**：很多作者用别的名字。判据是「有 YAML frontmatter
 * 且里面有 name 或 description」—— 这是 SKILL.md 格式的实质，文件叫什么是形式。
 * README.md 排在最后，因为它通常是给人看的介绍而不是给模型的指令。
 */
export async function installFromGithub(
  input: string,
  toolCtx: unknown,
  onProgress?: (s: string) => void,
): Promise<Skill[]> {
  const t = parseGithubTarget(input);
  if (!t) throw new Error('看不懂这个地址。写成 owner/repo 或者完整的 GitHub 链接。');

  const refQ = t.ref ? `?ref=${encodeURIComponent(t.ref)}` : '';
  const base = `/repos/${t.owner}/${t.repo}/contents`;

  onProgress?.(`在 ${t.owner}/${t.repo} 里找技能…`);

  const found: Skill[] = [];
  const seen = new Set<string>();
  /** 非 404 的失败：限额、网络、权限。这些必须让用户看见，不能当成「没找到」 */
  const hardErrors: string[] = [];

  const tryFile = async (p: string, opts: { requireFrontmatter?: boolean } = {}) => {
    if (seen.has(p) || found.length >= 20) return;
    seen.add(p);
    try {
      const md = await ghRaw(`${base}/${p}${refQ}`, toolCtx);
      if (!md.trim()) return;
      if (opts.requireFrontmatter && !looksLikeSkill(md)) return;

      // 目录名比文件名更能代表技能名：skills/pdf-export/SKILL.md → pdf-export
      const segs = p.split('/');
      const fallback = /^skill\.md$/i.test(segs[segs.length - 1])
        ? (segs[segs.length - 2] ?? t.repo)
        : segs[segs.length - 1].replace(/\.md$/i, '');

      const parsed = parseSkillMd(md, fallback);
      if (!parsed.body.trim()) return;
      found.push(makeSkill({ ...parsed, source: `github:${t.owner}/${t.repo}/${p}` }));
      onProgress?.(`找到 ${parsed.name}（${Math.round(md.length / 1024)} KB）`);
    } catch (e) {
      if (!isNotFound(e)) {
        hardErrors.push(`${p}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const listDir = async (p: string): Promise<GhEntry[]> => {
    try {
      const r = await ghJson(`${base}${p ? `/${p}` : ''}${refQ}`, toolCtx);
      return Array.isArray(r) ? (r as GhEntry[]) : [];
    } catch (e) {
      if (!isNotFound(e)) hardErrors.push(`列目录 ${p || '/'}：${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };

  /** 在一个目录里挑出像技能的 md 文件，按文件名优先级排序 */
  const mdFilesIn = (entries: GhEntry[]): GhEntry[] =>
    entries
      .filter((e) => e.type === 'file' && /\.md$/i.test(e.name))
      .sort((a, b) => nameRank(a.name) - nameRank(b.name));

  // 1. 路径直接指到一个 .md 文件
  if (/\.md$/i.test(t.path)) {
    await tryFile(t.path);
    if (found.length) return found;
  }

  // 2. 路径下的 SKILL.md
  await tryFile(t.path ? `${t.path}/SKILL.md` : 'SKILL.md');

  const entries = await listDir(t.path);

  // 3. 路径下其他名字的 md（要求有 frontmatter，避免把普通文档当技能装进来）
  if (!found.length) {
    for (const f of mdFilesIn(entries)) {
      if (nameRank(f.name) >= 9) continue; // README 留到最后一轮
      await tryFile(f.path, { requireFrontmatter: true });
    }
  }

  // 4. 下一层的每个目录
  for (const d of entries.filter((e) => e.type === 'dir').slice(0, 60)) {
    await tryFile(`${d.path}/SKILL.md`);
  }

  // 5. 仓库根常见的技能目录
  if (!found.length && !t.path) {
    for (const guess of ['skills', 'Skills', '.claude/skills']) {
      const sub = await listDir(guess);
      for (const d of sub.filter((e) => e.type === 'dir').slice(0, 60)) {
        await tryFile(`${d.path}/SKILL.md`);
      }
      for (const f of mdFilesIn(sub)) {
        await tryFile(f.path, { requireFrontmatter: true });
      }
      if (found.length) break;
    }
  }

  // 6. 最后一招：带 frontmatter 的 README
  if (!found.length) {
    for (const f of mdFilesIn(entries).filter((x) => nameRank(x.name) >= 9)) {
      await tryFile(f.path, { requireFrontmatter: true });
    }
  }

  if (!found.length) {
    if (hardErrors.length) {
      // 请求失败和「没有这个文件」是两回事，混着报会让人往错的方向查
      throw new Error(
        `访问 ${t.owner}/${t.repo} 时出错了，不是「没有技能」：\n${hardErrors.slice(0, 3).join('\n')}` +
          (/403|rate limit/i.test(hardErrors.join(' '))
            ? '\n\n看起来是 GitHub API 限额（不带 token 每小时只有 60 次）。设置 → 工具 → GitHub 填一个 token。'
            : ''),
      );
    }
    const mdNames = mdFilesIn(entries).map((f) => f.name);
    throw new Error(
      `在 ${t.owner}/${t.repo}${t.path ? `/${t.path}` : ''} 里没找到技能文件。` +
        (mdNames.length
          ? `\n这个路径下有这些 md：${mdNames.slice(0, 8).join('、')} —— 但它们都没有 ` +
            'YAML frontmatter（开头的 --- 块里要有 name 或 description），所以不像技能。' +
            '\n可以把地址直接指到某个具体的 .md 文件强制安装。'
          : '\n这个路径下一个 md 文件都没有。确认路径，或者指到具体的技能目录。'),
    );
  }
  return found;
}

/** 技能注入成什么样的 system 消息 */
export function skillSystemBlock(skills: Skill[]): string {
  if (!skills.length) return '';
  return skills
    .map(
      (s) =>
        `以下是用户唤起的技能「${s.name}」的指令，本轮请严格按它执行：\n<skill name="${s.name}">\n${s.body}\n</skill>`,
    )
    .join('\n\n');
}
