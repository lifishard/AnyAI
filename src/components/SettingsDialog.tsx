import React from 'react';
import LocalClientsPanel from './collaboration/LocalClientsPanel';
import type { AppSettings, KeyProfile, SearchProvider } from '../types';
import { BASE_URL_PRESETS, normalizeBaseUrl } from '../lib/api';
import { secretDelete, secretGet, secretSet, uid } from '../lib/store';
import { desktop, getTransport, type ChromeStatus, type RemoteStatus } from '../lib/transport';
import {
  EFFORT_LEVELS,
  STYLE_LABEL,
  defaultEffortMappings,
  type EffortMapping,
  type EffortStyle,
} from '../lib/effort';
import { Field, Modal, Segmented, Switch } from './ui';

type Tab = 'keys' | 'tools' | 'effort' | 'remote' | 'look';

const TAB_LABEL: Record<Tab, string> = {
  keys: 'API 凭据',
  tools: '工具',
  effort: '思考强度',
  remote: '遥控',
  look: '外观',
};

/* ------------------------------------------------------------------ *
 * 一个密钥输入框：进来时不显示已存的密钥，只显示「已保存」
 * ------------------------------------------------------------------ */

function SecretInput(props: {
  secretId: string;
  placeholder: string;
  onSaved?: () => void;
}) {
  const [value, setValue] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void secretGet(props.secretId).then((v) => {
      if (alive) setSaved(Boolean(v));
    });
    return () => {
      alive = false;
    };
  }, [props.secretId]);

  return (
    <div className="row">
      <input
        type="password"
        placeholder={saved && !dirty ? '已保存（留空不改动）' : props.placeholder}
        value={value}
        autoComplete="off"
        onChange={(e) => {
          setValue(e.target.value);
          setDirty(true);
        }}
      />
      <button
        className="btn sm"
        disabled={!value.trim()}
        onClick={async () => {
          await secretSet(props.secretId, value.trim());
          setValue('');
          setDirty(false);
          setSaved(true);
          props.onSaved?.();
        }}
      >
        保存
      </button>
      {saved ? (
        <button
          className="btn sm danger"
          onClick={async () => {
            await secretDelete(props.secretId);
            setSaved(false);
            setValue('');
          }}
        >
          清除
        </button>
      ) : null}
    </div>
  );
}



/* ------------------------------------------------------------------ *
 * Chrome 段落。带 hooks，独立成组件。
 * ------------------------------------------------------------------ */


/**
 * GitHub API 额度显示。
 *
 * /rate_limit 这个接口本身**不计入额度**，所以查它是免费的。
 * 这是「有没有入口重置」这个问题唯一能给的诚实答案：重置不了，但至少能看见
 * 还剩多少、什么时候自己恢复。
 */
/** 构建时间戳，本地时区显示。拿不到就说明是开发模式下跑的 */
function buildTime(): string {
  try {
    return new Date(__BUILD_TIME__).toLocaleString();
  } catch {
    return '开发模式（未打包）';
  }
}

function RateLimitRow() {
  const [state, setState] = React.useState<
    { remaining: number; limit: number; resetAt: number } | null
  >(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const check = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await getTransport().callTool(
        'github_api',
        { method: 'GET', path: '/rate_limit' },
        { toolTimeoutMs: 20000 } as never,
      );
      if (!res.ok) throw new Error(res.error ?? '查询失败');
      const data = JSON.parse(res.content) as {
        resources?: { core?: { remaining: number; limit: number; reset: number } };
      };
      const core = data.resources?.core;
      if (!core) throw new Error('返回里没有 core 额度');
      setState({ remaining: core.remaining, limit: core.limit, resetAt: core.reset * 1000 });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const mins = state ? Math.max(0, Math.round((state.resetAt - Date.now()) / 60000)) : 0;

  return (
    <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 4 }}>
      <button className="btn sm" onClick={() => void check()} disabled={busy}>
        {busy ? '查询中…' : '查看剩余额度'}
      </button>
      {state ? (
        <span className="hint">
          还剩 <b>{state.remaining}</b> / {state.limit} 次
          {state.remaining === 0 ? ` —— ${mins} 分钟后自动恢复` : `，${mins} 分钟后重置计数`}
          {state.limit <= 60 ? '（这是未登录的额度，填 token 会变成 5000）' : '（token 生效中）'}
        </span>
      ) : null}
      {err ? <span className="hint" style={{ color: 'var(--danger-fg, #b91c1c)' }}>{err}</span> : null}
    </div>
  );
}

