import React from 'react';
import type {
  AppSettings,
  ApprovalMode,
  Artifact,
  Attachment,
  ChatMessage,
  Conversation,
  GenerationConfig,
  KeyProfile,
  ModelInfo,
  SourceRef,
  ToolStep,
} from './types';
import { SEED_MODELS, fetchModels, previewBody } from './lib/api';
import { runAgent, type AgentHandle } from './lib/agent';
import { TOOL_BY_NAME, availableTools } from './lib/tools/registry';
import {
  loadConversations,
  loadSettings,
  newConversation,
  saveConversationsDebounced,
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
import { loadProjects, projectSystemBlock, saveProjects, type Project } from './lib/projects';
import {
  dueTasks,
  loadTasks,
  nextRun,
  saveTasks,
  type ScheduledTask,
} from './lib/schedule';
import AnswerBlock from './components/AnswerBlock';
import Composer from './components/Composer';
import ConfigPanel from './components/ConfigPanel';
import SettingsDialog from './components/SettingsDialog';
import Sidebar from './components/Sidebar';
import ArtifactPanel from './components/ArtifactPanel';
import Resizer from './components/Resizer';
import ErrorBoundary from './components/ErrorBoundary';
import ToolConfirm from './components/ToolConfirm';
import WorkspaceDialog from './components/WorkspaceDialog';
import { Modal, Toast, useToast } from './components/ui';

const EXAMPLES = [
  '日日新现在有哪些免费模型，各自的上下文长度是多少？',
  '读一下我工作目录里的 README，说说这个项目是干什么的',
  '搜一下 2026 年 A 股量化私募的监管新规，给我一个时间线',
  '把当前 Chrome 标签页的内容总结成三点',
];

export default function App() {
  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const [models, setModels] = React.useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [modelsError, setModelsError] = React.useState<string | null>(null);

  const [busy, setBusy] = React.useState<{ requestId: string; handle: AgentHandle } | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
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
  const [queue, setQueue] = React.useState<string[]>([]);

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
      setSettings(s);
      setConversations(c);
      setProjects(pr);
      setSkills(sk);
      setTasks(tk);
      setActiveId(c.length ? [...c].sort((a, b) => b.updatedAt - a.updatedAt)[0].id : null);
      setRemoteConfig(s.remote);
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
    if (conversations.length) saveConversationsDebounced(conversations);
  }, [conversations]);

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

  const send = React.useCallback(
    async (text: string, replaceFromIndex?: number) => {
      if (!settings) return;
      if (busy) {
        // 正在生成时不打断，排到队尾；附件跟着这条一起排
        setQueue((q) => [...q, text]);
        return;
      }

      if (!profile) {
        toast.show('先去设置里登记一份 API 凭据');
        setSettingsOpen(true);
        return;
      }
      const apiKey = await secretGet(profile.id);
      if (!apiKey) {
        toast.show('这份凭据还没填 API Key');
        setSettingsOpen(true);
        return;
      }

      // 没有会话就现开一个
      let conv = active;
      let baseList = conversations;
      if (!conv) {
        conv = newConversation(settings.defaultConfig, profile.id);
        baseList = [conv, ...conversations];
      }
      const cfg = conv.config;

      if (!cfg.model) {
        toast.show('先选一个模型');
        setConfigOpen(true);
        return;
      }

      const kept =
        replaceFromIndex === undefined ? conv.messages : conv.messages.slice(0, replaceFromIndex);

      // 本轮唤起的技能：固定一份快照，并记一次使用次数
      const turnSkills = activeSkills;
      if (turnSkills.length) {
        const ids = new Set(turnSkills.map((x) => x.id));
        setSkills((prev) => prev.map((x) => (ids.has(x.id) ? { ...x, uses: x.uses + 1 } : x)));
      }

      const userMsg: ChatMessage = {
        id: uid('m'),
        role: 'user',
        content: text,
        createdAt: Date.now(),
        attachments: attachments.length ? attachments : undefined,
        skillNames: turnSkills.length ? turnSkills.map((x) => x.name) : undefined,
      };
      const answerMsg: ChatMessage = {
        id: uid('m'),
        role: 'assistant',
        content: '',
        reasoning: '',
        createdAt: Date.now(),
        pending: true,
        model: cfg.model,
        steps: [],
        sources: [],
      };

      const convId = conv.id;
      const history = [...kept, userMsg];
      const nextConv: Conversation = {
        ...conv,
        title: kept.length === 0 ? titleFrom(text) : conv.title,
        messages: [...history, answerMsg],
        updatedAt: Date.now(),
      };

      setConversations(baseList.map((c) => (c.id === convId ? nextConv : c)));
      setActiveId(convId);
      setAttachments([]);
      setActiveSkills([]);

      /* --- 流式缓冲：按 60ms 节流刷进 state，不然一个 token 一次 setState --- */
      const buf = { content: '', reasoning: '', dirty: false };
      const flush = () => {
        if (!buf.dirty) return;
        buf.dirty = false;
        const content = buf.content;
        const reasoning = buf.reasoning;
        patchMessage(convId, answerMsg.id, { content, reasoning });
      };
      const timer = setInterval(flush, 60);

      const steps: ToolStep[] = [];
      const started = Date.now();
      const requestId = uid('r');

      const handle = runAgent({
        requestId,
        profile,
        apiKey,
        config: cfg,
        history,
        toolCtx: toolContextOf(settings, conv.projectId ?? null),
        effortMappings: settings.effortMappings,
        extraSystem: [
          projectSystemBlock(projects.find((p) => p.id === conv.projectId) ?? null),
          skillSystemBlock(turnSkills),
        ]
          .filter(Boolean)
          .join('\n\n'),
        timeoutMs: settings.requestTimeoutMs,
        canRunHostTools,
        confirm: (step) => {
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
            patchMessage(convId, answerMsg.id, { steps: [...steps] });
          },
          onSources(list: SourceRef[]) {
            patchMessage(convId, answerMsg.id, { sources: [...list] });
          },
          onUsage(u) {
            patchMessage(convId, answerMsg.id, { usage: u });
          },
          onRound() {},
          onDone() {
            clearInterval(timer);
            flush();
            const arts = collectArtifacts(buf.content, steps);
            patchMessage(convId, answerMsg.id, {
              pending: false,
              content: buf.content,
              reasoning: buf.reasoning,
              elapsedMs: Date.now() - started,
              artifacts: arts.length ? arts : undefined,
            });
            // 只产出一个东西时直接开右侧面板 —— 多个就让用户自己挑
            if (arts.length === 1) setOpenArtifact(arts[0]);
            setBusy(null);
          },
          onError(msg) {
            clearInterval(timer);
            flush();
            patchMessage(convId, answerMsg.id, {
              pending: false,
              error: msg,
              content: buf.content,
              elapsedMs: Date.now() - started,
            });
            setBusy(null);
          },
        },
      });

      setBusy({ requestId, handle });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, conversations, active, profile, busy, canRunHostTools, attachments, activeSkills, projects],
  );

  function stop() {
    busy?.handle.abort();
    setBusy(null);
  }

  // 上一轮结束后自动发下一条排队的
  React.useEffect(() => {
    if (busy || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void send(next);
  }, [busy, queue, send]);

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

  const composer = (
    <Composer
      busy={Boolean(busy)}
      disabled={false}
      sendKey={settings.sendKey}
      onSend={(t) => void send(t)}
      onStop={stop}
      stream={config.stream}
      toolCount={toolNames.length}
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
      effortLevel={config.effortLevel}
      onEffortLevel={(l: EffortLevel) => setConfig({ effortLevel: l })}
      effortMappings={settings.effortMappings}
      effortManual={config.thinkingStyle !== 'auto'}
      onOpenMappings={() => {
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
      queued={queue}
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
            <div className="hero-box">{composer}</div>
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
                    onCopy={(text) => {
                      void navigator.clipboard.writeText(text);
                      toast.show('已复制');
                    }}
                    onRetry={
                      busy || !t.q
                        ? undefined
                        : () => void send(t.q!.content, t.qIndex)
                    }
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
          onPreview={() => setPreview(previewBody(config, '这里是你输入的问题', toolNames))}
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
        />
        </ErrorBoundary>
      ) : null}

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
        <Modal title="将要发出的请求体" onClose={() => setPreview(null)} wide>
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

      <Toast message={toast.message} />
    </div>
  );
}
