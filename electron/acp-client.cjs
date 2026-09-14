'use strict';

const { spawn: nativeSpawn } = require('node:child_process');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const ACP_PROTOCOL_VERSION = 1;
const MAX_OUTPUT_BYTES = 2 * 1000 * 1000;
const MAX_FRAME_BYTES = 8 * 1000 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;

// Kimi's official login state is read by the native client from its normal
// user-data location. Keep only platform/runtime variables here: provider
// keys, custom endpoints, token overrides, and Node startup flags never cross
// the Electron process boundary.
function safeEnvironment(source = process.env) {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|LANG|LC_ALL|TERM)$/i;
  return {
    ...Object.fromEntries(Object.entries(source || {}).filter(([key]) => allowed.test(key))),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

function validateExecutable(binary, platform = process.platform) {
  if (!binary || !path.isAbsolute(binary) || /\.(cmd|bat|ps1|js|mjs|cjs|sh|bash)$/i.test(binary)) {
    throw Error('Configure the official native Kimi executable using an absolute path; shell scripts and shims are not accepted.');
  }
  if (platform === 'win32' && !/\.exe$/i.test(binary)) {
    throw Error('On Windows, configure the official Kimi .exe executable using an absolute path.');
  }
  return binary;
}

function validateCwd(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) throw Error('Kimi ACP requires an absolute project directory.');
  return cwd;
}

