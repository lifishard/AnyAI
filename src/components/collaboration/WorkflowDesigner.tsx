import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WorkflowCanvas from './WorkflowCanvas';
import type { CanvasSelection } from './WorkflowCanvas';
import {
  newNode,
  nodeLabels,
  type FlowNode,
  type FlowEdge,
  type FlowVersion,
  type Member,
  type NodeKind,
  type Workflow,
  validateGraph,
} from '../../lib/collaboration';
import { uid } from '../../lib/store';
import './WorkflowDesigner.css';

interface WorkflowDesignerProps {
  workflow: Workflow;
  members: Member[];
  onChange(workflow: Workflow): void;
  onRun(versionId: string): void;
  onSavedVersion?(): void;
}

type FlowNodePatch = Partial<Omit<FlowNode, 'inputRefs'>> & {
  inputRefs?: string | FlowNode['inputRefs'];
};

const DEFAULT_PORTS: Record<NodeKind, { id: string; label: string }[]> = {
  start: [{ id: 'next', label: '继续' }],
  agent: [{ id: 'next', label: '继续' }],
  discussion: [{ id: 'next', label: '继续' }],
  condition: [
    { id: 'pass', label: '通过' },
    { id: 'fail', label: '不通过' },
    { id: 'default', label: '其他' },
  ],
  parallel: [{ id: 'next', label: '继续' }],
  join: [{ id: 'next', label: '继续' }],
  review: [
    { id: 'pass', label: '通过' },
    { id: 'fail', label: '不通过' },
    { id: 'default', label: '其他' },
  ],
  approval: [
    { id: 'pass', label: '通过' },
    { id: 'fail', label: '不通过' },
    { id: 'default', label: '其他' },
  ],
  handoff: [{ id: 'next', label: '继续' }],
  end: [{ id: 'next', label: '继续' }],
};

const toInt = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatTime = (value: number) => new Date(value).toLocaleString();

