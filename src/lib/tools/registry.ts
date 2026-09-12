/* ------------------------------------------------------------------ *
 * 工具注册表
 *
 * 这里只声明「有哪些工具、参数长什么样、危不危险、在哪些平台能用」。
 * 真正的执行全在原生层（electron/tools/*.cjs），渲染进程一律通过
 * transport.callTool() 转发 —— 浏览器环境拿不到 fs、也绕不开 CORS。
 *
 * 加一个新工具 = 在 TOOLS 里加一条 + 在 electron/tools/index.cjs 里加一个执行器。
 * ------------------------------------------------------------------ */

export type ToolGroup = 'web' | 'files' | 'shell' | 'chrome' | 'github' | 'agent' | 'project';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDef {
  name: string;
  /** 给模型看的说明，直接进请求体 */
  description: string;
  parameters: JsonSchema;
  group: ToolGroup;
  /** 人看的名字 */
  label: string;
  /**
   * 危险 = 会改变世界的状态（写文件、执行命令、提交 issue）。
   * 这类工具执行前弹确认，除非用户在设置里主动关掉确认。
   */
  dangerous?: boolean;
  /** 需要本机执行能力（手机端必须配好遥控才可用） */
  needsHost?: boolean;
  /** 在步骤轨迹上显示的一句话 */
  summarize(args: Record<string, unknown>): string;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : String(v));
