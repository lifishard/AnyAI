import { getTransport } from './transport';
import { uid } from './store';

/* ------------------------------------------------------------------ *
 * 项目（Project）
 *
 * 一个项目 = 一组对话 + 一份共享的上下文。同一个项目里新开的对话自动继承：
 *   - 项目规范（instructions）→ 拼进 system prompt
 *   - 项目文档（docs）→ 目录进 system prompt，正文按需用工具读
 *   - 项目记忆（memory）→ 模型可以读写，跨对话累积
 *   - 常用提示词（prompts）→ 输入框里一键插入
 *
 * 文档为什么不全量注入：一个项目攒几万字很正常，每轮都塞进去等于每轮
 * 重付一次钱。给目录 + 一个读取工具，让模型自己决定要不要看。
 * ------------------------------------------------------------------ */

const K_PROJECTS = 'snc:projects:v1';

export interface ProjectDoc {
  id: string;
  name: string;
  text: string;
  updatedAt: number;
}

export interface ProjectPrompt {
  id: string;
  label: string;
  text: string;
}

export interface Project {
  id: string;
  name: string;
  emoji: string;
  /** 这个项目里所有对话都要遵守的规范 */
  instructions: string;
  docs: ProjectDoc[];
  prompts: ProjectPrompt[];
  /** 跨对话累积的记忆，模型可读写 */
  memory: string;
  /** 这个项目默认用哪个模型 / 凭据，新开对话时套上 */
  defaultModel?: string;
  defaultKeyProfileId?: string | null;
  createdAt: number;
}

export function makeProject(name: string): Project {
  return {
    id: uid('p'),
    name: name.trim() || '新项目',
    emoji: '📁',
    instructions: '',
    docs: [],
    prompts: [],
    memory: '',
    createdAt: Date.now(),
  };
}

export async function loadProjects(): Promise<Project[]> {
  try {
    const raw = await getTransport().kvGet(K_PROJECTS);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error("记录格式无效");
    return (list as Project[]).map((p) => ({
      ...p,
      docs: p.docs ?? [],
      prompts: p.prompts ?? [],
      memory: p.memory ?? '',
      instructions: p.instructions ?? '',
    }));
  } catch (error) {
    throw new Error(`Project 数据读取失败：${String(error)}`);
  }
}

export async function saveProjects(list: Project[]): Promise<void> {
  await getTransport().kvSet(K_PROJECTS, JSON.stringify(list));
}

/**
 * 项目拼进 system prompt 的那一段。
 * 文档只给目录和字数，正文让模型用 project_doc_read 按需取。
 */
export function projectSystemBlock(p: Project | null): string {
  if (!p) return '';
  const parts: string[] = [`当前项目：${p.name}`];

  if (p.instructions.trim()) {
    parts.push(`项目规范（本项目内所有对话都要遵守）：\n${p.instructions.trim()}`);
  }

  if (p.memory.trim()) {
    parts.push(
      `项目记忆（之前几轮对话里攒下来的，可能有用）：\n${p.memory.trim()}\n` +
        '有值得跨对话记住的结论或约定，用 project_memory_write 追加进去。',
    );
  }

  if (p.docs.length) {
    const index = p.docs
      .map((d) => `  - ${d.name}（${d.text.length} 字）`)
      .join('\n');
    parts.push(
      `项目文档清单（正文没有直接给你，需要时用 project_doc_read 按名字读）：\n${index}`,
    );
  }

  return parts.join('\n\n');
}
