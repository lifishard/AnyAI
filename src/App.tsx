import React from 'react';
import type {
  AccessRequest,
  AppSettings,
  ApprovalMode,
  Artifact,
  Attachment,
  ChatMessage,
  Conversation,
  GenerationConfig,
  KeyProfile,
  ModelInfo,
  MessageQuote,
  MessageAnnotation,
  RunState,
  SessionGrants,
  SourceRef,
  ToolResult,
  ToolStep,
} from './types';
import { SEED_MODELS, buildHeaders, endpoint, fetchModels, previewBody } from './lib/api';
import { PROBE_SPACING_MS, probe400, probeHistory, type ProbeStep } from './lib/probe400';
import { formatExchange, failedExchange, exchangeOf, importExchanges } from './lib/wiretap';
import { loadRuns, saveRun, recoverConversations, forgetRuns, runRecord } from './lib/runs';
import { localProgress } from './lib/task-context';
import { conversationMemory } from './lib/handoff';
import { capabilities, outputReserve, quotaKey, routeKey, workingBudget } from './lib/adaptive';
import { addRunInput } from './lib/delivery';
import { limitKey, mergeLearnedLimit, pacingFloor, estimateRequestTokens } from './lib/limits';
import { buildWire, runAgent, type AgentHandle } from './lib/agent';
import {
  clearHealth,
  mergeProbe,
  probeModels,
  recordFailure,
  recordSuccess,
  setMuted,
  type ProbeProgress,
} from './lib/health';
import { TOOL_BY_NAME, availableTools } from './lib/tools/registry';
import {
  loadConversations,
  loadSettings,
  newConversation,
  saveConversationsDebounced,
  saveConversationsNow,
  saveSettings,
  secretGet,
  titleFrom,
  toolContextOf,
  uid,
} from './lib/store';
import { desktop, getTransport, platformLabel, setRemoteConfig } from './lib/transport';
import type { EffortLevel } from './lib/effort';
import { loadSkills, saveSkills, skillSystemBlock, type Skill } from './lib/skills';
import { collectArtifacts } from './lib/artifacts';
import { applyPlan, describeSync, planSync } from './lib/skillsync';
import { loadProjects, projectSystemBlock, saveProjects, type Project } from './lib/projects';
import {
  dueTasks,
  loadTasks,
  nextRun,
  saveTasks,
  type ScheduledTask,
} from './lib/schedule';
import AnswerBlock from './components/AnswerBlock';
import SelectionActions from './components/SelectionActions';
import Composer from './components/Composer';
import ConfigPanel from './components/ConfigPanel';
import SettingsDialog from './components/SettingsDialog';
import Sidebar from './components/Sidebar';
import ArtifactPanel from './components/ArtifactPanel';
import Resizer from './components/Resizer';
import ErrorBoundary from './components/ErrorBoundary';
import ToolConfirm from './components/ToolConfirm';
import GrantDialog, { REMEMBER_DAYS } from './components/GrantDialog';
import WorkspaceDialog from './components/WorkspaceDialog';
import { Modal, Toast, useToast } from './components/ui';
const ObservationPanel = React.lazy(()=>import('./components/ObservationPanel'));

const EXAMPLES = [
  '日日新现在有哪些免费模型，各自的上下文长度是多少？',
  '读一下我工作目录里的 README，说说这个项目是干什么的',
  '搜一下 2026 年 A 股量化私募的监管新规，给我一个时间线',
  '把当前 Chrome 标签页的内容总结成三点',
];

interface QueuedInput { text: string; attachments: Attachment[]; quotes: MessageQuote[]; quoteOnly: boolean; conversationId: string | null }

