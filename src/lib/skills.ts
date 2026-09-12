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

async function gh(pathAndQuery: string, ctxLike: unknown): Promise<unknown> {
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

function decodeContent(e: GhEntry): string {
  if (!e.content) return '';
  if (e.encoding === 'base64') {
    const bin = atob(e.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  }
  return e.content;
}

/**
 * 到仓库里找 SKILL.md。
 * 先看给定路径本身，再看它下面一层的每个目录 —— 多数技能仓库是
 * skills/<name>/SKILL.md 这种布局。不做深递归，免得把整个仓库爬一遍。
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

  onProgress?.(`在 ${t.owner}/${t.repo} 里找 SKILL.md…`);

  const found: Skill[] = [];
  const seen = new Set<string>();

  const tryFile = async (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    try {
      const e = (await gh(`${base}/${p}${refQ}`, toolCtx)) as GhEntry;
      if (e && e.type === 'file') {
        const md = decodeContent(e);
        if (!md.trim()) return;
        const parsed = parseSkillMd(md, p.split('/').slice(-2)[0] ?? '');
        if (!parsed.body.trim()) return;
        found.push(
          makeSkill({
            ...parsed,
            source: `github:${t.owner}/${t.repo}/${p}`,
          }),
        );
        onProgress?.(`找到 ${parsed.name}`);
      }
    } catch {
      /* 这个路径没有就算了 */
    }
  };

  const listDir = async (p: string): Promise<GhEntry[]> => {
    try {
      const r = await gh(`${base}${p ? `/${p}` : ''}${refQ}`, toolCtx);
      return Array.isArray(r) ? (r as GhEntry[]) : [];
    } catch {
      return [];
    }
  };

  // 1. 路径直接就是一个 SKILL.md
  if (/SKILL\.md$/i.test(t.path)) {
    await tryFile(t.path);
    if (found.length) return found;
  }

  // 2. 路径下有 SKILL.md
  await tryFile(t.path ? `${t.path}/SKILL.md` : 'SKILL.md');

  // 3. 路径下每个子目录里找一层
  const entries = await listDir(t.path);
  const dirs = entries.filter((e) => e.type === 'dir');
  for (const d of dirs.slice(0, 60)) {
    await tryFile(`${d.path}/SKILL.md`);
  }

  // 4. 仓库根目录常见的几个技能目录
  if (!found.length && !t.path) {
    for (const guess of ['skills', 'Skills', '.claude/skills']) {
      const sub = await listDir(guess);
      for (const d of sub.filter((e) => e.type === 'dir').slice(0, 60)) {
        await tryFile(`${d.path}/SKILL.md`);
      }
      if (found.length) break;
    }
  }

  if (!found.length) {
    throw new Error(
      `在 ${t.owner}/${t.repo}${t.path ? `/${t.path}` : ''} 里没找到 SKILL.md。` +
        '确认一下路径，或者直接指到某个具体的技能目录。',
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
