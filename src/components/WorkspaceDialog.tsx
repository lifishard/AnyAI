import React from 'react';
import type { KeyProfile, ModelInfo, ToolContext } from '../types';
import { installFromGithub, makeSkill, parseSkillMd, toSkillMd, type Skill } from '../lib/skills';
import { makeProject, type Project, type ProjectDoc } from '../lib/projects';
import {
  describeSchedule,
  makeTask,
  nextRun,
  parseCron,
  type ScheduledTask,
} from '../lib/schedule';
import { uid } from '../lib/store';
import { Field, Modal, Segmented, Switch } from './ui';

type Tab = 'projects' | 'skills' | 'tasks';

const TAB_LABEL: Record<Tab, string> = {
  projects: '项目',
  skills: '技能',
  tasks: '定时任务',
};

/* ================================================================== *
 * 项目
 * ================================================================== */

function ProjectsTab(props: {
  projects: Project[];
  onChange: (p: Project[]) => void;
  profiles: KeyProfile[];
  models: ModelInfo[];
}) {
  const [sel, setSel] = React.useState<string | null>(props.projects[0]?.id ?? null);
  const p = props.projects.find((x) => x.id === sel) ?? null;

  const patch = (v: Partial<Project>) => {
    if (!p) return;
    props.onChange(props.projects.map((x) => (x.id === p.id ? { ...x, ...v } : x)));
  };

  const setDoc = (id: string, v: Partial<ProjectDoc>) =>
    patch({
      docs: (p?.docs ?? []).map((d) => (d.id === id ? { ...d, ...v, updatedAt: Date.now() } : d)),
    });

  return (
    <div>
      <div className="hint" style={{ marginBottom: 12, lineHeight: 1.85 }}>
        项目 = 一组对话 + 一份共享上下文。同一个项目里新开的对话自动继承规范、记忆、文档清单和常用提示词。
        <br />
        <strong>文档正文不会每轮都塞进去</strong> —— 只给模型一份目录，它需要时用 <code>project_doc_read</code>{' '}
        按名字取。一个项目攒几万字很正常，全量注入等于每轮重付一次钱。
      </div>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {props.projects.map((x) => (
          <button
            key={x.id}
            className={`picker-profile${x.id === sel ? ' on' : ''}`}
            onClick={() => setSel(x.id)}
          >
            {x.emoji} {x.name}
          </button>
        ))}
        <button
          className="btn sm"
          onClick={() => {
            const np = makeProject('新项目');
            props.onChange([...props.projects, np]);
            setSel(np.id);
          }}
        >
          ＋ 新建项目
        </button>
      </div>

      {!p ? (
        <div className="empty">还没有项目。建一个，把相关的对话归到一起。</div>
      ) : (
        <div>
          <div className="row" style={{ marginBottom: 10 }}>
            <input
              type="text"
              value={p.emoji}
              onChange={(e) => patch({ emoji: e.target.value.slice(0, 4) })}
              style={{ flex: '0 0 56px', textAlign: 'center' }}
            />
            <input
              type="text"
              value={p.name}
              onChange={(e) => patch({ name: e.target.value })}
              style={{ fontWeight: 600 }}
            />
            <button
              className="btn sm danger"
              onClick={() => {
                if (!confirm(`删除项目「${p.name}」？里面的对话会保留，只是不再归属任何项目。`)) return;
                const rest = props.projects.filter((x) => x.id !== p.id);
                props.onChange(rest);
                setSel(rest[0]?.id ?? null);
              }}
            >
              删除
            </button>
          </div>

          <Field
            label="项目规范"
            hint="拼进这个项目里每一轮的 system prompt。写约定、口径、禁忌 —— 别写具体任务。"
          >
            <textarea
              rows={5}
              value={p.instructions}
              placeholder="例如：所有代码用 TypeScript strict；回答先给结论再给推导；金额一律标明币种。"
              onChange={(e) => patch({ instructions: e.target.value })}
            />
          </Field>

          <Field label="默认模型" hint="在这个项目里新开对话时套上。留空就用全局默认。">
            <input
              type="text"
              list="ws-models"
              value={p.defaultModel ?? ''}
              placeholder="留空 = 跟随全局"
              onChange={(e) => patch({ defaultModel: e.target.value })}
            />
            <datalist id="ws-models">
              {props.models.slice(0, 200).map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </Field>

          <Field label="默认凭据">
            <select
              value={p.defaultKeyProfileId ?? ''}
              onChange={(e) => patch({ defaultKeyProfileId: e.target.value || null })}
            >
              <option value="">跟随全局</option>
              {props.profiles.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="section">
            <div className="section-title">项目记忆</div>
            <div className="hint" style={{ marginBottom: 6 }}>
              模型用 <code>project_memory_write</code> 往里追加跨对话的结论。这里可以直接改或清空。
              太长会挤占每轮的上下文，超过两万字会自动截断最早的部分。
            </div>
            <textarea
              rows={6}
              className="mono"
              value={p.memory}
              placeholder="（空）"
              onChange={(e) => patch({ memory: e.target.value })}
            />
          </div>

          <div className="section">
            <div className="section-title">文档</div>
            {(p.docs ?? []).map((d) => (
              <div className="card" key={d.id}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <input
                    type="text"
                    value={d.name}
                    onChange={(e) => setDoc(d.id, { name: e.target.value })}
                    style={{ fontWeight: 600 }}
                  />
                  <span className="chip">{d.text.length} 字</span>
                  <button
                    className="btn sm danger"
                    onClick={() => patch({ docs: p.docs.filter((x) => x.id !== d.id) })}
                  >
                    删除
                  </button>
                </div>
                <textarea
                  rows={5}
                  className="mono"
                  value={d.text}
                  onChange={(e) => setDoc(d.id, { text: e.target.value })}
                />
              </div>
            ))}
            <button
              className="btn block"
              onClick={() =>
                patch({
                  docs: [
                    ...(p.docs ?? []),
                    { id: uid('d'), name: `文档 ${(p.docs?.length ?? 0) + 1}`, text: '', updatedAt: Date.now() },
                  ],
                })
              }
            >
              ＋ 加一篇文档
            </button>
          </div>

          <div className="section">
            <div className="section-title">常用提示词</div>
            <div className="hint" style={{ marginBottom: 6 }}>
              在这个项目里、输入框还空着的时候，会以小胶囊的形式出现在输入框上方，点一下填进去。
            </div>
            {(p.prompts ?? []).map((pp) => (
              <div className="row" key={pp.id} style={{ marginBottom: 6 }}>
                <input
                  type="text"
                  value={pp.label}
                  placeholder="按钮上显示的短名"
                  onChange={(e) =>
                    patch({
                      prompts: p.prompts.map((x) =>
                        x.id === pp.id ? { ...x, label: e.target.value } : x,
                      ),
                    })
                  }
                  style={{ flex: '0 0 140px' }}
                />
                <input
                  type="text"
                  value={pp.text}
                  placeholder="点了之后填进输入框的内容"
                  onChange={(e) =>
                    patch({
                      prompts: p.prompts.map((x) =>
                        x.id === pp.id ? { ...x, text: e.target.value } : x,
                      ),
                    })
                  }
                />
                <button
                  className="btn sm danger"
                  onClick={() => patch({ prompts: p.prompts.filter((x) => x.id !== pp.id) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn block"
              onClick={() =>
                patch({ prompts: [...(p.prompts ?? []), { id: uid('pp'), label: '新提示词', text: '' }] })
              }
            >
              ＋ 加一条
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 * 技能
 * ================================================================== */

function SkillsTab(props: {
  skills: Skill[];
  onChange: (s: Skill[]) => void;
  toolCtx: ToolContext;
}) {
  const [ghInput, setGhInput] = React.useState('');
  const [installing, setInstalling] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);

  const patch = (id: string, v: Partial<Skill>) =>
    props.onChange(props.skills.map((s) => (s.id === id ? { ...s, ...v } : s)));

  async function install() {
    const input = ghInput.trim();
    if (!input) return;
    setInstalling(true);
    setMsg('连接 GitHub…');
    try {
      const found = await installFromGithub(input, props.toolCtx, (s) => setMsg(s));
      // 同名的覆盖，不同名的追加
      const byName = new Map(props.skills.map((s) => [s.name, s]));
      for (const f of found) byName.set(f.name, { ...f, id: byName.get(f.name)?.id ?? f.id });
      props.onChange([...byName.values()]);
      setMsg(`装好了 ${found.length} 个：${found.map((f) => `/${f.name}`).join(' ')}`);
      setGhInput('');
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div>
      <div className="hint" style={{ marginBottom: 12, lineHeight: 1.85 }}>
        技能 = 一段写好的指令，在输入框打 <code>/名字</code> 唤起，唤起时作为额外的 system 消息注入这一轮。
        <br />
        <strong>技能是提示词，不是可执行代码</strong> —— 装一个技能不会在你机器上跑任何东西，所以不需要沙箱。
        格式跟 Anthropic 的 SKILL.md 一致，GitHub 上现成的技能仓库能直接装。
        <br />
        也可以直接跟模型说「把刚才那套流程存成技能」，它会用 <code>skill_write</code> 自己写一个。
      </div>

      <div className="card">
        <div className="field-label">从 GitHub 安装</div>
        <div className="row">
          <input
            type="text"
            value={ghInput}
            placeholder="owner/repo 或 https://github.com/owner/repo/tree/main/skills"
            onChange={(e) => setGhInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !installing && void install()}
          />
          <button className="btn primary" disabled={installing || !ghInput.trim()} onClick={() => void install()}>
            {installing ? '装…' : '安装'}
          </button>
        </div>
        {msg ? (
          <div className="hint" style={{ marginTop: 6, color: msg.startsWith('✗') ? 'var(--danger)' : undefined }}>
            {msg}
          </div>
        ) : (
          <div className="hint" style={{ marginTop: 6 }}>
            会找这几个位置：给定路径本身、路径下的 md 文件、下一层每个目录、仓库根的 skills/ 和
            .claude/skills/。**文件名不限于 SKILL.md** —— 只要开头的 --- 块里有 name 或 description
            就认，README.md 排在最后。也可以把地址直接指到某个具体的 .md 文件。
            私有仓库需要在 设置 → 工具 → GitHub 里填 token。
          </div>
        )}
      </div>

      <div className="row" style={{ margin: '12px 0' }}>
        <button
          className="btn"
          onClick={() =>
            props.onChange([
              ...props.skills,
              makeSkill({ name: `skill-${props.skills.length + 1}`, body: '', description: '' }),
            ])
          }
        >
          ＋ 手写一个
        </button>
        <span className="hint" style={{ flex: 1 }}>
          共 {props.skills.length} 个
        </span>
      </div>

      {props.skills.length === 0 ? (
        <div className="empty">还没有技能。从 GitHub 装一个，或者手写一个。</div>
      ) : null}

      {props.skills.map((sk) => (
        <div className="card" key={sk.id}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="skill-slash">/</span>
            <input
              type="text"
              value={sk.name}
              onChange={(e) => patch(sk.id, { name: e.target.value })}
              style={{ fontFamily: 'var(--mono)', fontWeight: 600, flex: '0 0 170px' }}
            />
            <input
              type="text"
              value={sk.description}
              placeholder="一句话说明什么时候用"
              onChange={(e) => patch(sk.id, { description: e.target.value })}
            />
            <Switch checked={sk.enabled} onChange={(v) => patch(sk.id, { enabled: v })} label="" />
            <button className="btn sm" onClick={() => setEditing(editing === sk.id ? null : sk.id)}>
              {editing === sk.id ? '收起' : '正文'}
            </button>
            <button
              className="btn sm danger"
              onClick={() => props.onChange(props.skills.filter((x) => x.id !== sk.id))}
            >
              删除
            </button>
          </div>

          {editing === sk.id ? (
            <>
              <textarea
                rows={12}
                className="mono"
                value={sk.body}
                placeholder="技能的指令正文，Markdown。写成自包含的操作说明，别依赖某次对话的上下文。"
                onChange={(e) => patch(sk.id, { body: e.target.value })}
              />
              <div className="row" style={{ marginTop: 6 }}>
                <span className="hint" style={{ flex: 1 }}>
                  来源：{sk.source} · 用过 {sk.uses} 次 · 正文 {Math.round(sk.body.length / 1024)} KB
                  {sk.body.length > 16000
                    ? ' ⚠ 这个技能很大，每次唤起都会整段进上下文，注意 token 消耗'
                    : ''}
                </span>
                <button
                  className="btn sm"
                  onClick={() => void navigator.clipboard.writeText(toSkillMd(sk))}
                >
                  复制成 SKILL.md
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const md = await navigator.clipboard.readText();
                    if (!md.trim()) return;
                    const parsed = parseSkillMd(md, sk.name);
                    patch(sk.id, parsed);
                  }}
                >
                  从剪贴板粘 SKILL.md
                </button>
              </div>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ================================================================== *
 * 定时任务
 * ================================================================== */

function TasksTab(props: {
  tasks: ScheduledTask[];
  onChange: (t: ScheduledTask[]) => void;
  projects: Project[];
  profiles: KeyProfile[];
  models: ModelInfo[];
}) {
  const patch = (id: string, v: Partial<ScheduledTask>) =>
    props.onChange(
      props.tasks.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...v };
        // 改了排程或重新启用，下一次触发时间要跟着重算
        if (v.schedule || v.enabled !== undefined) {
          next.nextRunAt = next.enabled ? (nextRun(next.schedule) ?? undefined) : undefined;
        }
        return next;
      }),
    );

  const DAY = ['日', '一', '二', '三', '四', '五', '六'];

  return (
    <div>
      <div className="hint" style={{ marginBottom: 12, lineHeight: 1.85 }}>
        到点自动发一条消息给模型，工具照常能用。
        <br />
        <strong>说清楚边界：调度器跑在应用里，应用关着就不会触发。</strong>要做到关掉窗口也能跑，
        得把整个 Agent 循环搬进主进程再实现一遍，而且工具确认弹窗没人点照样卡住 —— 不值。
        补偿是「错过补跑」：下次打开应用时会把漏掉的补上一次。
        <br />
        自动跑的任务建议把放行档位设成「自动批准编辑」或更松，否则它会停在确认弹窗前等你。
      </div>

      <button
        className="btn"
        style={{ marginBottom: 12 }}
        onClick={() => props.onChange([...props.tasks, makeTask(`任务 ${props.tasks.length + 1}`)])}
      >
        ＋ 新建任务
      </button>

      {props.tasks.length === 0 ? <div className="empty">还没有定时任务。</div> : null}

      {props.tasks.map((t) => {
        const cronBad = t.schedule.kind === 'cron' && !parseCron(t.schedule.cron ?? '');
        return (
          <div className="card" key={t.id}>
            <div className="row" style={{ marginBottom: 8 }}>
              <input
                type="text"
                value={t.name}
                onChange={(e) => patch(t.id, { name: e.target.value })}
                style={{ fontWeight: 600 }}
              />
              <Switch checked={t.enabled} onChange={(v) => patch(t.id, { enabled: v })} label="启用" />
              <button
                className="btn sm danger"
                onClick={() => props.onChange(props.tasks.filter((x) => x.id !== t.id))}
              >
                删除
              </button>
            </div>

            <Field label="要它做什么" hint="每次触发就把这段话当成一条新消息发出去。写清楚，它看不到之前的对话。">
              <textarea
                rows={3}
                value={t.prompt}
                placeholder="例如：搜一下昨天美股收盘后有哪些和半导体相关的重要新闻，按重要性给我三条，带来源。"
                onChange={(e) => patch(t.id, { prompt: e.target.value })}
              />
            </Field>

            <Field label="什么时候跑">
              <Segmented
                value={t.schedule.kind}
                options={[
                  { value: 'interval' as const, label: '每隔' },
                  { value: 'daily' as const, label: '每天' },
                  { value: 'weekly' as const, label: '每周' },
                  { value: 'cron' as const, label: 'cron' },
                ]}
                onChange={(k) => patch(t.id, { schedule: { ...t.schedule, kind: k } })}
              />
            </Field>

            {t.schedule.kind === 'interval' ? (
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="hint">每</span>
                <input
                  type="number"
                  min={1}
                  value={t.schedule.everyMinutes ?? 60}
                  onChange={(e) =>
                    patch(t.id, {
                      schedule: { ...t.schedule, everyMinutes: Math.max(1, Number(e.target.value) || 60) },
                    })
                  }
                  style={{ width: 100 }}
                />
                <span className="hint">分钟</span>
              </div>
            ) : null}

            {t.schedule.kind === 'daily' || t.schedule.kind === 'weekly' ? (
              <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={t.schedule.hour ?? 9}
                  onChange={(e) => patch(t.id, { schedule: { ...t.schedule, hour: Number(e.target.value) } })}
                  style={{ width: 70 }}
                />
                <span className="hint">时</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={t.schedule.minute ?? 0}
                  onChange={(e) => patch(t.id, { schedule: { ...t.schedule, minute: Number(e.target.value) } })}
                  style={{ width: 70 }}
                />
                <span className="hint">分</span>
                {t.schedule.kind === 'weekly'
                  ? DAY.map((d, i) => {
                      const on = (t.schedule.weekdays ?? [1]).includes(i);
                      return (
                        <button
                          key={i}
                          className={`picker-profile${on ? ' on' : ''}`}
                          onClick={() => {
                            const cur = new Set(t.schedule.weekdays ?? [1]);
                            if (on) cur.delete(i);
                            else cur.add(i);
                            patch(t.id, { schedule: { ...t.schedule, weekdays: [...cur].sort() } });
                          }}
                        >
                          {d}
                        </button>
                      );
                    })
                  : null}
              </div>
            ) : null}

            {t.schedule.kind === 'cron' ? (
              <Field
                label="cron 表达式"
                hint={
                  cronBad ? (
                    <span style={{ color: 'var(--danger)' }}>解析不了。标准 5 段：分 时 日 月 周</span>
                  ) : (
                    '标准 5 段：分 时 日 月 周。支持 * , - / 。例如 0 9 * * 1-5 = 工作日早上九点。'
                  )
                }
              >
                <input
                  type="text"
                  value={t.schedule.cron ?? ''}
                  placeholder="0 9 * * 1-5"
                  onChange={(e) => patch(t.id, { schedule: { ...t.schedule, cron: e.target.value } })}
                  style={{ fontFamily: 'var(--mono)' }}
                />
              </Field>
            ) : null}

            <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
              <select
                value={t.projectId ?? ''}
                onChange={(e) => patch(t.id, { projectId: e.target.value || null })}
                style={{ flex: '0 0 150px' }}
              >
                <option value="">不属于项目</option>
                {props.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.emoji} {p.name}
                  </option>
                ))}
              </select>
              <select
                value={t.keyProfileId ?? ''}
                onChange={(e) => patch(t.id, { keyProfileId: e.target.value || null })}
                style={{ flex: '0 0 140px' }}
              >
                <option value="">跟随全局凭据</option>
                {props.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                list="ws-models"
                value={t.model}
                placeholder="模型（留空跟随全局）"
                onChange={(e) => patch(t.id, { model: e.target.value })}
              />
            </div>

            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Segmented
                value={t.target}
                options={[
                  { value: 'new' as const, label: '每次开新对话' },
                  { value: 'same' as const, label: '都追加到同一个' },
                ]}
                onChange={(v) => patch(t.id, { target: v })}
              />
              <Switch
                checked={t.catchUp}
                onChange={(v) => patch(t.id, { catchUp: v })}
                label="错过了补跑"
              />
            </div>

            <div className="hint" style={{ marginTop: 8 }}>
              {describeSchedule(t.schedule)}
              {t.enabled && t.nextRunAt
                ? ` · 下次 ${new Date(t.nextRunAt).toLocaleString('zh-CN', { hour12: false })}`
                : ' · 未启用'}
              {t.lastRunAt
                ? ` · 上次 ${new Date(t.lastRunAt).toLocaleString('zh-CN', { hour12: false })}${
                    t.lastResult ? `（${t.lastResult}）` : ''
                  }`
                : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================== */

export default function WorkspaceDialog(props: {
  tab: string;
  onTab: (t: string) => void;
  onClose: () => void;

  projects: Project[];
  onProjects: (p: Project[]) => void;
  skills: Skill[];
  onSkills: (s: Skill[]) => void;
  tasks: ScheduledTask[];
  onTasks: (t: ScheduledTask[]) => void;

  profiles: KeyProfile[];
  models: ModelInfo[];
  toolCtx: ToolContext;
}) {
  const tab = (['projects', 'skills', 'tasks'] as Tab[]).includes(props.tab as Tab)
    ? (props.tab as Tab)
    : 'projects';

  return (
    <Modal title="工作区" onClose={props.onClose} wide>
      <div className="tabs">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button key={t} className={t === tab ? 'on' : ''} onClick={() => props.onTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="modal-body">
        {tab === 'projects' ? (
          <ProjectsTab
            projects={props.projects}
            onChange={props.onProjects}
            profiles={props.profiles}
            models={props.models}
          />
        ) : null}
        {tab === 'skills' ? (
          <SkillsTab skills={props.skills} onChange={props.onSkills} toolCtx={props.toolCtx} />
        ) : null}
        {tab === 'tasks' ? (
          <TasksTab
            tasks={props.tasks}
            onChange={props.onTasks}
            projects={props.projects}
            profiles={props.profiles}
            models={props.models}
          />
        ) : null}
      </div>
    </Modal>
  );
}
