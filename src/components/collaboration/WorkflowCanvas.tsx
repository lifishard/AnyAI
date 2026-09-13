import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './WorkflowCanvas.css';

export interface CanvasNode {
  id: string;
  title: string;
  type: string;
  x: number;
  y: number;
  subtitle?: string;
  ports?: {
    id: string;
    label: string;
  }[];
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  port?: string;
  label: string;
  loop?: boolean;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export type CanvasSelection =
  | {
      type: 'node' | 'edge';
      id: string;
    }
  | null;

export interface WorkflowCanvasProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport;
  selection: CanvasSelection;
  onMoveNode: (id: string, x: number, y: number) => void;
  onConnect: (from: string, to: string, port: string) => void;
  onViewportChange: (viewport: CanvasViewport) => void;
  onSelect: (selection: CanvasSelection) => void;
  onAddNode: (x: number, y: number) => void;
  onDeleteSelection: () => void;
  onDuplicateSelection: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  readOnly?: boolean;
}

const NODE_WIDTH = 182;
const NODE_HEADER_HEIGHT = 30;
const PORT_ROW_HEIGHT = 18;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;

type Point = { x: number; y: number };
type DragState = { nodeId: string; pointerId: number; offsetX: number; offsetY: number } | null;
type PanState = { pointerId: number; startX: number; startY: number; startViewX: number; startViewY: number } | null;
type ConnectState = { fromNodeId: string; portId: string; pointerId: number; start: Point } | null;