export default function WorkflowDesigner({
  workflow,
  members,
  onChange,
  onRun,
  onSavedVersion,
}: WorkflowDesignerProps) {
  const [local, setLocal] = useState<Workflow>(() => structuredClone(workflow));
  const localRef = useRef(local);
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [undoStack, setUndoStack] = useState<Workflow[]>([]);
  const [redoStack, setRedoStack] = useState<Workflow[]>([]);
  const [addType, setAddType] = useState<NodeKind>('agent');
  const [runVersionId, setRunVersionId] = useState<string>(workflow.versions.at(-1)?.id ?? '');
  const [manualFrom, setManualFrom] = useState<string>('');
  const [manualTo, setManualTo] = useState<string>('');
  const [manualPort, setManualPort] = useState<string>('next');
  const [manualLabel, setManualLabel] = useState<string>('继续');
  const [manualMax, setManualMax] = useState<string>('1');
  const view=local.editorView??(window.innerWidth<600?'list':'canvas');
  const ownRevisions=useRef(new Set<number>());

  useEffect(() => {
    localRef.current = local;
  }, [local]);

  useEffect(() => {
    if(workflow.id===localRef.current.id&&ownRevisions.current.has(workflow.updatedAt))return;
    const incoming = JSON.stringify(workflow);
    const current = JSON.stringify(localRef.current);
    if (incoming === current) {
      return;
    }

    const next = structuredClone(workflow);
    localRef.current = next;
    setLocal(next);
    setSelection(null);
    setUndoStack([]);
    setRedoStack([]);
    setRunVersionId(next.versions.at(-1)?.id ?? '');
    setManualFrom(next.draft.nodes[0]?.id ?? '');
    setManualTo(next.draft.nodes[1]?.id ?? next.draft.nodes[0]?.id ?? '');
  }, [workflow]);

  const nodeTypeOptions = useMemo(
    () => Object.entries(nodeLabels).map(([value, title]) => ({ value: value as NodeKind, title })),
    [],
  );

  const issues = useMemo(() => validateGraph(local.draft, members), [local.draft, members]);
  const errors = useMemo(() => issues.filter((item) => item.severity === 'error'), [issues]);

  const nodeList = useMemo(() => {
    return local.draft.nodes.map((node) => ({
      id: node.id,
      title: node.title || nodeLabels[node.type],
      type: node.type,
      x: node.x,
      y: node.y,
      subtitle:
        node.outputRequirement ||
        (node.instructions
          ? `${node.instructions.slice(0, 18)}${node.instructions.length > 18 ? '…' : ''}`
          : ''),
      ports: node.ports ?? DEFAULT_PORTS[node.type],
    }));
  }, [local.draft.nodes]);

  const edgeList = useMemo(() => local.draft.edges.map((e) => ({ ...e })), [local.draft.edges]);

  const activeNode =
    selection?.type === 'node'
      ? local.draft.nodes.find((node) => node.id === selection.id) ?? null
      : null;
  const activeEdge =
    selection?.type === 'edge'
      ? local.draft.edges.find((edge) => edge.id === selection.id) ?? null
      : null;

  const commit = useCallback(
    (next: Workflow, options: { record?: boolean } = {}) => {
      const record = options.record !== false;
      if (record) {
        setUndoStack((history) => [...history, structuredClone(localRef.current)]);
        setRedoStack([]);
      }
      next.updatedAt = Math.max(Date.now(),localRef.current.updatedAt+1);
      ownRevisions.current.add(next.updatedAt);
      const cloned = structuredClone(next);
      localRef.current = cloned;
      setLocal(cloned);
      onChange(cloned);
    },
    [onChange],
  );

  const mutate = useCallback(
    (updater: (draft: Workflow) => void, options?: { record?: boolean }) => {
      const copy = structuredClone(localRef.current);
      updater(copy);
      commit(copy, options);
    },
    [commit],
  );

  const moveNode = useCallback((id: string, x: number, y: number) => {
    mutate((draft) => {
      const node = draft.draft.nodes.find((item) => item.id === id);
      if (node) {
        node.x = x;
        node.y = y;
      }
    });
  }, [mutate]);

  const setViewport = useCallback((viewport: { x: number; y: number; zoom: number }) => {
    mutate((draft) => {
      draft.viewport = viewport;
    },{record:false});
  }, [mutate]);

  const connect = useCallback((from: string, to: string, port: string) => {
    const source = localRef.current.draft.nodes.find((node) => node.id === from);
    const portLabel = source?.ports?.find((item) => item.id === port)?.label || port;
    const exists = localRef.current.draft.edges.some(
      (edge) => edge.from === from && edge.to === to && edge.port === port,
    );
    if (exists) {
      return;
    }

    mutate((draft) => {
      draft.draft.edges.push({
        id: uid('edge'),
        from,
        to,
        port,
        label: portLabel,
        loop: from === to,
        maxTraversals: 1,
      });
      draft.draft.edges = [...draft.draft.edges];
    });
    const added = localRef.current.draft.edges[localRef.current.draft.edges.length - 1]?.id;
    if (added) {
      setSelection({ type: 'edge', id: added });
    }
  }, [mutate]);

  const addNode = useCallback((atX?:number,atY?:number) => {
    const x=atX??140+(localRef.current.draft.nodes.length%4)*60;
    const y=atY??170+Math.floor(localRef.current.draft.nodes.length/4)*120;
    mutate((draft) => {
      const node = newNode(addType, x, y);
      node.title = `${nodeLabels[addType]}（${draft.draft.nodes.length + 1}）`;
      node.memberId =
        addType === 'agent' || addType === 'review' || addType === 'handoff' || addType === 'discussion'
          ? members.find((member) => member.enabled)?.id || ''
          : '';
      node.ports = structuredClone(DEFAULT_PORTS[addType]);
      draft.draft.nodes.push(node);
    });
    if (!manualFrom) {
      setManualFrom(localRef.current.draft.nodes[localRef.current.draft.nodes.length - 1]?.id ?? '');
    }
    if (!manualTo) {
      setManualTo(localRef.current.draft.nodes[localRef.current.draft.nodes.length - 1]?.id ?? '');
    }
  }, [addType, members, mutate]);

  const deleteSelection = useCallback(() => {
    if (!selection) {
      return;
    }

    mutate((draft) => {
      if (selection.type === 'node') {
        const nodeId = selection.id;
        draft.draft.nodes = draft.draft.nodes.filter((node) => node.id !== nodeId);
        draft.draft.edges = draft.draft.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
      } else {
        draft.draft.edges = draft.draft.edges.filter((edge) => edge.id !== selection.id);
      }
    }, { record: true });
    setSelection(null);
  }, [selection, mutate]);

  const duplicateSelection = useCallback(() => {
    if (!activeNode) {
      return;
    }

    const copiedId=uid('node');
    mutate((draft) => {
      const copy = structuredClone(activeNode);
      copy.id = copiedId;
      copy.title = `${copy.title}（副本）`;
      copy.x += 28;
      copy.y += 28;
      draft.draft.nodes.push(copy);
    });
    setSelection({ type: 'node', id: copiedId });
  }, [activeNode, mutate]);

  const undo=useCallback(()=>{
    if(!undoStack.length)return;
    const previous=structuredClone(undoStack.at(-1)!);previous.versions=structuredClone(localRef.current.versions);
    setRedoStack(f=>[structuredClone(localRef.current),...f]);setUndoStack(undoStack.slice(0,-1));setSelection(null);commit(previous,{record:false});
  },[commit,undoStack]);
  const redo=useCallback(()=>{
    if(!redoStack.length)return;
    const next=structuredClone(redoStack[0]);next.versions=structuredClone(localRef.current.versions);
    setUndoStack(h=>[...h,structuredClone(localRef.current)]);setRedoStack(redoStack.slice(1));setSelection(null);commit(next,{record:false});
  },[commit,redoStack]);

  const updateNode = useCallback(
    (id: string, patch: FlowNodePatch) => {
      mutate((draft) => {
        const node = draft.draft.nodes.find((item) => item.id === id);
        if (!node) {
          return;
        }

        if (patch.type && patch.type !== node.type) {
          node.type = patch.type;
          node.ports = structuredClone(DEFAULT_PORTS[patch.type]);
          if (patch.type === 'discussion') {
            node.participants = node.participants?.length ? node.participants : node.memberId ? [node.memberId] : [];
            node.memberId = '';
          } else {
            node.participants = [];
            if (patch.type !== 'start' && patch.type !== 'end' && patch.type !== 'parallel' && patch.type !== 'join') {
              const first = members.find((member) => member.enabled);
              node.memberId = first?.id ?? '';
            } else {
              node.memberId = '';
            }
          }
        }

        if (typeof patch.inputRefs === 'string') {
          node.inputRefs = patch.inputRefs
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
          return;
        }

        if (patch.condition) {
          node.condition = patch.condition;
          return;
        }

        Object.assign(node, patch);
      });
    },
    [members, mutate],
  );

  const setDiscussionParticipants = useCallback(
    (nodeId: string, participants: string[]) => {
      updateNode(nodeId, { participants });
    },
    [updateNode],
  );

  const setCondition = useCallback(
    (nodeId: string, source: string, contains: string) => {
      updateNode(nodeId, {
        condition: {
          source,
          contains,
        },
      });
    },
    [updateNode],
  );

  const updateEdge = useCallback(
    (id: string, patch: Partial<FlowEdge>) => {
      mutate((draft) => {
        const edge = draft.draft.edges.find((item) => item.id === id);
        if (!edge) {
          return;
        }
        Object.assign(edge, patch);
      });
    },
    [mutate],
  );

  const updateGraph = useCallback((patch: Partial<Workflow['draft']>) => {
    mutate((draft) => {
      draft.draft = {
        ...draft.draft,
        ...patch,
      };
    });
  }, [mutate]);

  const saveVersion = useCallback(() => {
    if(validateGraph(localRef.current.draft,members).some(i=>i.severity==='error'))return;
    const current=localRef.current;
    const nextNumber=current.versions.length?current.versions.at(-1)!.number+1:1;
    const version: FlowVersion = {
      id: uid('version'),
      number: nextNumber,
      createdAt: Date.now(),
      graph: structuredClone(current.draft),
    };
    mutate((draft) => {
      draft.versions = [...draft.versions, version];
    });
    setRunVersionId(version.id);
    onSavedVersion?.();
  }, [members, mutate, onSavedVersion]);

  const run = useCallback(() => {
    if (runVersionId) {
      onRun(runVersionId);
    }
  }, [onRun, runVersionId]);

  const fromNodePorts = useMemo(() => {
    return local.draft.nodes.find((node) => node.id === manualFrom)?.ports ?? [{ id: 'next', label: '继续' }];
  }, [manualFrom, local.draft.nodes]);

  const createManualEdge = useCallback(() => {
    if (!manualFrom || !manualTo) {
      return;
    }

    if (!manualPort || !fromNodePorts.some((item) => item.id === manualPort)) {
      setManualPort(fromNodePorts[0]?.id ?? 'next');
      return;
    }

    mutate((draft) => {
      const exists = draft.draft.edges.some(
        (edge) => edge.from === manualFrom && edge.to === manualTo && edge.port === manualPort,
      );
      if (exists) {
        return;
      }

      draft.draft.edges.push({
        id: uid('edge'),
        from: manualFrom,
        to: manualTo,
        port: manualPort,
        label: manualLabel.trim() || manualPort,
        loop: manualFrom === manualTo,
        maxTraversals: Math.max(1, toInt(manualMax, 1)),
      });
    });
  }, [manualFrom, manualLabel, manualMax, manualPort, fromNodePorts, mutate]);

  const canRun = Boolean(runVersionId) && errors.length === 0;
  const currentVersionNames = useMemo(() => local.versions.map((v) => ({ id: v.id, name: `v${v.number}` })), [local.versions]);

  useEffect(() => {
    if (manualFrom && manualFrom !== '' && fromNodePorts.length > 0 && !fromNodePorts.find((p) => p.id === manualPort)) {
      setManualPort(fromNodePorts[0].id);
      setManualLabel(fromNodePorts[0].label);
    }
  }, [fromNodePorts, manualFrom, manualPort]);

  const getMemberName = useCallback((id?: string) => {
    if (!id) {
      return '未设置';
    }
    return members.find((member) => member.id === id)?.name ?? '未知成员';
  }, [members]);

  return (
    <div className={`workflow-designer view-${view}`}>
      <header className="workflow-designer-header">
        <div className="workflow-designer-top-row">
          <label className="workflow-designer-field">
            <span>流程名</span>
            <input
              value={local.name}
              onChange={(event) => {
                mutate((draft) => {
                  draft.name = event.target.value;
                });
              }}
              className="workflow-designer-input"
            />
          </label>

          <label className="workflow-designer-field">
            <span>最大步骤</span>
            <input
              type="number"
              min={1}
              value={local.draft.maxSteps}
              onChange={(event) =>
                updateGraph({
                  maxSteps: toInt(event.target.value, local.draft.maxSteps),
                })
              }
              className="workflow-designer-input"
            />
          </label>

          <label className="workflow-designer-field">
            <span>最大分钟</span>
            <input
              type="number"
              min={1}
              value={local.draft.maxMinutes}
              onChange={(event) =>
                updateGraph({
                  maxMinutes: toInt(event.target.value, local.draft.maxMinutes),
                })
              }
              className="workflow-designer-input"
            />
          </label>

          <label className="workflow-designer-field">
            <span>最大 Token</span>
            <input
              type="number"
              min={1}
              value={local.draft.maxTokens}
              onChange={(event) =>
                updateGraph({
                  maxTokens: toInt(event.target.value, local.draft.maxTokens),
                })
              }
              className="workflow-designer-input"
            />
          </label>
        </div>

        <div className="workflow-designer-actions">
          <div className="workflow-designer-inline">
            <select value={addType} onChange={(event) => setAddType(event.target.value as NodeKind)} className="workflow-designer-select">
              {nodeTypeOptions.map((nodeType) => (
                <option key={nodeType.value} value={nodeType.value}>
                  {nodeType.title}
                </option>
              ))}
            </select>
            <button type="button" onClick={()=>addNode()} className="workflow-designer-btn">新增节点</button>
            <button type="button" onClick={deleteSelection} className="workflow-designer-btn workflow-designer-danger">删除</button>
            <button type="button" onClick={duplicateSelection} className="workflow-designer-btn">复制</button>
            <button type="button" onClick={undo} disabled={undoStack.length === 0} className="workflow-designer-btn">撤销</button>
            <button type="button" onClick={redo} disabled={redoStack.length === 0} className="workflow-designer-btn">重做</button>
          </div>

          <div className="workflow-designer-inline">
            <button type="button" onClick={saveVersion} disabled={errors.length>0} className="workflow-designer-btn workflow-designer-btn-accent">
              保存为版本
            </button>
            <select
              value={runVersionId}
              onChange={(event) => setRunVersionId(event.target.value)}
              className="workflow-designer-select"
            >
              <option value="">请选择版本</option>
              {currentVersionNames.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={run} disabled={!canRun} className="workflow-designer-btn">
              运行版本
            </button>
          </div>
        </div>

        <div className="workflow-designer-validation">
          <span className={`workflow-designer-pill ${errors.length ? 'is-error' : 'is-ok'}`}>错误: {errors.length}</span>
          <span className="workflow-designer-pill">警告: {issues.length - errors.length}</span>
          <button className="workflow-designer-btn" aria-pressed={view==='canvas'} onClick={()=>mutate(d=>{d.editorView='canvas';},{record:false})}>画布</button><button className="workflow-designer-btn" aria-pressed={view==='list'} onClick={()=>mutate(d=>{d.editorView='list';},{record:false})}>列表编辑</button><span className="workflow-designer-tip">拖拽端口可新建连线；回退/重做同步更新。</span>
        </div>
      </header>

      <div className="workflow-designer-workspace">
        <div className="workflow-designer-canvas">
          <WorkflowCanvas
            nodes={nodeList}
            edges={edgeList}
            viewport={local.viewport}
            selection={selection}
            onMoveNode={moveNode}
            onConnect={connect}
            onViewportChange={setViewport}
            onSelect={setSelection}
            onAddNode={(x, y) => {
              setAddType(addType);
              setManualFrom(activeNode?.id ?? local.draft.nodes[0]?.id ?? '');
              addNode(x,y);
            }}
            onDeleteSelection={deleteSelection}
            onDuplicateSelection={duplicateSelection}
            onUndo={undo}
            onRedo={redo}
            canUndo={undoStack.length > 0}
            canRedo={redoStack.length > 0}
          />
        </div>

        <aside className="workflow-designer-side">
          <section className="workflow-designer-panel">
            <h3>可编辑节点列表</h3>
            <div className="workflow-designer-list">
              {local.draft.nodes.map((node) => (
                <div
                  key={node.id}
                  className={`workflow-designer-list-item ${selection?.type === 'node' && selection.id === node.id ? 'is-active' : ''}`}
                  onClick={() => setSelection({ type: 'node', id: node.id })}
                >
                  <input
                    value={node.title}
                    onChange={(event) => {
                      event.stopPropagation();
                      updateNode(node.id, { title: event.target.value });
                    }}
                    className="workflow-designer-input"
                  />
                  <select
                    value={node.type}
                    onChange={(event) => {
                      event.stopPropagation();
                      updateNode(node.id, { type: event.target.value as NodeKind });
                    }}
                    className="workflow-designer-select"
                  >
                    {nodeTypeOptions.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </section>

          <section className="workflow-designer-panel">
            <h3>新建连线（列表）</h3>
            <div className="workflow-designer-inline">
              <select value={manualFrom} onChange={(event) => setManualFrom(event.target.value)} className="workflow-designer-select">
                <option value="">从</option>
                {local.draft.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.title}
                  </option>
                ))}
              </select>
              <select value={manualTo} onChange={(event) => setManualTo(event.target.value)} className="workflow-designer-select">
                <option value="">到</option>
                {local.draft.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="workflow-designer-inline">
              <select value={manualPort} onChange={(event) => setManualPort(event.target.value)} className="workflow-designer-select">
                {fromNodePorts.map((port) => (
                  <option key={port.id} value={port.id}>
                    {port.label}
                  </option>
                ))}
              </select>
              <input
                value={manualLabel}
                onChange={(event) => setManualLabel(event.target.value)}
                className="workflow-designer-input"
                placeholder="端口文案"
              />
              <input
                value={manualMax}
                onChange={(event) => setManualMax(event.target.value)}
                className="workflow-designer-input"
                min={1}
                type="number"
                placeholder="最大遍历"
              />
              <button type="button" onClick={createManualEdge} className="workflow-designer-btn workflow-designer-btn-accent">
                新建连线
              </button>
            </div>
          </section>

          <section className="workflow-designer-panel">
            <h3>连线可编辑列表</h3>
            <div className="workflow-designer-list">
              {local.draft.edges.map((edge) => (
                <div
                  key={edge.id}
                  className={`workflow-designer-list-item ${selection?.type === 'edge' && selection.id === edge.id ? 'is-active' : ''}`}
                  onClick={() => setSelection({ type: 'edge', id: edge.id })}
                >
                  <input
                    value={edge.label}
                    onChange={(event) => {
                      event.stopPropagation();
                      updateEdge(edge.id, { label: event.target.value });
                    }}
                    className="workflow-designer-input"
                  />
                  <div className="workflow-designer-inline">
                    <select
                      value={edge.from}
                      onChange={(event) => {
                        event.stopPropagation();
                        updateEdge(edge.id, { from: event.target.value });
                      }}
                      className="workflow-designer-select"
                    >
                      {local.draft.nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.title}
                        </option>
                      ))}
                    </select>
                    <span>→</span>
                    <select
                      value={edge.to}
                      onChange={(event) => {
                        event.stopPropagation();
                        updateEdge(edge.id, { to: event.target.value });
                      }}
                      className="workflow-designer-select"
                    >
                      {local.draft.nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="workflow-designer-inline">
                    <input
                      type="checkbox"
                      checked={edge.loop}
                      onChange={(event) => {
                        event.stopPropagation();
                        updateEdge(edge.id, { loop: event.target.checked });
                      }}
                    />
                    <span>循环</span>
                    <input
                      type="number"
                      value={edge.maxTraversals}
                      min={1}
                      onChange={(event) =>
                        updateEdge(edge.id, { maxTraversals: Math.max(1, toInt(event.target.value, edge.maxTraversals)) })
                      }
                      className="workflow-designer-input"
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="workflow-designer-panel">
            <h3>版本（不可变）</h3>
            <div className="workflow-designer-list">
              {local.versions.length ? (
                local.versions
                  .slice()
                  .sort((a, b) => b.number - a.number)
                  .map((version) => (
                    <div key={version.id} className="workflow-designer-list-item">
                      <div className="workflow-designer-version-title">
                        <strong>{`v${version.number}`}</strong>
                        <span>{formatTime(version.createdAt)}</span>
                      </div>
                      <button
                        type="button"
                        className="workflow-designer-btn"
                        onClick={() => {
                          setRunVersionId(version.id);
                          onRun(version.id);
                        }}
                      >
                        运行
                      </button>
                    </div>
                  ))
              ) : (
                <p className="workflow-designer-empty">尚未保存版本。</p>
              )}
            </div>
          </section>

          <section className="workflow-designer-panel">
            <h3>节点属性</h3>
            {activeNode ? (
              <div className="workflow-designer-form">
                <label>
                  标题
                  <input
                    value={activeNode.title}
                    onChange={(event) => updateNode(activeNode.id, { title: event.target.value })}
                    className="workflow-designer-input"
                  />
                </label>
                <label>
                  类型
                  <select
                    value={activeNode.type}
                    onChange={(event) =>
                      updateNode(activeNode.id, {
                        type: event.target.value as NodeKind,
                      })
                    }
                    className="workflow-designer-select"
                  >
                    {nodeTypeOptions.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  执行次数上限
                  <input
                    type="number"
                    min={1}
                    value={activeNode.maxVisits}
                    onChange={(event) =>
                      updateNode(activeNode.id, {
                        maxVisits: toInt(event.target.value, activeNode.maxVisits),
                      })
                    }
                    className="workflow-designer-input"
                  />
                </label>

                <label>
                  输入引用（逗号分隔）
                  <input
                    value={activeNode.inputRefs.join(', ')}
                    onChange={(event) => updateNode(activeNode.id, { inputRefs: event.target.value })}
                    className="workflow-designer-input"
                  />
                </label>

                <label>
                  输出要求
                  <textarea
                    value={activeNode.outputRequirement}
                    onChange={(event) =>
                      updateNode(activeNode.id, {
                        outputRequirement: event.target.value,
                      })
                    }
                    rows={2}
                    className="workflow-designer-textarea"
                  />
                </label>

                <label>
                  指令
                  <textarea
                    value={activeNode.instructions}
                    onChange={(event) => updateNode(activeNode.id, { instructions: event.target.value })}
                    rows={3}
                    className="workflow-designer-textarea"
                  />
                </label>

                {(activeNode.type === 'agent' || activeNode.type === 'review' || activeNode.type === 'handoff') && (
                  <label>
                    成员
                    <select
                      value={activeNode.memberId ?? ''}
                      onChange={(event) => updateNode(activeNode.id, { memberId: event.target.value })}
                      className="workflow-designer-select"
                    >
                      <option value="">未设置</option>
                      {members
                        .filter((member) => member.enabled)
                        .map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}

                {activeNode.type === 'discussion' ? (
                  <label>
                    讨论成员
                    <div className="workflow-designer-grid-small">
                      {members
                        .filter((member) => member.enabled)
                        .map((member) => {
                          const checked = (activeNode.participants ?? []).includes(member.id);
                          return (
                            <label key={member.id}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) => {
                                  const next = new Set(activeNode.participants ?? []);
                                  if (event.target.checked) {
                                    next.add(member.id);
                                  } else {
                                    next.delete(member.id);
                                  }
                                  setDiscussionParticipants(activeNode.id, [...next]);
                                }}
                              />
                              {member.name}
                            </label>
                          );
                        })}
                    </div>
                  </label>
                ) : null}

                {activeNode.type === 'condition' ? (
                  <>
                    <label>
                      条件来源
                      <select
                        value={activeNode.condition?.source ?? ''}
                        onChange={(event) =>
                          setCondition(activeNode.id, event.target.value, activeNode.condition?.contains ?? '')
                        }
                        className="workflow-designer-select"
                      >
                        <option value="">未设置</option>
                        {local.draft.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      命中文本
                      <input
                        value={activeNode.condition?.contains ?? ''}
                        onChange={(event) =>
                          setCondition(activeNode.id, activeNode.condition?.source ?? '', event.target.value)
                        }
                        className="workflow-designer-input"
                      />
                    </label>
                  </>
                ) : null}

                <label>
                  汇合策略
                  <select
                    value={activeNode.join}
                    onChange={(event) =>
                      updateNode(activeNode.id, {
                        join: event.target.value as 'all' | 'any',
                      })
                    }
                    className="workflow-designer-select"
                  >
                    <option value="all">all</option>
                    <option value="any">any</option>
                  </select>
                </label>

                <p className="workflow-designer-sub">成员当前：{getMemberName(activeNode.memberId)}</p>
              </div>
            ) : activeEdge ? (
              <div className="workflow-designer-form">
                <p>当前选中连线：{activeEdge.label}</p>
                <label>
                  文案
                  <input
                    value={activeEdge.label}
                    onChange={(event) => updateEdge(activeEdge.id, { label: event.target.value })}
                    className="workflow-designer-input"
                  />
                </label>
              </div>
            ) : (
              <p className="workflow-designer-empty">先选中一个节点或连线查看属性。</p>
            )}
          </section>

          <section className="workflow-designer-panel">
            <h3>校验</h3>
            <div className="workflow-designer-list">
              {issues.length ? (
                issues.map((issue) => (
                  <div
                    key={`${issue.message}-${issue.nodeId ?? issue.edgeId}`}
                    className={`workflow-designer-list-item ${issue.severity === 'error' ? 'workflow-designer-error' : ''}`}
                    onClick={() => {
                      if (issue.nodeId) {
                        setSelection({ type: 'node', id: issue.nodeId });
                      }
                      if (issue.edgeId) {
                        setSelection({ type: 'edge', id: issue.edgeId });
                      }
                    }}
                  >
                    <strong>[{issue.severity}]</strong>
                    <span>{issue.message}</span>
                  </div>
                ))
              ) : (
                <p className="workflow-designer-empty">校验通过。</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
