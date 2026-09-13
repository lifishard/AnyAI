'use strict';
/**
 * 工具分发器。渲染进程只发 (name, args, ctx)，密钥由这里自己从安全存储取 ——
 * Tavily / Brave / GitHub 的 token 一律不进渲染进程。
 */
const store = require('../store.cjs');
const { fail } = require('./common.cjs');
const web = require('./web.cjs');
const files = require('./files.cjs');
const shell = require('./shell.cjs');
const chrome = require('./chrome.cjs');
const github = require('./github.cjs');
const claudecode = require('./claudecode.cjs');
const knowledge = require('./knowledge.cjs');
const documents = require('./documents.cjs');
const computer = require('./computer.cjs');
const { runtimeStore } = require('../run-store.cjs');
const { verifyFiles } = require('../file-records.cjs');
const crypto = require('node:crypto');

/** 按 id 取密钥。工具模块通过这个函数拿，拿不到就返回 null */
async function secrets(id) {
  try {
    return store.secretGet(`tool:${id}`);
  } catch {
    return null;
  }
}

const HANDLERS = {
  read_tool_result: (a) => {
    const r = runtimeStore().readResult(String(a.id || ''), a.offset, a.limit);
    return { ok: true, content: JSON.stringify(r), summary: '读取已保存的工具结果' };
  },
  register_outputs: (a, c) => {
    const r = verifyFiles(Array.isArray(a.paths) ? a.paths : [], c.workspaceRoots);
    return { ok: r.errors.length === 0 && r.files.length > 0, content: JSON.stringify(r),
      files: r.files, error: r.errors.map((x) => x.error).join('\n') || undefined,
      summary: `核实 ${r.files.length} 个交付文件` };
  },
  web_search: (a, c) => web.webSearch(a, c, secrets),
  fetch_url: (a, c) => web.fetchUrl(a, c),

  list_dir: (a, c) => files.listDir(a, c),
  read_file: (a, c) => files.readFile(a, c),
  read_document: (a, c) => documents.readDocument(a, c),
  write_document: (a, c) => documents.writeDocument(a, c),
  write_file: (a, c) => files.writeFile(a, c),
  edit_file: (a, c) => files.editFile(a, c),
  search_files: (a, c) => files.searchFiles(a, c),

  run_command: (a, c) => shell.runCommand(a, c),

  computer_screenshot: (a, c) => computer.screenshot(a, c),
  computer_click: (a, c) => computer.click(a, c),
  computer_move: (a, c) => computer.moveMouse(a, c),
  computer_scroll: (a, c) => computer.scroll(a, c),
  computer_type: (a, c) => computer.typeText(a, c),
  computer_key: (a, c) => computer.pressKey(a, c),

  chrome_tabs: (a, c) => chrome.chromeTabs(a, c),
  chrome_navigate: (a, c) => chrome.chromeNavigate(a, c),
  chrome_read_page: (a, c) => chrome.chromeReadPage(a, c),
  chrome_click: (a, c) => chrome.chromeClick(a, c),
  chrome_eval: (a, c) => chrome.chromeEval(a, c),
  chrome_fetch_json: (a, c) => chrome.chromeFetchJson(a, c),

  github_api: (a, c) => github.githubApi(a, c, secrets),
  github_search: (a, c) => github.githubSearch(a, c, secrets),

  claude_code: (a, c) => claudecode.claudeCode(a, c),

  project_memory_read: (a, c) => knowledge.projectMemoryRead(a, c),
  project_memory_write: (a, c) => knowledge.projectMemoryWrite(a, c),
  project_doc_read: (a, c) => knowledge.projectDocRead(a, c),
  project_doc_write: (a, c) => knowledge.projectDocWrite(a, c),
  skill_list: (a, c) => knowledge.skillList(a, c),
  skill_write: (a, c) => knowledge.skillWrite(a, c),
};

const DEFAULT_CTX = {
  workspaceRoots: [],
  searchProvider: 'tavily',
  searxngUrl: '',
  chromePort: 9222,
  claudeBin: '',
  claudeExtraArgs: '',
  claudeTimeoutMs: 600000,
  toolTimeoutMs: 120000,
  projectId: null,
};

