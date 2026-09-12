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

/** 按 id 取密钥。工具模块通过这个函数拿，拿不到就返回 null */
async function secrets(id) {
  try {
    return store.secretGet(`tool:${id}`);
  } catch {
    return null;
  }
}

const HANDLERS = {
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

  chrome_tabs: (a, c) => chrome.chromeTabs(a, c),
  chrome_navigate: (a, c) => chrome.chromeNavigate(a, c),
  chrome_read_page: (a, c) => chrome.chromeReadPage(a, c),
  chrome_click: (a, c) => chrome.chromeClick(a, c),
  chrome_eval: (a, c) => chrome.chromeEval(a, c),

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

async function runTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return fail(`没有这个工具：${name}`);

  const merged = Object.assign({}, DEFAULT_CTX, ctx || {});
  if (!Array.isArray(merged.workspaceRoots)) merged.workspaceRoots = [];

  try {
    const res = await handler(args && typeof args === 'object' ? args : {}, merged);
    // 保底：任何 handler 都不该返回 undefined
    return res || fail(`${name} 没有返回结果`);
  } catch (e) {
    return fail(e);
  }
}

module.exports = { runTool, TOOL_NAMES: Object.keys(HANDLERS) };