export default function App() {
  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const [models, setModels] = React.useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [modelsError, setModelsError] = React.useState<string | null>(null);
  /** 批量体检的进度；null = 没在跑 */
  const [probe, setProbe] = React.useState<{ done: number; total: number; current: string } | null>(
    null,
  );
  const probeStopRef = React.useRef(false);

  const [busy, setBusy] = React.useState<{ requestId: string; handle: AgentHandle } | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [observationsOpen,setObservationsOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<string>('keys');
  const [configOpen, setConfigOpen] = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<{ encryptionAvailable: boolean; storePath: string } | null>(
    null,
  );

  const [confirmReq, setConfirmReq] = React.useState<{
    step: ToolStep;
    resolve: (ok: boolean) => void;
  } | null>(null);

  /**
   * 模型申请来的额外权限。刻意只放在 React state 里：应用一关就没了，
   * 下次要用得重新申请。能执行命令、能控屏幕的授权如果被永久记住，
   * 用户迟早会忘了自己给过。
   */
  const [grants, setGrants] = React.useState<SessionGrants>({
    extraRoots: [],
    admin: false,
    screen: false,
  });
  const grantsRef = React.useRef(grants);
  grantsRef.current = grants;

  // 跑到一半时要现读设置（学到的窗口大小会在这次提问过程中被写进去），
  // 闭包里那份快照是开跑那一刻的，读它等于永远慢一拍
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  const [grantReq, setGrantReq] = React.useState<{
    req: AccessRequest;
    resolve: (ok: boolean, remember?: boolean) => void;
  } | null>(null);

  const [projects, setProjects] = React.useState<Project[]>([]);
  const [skills, setSkills] = React.useState<Skill[]>([]);
  const [tasks, setTasks] = React.useState<ScheduledTask[]>([]);
  const [activeSkills, setActiveSkills] = React.useState<Skill[]>([]);
  const [openArtifact, setOpenArtifact] = React.useState<Artifact | null>(null);
  const [sidebarHidden, setSidebarHidden] = React.useState(false);
  const [sidebarW, setSidebarW] = React.useState(268);
  const [panelW, setPanelW] = React.useState(420);
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [workspaceTab, setWorkspaceTab] = React.useState<string>('projects');

  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  /** 生成期间又发的消息，按顺序排队，等这一轮结束再依次发出去 */
  const [queue, setQueue] = React.useState<QueuedInput[]>([]);
  const [quotes, setQuotes] = React.useState<MessageQuote[]>([]);
  const [quoteOnly, setQuoteOnly] = React.useState(true);
  const [queuePaused, setQueuePaused] = React.useState(false);
  const startingRef = React.useRef(false);
  const runningRef = React.useRef<{ requestId: string; convId: string; handle: AgentHandle } | null>(null);

  const toast = useToast();
  const scrollRef = React.useRef<HTMLDivElement>(null);

  /* ---------------- 启动加载 ---------------- */

  React.useEffect(() => {
    void (async () => {
      const [s, c, pr, sk, tk] = await Promise.all([
        loadSettings(),
        loadConversations(),
        loadProjects(),
        loadSkills(),
        loadTasks(),
      ]);
      let recovered = c;
      try { recovered = recoverConversations(c, await loadRuns()); }
      catch (err) { toast.show(`执行记录读取失败：${String(err)}`, 6000); }
      setSettings(s);
      setConversations(recovered);
      setProjects(pr);
      setSkills(sk);
      setTasks(tk);
      setActiveId(recovered.length ? [...recovered].sort((a, b) => b.updatedAt - a.updatedAt)[0].id : null);
      setRemoteConfig(s.remote);
      // 记住过的授权在这里回填。过期的那份 loadSettings 已经丢掉了，
      // 所以这里拿到什么就是什么，不用再判一次时间
      if (s.rememberedGrants) {
        setGrants({
          extraRoots: s.rememberedGrants.extraRoots,
          screen: s.rememberedGrants.screen,
          admin: false, // 提权永远不跨重启
        });
      }
      const bridge = desktop();
      if (bridge) {
        const i = await bridge.info();
        setInfo({ encryptionAvailable: i.encryptionAvailable, storePath: i.storePath });
      }
    })();
  }, []);

  React.useEffect(() => {
    if (settings) void saveSettings(settings);
    if (settings) setRemoteConfig(settings.remote);
  }, [settings]);

  React.useEffect(() => {
    if (settings) saveConversationsDebounced(conversations);
  }, [conversations, !!settings]);

  const bootedRef = React.useRef(false);
  React.useEffect(() => {
    // 首次渲染时这三个还是空数组，别把用户的数据覆盖成空
    if (!bootedRef.current) {
      bootedRef.current = true;
      return;
    }
    void saveProjects(projects);
    void saveSkills(skills);
    void saveTasks(tasks);
  }, [projects, skills, tasks]);

  /* ---------------- 启动时自动同步技能文件夹 ---------------- */

  const syncedOnceRef = React.useRef(false);
  React.useEffect(() => {
    if (syncedOnceRef.current) return;
    if (!settings?.skillSync?.auto || !settings.skillSync.dir) return;
    const bridge = desktop();
    if (!bridge) return;
    syncedOnceRef.current = true;

    void (async () => {
      try {
        const r = await bridge.skillsRead(settings.skillSync.dir);
        if (!r.ok) return;
        const plan = planSync(skills, r.items);
        if (!plan.push.length && !plan.pull.length && !plan.conflicts.length) return;
        if (plan.push.length) await bridge.skillsWrite(settings.skillSync.dir, plan.push);
        setSkills((prev) => applyPlan(prev, plan));
        toast.show(describeSync(plan, r.dir ?? settings.skillSync.dir).split('\n')[0], 5000);
      } catch {
        // 自动同步失败就安静收场 —— 启动时弹一个红条没意义，
        // 用户在工作区里手动点一次会看到真正的报错
      }
    })();
    // skills 只在首次挂载时取一次，不跟它联动：否则同步写回 skills 会触发自己
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.skillSync?.auto, settings?.skillSync?.dir]);

  /* ---------------- 快捷键 ---------------- */

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarHidden((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------------- 主题 ---------------- */

  React.useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const apply = () => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
    };
    apply();
    root.style.setProperty('--font-scale', String(settings.fontScale));
    if (settings.theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);

  /* ---------------- 派生值 ---------------- */

  const active = React.useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  /**
   * 当前会话用哪份凭据。
   * 会话在创建时会把 keyProfileId 钉下来 —— 这是故意的，不然翻旧对话时
   * 模型和端点会跟着全局设置漂走。代价是会话可能绑在一份你已经不用的凭据上，
   * 所以输入框左下角能随时改，改的是这个会话自己的绑定。
   */
  const profile: KeyProfile | null = React.useMemo(() => {
    if (!settings) return null;
    const pinned = active?.keyProfileId
      ? settings.keyProfiles.find((p) => p.id === active.keyProfileId)
      : null;
    if (pinned) return pinned;
    const global = settings.keyProfiles.find((p) => p.id === settings.activeKeyProfileId);
    return global ?? settings.keyProfiles[0] ?? null;
  }, [settings, active]);

  const activeProject: Project | null = React.useMemo(
    () => projects.find((p) => p.id === active?.projectId) ?? null,
    [projects, active?.projectId],
  );

  const config: GenerationConfig | null = active?.config ?? settings?.defaultConfig ?? null;
  const canRunHostTools = getTransport().canRunTools();

  /* ---------------- 模型列表 ---------------- */

  const refreshModels = React.useCallback(
    async (silent = false) => {
      if (!settings || !profile) return;
      const key = await secretGet(profile.id);
      if (!key) {
        if (!silent) setModelsError('这份凭据还没填 API Key');
        return;
      }
      setModelsLoading(true);
      setModelsError(null);
      try {
        const list = await fetchModels(profile, key, 30000);
        setSettings((s) =>
          s ? { ...s, cachedModels: { ...s.cachedModels, [profile.id]: list } } : s,
        );
      } catch (e) {
        setModelsError(e instanceof Error ? e.message : String(e));
      } finally {
        setModelsLoading(false);
      }
    },
    [settings, profile],
  );

  React.useEffect(() => {
    if (!settings || !profile) return;
    const cached = settings.cachedModels[profile.id] ?? [];
    const custom = settings.customModels[profile.id] ?? [];
    const merged = [...cached, ...custom];
    setModels(merged.length ? merged : SEED_MODELS);
    if (!cached.length) void refreshModels(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.cachedModels, settings?.customModels, profile?.id]);

  /* ---------------- 会话操作 ---------------- */

  function updateConv(id: string, fn: (c: Conversation) => Conversation) {
    setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  }

  function patchMessage(convId: string, msgId: string, patch: Partial<ChatMessage>) {
    updateConv(convId, (c) => ({
      ...c,
      updatedAt: Date.now(),
      messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
    }));
  }

  async function changeAnnotation(messageId: string, noteId: string, note?: MessageAnnotation) {
    if (!active) return;
    const next = conversations.map((c) => c.id !== active.id ? c : { ...c, updatedAt: Date.now(),
      messages: c.messages.map((m) => m.id !== messageId ? m : { ...m,
        annotations: [...(m.annotations ?? []).filter((n) => n.id !== noteId), ...(note ? [note] : [])] }) });
    setConversations(next);
    await saveConversationsNow(next);
  }

  const saveAnnotation = (note: MessageAnnotation) => changeAnnotation(note.quote.messageId, note.id, note);

  function setProfileForConversation(profileId: string) {
    if (active) updateConv(active.id, (c) => ({ ...c, keyProfileId: profileId }));
    // 同时更新全局默认，新开的会话跟着走
    setSettings((st) => (st ? { ...st, activeKeyProfileId: profileId } : st));
  }

  function togglePin(id: string) {
    updateConv(id, (c) => ({ ...c, pinned: !c.pinned }));
  }

  /**
   * 分叉一个会话：上下文整份复制到新会话，接着往下聊。
   * uptoIndex 给定时只复制到那条为止 —— 用来「回到某一步重开一条支线」。
   */
  function forkConversation(id: string, uptoIndex?: number) {
    const src = conversations.find((c) => c.id === id);
    if (!src) return;
    const slice = uptoIndex === undefined ? src.messages : src.messages.slice(0, uptoIndex + 1);
    const copy: Conversation = {
      ...src,
      id: uid('c'),
      title: `${src.title}（分叉）`,
      config: JSON.parse(JSON.stringify(src.config)) as GenerationConfig,
      messages: (JSON.parse(JSON.stringify(slice)) as ChatMessage[]).map((m) => ({
        ...m,
        pending: false,
        runState: undefined,
      })),
      pinned: false,
      forkedFrom: src.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setConversations((prev) => [copy, ...prev]);
    setActiveId(copy.id);
    toast.show(uptoIndex === undefined ? '已分叉，上下文都带过来了' : '已从这一步分叉');
  }

  function addCustomModel(id: string) {
    if (!profile) return;
    setSettings((st) => {
      if (!st) return st;
      const cur = st.customModels[profile.id] ?? [];
      if (cur.some((m) => m.id === id)) return st;
      return {
        ...st,
        customModels: { ...st.customModels, [profile.id]: [...cur, { id, custom: true }] },
      };
    });
  }

  function addPastedImage(dataUrl: string, name: string, mime: string, size: number) {
    setAttachments((prev) => [
      ...prev,
      { id: uid('a'), kind: 'image', name, mime, size, dataUrl },
    ]);
  }

  function setConfig(patch: Partial<GenerationConfig>) {
    if (active) {
      updateConv(active.id, (c) => ({ ...c, config: { ...c.config, ...patch } }));
    } else {
      setSettings((s) => (s ? { ...s, defaultConfig: { ...s.defaultConfig, ...patch } } : s));
    }
  }

  /**
   * 授权通过后把对应的工具一起打开。
   *
   * 不这么做的话会出现一个很蠢的局面：用户在弹窗上同意了「控制屏幕」，
   * 模型转头发现 computer_* 根本没在启用列表里 —— 同意了个寂寞。
   * 同意授权本来就是「我要它能做这件事」的意思。
   */
  function enableToolsNow(names: string[]) {
    const cur = active ? active.config : settings?.defaultConfig;
    if (!cur) return;
    const next = Array.from(new Set([...(cur.enabledTools ?? []), ...names]));
    setConfig({ toolsEnabled: true, enabledTools: next });
    // 同时写进「新会话默认」。只改当前会话的话，下次开个新对话这些工具
    // 又没了 —— 人明明已经点过同意，却要为每条对话重新点一遍
    setSettings((s) =>
      s
        ? {
            ...s,
            defaultConfig: {
              ...s.defaultConfig,
              toolsEnabled: true,
              enabledTools: Array.from(new Set([...(s.defaultConfig.enabledTools ?? []), ...names])),
            },
          }
        : s,
    );
  }
  const enableToolsRef = React.useRef(enableToolsNow);
  enableToolsRef.current = enableToolsNow;

  /* ---------------- 附件 / 工作目录 ---------------- */

  async function addAttachments(mode: 'file' | 'image') {
    const bridge = desktop();
    if (!bridge) {
      toast.show('这台设备读不了本地文件');
      return;
    }
    const picked = await bridge.pickFiles(mode);
    const added: Attachment[] = [];
    const errors: string[] = [];
    for (const f of picked) {
      if (f.error || !f.kind) {
        errors.push(f.error ?? '读取失败');
        continue;
      }
      added.push({
        id: uid('a'),
        kind: f.kind,
        name: f.name ?? '未命名',
        mime: f.mime ?? '',
        size: f.size ?? 0,
        text: f.text,
        dataUrl: f.dataUrl,
        path: f.path,
      });
    }
    if (added.length) setAttachments((prev) => [...prev, ...added]);
    if (errors.length) toast.show(errors[0], 4000);
  }

  async function pickWorkspace() {
    const bridge = desktop();
    if (!bridge) {
      toast.show('工作目录只能在桌面端添加');
      return;
    }
    const dir = await bridge.pickFolder();
    if (!dir) return;
    setSettings((st) => {
      if (!st) return st;
      if (st.tools.workspaceRoots.includes(dir)) return st;
      return { ...st, tools: { ...st.tools, workspaceRoots: [...st.tools.workspaceRoots, dir] } };
    });
    toast.show(`已加入工作目录：${dir}`);
  }

  /** 新建对话。带项目时套上项目的默认模型和凭据 */
  function newChat(projectId: string | null = activeProject?.id ?? null) {
    if (!settings) return;
    const proj = projects.find((p) => p.id === projectId) ?? null;
    const c = newConversation(
      settings.defaultConfig,
      proj?.defaultKeyProfileId ?? settings.activeKeyProfileId,
    );
    c.projectId = projectId;
    if (proj?.defaultModel) c.config = { ...c.config, model: proj.defaultModel };
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    setSidebarOpen(false);
  }

  function moveToProject(convId: string, projectId: string | null) {
    updateConv(convId, (c) => ({ ...c, projectId }));
  }

  /* ---------------- 发送 ---------------- */

  /**
   * 批量体检：给列表里每个模型发一个最小请求，把死掉的路由挑出来。
   *
   * 并发压到 2 并且撞到限流就整体暂停 —— 体检本身把额度打爆的话，
   * 一批好模型会被记成「限流」，那比不测还糟。
   */
  const runProbe = React.useCallback(async () => {
    if (!settings || !profile) {
      toast.show('先选一份凭据');
      return;
    }
    if (!models.length) {
      toast.show('先拉一次模型列表');
      return;
    }
    const key = await secretGet(profile.id);
    if (!key) {
      toast.show('这份凭据还没填 API Key');
      return;
    }

    probeStopRef.current = false;
    setProbe({ done: 0, total: models.length, current: '' });

    const out = await probeModels({
      profile,
      apiKey: key,
      models: models.map((m) => m.id),
      timeoutMs: 30_000,
      concurrency: 2,
      onProgress: (p: ProbeProgress) =>
        setProbe({ done: p.done, total: p.total, current: p.current }),
      shouldStop: () => probeStopRef.current,
      // 体检跟对话共用同一份「这条路由的脾气」：读同一份记录，也往回写
      limitOf: (m) => settingsRef.current?.modelLimits?.[limitKey(profile.id, m, profile.baseUrl)],
      onLearnLimit: (m, l) =>
        setSettings((prev) =>
          prev
            ? {
                ...prev,
                modelLimits: {
                  ...(prev.modelLimits ?? {}),
                  [limitKey(profile.id, m, profile.baseUrl)]: mergeLearnedLimit(prev.modelLimits?.[limitKey(profile.id, m, profile.baseUrl)],l),
                },
              }
            : prev,
        ),
    });

    setSettings((prev) =>
      prev
        ? { ...prev, modelHealth: mergeProbe(prev.modelHealth ?? {}, profile.id, out.health) }
        : prev,
    );
    setProbe(null);

    if (out.fatal) {
      toast.show(`体检中断：${out.fatal.title}`, 5000);
      return;
    }
    const tested = Object.keys(out.health).length;
    const bad = Object.values(out.health).filter(
      (h) => h.status === 'broken' || h.status === 'missing',
    ).length;
    toast.show(
      out.stopped
        ? `体检已停止，测了 ${tested} 个，其中 ${bad} 个不可用`
        : `体检完成：${tested} 个里有 ${bad} 个不可用，已从默认列表移出`,
      5000,
    );
  }, [settings, profile, models, toast]);

  /**
   * 模型申请会话级权限。同意之后只写进 React state —— 不落盘、不跨会话。
   *
   * 三种 scope 的共同点：它们都扩大了「模型能碰到什么」的边界，所以每一次
   * 都要用户亲自点。已经有的授权直接回「已有」，不重复打扰。
   */
  const grantAccess = React.useCallback((req: AccessRequest): Promise<ToolResult> => {
    const scope = req.scope;
    if (scope !== 'path' && scope !== 'admin' && scope !== 'screen') {
      return Promise.resolve({
        ok: false,
        content: '',
        error: `不认识的 scope：${String(scope)}。只能是 path、admin、screen 三者之一。`,
      });
    }
    if (scope === 'path' && !req.target) {
      return Promise.resolve({
        ok: false,
        content: '',
        error: 'scope="path" 必须同时给 target，填要访问的目录的绝对路径。',
      });
    }
    if (!req.reason || req.reason.trim().length < 4) {
      return Promise.resolve({
        ok: false,
        content: '',
        error: '必须给出具体理由：你要用这个权限做什么。理由会原样展示给用户看。',
      });
    }

    const g = grantsRef.current;
    if (scope === 'admin' && g.admin) {
      return Promise.resolve({ ok: true, content: '这次会话已经有管理员授权了，直接用 run_command 的 elevated 参数即可。', summary: '已有授权' });
    }
    if (scope === 'screen' && g.screen) {
      return Promise.resolve({ ok: true, content: '这次会话已经有屏幕控制授权了，可以直接截屏和操作。', summary: '已有授权' });
    }
    if (scope === 'path' && req.target && g.extraRoots.includes(req.target)) {
      return Promise.resolve({ ok: true, content: `${req.target} 已经在可访问范围里了。`, summary: '已有授权' });
    }

    return new Promise<ToolResult>((resolve) => {
      setGrantReq({
        req,
        resolve: (okGranted, remember) => {
          if (!okGranted) {
            resolve({
              ok: false,
              content: '',
              error:
                '用户拒绝了这次权限申请。不要反复申请同一项 —— 换一个不需要它的做法，' +
                '或者直接问用户希望怎么处理。',
            });
            return;
          }
          setGrants((prev) =>
            scope === 'path'
              ? { ...prev, extraRoots: Array.from(new Set([...prev.extraRoots, req.target as string])) }
              : scope === 'admin'
                ? { ...prev, admin: true }
                : { ...prev, screen: true },
          );
          // 选了记住就落进设置，重启（以及每次更新）之后还在。
          // admin 不在此列 —— GrantDialog 压根不给它这个按钮
          if (remember && scope !== 'admin') {
            setSettings((prev) => {
              if (!prev) return prev;
              const cur = prev.rememberedGrants;
              const alive = cur && cur.expiresAt > Date.now() ? cur : null;
              return {
                ...prev,
                rememberedGrants: {
                  extraRoots:
                    scope === 'path'
                      ? Array.from(new Set([...(alive?.extraRoots ?? []), req.target as string]))
                      : (alive?.extraRoots ?? []),
                  screen: scope === 'screen' ? true : Boolean(alive?.screen),
                  expiresAt: Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000,
                },
              };
            });
          }
          if (scope === 'screen') {
            enableToolsRef.current([
              'computer_screenshot',
              'computer_click',
              'computer_move',
              'computer_scroll',
              'computer_type',
              'computer_key',
            ]);
          } else if (scope === 'admin') {
            enableToolsRef.current(['run_command']);
          }
          // 有效期照实说。之前一律写「仅本次会话」，现在能记住了，
          // 再这么说就是在骗模型 —— 它会因此以为下一轮还得重新申请
          const span = remember && scope !== 'admin' ? `${REMEMBER_DAYS} 天内有效` : '仅本次会话';
          resolve({
            ok: true,
            summary: '授权通过',
            content:
              scope === 'path'
                ? `已获准访问 ${req.target}（${span}）。`
                : scope === 'admin'
                  ? '已获准提权（仅本次会话）。注意：每条 elevated 命令仍会单独弹确认，系统还会再弹一次 UAC 由用户亲自放行。'
                  : `已获准控制屏幕（${span}）。动手之前先 computer_screenshot 看清楚，不要凭记忆点击。`,
          });
        },
      });
    });
  }, []);

  /**
   * 400 自动排查。
   *
   * `inference request is invalid (code 400001)` 这种报错不点名任何字段，
   * 人只能一个个去掉再试。那件事交给机器做：从最小请求体开始一层层加回去，
   * 工具那一组再二分。十几次短请求换一个确定的答案。
   *
   * 注意别跟上面那个 runProbe 搞混：那个是「批量体检模型列表」，
   * 这个是「拆解一次失败的请求」。两件事，两个名字。
   */
  const runRequestProbe = React.useCallback(async (message?: ChatMessage) => {
    const cfg = active?.config ?? settings?.defaultConfig;
    if (!cfg || !profile || !settings) return;
    const runId = message?.runState?.runId;
    const bridge = desktop();
    if (bridge?.exchanges) importExchanges(await bridge.exchanges(runId));
    const captured = exchangeOf(message?.runState?.failedRequestId) ?? failedExchange(runId);
    if (!captured) { setPreview('没有找到对应的失败请求，无法根据普通聊天记录替它下结论。'); return; }
    setPreview(formatExchange(captured));
    const apiKey = await secretGet(profile.id);
    if (!apiKey) return;
    const original = captured.request as Record<string, unknown>;
    const tokens = estimateRequestTokens(original);
    const limit = settings.modelLimits?.[limitKey(profile.id, String(original.model), profile.baseUrl)];
    const cap = capabilities(profile,cfg,limit,models.find(m => m.id === cfg.model));
    const tpm = cap.tpm;
    const output = outputReserve(original,cfg,cap);
    if ((tpm && tokens+output > tpm) || tokens > workingBudget(cfg,cap,output)) {
      setPreview(formatExchange(captured)+'\n\n本地检查：原请求超出当前发送预算，已保留原文，不再重复发送大请求。'); return;
    }
    const attempts: string[] = [];
    // Compare an explicit baseline with the exact original body, not reconstructed chat history.
    for (const [label, body] of [
      ['最小基线', { model: original.model, messages: [{ role: 'user', content: 'Reply OK' }], stream: false, max_tokens: 1 }],
      ['原始失败请求', original],
    ] as const) {
      let failure = '';
      const id = uid('probe');
      await getTransport().chat({ requestId: id, purpose: 'probe', runId, url: captured.url,
        headers: buildHeaders(apiKey, profile), body, stream: body.stream === true, timeoutMs: 30000,
        paceKey: quotaKey(profile), paceTokens: estimateRequestTokens(body)+outputReserve(body,cfg,cap), paceTpm: tpm,
        paceInput:estimateRequestTokens(body), paceOutput:outputReserve(body,cfg,cap), paceItpm:cap.itpm, paceOtpm:cap.otpm,
        paceMinMs: Math.max(PROBE_SPACING_MS, cfg.runtime?.rpm ? 60000/cfg.runtime.rpm : 0),
      }, { onContent() {}, onReasoning() {}, onToolCalls() {}, onUsage() {}, onDone() {},
        onError(text, status) { failure = `${status ?? ''} ${text}`; },
        onPaceWait(ms) { setPreview(formatExchange(captured)+`\n\n${label}正在排队，约 ${Math.ceil(ms/1000)} 秒后发送。`); },
      });
      attempts.push(`${label}：${failure || '请求成功'}`);
      if (failure && /429|tpm|rpm|限流|401|403/i.test(failure)) break;
    }
    setPreview(formatExchange(captured)+'\n\n—— 对照结果 ——\n'+attempts.join('\n')+
      '\n单次成功不证明故障不存在；以上只说明本次对照结果，原失败证据仍保留。');
  }, [active, settings, profile]);

  const revokeGrants = React.useCallback(() => {
    setGrants({ extraRoots: [], admin: false, screen: false });
    // 记住的那份也一起清掉 —— 「全部撤销」按下去之后还能被重启复活，
    // 那这个按钮就是在骗人
    setSettings((prev) => (prev ? { ...prev, rememberedGrants: undefined } : prev));
    toast.show('已撤销全部额外授权，包括记住的那些');
  }, [toast]);

  const clearProfileHealth = React.useCallback(() => {
    if (!profile) return;
    setSettings((prev) =>
      prev ? { ...prev, modelHealth: clearHealth(prev.modelHealth ?? {}, profile.id) } : prev,
    );
    toast.show('已清空这份凭据的体检记录');
  }, [profile, toast]);

  const muteModel = React.useCallback(
    (modelId: string, muted: boolean) => {
      if (!profile) return;
      setSettings((prev) =>
        prev
          ? { ...prev, modelHealth: setMuted(prev.modelHealth ?? {}, profile.id, modelId, muted) }
          : prev,
      );
    },
    [profile],
  );

  const send = React.useCallback(
    async (text: string, replaceFromIndex?: number, resumeFrom?: RunState, queuedInput?: QueuedInput, resolution?: 'skip' | 'retry') => {
      if (!settings) return;
      if (startingRef.current || busy || runningRef.current) {
        setQueue((q) => [...q, queuedInput ?? { text, attachments: [...attachments], quotes: [...quotes], quoteOnly, conversationId: active?.id ?? null }]);
        setAttachments([]); setQuotes([]);
        return;
      }
      if (!profile) {
        toast.show('先去设置里登记一份 API 凭据'); setSettingsOpen(true); return;
      }
      startingRef.current = true;
      let apiKey: string | null;
      try { apiKey = await secretGet(profile.id); }
      catch (e) { startingRef.current = false; toast.show(String(e)); return; }
      if (!apiKey) { startingRef.current = false; toast.show('这份凭据还没填 API Key'); setSettingsOpen(true); return; }
      // 没有会话就现开一个
      let conv = active;
      let baseList = conversations;
      if (!conv) {
        conv = newConversation(settings.defaultConfig, profile.id);
        baseList = [conv, ...conversations];
      }
      const cfg = conv.config;

      if (!cfg.model) {
        startingRef.current = false;
        toast.show('先选一个模型');
        setConfigOpen(true);
        return;
      }

      const resumeIndex = resumeFrom ? conv.messages.findIndex((m) => m.runState === resumeFrom ||
        (resumeFrom.runId && m.runState?.runId === resumeFrom.runId)) : -1;
      const resumeAnswer = resumeIndex >= 0 ? conv.messages[resumeIndex] : undefined;
      const previousQuestion = resumeIndex > 0 ? conv.messages[resumeIndex-1] : undefined;
      const kept = resumeFrom ? conv.messages.slice(0, Math.max(0, resumeIndex-1))
        : replaceFromIndex === undefined ? conv.messages : conv.messages.slice(0, replaceFromIndex);
      if (!resumeFrom && replaceFromIndex !== undefined) {
        try { await forgetRuns(conv.id, new Set(conv.messages.slice(replaceFromIndex).map((m) => m.id))); }
        catch (e) { startingRef.current = false; toast.show(`无法更新执行记录：${String(e)}`); return; }
      }

      // 本轮唤起的技能：固定一份快照，并记一次使用次数。
      // 注意技能是**粘的** —— 发完不清空，一直注入到用户自己点掉那个 ✕。
      // 一次性注入看着更"干净"，但技能通常是一整段工作流（先查再写再验），
      // 第二轮开始模型就看不见规则了，表现出来就是"它好像忘了"。
      const turnSkills = activeSkills;
      if (turnSkills.length) {
        const ids = new Set(turnSkills.map((x) => x.id));
        setSkills((prev) => prev.map((x) => (ids.has(x.id) ? { ...x, uses: x.uses + 1 } : x)));
      }

      const userMsg: ChatMessage = previousQuestion ?? {
        id: uid('m'),
        role: 'user',
        content: text,
        createdAt: Date.now(),
        attachments: (queuedInput?.attachments ?? attachments).length ? (queuedInput?.attachments ?? attachments) : undefined,
        quotes: queuedInput?.quotes ?? quotes,
        quoteOnly: (queuedInput?.quotes ?? quotes).length > 0 ? (queuedInput?.quoteOnly ?? quoteOnly) : false,
        skillNames: turnSkills.length ? turnSkills.map((x) => x.name) : undefined,
      };
      const answerMsg: ChatMessage = {
        ...resumeAnswer,
        id: resumeAnswer?.id ?? uid('m'),
        role: 'assistant',
        content: resumeFrom?.content ?? resumeAnswer?.content ?? '',
        reasoning: resumeFrom?.reasoning ?? resumeAnswer?.reasoning ?? '',
        createdAt: resumeAnswer?.createdAt ?? Date.now(),
        pending: true, error: undefined, errorInfo: undefined, progress: undefined,
        model: cfg.model,
        steps: resumeFrom?.steps ?? resumeAnswer?.steps ?? [],
        sources: resumeFrom?.sources ?? [],
      };

      const convId = conv.id;
      const history = [...kept, userMsg];
      const nextConv: Conversation = {
        ...conv,
        title: kept.length === 0 ? titleFrom(text) : conv.title,
        messages: resumeAnswer ? conv.messages.map((m) => m.id === answerMsg.id ? answerMsg : m) : [...history, answerMsg],
        updatedAt: Date.now(),
      };

      setConversations(baseList.map((c) => (c.id === convId ? nextConv : c)));
      setActiveId(convId);
      if (!resumeFrom) { setAttachments([]); setQuotes([]); }
      setQueuePaused(false);

      /* --- 流式缓冲：按 60ms 节流刷进 state，不然一个 token 一次 setState --- */
      const buf = { content: answerMsg.content, reasoning: answerMsg.reasoning ?? '', dirty: false };
      const flush = () => {
        if (!buf.dirty) return;
        buf.dirty = false;
        const content = buf.content;
        const reasoning = buf.reasoning;
        patchMessage(convId, answerMsg.id, { content, reasoning });
      };
      const timer = setInterval(flush, 60);

      const steps: ToolStep[] = [...(answerMsg.steps ?? [])];
      let latestState: RunState | null = resumeFrom ?? null;
      const started = Date.now();
      const requestId = uid('r');

      const finishUi = () => {
        clearInterval(timer); flush();
        if (runningRef.current?.requestId === requestId) { runningRef.current = null; setBusy(null); }
        startingRef.current = false;
      };
      const handle = runAgent({
        requestId,
        profile,
        apiKey,
        config: cfg,
        history,
        autoRetry: settings.autoRetry ?? 2,
        profileName: profile.name,
        // 传函数而不是快照：中途拿到的授权要对后面的工具调用立刻生效
        toolCtx: () => toolContextOf(settings, conv.projectId ?? null, grantsRef.current),
        effortMappings: settings.effortMappings,
        resume: resumeFrom,
        previousModel: resumeAnswer?.model,
        conversationMemory: resumeFrom ? undefined : conversationMemory(history, runRecord),
        resolveUncertain: resolution,
        // 这条路由的窗口有多大 —— 之前撞出来的那个数
        modelInfo: [...(settings.cachedModels[profile.id] ?? []), ...(settings.customModels[profile.id] ?? [])].find(m => m.id === cfg.model),
        limitOf: () => settingsRef.current?.modelLimits?.[limitKey(profile.id, cfg.model, profile.baseUrl)],
        onLearnLimit: (l) =>
          setSettings((prev) =>
            prev
              ? {
                  ...prev,
                  modelLimits: {
                    ...(prev.modelLimits ?? {}),
                    [limitKey(profile.id, cfg.model, profile.baseUrl)]: mergeLearnedLimit(prev.modelLimits?.[limitKey(profile.id, cfg.model, profile.baseUrl)],l),
                  },
                }
              : prev,
          ),
        extraSystem: [
          projectSystemBlock(projects.find((p) => p.id === conv.projectId) ?? null),
          skillSystemBlock(turnSkills),
        ]
          .filter(Boolean)
          .join('\n\n'),
        timeoutMs: settings.requestTimeoutMs,
        canRunHostTools,
        grantAccess,
        confirm: (step) => {
          // 这两类永远要人点头，连「全部放行」都不例外：
          //   - 提权：它越过的是工作目录白名单之外的一切
          //   - 权限申请：一个「一律放行」的档位如果连「要不要给权限」都替人答了，
          //     那这个档位就等于把授权体系整个关掉
          const args = (step.args ?? {}) as Record<string, unknown>;
          const alwaysAsk =
            step.name === 'request_access' || (step.name === 'run_command' && Boolean(args.elevated));
          if (alwaysAsk) {
            return new Promise<boolean>((resolve) => setConfirmReq({ step, resolve }));
          }
          if (cfg.approvalMode === 'all') return Promise.resolve(true);
          if (cfg.approvalMode === 'auto') {
            const def = TOOL_BY_NAME[step.name];
            // 「自动批准编辑」只放行改文件和 Chrome；
            // 跑命令和 Claude Code 影响面太大，这一档仍然要问
            const heavy = def?.group === 'shell' || def?.group === 'agent';
            if (!heavy) return Promise.resolve(true);
          }
          return new Promise<boolean>((resolve) => setConfirmReq({ step, resolve }));
        },
        events: {
          onContentReplace(content, reasoning) {
            buf.content = content; buf.reasoning = reasoning; buf.dirty = true; flush();
          },
          onContentDelta(d) {
            buf.content += d;
            buf.dirty = true;
          },
          onReasoningDelta(d) {
            buf.reasoning += d;
            buf.dirty = true;
          },
          onStep(step) {
            const i = steps.findIndex((s) => s.id === step.id);
            if (i === -1) steps.push(step);
            else steps[i] = step;
            patchMessage(convId, answerMsg.id, { steps: [...steps], artifacts: collectArtifacts(buf.content, steps) });
          },
          onSources(list: SourceRef[]) {
            patchMessage(convId, answerMsg.id, { sources: [...list] });
          },
          onUsage(u) {
            patchMessage(convId, answerMsg.id, { usage: u });
          },
          onRound() {},
          onNotice(text) {
            patchMessage(convId, answerMsg.id, { notice: text || undefined });
          },
          onStopReason(reason) {
            patchMessage(convId, answerMsg.id, { stopReason: reason ?? undefined });
          },
          async onRunState(state) {
            if (state) {
              latestState = state;
              await saveRun({ id: state.runId ?? requestId, conversationId: convId, answerId: answerMsg.id,
                question: userMsg, config: cfg, keyProfileId: profile.id, projectId: conv!.projectId,
                title: nextConv.title, state });
            }
            patchMessage(convId, answerMsg.id, { runState: state ?? undefined,
              ...(state ? { milestones: state.milestones, contextSnapshot: state.contextSnapshot, delivery: state.delivery, taskId:state.runId, supplementalInputs:state.supplementalInputs, handoff:state.handoff } : {}) });
          },
          onPaused(reason) {
            finishUi(); setQueuePaused(true);
            patchMessage(convId, answerMsg.id, { pending: false, notice: undefined,
              content: buf.content, reasoning: buf.reasoning, progress: localProgress(steps, reason),
              artifacts: collectArtifacts(buf.content, steps), elapsedMs: Date.now()-started });
          },
          onDone() {
            finishUi();
            const arts = collectArtifacts(buf.content, steps);
            patchMessage(convId, answerMsg.id, {
              pending: false,
              notice: undefined,
              progress: undefined,
              content: buf.content,
              reasoning: buf.reasoning,
              elapsedMs: Date.now() - started,
              artifacts: arts.length ? arts : undefined,
            });
            // 只有完整响应成功才清除失败记录。
            if (latestState?.status === 'completed') setSettings((prev) =>
              prev
                ? {
                    ...prev,
                    modelHealth: recordSuccess(prev.modelHealth ?? {}, profile.id, cfg.model),
                  }
                : prev,
            );
            // 只产出一个东西时直接开右侧面板 —— 多个就让用户自己挑
            if (arts.length === 1) setOpenArtifact(arts[0]);
          },
          onError(msg, info) {
            finishUi(); setQueuePaused(true);
            patchMessage(convId, answerMsg.id, {
              pending: false,
              notice: undefined,
              error: msg,
              errorInfo: info,
              progress: localProgress(steps, msg),
              artifacts: collectArtifacts(buf.content, steps),
              content: buf.content,
              elapsedMs: Date.now() - started,
            });
            // 记一笔健康度：确定性的服务端崩溃和「模型不存在」会让这个 ID
            // 从默认模型列表里消失，限流和超时不算
            if (info.blameModel) {
              setSettings((prev) =>
                prev
                  ? {
                      ...prev,
                      modelHealth: recordFailure(prev.modelHealth ?? {}, profile.id, cfg.model, info),
                    }
                  : prev,
              );
            }
          },
        },
      });

      startingRef.current = false;
      runningRef.current = { requestId, convId, handle };
      setBusy({ requestId, handle });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, conversations, active, profile, busy, canRunHostTools, attachments, activeSkills, projects, quotes, quoteOnly],
  );

  function stop() {
    setQueuePaused(true);
    runningRef.current?.handle.abort();
    setConfirmReq((request) => { request?.resolve(false); return null; });
    setGrantReq((request) => { request?.resolve(false); return null; });
  }

  const resumeRun = React.useCallback(
    (msg: ChatMessage, resolution?: 'skip' | 'retry', additionalInput?: string) => {
      if (busy || !msg.runState || !active) return;
      const index = active.messages.findIndex((m) => m.id === msg.id);
      const question = active.messages[index-1]?.content ?? '继续';
      let state = structuredClone(msg.runState);
      if (additionalInput?.trim()) {
        const message: ChatMessage = {id:uid('m'),role:'user',content:additionalInput.trim(),createdAt:Date.now()};
        state=addRunInput(state,message);
        state.reason = '用户已补充信息，正在继续';
      }
      void send(question, undefined, state, undefined, resolution);
    }, [busy, active, send],
  );

  // 上一轮结束后自动发下一条排队的
  React.useEffect(() => {
    if (busy || runningRef.current || queuePaused || queue.length === 0) return;
    const [next, ...rest] = queue;
    if (next.conversationId && next.conversationId !== activeId) { setActiveId(next.conversationId); return; }
    setQueue(rest);
    void send(next.text, undefined, undefined, next);
  }, [busy, queue, send, queuePaused, activeId]);

  /* ---------------- 定时任务调度 ---------------- */

  /**
   * 每 20 秒看一眼有没有到点的任务。
   * 跑在渲染进程里 —— 应用关着就不会触发，这是已知的取舍，
   * TasksTab 里跟用户讲清楚了。
   */
  const sendRef = React.useRef(send);
  sendRef.current = send;

  const busyRef = React.useRef(false);
  busyRef.current = Boolean(busy);

  React.useEffect(() => {
    if (!settings) return;

    // 启用了但还没算过下次触发时间的，补上
    setTasks((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.enabled && !t.nextRunAt) {
          changed = true;
          return { ...t, nextRunAt: nextRun(t.schedule) ?? undefined };
        }
        return t;
      });
      return changed ? next : prev;
    });

    const tick = () => {
      if (busyRef.current) return; // 正在生成就等下一轮，别插队
      const due = dueTasks(tasks);
      if (!due.length) return;

      const t = due[0];
      const now = Date.now();

      setTasks((prev) =>
        prev.map((x) =>
          x.id === t.id
            ? { ...x, lastRunAt: now, lastResult: '已触发', nextRunAt: nextRun(x.schedule, new Date(now)) ?? undefined }
            : x,
        ),
      );

      void runTask(t);
    };

    const id = setInterval(tick, 20_000);
    const first = setTimeout(tick, 3_000); // 打开应用几秒后先补一次
    return () => {
      clearInterval(id);
      clearTimeout(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, settings]);

  /** 一个定时任务到点了：开对话（或复用），把 prompt 发出去 */
  async function runTask(t: ScheduledTask) {
    if (!settings) return;

    let convId = t.conversationId;
    const reuse = t.target === 'same' && convId && conversations.some((c) => c.id === convId);

    if (!reuse) {
      const proj = projects.find((p) => p.id === t.projectId) ?? null;
      const c = newConversation(
        settings.defaultConfig,
        t.keyProfileId ?? proj?.defaultKeyProfileId ?? settings.activeKeyProfileId,
      );
      c.projectId = t.projectId;
      c.taskId = t.id;
      c.title = `⏰ ${t.name}`;
      const model = t.model || proj?.defaultModel || settings.defaultConfig.model;
      if (model) c.config = { ...c.config, model };
      convId = c.id;
      setConversations((prev) => [c, ...prev]);
      if (t.target === 'same') {
        setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, conversationId: c.id } : x)));
      }
    }

    setActiveId(convId!);
    // 等一帧让上面的 state 落地，再走正常的发送链路
    await new Promise((r) => setTimeout(r, 60));
    sendRef.current(t.prompt);
  }

  /* ---------------- 滚动跟随 ---------------- */

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 220;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [active?.messages]);

  /* ---------------- 渲染 ---------------- */

  if (!settings || !config) {
    return <div className="empty" style={{ paddingTop: 80 }}>加载中…</div>;
  }

  // 把消息配成「一问一答」
  const turns: { q: ChatMessage | null; a: ChatMessage | null; qIndex: number }[] = [];
  const msgs = active?.messages ?? [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'user') {
      const next = msgs[i + 1];
      if (next && next.role === 'assistant') {
        turns.push({ q: m, a: next, qIndex: i });
        i++;
      } else {
        turns.push({ q: m, a: null, qIndex: i });
      }
    } else if (m.role === 'assistant') {
      turns.push({ q: null, a: m, qIndex: i });
    }
  }

  const toolNames = config.toolsEnabled
    ? config.enabledTools.filter((n) =>
        availableTools(canRunHostTools).some((t) => t.name === n),
      )
    : [];

  /** 已生效的额外授权：一直显示在输入框上方，不让人忘了自己给过什么 */
  const grantBanner =
    grants.admin || grants.screen || grants.extraRoots.length ? (
      <div className="grant-banner">
        <span className="grant-banner-label">
          已授权
          {settings?.rememberedGrants
            ? `（记到 ${new Date(settings.rememberedGrants.expiresAt).toLocaleDateString()}）`
            : '（仅本次会话）'}
        </span>
        {grants.screen ? <span className="grant-chip">🖥 屏幕控制</span> : null}
        {grants.admin ? <span className="grant-chip">🛡 管理员执行</span> : null}
        {grants.extraRoots.map((r) => (
          <span key={r} className="grant-chip" title={r}>
            📂 {r.split(/[\\/]/).filter(Boolean).slice(-1)[0] || r}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={revokeGrants}>
          全部撤销
        </button>
      </div>
    ) : null;

  const composer = (
    <Composer
      contextPreview={profile ? { profile,config,history:(active?.messages ?? []).filter(m => !m.pending),
        extraSystem:[projectSystemBlock(activeProject),skillSystemBlock(activeSkills)].filter(Boolean).join('\n\n'),
        toolNames,mappings:settings.effortMappings,learned:settings.modelLimits?.[limitKey(profile.id,config.model,profile.baseUrl)],
        modelInfo:models.find(m => m.id === config.model), current:busy ? [...(active?.messages ?? [])].reverse().find(m => m.pending)?.contextSnapshot : undefined } : undefined}
      busy={Boolean(busy)}
      disabled={false}
      sendKey={settings.sendKey}
      onSend={(t) => void send(t)}
      onStop={stop}
      stream={config.stream}
      toolCount={toolNames.length}
      quotes={quotes}
      quoteOnly={quoteOnly}
      onQuoteOnly={setQuoteOnly}
      onRemoveQuote={(id) => setQuotes((q) => q.filter((x) => x.id !== id))}
      attachments={attachments}
      onAddAttachments={(m) => void addAttachments(m)}
      onPasteImage={addPastedImage}
      onRemoveAttachment={(id) => setAttachments((p) => p.filter((a) => a.id !== id))}
      onPickWorkspace={() => void pickWorkspace()}
      workspaceCount={settings.tools.workspaceRoots.length}
      canPickLocal={Boolean(desktop())}
      approvalMode={config.approvalMode}
      onApprovalMode={(m: ApprovalMode) => setConfig({ approvalMode: m })}
      profiles={settings.keyProfiles}
      profileId={profile?.id ?? null}
      onProfile={setProfileForConversation}
      models={models}
      model={config.model}
      onModel={(id) => setConfig({ model: id })}
      modelsLoading={modelsLoading}
      modelsError={modelsError}
      onRefreshModels={() => void refreshModels()}
      onAddModel={addCustomModel}
      modelHealth={settings.modelHealth ?? {}}
      probe={probe}
      onProbe={() => void runProbe()}
      onStopProbe={() => {
        probeStopRef.current = true;
      }}
      onMuteModel={muteModel}
      onClearHealth={clearProfileHealth}
      effortLevel={config.effortLevel}
      onEffortLevel={(l: EffortLevel) => setConfig({ effortLevel: l })}
      effortMappings={settings.effortMappings}
      effortManual={config.thinkingStyle !== 'auto'}
      onOpenMappings={() => {
        const route = profile?.routeProfiles?.[routeKey(profile,config.model)];
        if (route?.effortStyle && route.effortStyle !== 'mapping') { setConfigOpen(true); return; }
        setSettingsOpen(true);
        setSettingsTab('effort');
      }}
      skills={skills}
      activeSkills={activeSkills}
      onPickSkill={(sk) =>
        setActiveSkills((prev) => (prev.some((x) => x.id === sk.id) ? prev : [...prev, sk]))
      }
      onDropSkill={(id) => setActiveSkills((prev) => prev.filter((x) => x.id !== id))}
      projectPrompts={activeProject?.prompts ?? []}
      queued={queue.map((q) => q.text || `${q.attachments.length} 个附件`)}
      queuePaused={queuePaused}
      onResumeQueue={() => setQueuePaused(false)}
      onDropQueued={(i) => setQueue((q) => q.filter((_, j) => j !== i))}
    />
  );

  return (
    <div className="app">
      {!sidebarHidden ? (
      <aside
        className={`sidebar${sidebarOpen ? ' open' : ''}`}
        style={{ width: sidebarW, flexBasis: sidebarW }}
      >
        <Sidebar
          onHide={() => setSidebarHidden(true)}
          conversations={conversations}
          activeId={activeId}
          platform={platformLabel()}
          onSelect={(id) => {
            setActiveId(id);
            setSidebarOpen(false);
          }}
          onNew={() => newChat(null)}
          onDelete={(id) => {
            if (runningRef.current?.convId === id) stop();
            void forgetRuns(id);
            setConversations((prev) => prev.filter((c) => c.id !== id));
            if (activeId === id) setActiveId(null);
          }}
          onRename={(id, title) => updateConv(id, (c) => ({ ...c, title }))}
          projects={projects}
          onTogglePin={togglePin}
          onFork={(id) => forkConversation(id)}
          onNewInProject={(pid) => newChat(pid)}
          onOpenWorkspace={(t) => {
            setWorkspaceTab(t);
            setWorkspaceOpen(true);
            setSidebarOpen(false);
          }}
          onOpenSettings={() => {
            setSettingsOpen(true);
            setSidebarOpen(false);
          }}
          onOpenObservations={()=>{setObservationsOpen(true);setSidebarOpen(false);}}
        />
      </aside>
      ) : null}

      {!sidebarHidden ? (
        <Resizer
          side="left"
          width={sidebarW}
          min={190}
          max={460}
          onWidth={setSidebarW}
          onDoubleClick={() => setSidebarW(268)}
        />
      ) : null}

      {(sidebarOpen || configOpen) && (
        <div
          className="backdrop"
          onClick={() => {
            setSidebarOpen(false);
            setConfigOpen(false);
          }}
        />
      )}

      <main className="main">
        <div className="topbar">
          <button className="btn sm ghost only-narrow" onClick={() => setSidebarOpen(true)}>
            ☰
          </button>
          {sidebarHidden ? (
            <button
              className="btn sm ghost wide-only"
              title="展开侧栏（Ctrl+B）"
              onClick={() => setSidebarHidden(false)}
            >
              ⇥
            </button>
          ) : null}
          <span style={{ fontWeight: 600, fontSize: 13 }}>{active?.title ?? '新对话'}</span>
          {active ? (
            <select
              className="topbar-project"
              value={active.projectId ?? ''}
              title="把这个对话归到某个项目里 —— 项目的规范、记忆和文档会自动带进来"
              onChange={(e) => moveToProject(active.id, e.target.value || null)}
            >
              <option value="">不属于项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.emoji} {p.name}
                </option>
              ))}
            </select>
          ) : null}
          <span className="spacer" />
          {!profile ? <span className="chip warn">未配置凭据</span> : null}
          <span className="chip">{config.model || '未选模型'}</span>
          {config.toolsEnabled ? <span className="chip">{toolNames.length} 个工具</span> : null}
          <button className="btn sm" onClick={() => setConfigOpen((v) => !v)}>
            ⚙ 配置
          </button>
        </div>

        {turns.length === 0 ? (
          <div className="hero">
            <h1 className="hero-title">问点什么</h1>
            <p className="hero-sub">
              会自己联网查证、读你本地的文件、翻 Chrome 里的页面，答案里带可点的来源编号。
            </p>
            <div className="hero-box">
              {grantBanner}
              {composer}
            </div>
            <div className="hero-examples">
              {EXAMPLES.map((e) => (
                <button key={e} className="example-chip" onClick={() => void send(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="messages" ref={scrollRef}>
              <div className="messages-inner">
                {turns.map((t, i) => (
                  <AnswerBlock
                    key={(t.a ?? t.q)!.id}
                    question={t.q}
                    answer={t.a}
                    showReasoning={settings.showReasoningByDefault}
                    onOpenArtifact={setOpenArtifact}
                    onArtifactSaved={(artifact) => {
                      if (active && t.a) updateConv(active.id, (c) => ({ ...c, messages: c.messages.map((m) => m.id === t.a!.id
                        ? { ...m, artifacts: [...(m.artifacts ?? []).filter((a) => a.path !== artifact.path), artifact] } : m) }));
                    }}
                    onCopy={(text) => {
                      void navigator.clipboard.writeText(text);
                      toast.show('已复制');
                    }}
                    onRetry={
                      busy || !t.q
                        ? undefined
                        : () => void send(t.q!.content, t.qIndex)
                    }
                    onProbe={busy ? undefined : () => void runRequestProbe(t.a ?? undefined)}
                    onResume={busy || !t.a?.runState ? undefined : () => resumeRun(t.a!)}
                    onResumeWithInput={busy || !t.a?.runState ? undefined : (text) => resumeRun(t.a!,undefined,text)}
                    onResolveUncertain={busy || !t.a?.runState ? undefined : (choice) => resumeRun(t.a!, choice)}
                    onSaveAnnotation={saveAnnotation}
                    onDeleteAnnotation={(messageId, noteId) => changeAnnotation(messageId, noteId)}
                    onEditQuestion={
                      busy || !t.q ? undefined : (text) => void send(text, t.qIndex)
                    }
                    onFork={busy ? undefined : () => forkConversation(active!.id, t.qIndex + (t.a ? 1 : 0))}
                    onDelete={
                      busy
                        ? undefined
                        : () => {
                            if (!active) return;
                            const drop = new Set<string>();
                            if (t.q) drop.add(t.q.id);
                            if (t.a) drop.add(t.a.id);
                            void forgetRuns(active.id, drop);
                            updateConv(active.id, (c) => ({
                              ...c,
                              messages: c.messages.filter((m) => !drop.has(m.id)),
                            }));
                          }
                    }
                  />
                ))}
              </div>
            </div>
            {grantBanner}
            {composer}
          </>
        )}
      </main>

      {openArtifact ? (
        <>
          <Resizer
            side="right"
            width={panelW}
            min={300}
            max={900}
            onWidth={setPanelW}
            onDoubleClick={() => setPanelW(420)}
          />
          <div style={{ width: panelW, flex: `0 0 ${panelW}px`, display: 'flex', minWidth: 0 }}>
            <ErrorBoundary label="产物预览" onReset={() => setOpenArtifact(null)}>
              <ArtifactPanel artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
            </ErrorBoundary>
          </div>
        </>
      ) : null}

      {configOpen ? (
      <aside className="config-panel open">
        <ConfigPanel
          profile={profile}
          onProfileChange={next => setSettings(prev => prev ? { ...prev,keyProfiles:prev.keyProfiles.map(p => p.id === next.id ? next : p) } : prev)}
          config={config}
          onChange={setConfig}
          models={models}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          hasKey={Boolean(profile)}
          canRunHostTools={canRunHostTools}
          onRefreshModels={() => void refreshModels()}
          onAddModel={(id) => {
            addCustomModel(id);
            setConfig({ model: id });
          }}
          onPreview={() =>
            setPreview(
              previewBody(
                config,
                '这里是你输入的问题',
                toolNames,
                // 跟真正发出去的那份用同一个表达式拼，预览才有意义
                [projectSystemBlock(activeProject), skillSystemBlock(activeSkills)]
                  .filter(Boolean)
                  .join('\n\n'),
              ),
            )
          }
          onRawDump={() => { void (async () => {
            const runId = [...(active?.messages ?? [])].reverse().find((m) => m.runState)?.runState?.runId;
            const bridge = desktop();
            if (bridge?.exchanges) importExchanges(await bridge.exchanges(runId));
            setPreview(formatExchange(failedExchange(runId)));
          })(); }}
          onSaveAsDefault={() => {
            setSettings((s) => (s ? { ...s, defaultConfig: config } : s));
            toast.show('已存为新会话的默认配置');
          }}
        />
      </aside>
      ) : null}

      {workspaceOpen ? (
        <ErrorBoundary label="工作区" onReset={() => setWorkspaceOpen(false)}>
        <WorkspaceDialog
          tab={workspaceTab}
          onTab={setWorkspaceTab}
          onClose={() => setWorkspaceOpen(false)}
          projects={projects}
          onProjects={setProjects}
          skills={skills}
          onSkills={setSkills}
          tasks={tasks}
          onTasks={setTasks}
          profiles={settings.keyProfiles}
          models={models}
          toolCtx={toolContextOf(settings, active?.projectId ?? null)}
          skillSync={settings.skillSync ?? { dir: '', auto: false }}
          onSkillSync={(c) => setSettings((p) => (p ? { ...p, skillSync: c } : p))}
        />
        </ErrorBoundary>
      ) : null}

      {observationsOpen ? <React.Suspense fallback={<Modal title="任务记录与分析" onClose={()=>setObservationsOpen(false)}><div className="modal-body">正在读取记录…</div></Modal>}>
        <ObservationPanel onClose={()=>setObservationsOpen(false)} onOpenTask={(conversationId,answerId)=>{setActiveId(conversationId);setObservationsOpen(false);setTimeout(()=>document.getElementById(`msg-${answerId}`)?.scrollIntoView({block:'center'}),150);}}/>
      </React.Suspense>:null}
      {settingsOpen ? (
        <ErrorBoundary label="设置" onReset={() => setSettingsTab('keys')}>
        <SettingsDialog
          tab={settingsTab}
          onTab={setSettingsTab}
          settings={settings}
          onChange={(patch) => setSettings((s) => (s ? { ...s, ...patch } : s))}
          onClose={() => setSettingsOpen(false)}
          encryptionAvailable={info ? info.encryptionAvailable : null}
          storePath={info?.storePath ?? ''}
          onTestProfile={async (p) => {
            const key = await secretGet(p.id);
            if (!key) return '还没填 API Key';
            try {
              const list = await fetchModels(p, key, 30000);
              setSettings((s) =>
                s ? { ...s, cachedModels: { ...s.cachedModels, [p.id]: list } } : s,
              );
              return `连上了，拿到 ${list.length} 个模型`;
            } catch (e) {
              return `失败：${e instanceof Error ? e.message : String(e)}`;
            }
          }}
        />
        </ErrorBoundary>
      ) : null}

      {preview !== null ? (
        <Modal title="请求详情" onClose={() => setPreview(null)} wide>
          <div className="modal-body">
            <pre
              style={{
                margin: 0,
                fontFamily: 'var(--mono)',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {preview}
            </pre>
          </div>
        </Modal>
      ) : null}

      {confirmReq ? (
        <ToolConfirm
          step={confirmReq.step}
          onResolve={(ok) => {
            confirmReq.resolve(ok);
            setConfirmReq(null);
          }}
        />
      ) : null}

      {grantReq ? (
        <GrantDialog
          req={grantReq.req}
          onDecide={(ok, remember) => {
            grantReq.resolve(ok, remember);
            setGrantReq(null);
          }}
        />
      ) : null}

      {active ? <SelectionActions key={active.id} messages={active.messages}
        onReply={(quote) => { setQuotes((q) => [...q, quote]); setQuoteOnly(true); }}
        onAnnotate={saveAnnotation} /> : null}
      <Toast message={toast.message} />
    </div>
  );
}