const clip = (v: unknown, n = 48): string => {
  const t = s(v).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export const TOOLS: ToolDef[] = [
  /* ---------------- 联网 ---------------- */
  {
    name: 'web_search',
    label: '联网搜索',
    group: 'web',
    description:
      '在互联网上搜索，返回若干条结果（标题、网址、正文摘要）。需要最新信息、你不确定的事实、具体数字或价格时使用。回答时必须用 [n] 标注引用了第几条来源。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词。用关键词，不要用整句问句。' },
        max_results: { type: 'integer', description: '返回条数，默认 6，最多 10', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
    summarize: (a) => `搜索「${clip(a.query)}」`,
  },
  {
    name: 'fetch_url',
    label: '抓取网页',
    group: 'web',
    description:
      '抓取一个网页并转成 Markdown 正文。搜索结果的摘要不够用、需要看全文时使用。也能用来读 API 返回的 JSON。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整网址，要带 http(s)://' },
        max_chars: { type: 'integer', description: '最多返回多少字符，默认 20000' },
      },
      required: ['url'],
    },
    summarize: (a) => `读取 ${clip(a.url, 60)}`,
  },

  /* ---------------- 本地文件 ---------------- */
  {
    name: 'list_dir',
    label: '列目录',
    group: 'files',
    needsHost: true,
    description: '列出一个目录下的文件和子目录。只能访问设置里配好的工作目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径' },
        depth: { type: 'integer', description: '递归深度，默认 1，最大 4' },
      },
      required: ['path'],
    },
    summarize: (a) => `列出 ${clip(a.path, 60)}`,
  },
  {
    name: 'read_file',
    label: '读文件',
    group: 'files',
    needsHost: true,
    description: '读取一个文本文件的内容。返回带行号，方便后续定位修改。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        start_line: { type: 'integer', description: '从第几行开始，1 起算' },
        max_lines: { type: 'integer', description: '最多读多少行，默认 600' },
      },
      required: ['path'],
    },
    summarize: (a) => `读取 ${clip(a.path, 60)}`,
  },
  {
    name: 'read_document',
    label: '读文档',
    group: 'files',
    needsHost: true,
    description:
      'pdf / docx / xlsx / csv 转成 Markdown 读出来。PDF 会按版面重建（分栏、标题、表格、段落都尽量还原），不是简单拼字符串。read_file 只认纯文本，这几种格式必须用这个。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        pages: { type: 'string', description: 'PDF 页范围，例如 "1-5,8"。留空读前 80 页' },
        sheet: { type: 'string', description: '表格的工作表名，留空读全部' },
        max_rows: { type: 'integer', description: '表格每张表最多读多少行，默认 500' },
        max_chars: { type: 'integer', description: '最多返回多少字符，默认 40000' },
      },
      required: ['path'],
    },
    summarize: (a) => `读文档 ${clip(a.path, 50)}`,
  },
  {
    name: 'write_document',
    label: '生成文档',
    group: 'files',
    needsHost: true,
    dangerous: true,
    description:
      '生成 docx / pdf / xlsx / html。按 path 的扩展名决定格式，content 写 Markdown（标题、列表、表格、粗体、代码块都认）。生成 xlsx 时可以用 rows 传二维数组，或者在 content 里写一张 Markdown 表格。纯文本文件用 write_file，别用这个。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出文件绝对路径，扩展名决定格式' },
        content: { type: 'string', description: 'Markdown 正文' },
        rows: { type: 'array', description: '生成 xlsx 时的二维数组，第一行当表头' },
        sheet: { type: 'string', description: 'xlsx 的工作表名' },
        title: { type: 'string', description: '文档标题，默认取文件名' },
      },
      required: ['path'],
    },
    summarize: (a) => `生成 ${clip(a.path, 50)}`,
  },
  {
    name: 'write_file',
    label: '写文件',
    group: 'files',
    needsHost: true,
    dangerous: true,
    description: '把内容整个写入一个文件，已存在则覆盖。只做整文件替换；改动一小段请用 edit_file。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '完整的文件内容' },
      },
      required: ['path', 'content'],
    },
    summarize: (a) => `写入 ${clip(a.path, 60)}`,
  },
  {
    name: 'edit_file',
    label: '改文件',
    group: 'files',
    needsHost: true,
    dangerous: true,
    description:
      '在文件里把 old_str 替换成 new_str。old_str 必须在文件中唯一出现一次，否则报错 —— 不唯一就多带几行上下文。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        old_str: { type: 'string', description: '要被替换的原文，必须唯一' },
        new_str: { type: 'string', description: '替换成的新内容，可以为空表示删除' },
      },
      required: ['path', 'old_str', 'new_str'],
    },
    summarize: (a) => `修改 ${clip(a.path, 60)}`,
  },
  {
    name: 'search_files',
    label: '搜索代码',
    group: 'files',
    needsHost: true,
    description: '在工作目录里按正则搜索文件内容，返回命中的文件、行号和该行文本。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索根目录，默认第一个工作目录' },
        glob: { type: 'string', description: '文件名过滤，例如 *.ts' },
        max_results: { type: 'integer', description: '最多返回多少条，默认 60' },
      },
      required: ['pattern'],
    },
    summarize: (a) => `搜索代码 /${clip(a.pattern, 40)}/`,
  },

  /* ---------------- 命令行 ---------------- */
  {
    name: 'run_command',
    label: '执行命令',
    group: 'shell',
    needsHost: true,
    dangerous: true,
    description:
      '在工作目录里执行一条 shell 命令，返回 stdout/stderr 和退出码。用于 git、构建、测试等。不要执行交互式命令（会挂住）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '完整命令行' },
        cwd: { type: 'string', description: '工作目录，默认第一个工作目录' },
        timeout_ms: { type: 'integer', description: '超时毫秒，默认 120000' },
      },
      required: ['command'],
    },
    summarize: (a) => `执行 ${clip(a.command, 60)}`,
  },

  /* ---------------- Chrome ---------------- */
  {
    name: 'chrome_tabs',
    label: 'Chrome 标签页',
    group: 'chrome',
    needsHost: true,
    description: '列出 Chrome 当前打开的标签页（id、标题、网址）。操作某个标签页前先用它拿 id。',
    parameters: { type: 'object', properties: {} },
    summarize: () => '列出 Chrome 标签页',
  },
  {
    name: 'chrome_navigate',
    label: 'Chrome 导航',
    group: 'chrome',
    needsHost: true,
    description: '让 Chrome 打开一个网址。不给 tab_id 就新开标签页。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整网址' },
        tab_id: { type: 'string', description: '要复用的标签页 id，留空则新开' },
      },
      required: ['url'],
    },
    summarize: (a) => `Chrome 打开 ${clip(a.url, 50)}`,
  },
  {
    name: 'chrome_read_page',
    label: 'Chrome 读页面',
    group: 'chrome',
    needsHost: true,
    description:
      '读取某个标签页当前渲染出来的正文（转 Markdown）。用它来看需要登录态、或者 JS 渲染后才有内容的页面 —— 这类页面 fetch_url 抓不到。',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: '标签页 id，留空用当前活动标签页' },
        max_chars: { type: 'integer', description: '最多返回多少字符，默认 20000' },
      },
    },
    summarize: () => '读取 Chrome 当前页面',
  },
  {
    name: 'chrome_click',
    label: 'Chrome 点击',
    group: 'chrome',
    needsHost: true,
    dangerous: true,
    description: '在某个标签页里点击一个 CSS 选择器命中的元素。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' },
        tab_id: { type: 'string', description: '标签页 id' },
      },
      required: ['selector'],
    },
    summarize: (a) => `Chrome 点击 ${clip(a.selector, 40)}`,
  },
  {
    name: 'chrome_eval',
    label: 'Chrome 执行脚本',
    group: 'chrome',
    needsHost: true,
    dangerous: true,
    description:
      '在某个标签页里执行一段 JavaScript 并返回结果。填表单、取页面数据等复杂操作用它。注意不要触发 alert/confirm，会卡住页面。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '要执行的 JS 表达式' },
        tab_id: { type: 'string', description: '标签页 id' },
      },
      required: ['expression'],
    },
    summarize: (a) => `Chrome 执行脚本 ${clip(a.expression, 40)}`,
  },

  /* ---------------- GitHub ---------------- */
  {
    name: 'github_api',
    label: 'GitHub API',
    group: 'github',
    description:
      'GitHub REST API 直通。path 从 / 开始写，例如 /repos/owner/name/issues。GET 之外的方法会改动仓库，请谨慎。',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] },
        path: { type: 'string', description: '以 / 开头的 API 路径，可带查询串' },
        body: { type: 'object', description: '请求体，GET 时省略' },
      },
      required: ['method', 'path'],
    },
    dangerous: true,
    summarize: (a) => `GitHub ${s(a.method) || 'GET'} ${clip(a.path, 50)}`,
  },
  {
    name: 'github_search',
    label: 'GitHub 搜索',
    group: 'github',
    description: '搜索 GitHub 上的仓库、代码或 issue。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['repositories', 'code', 'issues'], description: '搜什么' },
        q: { type: 'string', description: 'GitHub 搜索语法的查询串' },
        max_results: { type: 'integer', description: '默认 10' },
      },
      required: ['kind', 'q'],
    },
    summarize: (a) => `GitHub 搜索 ${clip(a.q, 45)}`,
  },

  /* ---------------- Claude Code ---------------- */
  {
    name: 'claude_code',
    label: '调用 Claude Code',
    group: 'agent',
    needsHost: true,
    dangerous: true,
    description:
      '把一整件编码工作交给本机的 Claude Code 去做：它会自己读写文件、跑命令、用 git，最后回报结果。适合「重构这个模块」「修好这个失败的测试」这种多步骤任务。任务描述要写全，它看不到我们这边的对话历史。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '完整、自包含的任务描述' },
        cwd: { type: 'string', description: '在哪个目录跑，默认第一个工作目录' },
      },
      required: ['prompt'],
    },
    summarize: (a) => `Claude Code：${clip(a.prompt, 50)}`,
  },

  /* ---------------- 项目与技能 ---------------- */
  {
    name: 'project_memory_read',
    label: '读项目记忆',
    group: 'project',
    description:
      '读当前项目的记忆 —— 之前几轮对话里攒下来的结论和约定。开始一件跟这个项目有关的事之前，值得先看一眼。',
    parameters: { type: 'object', properties: {} },
    summarize: () => '读项目记忆',
  },
  {
    name: 'project_memory_write',
    label: '写项目记忆',
    group: 'project',
    description:
      '往当前项目的记忆里追加一条。只写**跨对话还成立**的东西：确定下来的决策、踩过的坑、用户明确的偏好。这一轮的临时细节不要写。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记下来的内容，一两句话' },
        mode: { type: 'string', enum: ['append', 'replace'], description: '默认 append' },
      },
      required: ['text'],
    },
    summarize: (a) => `记到项目记忆：${clip(a.text, 40)}`,
  },
  {
    name: 'project_doc_read',
    label: '读项目文档',
    group: 'project',
    description:
      '读当前项目里的一篇文档。不给 name 就返回文档清单。文档正文不会自动进上下文，需要才读。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文档名，留空则列出全部' },
        max_chars: { type: 'integer', description: '最多返回多少字符，默认 20000' },
      },
    },
    summarize: (a) => (a.name ? `读文档《${clip(a.name, 30)}》` : '列出项目文档'),
  },
  {
    name: 'project_doc_write',
    label: '写项目文档',
    group: 'project',
    dangerous: true,
    description: '在当前项目里新建或覆盖一篇文档。同名就覆盖。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文档名' },
        text: { type: 'string', description: '完整正文' },
      },
      required: ['name', 'text'],
    },
    summarize: (a) => `写文档《${clip(a.name, 30)}》`,
  },
  {
    name: 'skill_list',
    label: '列出技能',
    group: 'project',
    description: '列出用户已经装了哪些技能，以及每个是干什么的。',
    parameters: { type: 'object', properties: {} },
    summarize: () => '列出技能',
  },
  {
    name: 'skill_write',
    label: '创建技能',
    group: 'project',
    dangerous: true,
    description:
      '把一套做法固化成技能，之后用户打 /名字 就能唤起。用户说「把刚才那套流程存成技能」时用它。body 要写成一份自包含的操作指令，别依赖当前对话的上下文。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名，英文小写加连字符最稳' },
        description: { type: 'string', description: '一句话说明什么时候该用' },
        body: { type: 'string', description: '指令正文，Markdown，自包含' },
      },
      required: ['name', 'body'],
    },
    summarize: (a) => `创建技能 /${clip(a.name, 30)}`,
  },
];

export const TOOL_BY_NAME: Record<string, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);

export const GROUP_LABEL: Record<ToolGroup, string> = {
  web: '联网',
  files: '本地文件',
  shell: '命令行',
  chrome: 'Chrome',
  github: 'GitHub',
  agent: 'Agent',
  project: '项目与技能',
};

/** 新会话默认开这些：够用、且都是只读的 */
export const DEFAULT_ENABLED_TOOLS = [
  'web_search',
  'fetch_url',
  'project_memory_read',
  'project_memory_write',
  'project_doc_read',
  'list_dir',
  'read_file',
  'search_files',
  'chrome_tabs',
  'chrome_read_page',
  'github_search',
];

/** 翻译成请求体里的 tools 字段 */
export function toolsPayload(names: string[]): unknown[] {
  return names
    .map((n) => TOOL_BY_NAME[n])
    .filter(Boolean)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
}

/** 当前平台实际可用的工具 */
export function availableTools(canRunHostTools: boolean): ToolDef[] {
  return TOOLS.filter((t) => (t.needsHost ? canRunHostTools : true));
}