export default function WorkflowCanvas({
  nodes,
  edges,
  viewport,
  selection,
  onMoveNode,
  onConnect,
  onViewportChange,
  onSelect,
  onAddNode,
  onDeleteSelection,
  onDuplicateSelection,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  readOnly = false,
}: WorkflowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState<DragState>(null);
  const [panning, setPanning] = useState<PanState>(null);
  const [connecting, setConnecting] = useState<ConnectState>(null);
  const [connectingCursor, setConnectingCursor] = useState<Point | null>(null);
  const [dragPreview,setDragPreview]=useState<{id:string;x:number;y:number}|null>(null);
  const dragPreviewRef=useRef(dragPreview);dragPreviewRef.current=dragPreview;
  const displayNodes=useMemo(()=>nodes.map(n=>n.id===dragPreview?.id?{...n,x:dragPreview.x,y:dragPreview.y}:n),[nodes,dragPreview]);

  const nodeById = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    for (const node of displayNodes) {
      map.set(node.id, node);
    }
    return map;
  }, [displayNodes]);

  const isTextInput = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    if ((target.tagName.toLowerCase() !== 'input' && target.tagName.toLowerCase() !== 'textarea' && target.tagName.toLowerCase() !== 'select') && !target.isContentEditable) {
      return false;
    }

    return true;
  }, []);

  const clampZoom = useCallback((value: number) => {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
  }, []);

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return { x: 0, y: 0 };
      }
      return {
        x: (clientX - rect.left - viewport.x) / viewport.zoom,
        y: (clientY - rect.top - viewport.y) / viewport.zoom,
      };
    },
    [viewport.x, viewport.y, viewport.zoom],
  );

  const getNodeHeight = useCallback((node: CanvasNode) => {
    const portCount = Math.max(1, (node.ports?.length ?? 1));
    return 78 + PORT_ROW_HEIGHT * portCount;
  }, []);

  const getPortPoint = useCallback(
    (node: CanvasNode, portId?: string): Point => {
      const ports = node.ports ?? [{ id: 'default', label: '' }];
      const index = Math.max(0, ports.findIndex((p) => p.id === portId));
      return {
        x: node.x + NODE_WIDTH,
        y: node.y + 76 + index * PORT_ROW_HEIGHT,
      };
    },
    [],
  );

  const getLeftPoint = useCallback((node: CanvasNode): Point => ({ x: node.x, y: node.y + getNodeHeight(node) / 2 }), [getNodeHeight]);

  const buildEdgePath = useCallback((from: Point, to: Point) => {
    const dx = to.x - from.x;
    const curve = Math.max(70, Math.abs(dx) * 0.6);
    const c1x = from.x + curve;
    const c2x = to.x - curve;

    return `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
  }, []);

  const buildLoopPath = useCallback((node: CanvasNode) => {
    const h = getNodeHeight(node);
    const ox = node.x + NODE_WIDTH;
    const oy = node.y + h / 2;
    const offset = 40;
    const rise = 34;

    return `M ${ox} ${oy} C ${ox + offset} ${oy - rise}, ${ox + offset} ${oy - rise}, ${ox + 14} ${oy}`;
  }, [getNodeHeight]);

  const endPanDragOrConnect = useCallback(() => {
    if (dragging) {
      try {
        containerRef.current?.releasePointerCapture(dragging.pointerId);
      } catch {}
    }
    if (panning) {
      try {
        containerRef.current?.releasePointerCapture(panning.pointerId);
      } catch {}
    }
    if (connecting) {
      try {
        containerRef.current?.releasePointerCapture(connecting.pointerId);
      } catch {}
    }

    setDragging(null);
    setDragPreview(null);
    setPanning(null);
    setConnecting(null);
    setConnectingCursor(null);
  }, [connecting, dragging, panning]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || isTextInput(event.target)) {
        return;
      }

      const target = event.target as HTMLElement;
      if (
        target.closest('.workflow-canvas-node') ||
        target.closest('.workflow-canvas-edge') ||
        target.closest('.workflow-canvas-toolbar') ||
        target.closest('.workflow-canvas-node-list')
      ) {
        return;
      }

      containerRef.current?.focus();
      setPanning({
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startViewX: viewport.x,
        startViewY: viewport.y,
      });
      setConnecting(null);
      setConnectingCursor(null);
      onSelect(null);
      event.preventDefault();

      try {
        containerRef.current?.setPointerCapture(event.pointerId);
      } catch {}
    },
    [isTextInput, onSelect, viewport.x, viewport.y],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragging) {
        const p = screenToWorld(event.clientX, event.clientY);
        setDragPreview({id:dragging.nodeId,x:p.x-dragging.offsetX,y:p.y-dragging.offsetY});
        return;
      }

      if (panning) {
        const dx = event.clientX - panning.startX;
        const dy = event.clientY - panning.startY;
        onViewportChange({
          x: panning.startViewX + dx,
          y: panning.startViewY + dy,
          zoom: viewport.zoom,
        });
        return;
      }

      if (connecting) {
        setConnectingCursor(screenToWorld(event.clientX, event.clientY));
      }
    },
    [connecting, dragging, onMoveNode, onViewportChange, panning, screenToWorld, viewport.zoom],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (connecting) {
        const targetNode = document.elementFromPoint(event.clientX,event.clientY)?.closest('.workflow-canvas-node')?.getAttribute('data-node-id') ?? null;

        if (targetNode && targetNode !== connecting.fromNodeId) {
          onConnect(connecting.fromNodeId, targetNode, connecting.portId);
          onSelect({ type: 'node', id: targetNode });
        }

        endPanDragOrConnect();
        return;
      }
      const moved=dragPreviewRef.current;if(moved&&!readOnly)onMoveNode(moved.id,moved.x,moved.y);
      endPanDragOrConnect();
    },
    [connecting, endPanDragOrConnect, onConnect, onSelect,onMoveNode,readOnly],
  );

  const beginDragNode = useCallback(
    (node: CanvasNode, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || isTextInput(event.target)) {
        return;
      }

      if (!readOnly) {
        containerRef.current?.focus();
        const p = screenToWorld(event.clientX, event.clientY);
        setDragging({
          nodeId: node.id,
          pointerId: event.pointerId,
          offsetX: p.x - node.x,
          offsetY: p.y - node.y,
        });
        setConnecting(null);
        event.preventDefault();
        onSelect({ type: 'node', id: node.id });

        try {
          containerRef.current?.setPointerCapture(event.pointerId);
        } catch {}
      } else {
        onSelect({ type: 'node', id: node.id });
      }
    },
    [isTextInput, onSelect, readOnly, screenToWorld],
  );

  const beginConnect = useCallback(
    (nodeId: string, portId: string, event: React.PointerEvent<HTMLButtonElement>) => {
      if (readOnly) {
        return;
      }

      const node = nodeById.get(nodeId);
      if (!node) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setConnecting({
        fromNodeId: nodeId,
        portId,
        pointerId: event.pointerId,
        start: getPortPoint(node, portId),
      });
      setConnectingCursor(screenToWorld(event.clientX, event.clientY));
      onSelect(null);

      try {
        containerRef.current?.setPointerCapture(event.pointerId);
      } catch {}
    },
    [getPortPoint, nodeById, onSelect, readOnly, screenToWorld],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if((event.target as Element).closest('.workflow-canvas-node-list'))return;
      event.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      const worldX = (cx - viewport.x) / viewport.zoom;
      const worldY = (cy - viewport.y) / viewport.zoom;
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nextZoom = clampZoom(viewport.zoom * factor);
      const nextX = cx - worldX * nextZoom;
      const nextY = cy - worldY * nextZoom;

      onViewportChange({ x: nextX, y: nextY, zoom: nextZoom });
    },
    [clampZoom, onViewportChange, viewport.x, viewport.y, viewport.zoom],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!focused || isTextInput(event.target) || event.nativeEvent.isComposing) {
        return;
      }

      const key = event.key;
      const isModifier = event.ctrlKey || event.metaKey;
      const isShort = event.target === containerRef.current;
      if (!isShort) {
        return;
      }

      if (isModifier && (key === 'z' || key === 'Z')) {
        if(readOnly)return;
        if(event.shiftKey){if(canRedo){event.preventDefault();onRedo();}return;}
        if (!canUndo) {
          return;
        }
        event.preventDefault();
        onUndo();
        return;
      }

      if (isModifier && (key === 'y' || key === 'Y')) {
        if(readOnly)return;
        if (!canRedo) {
          return;
        }
        event.preventDefault();
        onRedo();
        return;
      }

      if (isModifier && (key === 'd' || key === 'D')) {
        if (readOnly) {
          return;
        }
        event.preventDefault();
        onDuplicateSelection();
        return;
      }

      if ((key === 'Delete' || key === 'Backspace') && !readOnly) {
        event.preventDefault();
        onDeleteSelection();
        return;
      }

      if ((key === 'n' || key === 'N') && !readOnly) {
        event.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) {
          return;
        }
        const x = (rect.width / 2 - viewport.x) / viewport.zoom;
        const y = (rect.height / 2 - viewport.y) / viewport.zoom;
        onAddNode(x, y);
      }
    },
    [
      canRedo,
      canUndo,
      focused,
      isTextInput,
      onAddNode,
      onDeleteSelection,
      onDuplicateSelection,
      onRedo,
      onUndo,
      readOnly,
      viewport.x,
      viewport.y,
      viewport.zoom,
    ],
  );

  const selectedNode = selection?.type === 'node' ? nodeById.get(selection.id) ?? null : null;

  useEffect(() => {
    const onPointerUp = () => endPanDragOrConnect();
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [endPanDragOrConnect]);

  return (
    <section
      className="workflow-canvas-shell"
      ref={containerRef}
      tabIndex={0}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={endPanDragOrConnect}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
    >
      <div className="workflow-canvas-main" onClick={() => onSelect(null)}>
        <div className="workflow-canvas-view-controls" onPointerDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}><button type="button" onClick={()=>onViewportChange({...viewport,zoom:clampZoom(viewport.zoom/1.2)})} aria-label="缩小画布">−</button><span>{Math.round(viewport.zoom*100)}%</span><button type="button" onClick={()=>onViewportChange({...viewport,zoom:clampZoom(viewport.zoom*1.2)})} aria-label="放大画布">+</button><button type="button" onClick={()=>{const main=containerRef.current?.querySelector('.workflow-canvas-main');if(!main||!nodes.length)return;const box=main.getBoundingClientRect(),minX=Math.min(...nodes.map(n=>n.x)),minY=Math.min(...nodes.map(n=>n.y)),maxX=Math.max(...nodes.map(n=>n.x+NODE_WIDTH)),maxY=Math.max(...nodes.map(n=>n.y+getNodeHeight(n)));const zoom=clampZoom(Math.min((box.width-80)/(maxX-minX),(box.height-100)/(maxY-minY),1.5));onViewportChange({x:(box.width-(maxX-minX)*zoom)/2-minX*zoom,y:(box.height-(maxY-minY)*zoom)/2-minY*zoom,zoom});}}>适应画布</button></div>
        <svg className="workflow-canvas-svg" aria-hidden="true">
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
            <defs>
              <marker id="workflow-arrow" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M0 0 L10 4 L0 8 L2 4 z" fill="currentColor" />
              </marker>
              <pattern id="workflow-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M24 0L24 24" stroke="var(--border)" strokeWidth="0.7" />
                <path d="M0 24L24 24" stroke="var(--border)" strokeWidth="0.7" />
              </pattern>
            </defs>

            <rect x="-4000" y="-4000" width="8000" height="8000" fill="url(#workflow-grid)" />

            <g className="workflow-canvas-edge-layer">
              {edges.map((edge) => {
                const fromNode = nodeById.get(edge.from);
                const toNode = nodeById.get(edge.to);
                if (!fromNode || !toNode) {
                  return null;
                }

                const from = edge.loop || edge.from === edge.to ? getPortPoint(fromNode, edge.port) : getPortPoint(fromNode, edge.port);
                const to = getLeftPoint(toNode);
                const path = edge.from === edge.to ? buildLoopPath(toNode) : buildEdgePath(from, to);
                const isSelected = selection?.type === 'edge' && selection.id === edge.id;
                const midX = (from.x + to.x) / 2;
                const midY = (from.y + to.y) / 2;

                const width = Math.max(16, (edge.label?.length ?? 0) * 7 + 18);

                return (
                  <g
                    key={edge.id}
                    className={`workflow-canvas-edge ${isSelected ? 'is-selected' : ''}`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      onSelect({ type: 'edge', id: edge.id });
                    }}
                    onClick={event=>{event.stopPropagation();onSelect({type:'edge',id:edge.id});}}
                  >
                    <path className="workflow-canvas-edge-hit" d={path} />
                    <path className="workflow-canvas-edge-path" d={path} markerEnd="url(#workflow-arrow)" />

                    <g transform={`translate(${midX}, ${midY})`}>
                      <rect
                        className="workflow-canvas-edge-label-bg"
                        x={-(width / 2)}
                        y={-11}
                        width={width}
                        height={20}
                        rx={9}
                        ry={9}
                      />
                      <text className="workflow-canvas-edge-label" x={0} y={6} textAnchor="middle">
                        {edge.label}
                      </text>
                    </g>
                  </g>
                );
              })}
            </g>

            {connecting && connectingCursor ? (
              <path
                className="workflow-canvas-edge-path is-connecting"
                d={buildEdgePath(connecting.start, connectingCursor)}
                markerEnd="url(#workflow-arrow)"
              />
            ) : null}
          </g>
        </svg>

        <div
          className="workflow-canvas-node-layer"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, transformOrigin: '0 0' }}
        >
          {displayNodes.map((node) => {
            const selected = selection?.type === 'node' && selection.id === node.id;
            const ports = node.ports ?? [];
            return (
              <article
                key={node.id}
                className={`workflow-canvas-node ${selected ? 'is-selected' : ''}`}
                data-node-id={node.id}
                style={{
                  width: `${NODE_WIDTH}px`,
                  height: `${getNodeHeight(node)}px`,
                  transform: `translate(${node.x}px, ${node.y}px)`,
                }}
                onPointerDown={(event) => beginDragNode(node, event)}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  onSelect({ type: 'node', id: node.id });
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect({ type: 'node', id: node.id });
                }}
              >
                <header className="workflow-canvas-node-head">
                  <div className="workflow-canvas-node-title">{node.title}</div>
                  <span className="workflow-canvas-node-type">{node.type}</span>
                </header>
                {node.subtitle ? <p className="workflow-canvas-node-subtitle">{node.subtitle}</p> : null}

                <div className="workflow-canvas-node-ports">
                  {ports.length === 0 ? <span className="workflow-canvas-port-empty">无端口</span> : null}
                  {ports.map((port, index) => (
                    <button
                      key={port.id}
                      type="button"
                      className="workflow-canvas-node-port"
                      style={{ top: `${66 + PORT_ROW_HEIGHT * index}px` }}
                      onPointerDown={(event) => beginConnect(node.id, port.id, event)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className="workflow-canvas-port-dot" />
                      <span className="workflow-canvas-port-label">{port.label}</span>
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <aside className="workflow-canvas-node-list">
        <header className="workflow-canvas-toolbar">
          <h2 className="workflow-canvas-toolbar-title">节点列表</h2>
          {!readOnly ? (
            <div className="workflow-canvas-toolbar-actions">
              <button
                type="button"
                className="workflow-canvas-toolbar-btn"
                onClick={() => {
                  const rect = containerRef.current?.getBoundingClientRect();
                  if (!rect) {
                    return;
                  }
                  onAddNode((rect.width / 2 - viewport.x) / viewport.zoom, (rect.height / 2 - viewport.y) / viewport.zoom);
                }}
              >
                新建 N
              </button>
              <button type="button" className="workflow-canvas-toolbar-btn" onClick={onUndo} disabled={!canUndo}>
                撤销
              </button>
              <button type="button" className="workflow-canvas-toolbar-btn" onClick={onRedo} disabled={!canRedo}>
                重做
              </button>
            </div>
          ) : null}
        </header>

        <div className="workflow-canvas-node-scroll">
          {nodes.map((node) => {
            const active = selectedNode?.id === node.id;
            return (
              <button
                type="button"
                key={node.id}
                className={`workflow-canvas-node-item ${active ? 'is-selected' : ''}`}
                onClick={() => onSelect({ type: 'node', id: node.id })}
              >
                <span className="workflow-canvas-node-item-title">{node.title}</span>
                <span className="workflow-canvas-node-item-type">{node.type}</span>
              </button>
            );
          })}
        </div>
      </aside>
    </section>
  );
}