async function executeTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return fail(`没有这个工具：${name}`);

  const merged = Object.assign({}, DEFAULT_CTX, ctx || {});
  if (!Array.isArray(merged.workspaceRoots)) merged.workspaceRoots = [];

  const input = args && typeof args === 'object' ? args : {};
  const execution = merged.execution;
  const journal = execution?.runId && execution?.callId ? runtimeStore() : null;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ name, args: input })).digest('hex');
  const readOnly = new Set(['read_tool_result', 'register_outputs', 'web_search', 'fetch_url', 'list_dir',
    'read_file', 'read_document', 'search_files', 'chrome_tabs', 'chrome_read_page', 'chrome_fetch_json', 'github_search',
    'project_memory_read', 'project_doc_read', 'skill_list']);
  if (journal) {
    const previous = journal.job(execution.runId, execution.callId);
    if (previous && previous.fingerprint !== fingerprint) return fail('同一工具调用编号对应了不同参数，已停止执行');
    if (previous?.result) return previous.result;
    if (previous?.status === 'started' && !readOnly.has(name) && !execution.retryUncertain) {
      return { ok: false, content: '', uncertain: true,
        error: '这一步在中断前已开始，但没有可靠的完成记录。请先核实外部结果，再选择跳过或明确允许重试，避免重复操作。' };
    }
    journal.saveJob(execution.runId, execution.callId, { fingerprint, name, status: 'started', at: Date.now() });
  }
  try {
    const res = (await handler(input, merged)) || fail(`${name} 没有返回结果`);
    const outputPaths = [res.filePath, ...(Array.isArray(input.output_files) ? input.output_files : [])].filter(Boolean);
    const inputPaths = ['read_file', 'read_document'].includes(name) && input.path ? [input.path] : [];
    const outputs = verifyFiles(outputPaths, merged.workspaceRoots);
    const inputs = verifyFiles(inputPaths, merged.workspaceRoots, 'input');
    res.files = [...(res.files || []), ...outputs.files, ...inputs.files];
    if (outputs.errors.length) {
      res.content += `\n文件核实失败：${outputs.errors.map((x) => x.error).join('; ')}`;
      if (res.filePath) delete res.filePath;
    }
    if (journal && String(res.content).length > 12000) {
      const raw = String(res.content);
      res.resultRef = journal.saveResult(execution.runId, execution.callId, raw);
      res.content = `${raw.slice(0, 8000)}\n\n[完整结果已保存，${raw.length} 字符；用 read_tool_result(id="${res.resultRef}", offset=8000) 分页读取，不必重新查询。]\n\n${raw.slice(-2000)}`;
    }
    if (journal) journal.saveJob(execution.runId, execution.callId, { fingerprint, name, status: 'completed', result: res, at: Date.now() });
    return res;
  } catch (e) {
    if (journal) return { ok: false, content: '', uncertain: true,
      error: `操作执行或完成记录写入时中断，需要核实结果：${e.message}` };
    return fail(e);
  }
}

// A paused renderer can reconnect while the original native operation still runs.
// Join that operation even when retry was explicitly allowed; never execute it twice concurrently.
const activeJobs = new Map();
async function runTool(name, args, ctx) {
  const execution = ctx?.execution;
  if (!execution?.runId || !execution?.callId) return executeTool(name, args, ctx);
  const key = `${execution.runId}:${execution.callId}`;
  const fingerprint = JSON.stringify({ name, args });
  const active = activeJobs.get(key);
  if (active) return active.fingerprint === fingerprint ? active.promise : fail('同一工具调用编号对应了不同参数，已停止执行');
  const promise = executeTool(name, args, ctx);
  activeJobs.set(key, { fingerprint, promise });
  try { return await promise; }
  finally { if (activeJobs.get(key)?.promise === promise) activeJobs.delete(key); }
}
module.exports = { runTool, TOOL_NAMES: Object.keys(HANDLERS) };