function ChromeSection(props: { port: number; onPort: (p: number) => void }) {
  const bridge = desktop();
  const [status, setStatus] = React.useState<ChromeStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!bridge) return;
    setStatus(await bridge.chromeStatus(props.port));
  }, [bridge, props.port]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="section">
      <div className="section-title">Chrome</div>

      <div className="hint" style={{ marginBottom: 10, lineHeight: 1.85 }}>
        Chrome 136 之后，<code>--remote-debugging-port</code> 在<strong>默认用户目录</strong>下会被直接忽略
        —— 这是 Google 为了堵住「拿调试端口偷 cookie」做的安全变更。所以没法直接控制你日常那个
        Chrome，必须用一份独立的配置目录。
        <br />
        下面这个按钮会用一份专属配置拉起 Chrome。<strong>第一次需要在那个窗口里登录一遍你要用的网站</strong>，
        之后配置一直留着，不用重复登录，也完全不碰你日常那份。
      </div>

      <Field label="远程调试端口">
        <input
          type="number"
          value={props.port}
          onChange={(e) => props.onPort(Number(e.target.value) || 9222)}
        />
      </Field>

      {bridge ? (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setMsg(null);
                try {
                  const r = await bridge.chromeLaunch(props.port);
                  if (r.ok) {
                    setMsg(
                      r.alreadyRunning
                        ? `端口上已经有一个实例在跑：${r.browser ?? ''}`
                        : `已启动 ${r.browserName ?? ''}${r.browser ? `（${r.browser}）` : ''}`,
                    );
                  } else {
                    setMsg(r.error ?? '启动失败');
                  }
                } finally {
                  setBusy(false);
                  void refresh();
                }
              }}
            >
              {busy ? '启动中…' : '启动可控制的 Chrome'}
            </button>
            <button className="btn" onClick={() => void refresh()}>
              检测
            </button>
            <span className="chip">{status?.running ? '已连通' : '未连通'}</span>
          </div>

          {msg ? (
            <div className="hint" style={{ color: status?.running ? 'var(--ok)' : 'var(--danger)' }}>
              {msg}
            </div>
          ) : null}

          <div className="hint" style={{ marginTop: 8 }}>
            {status?.browserPath ? (
              <>
                找到的浏览器：<code>{status.browserPath}</code>
                <br />
              </>
            ) : (
              <>没在常见位置找到 Chrome 或 Edge。<br /></>
            )}
            {status?.profileDir ? (
              <>
                专属配置目录：<code>{status.profileDir}</code>
              </>
            ) : null}
          </div>
        </>
      ) : (
        <div className="hint">Chrome 只能从桌面端启动。手机端配好遥控后，操作会转发到电脑执行。</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 遥控页签。带 hooks，所以必须是独立组件 —— 定义在渲染函数里再条件调用
 * 会违反 hooks 调用顺序必须稳定的规则。
 * ------------------------------------------------------------------ */

function RemoteTab(props: {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}) {
  const bridge = desktop();
  const s = props.settings;
  const [status, setStatus] = React.useState<RemoteStatus | null>(null);
  const [port, setPort] = React.useState(8719);
  const [busy, setBusy] = React.useState(false);
  const [ping, setPing] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!bridge) return;
    void bridge.remoteStatus().then((st) => {
      setStatus(st);
      if (st.port) setPort(st.port);
    });
  }, [bridge]);

  if (bridge) {
    return (
      <div>
        <div className="hint" style={{ marginBottom: 14, lineHeight: 1.8 }}>
          手机上没有文件系统权限、控不了 Chrome、也没有 claude CLI，所以手机端的这些工具调用会转发到这台电脑执行。
          打开下面的服务，然后把地址和令牌抄到手机端的「遥控」设置里。
          <br />
          <strong>只在内网用。</strong>别把这个端口做端口转发暴露到公网 —— 它背后就是你电脑的命令行。
        </div>

        <Field label="监听端口">
          <input
            type="number"
            value={port}
            disabled={Boolean(status?.running)}
            onChange={(e) => setPort(Number(e.target.value) || 8719)}
          />
        </Field>

        <div className="row" style={{ marginBottom: 14 }}>
          <button
            className={`btn ${status?.running ? 'danger' : 'primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setStatus(
                  status?.running ? await bridge.remoteStop() : await bridge.remoteStart(port, ''),
                );
              } catch (e) {
                setPing(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {status?.running ? '停止服务' : '启动服务'}
          </button>
          <span className="chip">{status?.running ? '运行中' : '已停止'}</span>
          {ping ? <span className="hint" style={{ color: 'var(--danger)' }}>{ping}</span> : null}
        </div>

        {status?.running ? (
          <>
            <Field label="手机端填这个地址" hint="同一个 Wi-Fi 下，挑能通的那条。">
              <textarea
                className="mono"
                rows={Math.max(2, status.addresses.length)}
                readOnly
                value={status.addresses.join('\n')}
              />
            </Field>
            <Field label="配对令牌" hint="抄到手机端。换端口重启会保留同一个令牌。">
              <input
                type="text"
                readOnly
                value={status.token}
                style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
              />
            </Field>
          </>
        ) : null}
      </div>
    );
  }

  const r = s.remote;
  const patch = (p: Partial<typeof r>) => props.onChange({ remote: { ...r, ...p } });

  return (
    <div>
      <div className="hint" style={{ marginBottom: 14, lineHeight: 1.8 }}>
        在电脑上打开 设置 → 遥控 里的服务，把那边显示的地址和令牌填到这里。
        填好之后，手机上也能让模型读你电脑的文件、控 Chrome、调 Claude Code。
      </div>

      <div className="field">
        <Switch checked={r.enabled} onChange={(v) => patch({ enabled: v })} label="启用遥控" />
      </div>

      <Field label="电脑地址">
        <input
          type="text"
          value={r.url}
          placeholder="http://192.168.1.10:8719"
          onChange={(e) => patch({ url: e.target.value })}
        />
      </Field>

      <Field label="配对令牌">
        <input type="text" value={r.token} onChange={(e) => patch({ token: e.target.value })} />
      </Field>

      <button
        className="btn block"
        onClick={async () => {
          setPing('连接中…');
          try {
            const res = await fetch(`${r.url.replace(/\/+$/, '')}/ping`);
            const j = await res.json();
            setPing(j.ok ? `连通了：${j.host}` : '对面返回了意外内容');
          } catch (e) {
            setPing(`连不上：${e instanceof Error ? e.message : String(e)}`);
          }
        }}
      >
        测试连通
      </button>
      {ping ? <div className="hint" style={{ marginTop: 8 }}>{ping}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function SettingsDialog(props: {
  tab: string;
  onTab: (t: string) => void;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
  onTestProfile: (p: KeyProfile) => Promise<string>;
  encryptionAvailable: boolean | null;
  storePath: string;
}) {
  const tab = (['keys', 'tools', 'effort', 'remote', 'look'] as Tab[]).includes(props.tab as Tab)
    ? (props.tab as Tab)
    : 'keys';
  const setTab = (t: Tab) => props.onTab(t);
  const s = props.settings;
  const bridge = desktop();

  /* ---------------- 凭据 ---------------- */

  function updateProfile(id: string, patch: Partial<KeyProfile>) {
    props.onChange({
      keyProfiles: s.keyProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  }

  function addProfile() {
    const p: KeyProfile = {
      id: uid('k'),
      name: `凭据 ${s.keyProfiles.length + 1}`,
      baseUrl: BASE_URL_PRESETS[0].url,
      hasSecret: false,
      extraHeaders: {},
      createdAt: Date.now(),
    };
    props.onChange({
      keyProfiles: [...s.keyProfiles, p],
      activeKeyProfileId: s.activeKeyProfileId ?? p.id,
    });
  }

  const [testing, setTesting] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<Record<string, string>>({});

  function KeysTab() {
    return (
      <div>
        {props.encryptionAvailable === false ? (
          <div className="card" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}>
            这台机器上系统级加密不可用，密钥会以明文存在 {props.storePath}。
            注意别把这个文件同步到云盘或共享出去。
          </div>
        ) : null}

        {s.keyProfiles.length === 0 ? (
          <div className="empty">
            还没有登记任何凭据。
            <br />
            去 platform.sensenova.cn 控制台复制一个 API Key 回来。
          </div>
        ) : null}

        {s.keyProfiles.map((p) => (
          <div className="card" key={p.id}>
            <div className="row" style={{ marginBottom: 10 }}>
              <input
                type="text"
                value={p.name}
                onChange={(e) => updateProfile(p.id, { name: e.target.value })}
                style={{ fontWeight: 600 }}
              />
              <label className="switch" title="设为当前使用的凭据">
                <input
                  type="radio"
                  name="activeProfile"
                  checked={s.activeKeyProfileId === p.id}
                  onChange={() => props.onChange({ activeKeyProfileId: p.id })}
                  style={{ appearance: 'auto', width: 16, height: 16 }}
                />
                <span style={{ fontSize: 12 }}>当前</span>
              </label>
              <button
                className="btn sm danger"
                onClick={() => {
                  void secretDelete(p.id);
                  const rest = s.keyProfiles.filter((x) => x.id !== p.id);
                  props.onChange({
                    keyProfiles: rest,
                    activeKeyProfileId:
                      s.activeKeyProfileId === p.id ? (rest[0]?.id ?? null) : s.activeKeyProfileId,
                  });
                }}
              >
                删除
              </button>
            </div>

            <Field
              label="API Base URL"
              hint="免费额度走 token 端点；企业账号或自建网关填自己的地址。末尾不用加斜杠。"
            >
              <input
                type="text"
                value={p.baseUrl}
                onChange={(e) => updateProfile(p.id, { baseUrl: e.target.value })}
                onBlur={(e) => updateProfile(p.id, { baseUrl: normalizeBaseUrl(e.target.value) })}
                list={`presets-${p.id}`}
              />
              <datalist id={`presets-${p.id}`}>
                {BASE_URL_PRESETS.map((b) => (
                  <option key={b.url} value={b.url}>
                    {b.label}
                  </option>
                ))}
              </datalist>
            </Field>

            <Field label="API Key" hint="保存后就只留在本机的安全存储里，界面上不再回显。">
              <SecretInput
                secretId={p.id}
                placeholder="粘贴 API Key"
                onSaved={() => updateProfile(p.id, { hasSecret: true })}
              />
            </Field>

            <div className="row">
              <button
                className="btn sm"
                disabled={testing === p.id}
                onClick={async () => {
                  setTesting(p.id);
                  const msg = await props.onTestProfile(p);
                  setTestResult((r) => ({ ...r, [p.id]: msg }));
                  setTesting(null);
                }}
              >
                {testing === p.id ? '测试中…' : '测试连接'}
              </button>
              {testResult[p.id] ? (
                <span className="hint" style={{ flex: 1 }}>
                  {testResult[p.id]}
                </span>
              ) : null}
            </div>
          </div>
        ))}

        <button className="btn block" onClick={addProfile}>
          ＋ 添加一份凭据
        </button>

        <div className="card" style={{ marginTop: 14 }}>
          <div className="section-title" style={{ marginTop: 0 }}>关于上下文缓存</div>
          <div className="hint" style={{ lineHeight: 1.85 }}>
            Kimi / Moonshot 的上下文缓存现在是<strong>全自动的</strong> —— 没有要调的接口、没有要发的
            header、也没有缓存对象要创建。超过 256 token 的请求，重复的前缀会自动命中。
            <br />
            <br />
            所以省 token 这件事上，客户端能做的只有一件：<strong>别把前缀搞乱</strong>。缓存是按前缀逐字节
            匹配的，这个应用为此做了两件事 —— 工具清单下发前排序（否则你勾一下工具，序列化结果变了，
            整段前缀就失配），以及只往历史后面追加、不改写前面的内容。
            <br />
            <br />
            有两个操作会主动破坏前缀，用的时候心里有数就行：把「携带历史条数」从 0 改成有限值（会从
            头部截断），以及超长对话触发的旧工具输出压缩。命中了多少会显示在每条回答下面。
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- 工具 ---------------- */

  function ToolsTab() {
    const t = s.tools;
    const patch = (p: Partial<typeof t>) => props.onChange({ tools: { ...t, ...p } });

    return (
      <div>
        <div className="section">
          <div className="section-title">工作目录</div>
          <div className="hint" style={{ marginBottom: 8 }}>
            文件和命令行工具只能在这些目录里动手。<strong>一个都不加的话，这类工具会全部拒绝执行</strong>
            —— 这是故意的，默认不给整块磁盘的权限。
          </div>

          {t.workspaceRoots.map((root, i) => (
            <div className="row" key={`${root}-${i}`} style={{ marginBottom: 6 }}>
              <input type="text" value={root} readOnly style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
              <button
                className="btn sm danger"
                onClick={() => patch({ workspaceRoots: t.workspaceRoots.filter((_, j) => j !== i) })}
              >
                移除
              </button>
            </div>
          ))}

          {bridge ? (
            <button
              className="btn block"
              onClick={async () => {
                const dir = await bridge.pickFolder();
                if (dir && !t.workspaceRoots.includes(dir)) {
                  patch({ workspaceRoots: [...t.workspaceRoots, dir] });
                }
              }}
            >
              ＋ 选一个目录
            </button>
          ) : (
            <div className="hint">工作目录只能在桌面端添加。</div>
          )}
        </div>

        <div className="section">
          <div className="section-title">操作放行</div>
          <div className="hint" style={{ lineHeight: 1.85 }}>
            危险操作问不问，已经挪到输入框左下角那个按钮上了 —— 逐步确认 / 自动批准编辑 / 全部放行，
            每个会话各自记住自己的档位，随时能在对话中途切。
            <br />
            放这儿不合适：这是个会话级、需要频繁切换的决定，藏在设置里等于逼你每次都翻两层。
          </div>
        </div>

        <div className="section">
          <div className="section-title">搜索</div>
          <Field label="搜索源">
            <Segmented<SearchProvider>
              value={t.searchProvider}
              options={[
                { value: 'tavily', label: 'Tavily' },
                { value: 'brave', label: 'Brave' },
                { value: 'searxng', label: 'SearXNG' },
              ]}
              onChange={(v) => patch({ searchProvider: v })}
            />
          </Field>

          {t.searchProvider === 'tavily' ? (
            <Field label="Tavily API Key" hint="app.tavily.com 注册后拿，免费额度每月 1000 次。">
              <SecretInput secretId="tool:tavily" placeholder="tvly-..." />
            </Field>
          ) : null}

          {t.searchProvider === 'brave' ? (
            <Field
              label="Brave Search API Key"
              hint="brave.com/search/api 申请，免费档每月 2000 次。注意 Brave 只给标题和摘要，需要正文时让模型再 fetch_url。"
            >
              <SecretInput secretId="tool:brave" placeholder="BSA..." />
            </Field>
          ) : null}

          {t.searchProvider === 'searxng' ? (
            <Field
              label="SearXNG 地址"
              hint="自建实例的地址。要在它的 settings.yml 里打开 json 格式输出，否则会返回 403。"
            >
              <input
                type="text"
                value={t.searxngUrl}
                placeholder="http://127.0.0.1:8080"
                onChange={(e) => patch({ searxngUrl: e.target.value })}
              />
            </Field>
          ) : null}
        </div>

        <ChromeSection port={t.chromePort} onPort={(v) => patch({ chromePort: v })} />

        <div className="section">
          <div className="section-title">GitHub</div>
          <Field
            label="Personal Access Token"
            hint="不填也能用，但只能读公开内容，而且限额是按 IP 每小时 60 次。填了变成 5000 次。代码搜索必须要 token。"
          >
            <SecretInput secretId="tool:github" placeholder="ghp_... 或 github_pat_..." />
          </Field>
          <RateLimitRow />
          <div className="hint" style={{ marginTop: 6, lineHeight: 1.8 }}>
            到哪拿：github.com → Settings → Developer settings → Personal access tokens →
            <b> Fine-grained tokens</b> → Generate new token。Repository access 选
            「Public Repositories (read-only)」就够装技能了，什么权限都不用勾。
            <br />
            已经装了 GitHub CLI 的话更快：命令行跑 <code>gh auth login</code>，然后
            <code>gh auth token</code> 会把 token 打印出来，复制粘贴进上面那个框。
            <br />
            <b>限额不能重置</b> —— 它是 GitHub 服务端按 IP 算的滚动窗口，客户端没有任何手段清零，
            只能等窗口滚过去，或者换成 token 额度。
          </div>
        </div>

        <div className="section">
          <div className="section-title">Claude Code</div>
          <Field label="claude 可执行文件" hint="留空就用 PATH 里的 claude。装了但找不到就填绝对路径。">
            <input
              type="text"
              value={t.claudeBin}
              placeholder="claude"
              onChange={(e) => patch({ claudeBin: e.target.value })}
            />
          </Field>
          <Field
            label="附加命令行参数"
            hint="默认给了 --permission-mode acceptEdits，否则 headless 模式下它遇到要授权的操作会直接卡住。想让它更放得开可以调，但那意味着它改什么都不问你。"
          >
            <input
              type="text"
              value={t.claudeExtraArgs}
              onChange={(e) => patch({ claudeExtraArgs: e.target.value })}
            />
          </Field>
          <Field label={`超时：${Math.round(t.claudeTimeoutMs / 1000)} 秒`}>
            <input
              type="range"
              min={30000}
              max={3600000}
              step={30000}
              value={t.claudeTimeoutMs}
              onChange={(e) => patch({ claudeTimeoutMs: Number(e.target.value) })}
            />
          </Field>
        </div>
      </div>
    );
  }


  /* ---------------- 思考强度映射 ---------------- */

  function EffortTab() {
    const mappings = s.effortMappings;
    const setMappings = (next: EffortMapping[]) => props.onChange({ effortMappings: next });
    const patchAt = (i: number, patch: Partial<EffortMapping>) =>
      setMappings(mappings.map((m, j) => (j === i ? { ...m, ...patch } : m)));

    const levels = EFFORT_LEVELS.filter((l) => l.value !== 'off');
    const EMPTY_LEVELS = { low: '', medium: '', high: '', xhigh: '', max: '' };

    return (
      <div>
        <div className="hint" style={{ marginBottom: 14, lineHeight: 1.85 }}>
          同一件事（「多想一会儿」）各家 API 长得完全不一样：OpenAI 是
          <code>reasoning_effort</code> 字符串，Anthropic 是 <code>thinking</code> 对象带 token
          预算，通义智谱是 <code>enable_thinking</code> 加预算，DeepSeek 的 reasoner 干脆没有开关。
          <br />
          所以输入框右下角只给一档五级刻度，切模型不用重学。这张表负责翻译：
          <strong>按顺序匹配模型 ID，第一条命中的生效</strong>。
          <br />
          标了「推测」的几条是按厂商惯例填的，没有逐个实测 —— 报 400 就改这里，不用改代码。
        </div>

        {mappings.map((m, i) => (
          <div className="card" key={m.id}>
            <div className="row" style={{ marginBottom: 8 }}>
              <input
                type="text"
                value={m.label}
                onChange={(e) => patchAt(i, { label: e.target.value })}
                style={{ fontWeight: 600, flex: '0 0 150px' }}
              />
              <input
                type="text"
                value={m.pattern}
                onChange={(e) => patchAt(i, { pattern: e.target.value })}
                placeholder="匹配模型 ID 的正则"
                style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
              />
              {m.unverified ? <span className="badge-danger">推测</span> : null}
              <button className="icon-btn" title="上移" onClick={() => {
                if (i === 0) return;
                const next = [...mappings];
                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                setMappings(next);
              }}>↑</button>
              <button className="btn sm danger" onClick={() => setMappings(mappings.filter((_, j) => j !== i))}>
                删除
              </button>
            </div>

            <Field label="下发方式">
              <select
                value={m.style}
                onChange={(e) => patchAt(i, { style: e.target.value as EffortStyle })}
              >
                {(Object.keys(STYLE_LABEL) as EffortStyle[]).map((k) => (
                  <option key={k} value={k}>
                    {STYLE_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>

            {m.style !== 'none' ? (
              <div>
                <div className="field-label" style={{ marginBottom: 4 }}>
                  每一级发什么
                  <span style={{ fontWeight: 400, color: 'var(--fg-faint)' }}>
                    {m.style === 'openai'
                      ? '（填字符串，例如 low / medium / high）'
                      : m.style === 'custom'
                        ? '（填 JSON 片段）'
                        : '（填 token 预算数字）'}
                  </span>
                </div>
                {levels.map((l) => (
                  <div className="param-row" key={l.value}>
                    <span className="popup-icon">{l.short}</span>
                    <span className="name">{l.label}</span>
                    <input
                      type="text"
                      value={(m.levels ?? EMPTY_LEVELS)[l.value as keyof typeof EMPTY_LEVELS] ?? ''}
                      placeholder="留空 = 这一级不下发"
                      onChange={(e) =>
                        patchAt(i, {
                          levels: { ...EMPTY_LEVELS, ...m.levels, [l.value]: e.target.value },
                        })
                      }
                      style={{ width: m.style === 'custom' ? 200 : 120 }}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}

        <div className="row">
          <button
            className="btn"
            onClick={() =>
              setMappings([
                {
                  id: `m-${Date.now()}`,
                  pattern: '',
                  label: '新规则',
                  style: 'openai',
                  levels: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },
                },
                ...mappings,
              ])
            }
          >
            ＋ 加一条（插到最前面）
          </button>
          <button className="btn" onClick={() => setMappings(defaultEffortMappings())}>
            恢复默认
          </button>
        </div>
      </div>
    );
  }

  /* ---------------- 外观 ---------------- */

  function LookTab() {
    return (
      <div>
        <Field label="主题">
          <Segmented
            value={s.theme}
            options={[
              { value: 'system' as const, label: '跟随系统' },
              { value: 'light' as const, label: '浅色' },
              { value: 'dark' as const, label: '深色' },
            ]}
            onChange={(v) => props.onChange({ theme: v })}
          />
        </Field>

        <Field label="发送快捷键">
          <Segmented
            value={s.sendKey}
            options={[
              { value: 'enter' as const, label: 'Enter 发送' },
              { value: 'mod-enter' as const, label: 'Ctrl/⌘+Enter 发送' },
            ]}
            onChange={(v) => props.onChange({ sendKey: v })}
          />
        </Field>

        <Field label={`字号：${Math.round(s.fontScale * 100)}%`}>
          <input
            type="range"
            min={0.85}
            max={1.4}
            step={0.05}
            value={s.fontScale}
            onChange={(e) => props.onChange({ fontScale: Number(e.target.value) })}
          />
        </Field>

        <div className="field">
          <Switch
            checked={s.showReasoningByDefault}
            onChange={(v) => props.onChange({ showReasoningByDefault: v })}
            label="生成时自动展开思考过程"
          />
        </div>

        <Field label={`请求超时：${Math.round(s.requestTimeoutMs / 1000)} 秒`}>
          <input
            type="range"
            min={30000}
            max={600000}
            step={10000}
            value={s.requestTimeoutMs}
            onChange={(e) => props.onChange({ requestTimeoutMs: Number(e.target.value) })}
          />
        </Field>

        <div className="hint" style={{ marginTop: 16, lineHeight: 1.9 }}>
          {props.storePath ? (
            <>
              数据文件：<code>{props.storePath}</code>
              <br />
            </>
          ) : null}
          构建于：<code>{buildTime()}</code>
          <br />
          改了代码之后要重新跑一次打包，这里的时间才会变 —— 遇到「明明改了却没生效」先看这个。
        </div>
      </div>
    );
  }

  return (
    <Modal title="设置" onClose={props.onClose} wide>
      <div className="tabs">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="modal-body">
        {tab === 'keys' ? <>{KeysTab()}<LocalClientsPanel settings={s} onChange={props.onChange}/></> : null}
        {tab === 'tools' ? ToolsTab() : null}
        {tab === 'effort' ? EffortTab() : null}
        {tab === 'remote' ? <RemoteTab settings={s} onChange={props.onChange} /> : null}
        {tab === 'look' ? LookTab() : null}
      </div>
    </Modal>
  );
}