function finiteTimeout(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function clipText(value, limit = 4000) {
  const text = String(value || '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function errorMessage(error, fallback = 'Kimi ACP request failed.') {
  const value = clipText(error?.message || error || fallback).replace(/(bearer\s+|sk-[a-z0-9_-]{8,})[^\s]*/gi, '$1[redacted]');
  return value || fallback;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stringValue(value, fallback = '') {
  return typeof value === 'string' ? clipText(value) : fallback;
}

function bool(value) {
  return value === true;
}

function optionValues(option) {
  const values = [];
  const options = option?.options;
  if (!Array.isArray(options)) return values;
  for (const entry of options) {
    if (entry && typeof entry === 'object' && Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        if (nested && typeof nested.value === 'string') values.push({ id: nested.value, name: stringValue(nested.name, nested.value), description: stringValue(nested.description) || null });
      }
    } else if (entry && typeof entry.value === 'string') {
      values.push({ id: entry.value, name: stringValue(entry.name, entry.value), description: stringValue(entry.description) || null });
    }
  }
  const seen = new Set();
  return values.filter(entry => !seen.has(entry.id) && seen.add(entry.id));
}

function normalizedItem(entry, fallbackId = '') {
  if (typeof entry === 'string') return entry ? { id: clipText(entry, 240), name: clipText(entry, 240), description: null } : null;
  if (!entry || typeof entry !== 'object') return null;
  const id = entry.id ?? entry.modelId ?? entry.model_id ?? entry.value ?? entry.name;
  if (typeof id !== 'string' || !id) return null;
  const name = entry.name ?? entry.title ?? id;
  return {
    id: clipText(id, 240),
    name: clipText(typeof name === 'string' && name ? name : id, 240),
    description: typeof entry.description === 'string' ? clipText(entry.description, 400) : null,
  };
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter(item => item && !seen.has(item.id) && seen.add(item.id));
}

function configCategory(option) {
  return typeof option?.category === 'string' ? option.category.toLowerCase() : '';
}

function isConfigOption(option, kind) {
  if (!option || typeof option !== 'object') return false;
  const id = typeof option.id === 'string' ? option.id.toLowerCase() : '';
  const category = configCategory(option);
  if (kind === 'model') return category === 'model' || id === 'model' || id === 'models';
  if (kind === 'mode') return category === 'mode' || id === 'mode' || id === 'modes';
  if (kind === 'effort') return category === 'thought_level' || /^(effort|thinking|thought_level|reasoning)(?:[_-].*)?$/.test(id);
  return false;
}

function currentValue(option) {
  if (!option || typeof option !== 'object') return null;
  if (typeof option.currentValue === 'string') return option.currentValue;
  if (typeof option.currentValue === 'boolean') return option.currentValue ? 'on' : 'off';
  return null;
}

function safeAgentInfo(value) {
  if (!value || typeof value !== 'object') return null;
  const name = typeof value.name === 'string' ? clipText(value.name, 160) : '';
  const title = typeof value.title === 'string' ? clipText(value.title, 160) : '';
  const version = typeof value.version === 'string' ? clipText(value.version, 80) : '';
  if (!name && !title && !version) return null;
  return { name: name || null, title: title || null, version: version || null };
}

// Authentication details may be attached to ACP's AUTH_REQUIRED error. Keep
// only the display fields so a caller can explain how to sign in without
// exposing command arguments, environment values, or provider data.
function safeAuthMethods(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(method => {
    if (!method || typeof method !== 'object') return null;
    const id = typeof method.id === 'string' ? clipText(method.id, 120) : '';
    const name = typeof method.name === 'string' ? clipText(method.name, 240) : '';
    const description = typeof method.description === 'string' ? clipText(method.description, 500) : null;
    const type = typeof method.type === 'string' ? clipText(method.type, 80) : null;
    return id && name ? { id, name, description, ...(type ? { type } : {}) } : null;
  }).filter(Boolean);
}

function capabilityObject(value) {
  const caps = value && typeof value === 'object' ? value : {};
  const session = caps.sessionCapabilities && typeof caps.sessionCapabilities === 'object' ? caps.sessionCapabilities : {};
  const auth = caps.auth && typeof caps.auth === 'object' ? caps.auth : {};
  const prompt = caps.promptCapabilities && typeof caps.promptCapabilities === 'object' ? caps.promptCapabilities : {};
  const mcp = caps.mcpCapabilities && typeof caps.mcpCapabilities === 'object' ? caps.mcpCapabilities : {};
  return {
    loadSession: bool(caps.loadSession),
    prompt: { image: bool(prompt.image), audio: bool(prompt.audio), embeddedContext: bool(prompt.embeddedContext) },
    mcp: { http: bool(mcp.http), sse: bool(mcp.sse) },
    session: {
      list: session.list != null,
      delete: session.delete != null,
      additionalDirectories: session.additionalDirectories != null,
      resume: session.resume != null,
      close: session.close != null,
    },
    auth: { logout: auth.logout != null },
  };
}

function normalizeModels(result, options) {
  const direct = Array.isArray(result?.models)
    ? result.models.map(entry => normalizedItem(entry)).filter(Boolean)
    : Array.isArray(result?.models?.availableModels)
      ? result.models.availableModels.map(entry => normalizedItem(entry)).filter(Boolean)
      : [];
  const modelOption = options.find(option => isConfigOption(option, 'model'));
  return dedupeItems([...direct, ...optionValues(modelOption)]);
}

function normalizeModes(result, options) {
  const available = Array.isArray(result?.modes?.availableModes) ? result.modes.availableModes.map(entry => normalizedItem(entry)).filter(Boolean) : [];
  const modeOption = options.find(option => isConfigOption(option, 'mode'));
  return dedupeItems([...available, ...optionValues(modeOption)]);
}

function normalizeEfforts(options) {
  const effortOption = options.find(option => isConfigOption(option, 'effort'));
  if (!effortOption) return [];
  if (effortOption.type === 'boolean') return [{ id: 'off', name: 'Off', description: null }, { id: 'on', name: 'On', description: null }];
  return optionValues(effortOption);
}

function normalizeInspection(initialize, session) {
  const result = session && typeof session === 'object' ? session : {};
  const rawOptions = Array.isArray(result.configOptions) ? result.configOptions.filter(option => option && typeof option === 'object') : [];
  const models = normalizeModels(result, rawOptions);
  const modes = normalizeModes(result, rawOptions);
  const efforts = normalizeEfforts(rawOptions);
  const modelOption = rawOptions.find(option => isConfigOption(option, 'model'));
  const modeOption = rawOptions.find(option => isConfigOption(option, 'mode'));
  const effortOption = rawOptions.find(option => isConfigOption(option, 'effort'));
  return {
    sessionId: typeof result.sessionId === 'string' && result.sessionId ? result.sessionId : null,
    protocolVersion: initialize?.protocolVersion ?? null,
    agent: safeAgentInfo(initialize?.agentInfo),
    capabilities: capabilityObject(initialize?.agentCapabilities),
    models,
    modes,
    efforts,
    current: {
      model: currentValue(modelOption) || (typeof result.currentModelId === 'string' ? result.currentModelId : null) || (typeof result.models?.currentModelId === 'string' ? result.models.currentModelId : null),
      mode: currentValue(modeOption) || (typeof result.modes?.currentModeId === 'string' ? result.modes.currentModeId : null),
      effort: currentValue(effortOption),
    },
  };
}

function configSpecs(result) {
  const options = Array.isArray(result?.configOptions) ? result.configOptions.filter(option => option && typeof option === 'object' && typeof option.id === 'string') : [];
  return {
    options,
    model: options.find(option => isConfigOption(option, 'model')) || null,
    mode: options.find(option => isConfigOption(option, 'mode')) || null,
    effort: options.find(option => isConfigOption(option, 'effort')) || null,
  };
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result = {};
  if (Number.isFinite(usage.used) && usage.used >= 0) result.used = usage.used;
  if (Number.isFinite(usage.size) && usage.size >= 0) result.size = usage.size;
  if (usage.cost && typeof usage.cost === 'object' && Number.isFinite(usage.cost.amount) && usage.cost.amount >= 0 && typeof usage.cost.currency === 'string' && /^[A-Z]{3}$/.test(usage.cost.currency)) {
    result.cost = { amount: usage.cost.amount, currency: usage.cost.currency };
  }
  return Object.keys(result).length ? result : null;
}

function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = Math.max(0, Math.min(text.length, maxBytes));
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return text.slice(0, end);
}

function createAcpClient({
  binary,
  cwd,
  spawn = nativeSpawn,
  env = process.env,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  cancelTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS,
  platform = process.platform,
} = {}) {
  // Validate against the host platform by default. An injectable platform is
  // useful for offline tests and does not change the public contract.
  if (!binary || !path.isAbsolute(binary) || /\.(cmd|bat|ps1|js|mjs|cjs|sh|bash)$/i.test(binary) || (platform === 'win32' && !/\.exe$/i.test(binary))) {
    throw Error(platform === 'win32'
      ? 'On Windows, configure the official Kimi .exe executable using an absolute path.'
      : 'Configure the official native Kimi executable using an absolute path; shell scripts and shims are not accepted.');
  }
  validateCwd(cwd);

  const requestTimeout = finiteTimeout(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const turnTimeout = finiteTimeout(turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
  const cancelTimeout = finiteTimeout(cancelTimeoutMs, DEFAULT_CANCEL_TIMEOUT_MS);
  const safeEnv = safeEnvironment(env);
  let child = null;
  let dead = false;
  let nextId = 1;
  let handshakePromise = null;
  let inspectionPromise = null;
  let initializeResult = null;
  let inspection = null;
  let sessionResult = null;
  let specs = { options: [], model: null, mode: null, effort: null };
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  const pending = new Map();
  let active = null;

  function send(message) {
    if (dead || !child?.stdin?.writable) throw Error('Kimi ACP connection is closed.');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function rejectError(message, unknown = false) {
    const error = Error(message);
    if (unknown) error.unknown = true;
    return error;
  }

  function clearPending() {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(rejectError(entry.reason || 'Kimi ACP connection closed.', entry.unknown));
    }
    pending.clear();
  }

  function settleActive(status, error = null) {
    const run = active;
    if (!run || run.settled) return;
    run.settled = true;
    clearTimeout(run.timer);
    clearTimeout(run.cancelTimer);
    run.signal?.removeEventListener('abort', run.abort);
    for (const permission of run.permissions.values()) {
      clearTimeout(permission.timer);
      permission.settled = true;
    }
    run.permissions.clear();
    active = null;
    const result = {
      status,
      text: run.text,
      sessionId: run.sessionId || null,
    };
    if (error) result.error = clipText(errorMessage(error));
    if (run.usage) result.usage = clone(run.usage);
    run.resolve(result);
  }

  function disconnect(reason, unknown = true) {
    if (dead) return;
    dead = true;
    clearPending();
    settleActive('unknown', reason);
    try { child?.kill(); } catch { /* already exited */ }
  }

  function request(method, params = {}, { timeoutMs = requestTimeout, onId = null, kind = method } = {}) {
    return new Promise((resolve, reject) => {
      if (dead) {
        reject(rejectError('Kimi ACP connection is closed.', true));
        return;
      }
      const id = nextId++;
      const entry = { resolve, reject, kind, timer: null, unknown: false, reason: null };
      entry.timer = setTimeout(() => {
        pending.delete(id);
        entry.unknown = true;
        entry.reason = `Kimi ACP ${method} timed out; execution state is unknown.`;
        const error = rejectError(entry.reason, true);
        reject(error);
        disconnect(entry.reason, true);
      }, timeoutMs);
      pending.set(id, entry);
      try {
        onId?.(id);
        send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(error);
      }
    });
  }

  function sendResponse(message) {
    try { send(message); } catch (error) { disconnect(errorMessage(error), true); }
  }

  function permissionOption(options, kind) {
    return (Array.isArray(options) ? options : []).find(option => option && typeof option.optionId === 'string' && option.kind === kind) || null;
  }

  function safeToolCall(value) {
    if (!value || typeof value !== 'object') return {};
    const allowed = ['toolCallId', 'kind', 'title', 'status', 'locations'];
    const result = {};
    let locationsUnsafe = false;
    for (const key of allowed) {
      if (key === 'locations' && Array.isArray(value.locations)) {
        if (value.locations.length > 50) locationsUnsafe = true;
        result.locations = value.locations.slice(0, 50).map(location => ({
          path: typeof location?.path === 'string' ? clipText(location.path, 1000) : '',
          ...(Number.isInteger(location?.line) ? { line: location.line } : {}),
        })).filter(location => {
          if (!location.path) locationsUnsafe = true;
          if (location.path.length >= 1000) locationsUnsafe = true;
          return true;
        });
      } else if (typeof value[key] === 'string') result[key] = clipText(value[key], 1000);
      else if (key === 'status' && value[key] != null) result[key] = clipText(value[key], 1000);
    }
    if (locationsUnsafe) result.locationsUnsafe = true;
    return result;
  }

  function normalizeApprovalChoice(choice, params) {
    const options = Array.isArray(params?.options) ? params.options.filter(option => option && typeof option.optionId === 'string') : [];
    const firstReject = permissionOption(options, 'reject_once') || permissionOption(options, 'reject_always');
    const firstAllow = permissionOption(options, 'allow_once');
    let value = choice;
    if (value && typeof value === 'object') {
      if (typeof value.optionId === 'string') value = value.optionId;
      else if (typeof value.decision === 'string') value = value.decision;
      else if (typeof value.outcome?.optionId === 'string') value = value.outcome.optionId;
    }
    if (value === true || value === 'accept' || value === 'allow') value = firstAllow?.optionId || null;
    if (value === false || value == null || value === 'decline' || value === 'reject' || value === 'cancelled' || value === 'cancel') value = firstReject?.optionId || null;
    const selected = options.find(option => option.optionId === value) || null;
    // The host approval API is intentionally one-action scoped. Never turn a
    // boolean approval into Kimi's session-wide allow_always grant.
    if (!selected || (selected.kind !== 'allow_once' && !/^reject_/.test(String(selected.kind)))) {
      return { outcome: { outcome: 'cancelled' }, denied: true };
    }
    const denied = !String(selected.kind).startsWith('allow_');
    return { outcome: { outcome: 'selected', optionId: selected.optionId }, denied };
  }

  function finishPermission(run, id, choice, reason = 'user') {
    const entry = run.permissions.get(id);
    if (!entry || entry.settled) return;
    run.permissions.delete(id);
    clearTimeout(entry.timer);
    entry.settled = true;
    const selected = reason === 'cancelled' || run.cancelRequested
      ? { outcome: { outcome: 'cancelled' }, denied: true }
      : normalizeApprovalChoice(choice, entry.params);
    if (selected.denied) run.denied = true;
    if (!dead) sendResponse({ jsonrpc: '2.0', id, result: { outcome: selected.outcome } });
  }

  function handlePermission(message) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const run = active;
    if (!run || run.settled || !run.promptStarted || params.sessionId !== run.sessionId) {
      sendResponse({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Permission request does not match the active ACP session.' } });
      return;
    }
    if (run.permissions.has(message.id)) {
      sendResponse({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Duplicate ACP permission request id.' } });
      return;
    }
    const options = Array.isArray(params.options) ? params.options.slice(0, 32).map(option => ({
      optionId: typeof option?.optionId === 'string' ? clipText(option.optionId, 160) : '',
      name: typeof option?.name === 'string' ? clipText(option.name, 400) : '',
      kind: typeof option?.kind === 'string' ? clipText(option.kind, 80) : '',
    })).filter(option => option.optionId && option.name) : [];
    const request = {
      type: 'permission_required',
      requestId: message.id,
      sessionId: run.sessionId,
      toolCall: safeToolCall(params.toolCall),
      options,
    };
    const entry = { params: { ...params, options }, timer: null, settled: false };
    run.permissions.set(message.id, entry);
    entry.timer = setTimeout(() => finishPermission(run, message.id, null, 'timeout'), requestTimeout);
    if (run.cancelRequested || dead) {
      finishPermission(run, message.id, null, 'cancelled');
      return;
    }
    if (typeof run.onApproval !== 'function') {
      finishPermission(run, message.id, null, 'declined');
      return;
    }
    Promise.resolve().then(() => run.onApproval(clone(request))).then(choice => finishPermission(run, message.id, choice), () => finishPermission(run, message.id, null, 'callback_error'));
  }

  function unsupportedServerRequest(message) {
    sendResponse({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'This client does not provide host file, terminal, MCP, or elicitation authority.' } });
  }

  function textBlocks(update) {
    if (!update || typeof update !== 'object') return [];
    const content = update.content;
    if (Array.isArray(content)) return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text);
    if (content && content.type === 'text' && typeof content.text === 'string') return [content.text];
    if (typeof update.text === 'string') return [update.text];
    return [];
  }

  function appendText(run, delta) {
    if (!delta) return true;
    const bytes = Buffer.byteLength(delta, 'utf8');
    if (run.outputBytes + bytes > MAX_OUTPUT_BYTES) {
      disconnect('Kimi ACP agent output exceeded the 2 MB limit; execution state is unknown.', true);
      return false;
    }
    run.text += delta;
    run.outputBytes += bytes;
    return true;
  }

  function emitText(run, delta) {
    if (!appendText(run, delta) || run.settled) return;
    try { run.onEvent?.({ type: 'text', delta }); } catch (error) { disconnect('Kimi ACP text event could not be recorded; execution state is unknown.', true); }
  }

  function updateStateFromOptions(rawOptions) {
    if (!Array.isArray(rawOptions)) return;
    const filtered = rawOptions.filter(option => option && typeof option === 'object');
    if (!sessionResult) sessionResult = {};
    sessionResult = { ...sessionResult, configOptions: filtered };
    specs = configSpecs(sessionResult);
    if (inspection) {
      inspection = normalizeInspection(initializeResult, sessionResult);
      inspectionPromise = Promise.resolve(clone(inspection));
    }
  }

  function handleNotification(message) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    if (message.method === 'session/update') {
      if (typeof params.sessionId !== 'string') return;
      if (active && params.sessionId === active.sessionId && active.promptStarted) {
        const update = params.update && typeof params.update === 'object' ? params.update : {};
        if (update.sessionUpdate === 'agent_message_chunk') {
          for (const delta of textBlocks(update)) emitText(active, delta);
        } else if (update.sessionUpdate === 'usage_update') {
          active.usage = safeUsage(update);
        } else if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
          updateStateFromOptions(update.configOptions);
        }
      } else if (inspection && params.sessionId === inspection.sessionId) {
        const update = params.update && typeof params.update === 'object' ? params.update : {};
        if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) updateStateFromOptions(update.configOptions);
      }
      // `agent_thought_chunk`, tool calls, plans, and other updates are
      // intentionally not forwarded to the host chat stream.
      return;
    }
    // ACP has no standard initialized notification. Other notifications are
    // harmless and must not be interpreted as model text.
  }

  function accept(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (typeof message.method === 'string' && Object.hasOwn(message, 'id')) {
      if (message.method === 'session/request_permission') handlePermission(message);
      else unsupportedServerRequest(message);
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        if (entry.kind === 'session/prompt' && message.error.code === -32800) entry.resolve({ stopReason: 'cancelled', __cancelledError: true });
        else {
          const error = rejectError(errorMessage(message.error, 'Kimi ACP request failed.'));
          if (Number.isInteger(message.error.code)) error.code = message.error.code;
          if (message.error.code === -32000 || /auth(?:entication)?[_ -]?required|login required/i.test(String(message.error.message || ''))) error.authRequired = true;
          const authMethods = message.error.data?.authMethods || message.error.data?.auth_methods;
          if (Array.isArray(authMethods)) error.authMethods = safeAuthMethods(authMethods);
          entry.reject(error);
        }
      } else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
      else entry.reject(Error('Malformed Kimi ACP response.'));
      return;
    }
    if (typeof message.method === 'string') handleNotification(message);
  }

  function attachChild(processObject) {
    child = processObject;
    if (!child || !child.stdout || !child.stdin) throw Error('The Kimi ACP process did not expose stdio streams.');
    child.on('error', () => disconnect('The official Kimi ACP process could not start.', false));
    child.on('close', (code, signal) => {
      if (!dead) disconnect(`Kimi ACP process exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''}); no matching terminal response was received.`, true);
    });
    child.stdin.on?.('error', () => disconnect('Kimi ACP input stream closed; execution state is unknown.', true));
    child.stderr?.on?.('data', () => {}); // Diagnostics can contain paths or credentials; never persist them.
    child.stdout.on('data', chunk => {
      if (dead) return;
      try {
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        let newline;
        while (!dead && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
            disconnect('Kimi ACP protocol frame exceeded the 8 MB limit; execution state is unknown.', true);
            return;
          }
          try { accept(JSON.parse(line)); } catch { disconnect('Kimi ACP returned an invalid protocol frame; execution state is unknown.', true); }
        }
        // A single stdout chunk can contain many complete frames. Only the
        // currently incomplete frame is subject to the accumulator limit.
        if (!dead && Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
          disconnect('Kimi ACP protocol frame exceeded the 8 MB limit; execution state is unknown.', true);
          return;
        }
      } catch { disconnect('Kimi ACP output could not be decoded; execution state is unknown.', true); }
    });
  }

  function start() {
    if (handshakePromise) return handshakePromise;
    handshakePromise = (async () => {
      if (dead) throw rejectError('Kimi ACP connection is closed.', true);
      let processObject;
      try {
        processObject = spawn(binary, ['acp'], {
          cwd,
          env: safeEnv,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        attachChild(processObject);
      } catch (error) {
        dead = true;
        throw error;
      }
      initializeResult = await request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // No filesystem, terminal, elicitation, or MCP bridge is advertised.
        // Kimi must therefore not receive authority over the host through
        // this client, including when the selected mode is "work".
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'wickrunai', title: 'wickrunAI', version: '2.0.1' },
      });
      if (!initializeResult || initializeResult.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw rejectError(`Kimi ACP negotiated unsupported protocol version ${initializeResult?.protocolVersion ?? 'unknown'}.`);
      }
      return {
        protocolVersion: initializeResult.protocolVersion,
        agent: safeAgentInfo(initializeResult.agentInfo),
        capabilities: capabilityObject(initializeResult.agentCapabilities),
      };
    })().catch(error => {
      if (!dead) disconnect(errorMessage(error), !!error.unknown);
      throw error;
    });
    return handshakePromise;
  }

  async function inspect() {
    if (inspectionPromise) return clone(await inspectionPromise);
    inspectionPromise = (async () => {
      await start();
      sessionResult = await request('session/new', { cwd, mcpServers: [] });
      if (!sessionResult || typeof sessionResult.sessionId !== 'string' || !sessionResult.sessionId) throw Error('Kimi ACP did not return a session id.');
      specs = configSpecs(sessionResult);
      inspection = normalizeInspection(initializeResult, sessionResult);
      return clone(inspection);
    })().catch(error => {
      inspectionPromise = null;
      throw error;
    });
    return clone(await inspectionPromise);
  }

  function supportedIds(kind) {
    if (kind === 'model') {
      const values = optionValues(specs.model);
      if (values.length) return values.map(value => value.id);
      return inspection?.models?.map(item => item.id) || [];
    }
    if (kind === 'effort') return normalizeEfforts([specs.effort]).map(item => item.id);
    if (kind === 'mode') {
      const values = optionValues(specs.mode);
      if (values.length) return values.map(value => value.id);
      return inspection?.modes?.map(item => item.id) || [];
    }
    return [];
  }

  function assertSupported(kind, value) {
    if (typeof value !== 'string' || !value) throw Error(`Kimi ACP ${kind} must be a non-empty supported value.`);
    const ids = supportedIds(kind);
    if (!ids.includes(value)) throw Error(`Kimi ACP does not advertise ${kind} value "${clipText(value, 120)}".`);
  }

  function chooseMode(requested) {
    const modes = inspection?.modes || [];
    if (!modes.length) return null;
    const lower = mode => `${mode.id} ${mode.name}`.toLowerCase();
    if (requested === 'chat') {
      const safe = modes.find(mode => mode.id === 'plan') || modes.find(mode => /\b(read[- ]?only|plan|chat)\b/.test(lower(mode)));
      if (safe) return safe.id;
      const manual = modes.find(mode => mode.id === 'default');
      if (manual) return manual.id;
      if (modes.every(mode => /^(auto|yolo)$/i.test(mode.id))) throw Error('Kimi ACP did not advertise a safe chat mode; refusing to select a permissive mode.');
      return null;
    }
    const manual = modes.find(mode => /^(default|work|agent)$/i.test(mode.id)) || modes.find(mode => /\b(default|work|agent|manual)\b/.test(lower(mode)));
    if (manual) return manual.id;
    if (modes.some(mode => /^(auto|yolo)$/i.test(mode.id)) && modes.every(mode => /^(auto|yolo)$/i.test(mode.id))) return null;
    return modes.find(mode => !/^(auto|yolo)$/i.test(mode.id))?.id || null;
  }

  async function configure(state, options) {
    const requestedMode = options.mode || 'chat';
    if (requestedMode !== 'chat' && requestedMode !== 'work') throw Error('Kimi ACP mode must be "chat" or "work".');
    if (options.model !== undefined) {
      assertSupported('model', options.model);
      if (specs.model) {
        const response = await request('session/set_config_option', { sessionId: state.sessionId, configId: specs.model.id, value: options.model });
        if (response?.configOptions) updateStateFromOptions(response.configOptions);
      } else {
        await request('session/set_model', { sessionId: state.sessionId, model: options.model });
      }
    }
    if (options.effort !== undefined) {
      assertSupported('effort', options.effort);
      if (!specs.effort) throw Error('Kimi ACP did not advertise a session effort option.');
      const response = await request('session/set_config_option', { sessionId: state.sessionId, configId: specs.effort.id, value: options.effort });
      if (response?.configOptions) updateStateFromOptions(response.configOptions);
    }
    const modeId = chooseMode(requestedMode);
    if (modeId) {
      const response = await request('session/set_mode', { sessionId: state.sessionId, modeId });
      if (response?.configOptions) updateStateFromOptions(response.configOptions);
    }
  }

  async function run(options = {}) {
    if (active) throw Error('A Kimi ACP turn is already active.');
    if (typeof options.prompt !== 'string' || !options.prompt.trim()) throw Error('A prompt is required.');
    if (options.mode !== undefined && options.mode !== 'chat' && options.mode !== 'work') throw Error('Kimi ACP mode must be "chat" or "work".');
    if (options.signal?.aborted) return { status: 'cancelled', text: '', sessionId: null };

    let resolve;
    const outcome = new Promise(done => { resolve = done; });
    const state = active = {
      resolve,
      sessionId: null,
      promptRequestId: null,
      promptStarted: false,
      text: '',
      outputBytes: 0,
      usage: null,
      denied: false,
      cancelRequested: false,
      cancelReason: null,
      cancelTimer: null,
      timer: null,
      permissions: new Map(),
      onEvent: options.onEvent,
      onApproval: options.onApproval,
      signal: options.signal,
      settled: false,
      abort: null,
    };

    const cancel = () => {
      if (state.settled || state.cancelRequested) return;
      state.cancelRequested = true;
      state.cancelReason = 'user';
      for (const id of [...state.permissions.keys()]) finishPermission(state, id, null, 'cancelled');
      if (!state.promptStarted || !state.sessionId) {
        settleActive('cancelled');
        return;
      }
      try { send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: state.sessionId } }); } catch (error) { disconnect(errorMessage(error), true); return; }
      state.cancelTimer = setTimeout(() => {
        if (!state.settled) disconnect('Kimi ACP cancellation was not confirmed; execution state is unknown.', true);
      }, cancelTimeout);
    };
    state.abort = cancel;
    state.signal?.addEventListener('abort', cancel, { once: true });
    state.timer = setTimeout(() => {
      if (state.settled || state.cancelRequested) return;
      state.cancelRequested = true;
      state.cancelReason = 'timeout';
      for (const id of [...state.permissions.keys()]) finishPermission(state, id, null, 'cancelled');
      if (!state.promptStarted || !state.sessionId) { settleActive('unknown', 'Kimi ACP turn timed out before a prompt was submitted.'); return; }
      try { send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: state.sessionId } }); } catch { disconnect('Kimi ACP turn timed out; execution state is unknown.', true); return; }
      state.cancelTimer = setTimeout(() => { if (!state.settled) disconnect('Kimi ACP turn timed out; cancellation was not confirmed.', true); }, cancelTimeout);
    }, turnTimeout);

    (async () => {
      try {
        const info = await inspect();
        if (state.settled) return;
        state.sessionId = info.sessionId;
        await configure(state, options);
        if (state.settled) return;
        if (state.cancelRequested) { settleActive(state.cancelReason === 'user' ? 'cancelled' : 'unknown', state.cancelReason === 'timeout' ? 'Kimi ACP turn timed out.' : null); return; }
        state.promptStarted = true;
        const response = await request('session/prompt', { sessionId: state.sessionId, prompt: [{ type: 'text', text: options.prompt }] }, {
          timeoutMs: turnTimeout + cancelTimeout,
          kind: 'session/prompt',
          onId: id => { state.promptRequestId = id; },
        });
        if (state.settled) return;
        const stopReason = response?.stopReason;
        if (state.cancelRequested) {
          if (state.cancelReason === 'user' && stopReason === 'cancelled') settleActive('cancelled');
          else settleActive('unknown', state.cancelReason === 'timeout' ? 'Kimi ACP turn timed out.' : 'Kimi ACP cancellation was not confirmed.');
          return;
        }
        if (stopReason === 'end_turn') {
          if (state.denied) settleActive('permission_required', 'A permission request was declined.');
          else settleActive('completed');
        } else if (stopReason === 'cancelled') settleActive('cancelled');
        else if (typeof stopReason === 'string' && stopReason) settleActive('failed', `Kimi ACP stopped with ${stopReason}.`);
        else settleActive('unknown', 'Kimi ACP did not return a protocol stop reason.');
      } catch (error) {
        if (state.settled) return;
        settleActive(error?.unknown ? 'unknown' : 'failed', errorMessage(error));
      }
    })();
    if (state.signal?.aborted) cancel();
    return outcome;
  }

  async function close() {
    if (dead) return;
    if (active && !active.settled) {
      active.cancelRequested = true;
      active.cancelReason = 'close';
      for (const id of [...active.permissions.keys()]) finishPermission(active, id, null, 'cancelled');
      try { if (active.sessionId) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: active.sessionId } }); } catch { /* disconnect below */ }
      disconnect('Kimi ACP connection closed; execution state is unknown.', true);
      return;
    }
    if (inspection?.sessionId && initializeResult?.agentCapabilities?.sessionCapabilities?.close != null && !dead) {
      try { await request('session/close', { sessionId: inspection.sessionId }); } catch { /* process teardown remains authoritative */ }
    }
    disconnect('Kimi ACP connection closed.', false);
  }

  return { start, inspect, run, close };
}

module.exports = {
  createAcpClient,
  safeEnvironment,
  validateExecutable,
  ACP_PROTOCOL_VERSION,
  MAX_OUTPUT_BYTES,
  MAX_FRAME_BYTES,
};
