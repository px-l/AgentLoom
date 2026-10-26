import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  type NodeProps,
} from '@xyflow/react';
import {
  ArrowLeft,
  Check,
  Play,
  Undo2,
  Redo2,
  Save,
  UploadCloud,
  PanelBottom,
  Plus,
  Trash2,
  GripVertical,
  Workflow as WorkflowIcon,
  ChevronDown,
} from 'lucide-react';
import { type AppRecord, type Kind, type NodeData, kindLabels, validateGraph } from '@agentloom/protocol';
import { useEditor, useTrace, type CanvasNode } from './store';
import { api, post } from './api';
import { Button, ErrorBox, Loading, RunStart } from './components';
import { Trace } from './RunView';
import '@xyflow/react/dist/style.css';
const kindSymbol: Record<Kind, string> = {
  start: '↗',
  llm: '✦',
  retrieval: '▤',
  agent: '◈',
  condition: '⑂',
  approval: '✓',
  end: '↘',
};
const FlowNode = memo(function FlowNode({ id, type, data, selected }: NodeProps<CanvasNode>) {
  const status = useTrace((s) => s.statuses[id]);
  return (
    <div className={`flow-card ${type} ${selected ? 'selected' : ''} ${status ?? ''}`}>
      {type !== 'start' && <Handle type="target" position={Position.Left} />}
      <div className="node-kind">
        <span className={`node-icon ${type}`}>{kindSymbol[type!]}</span>
        <span>{kindLabels[type!]}</span>
        <span className={`node-status ${status ?? ''}`} />
      </div>
      <strong>{data.label}</strong>
      <small>{id}</small>
      {type === 'condition' ? (
        <>
          <Handle id="true" type="source" position={Position.Right} style={{ top: '35%' }} />
          <span className="handle-label true">是</span>
          <Handle id="false" type="source" position={Position.Right} style={{ top: '75%' }} />
          <span className="handle-label false">否</span>
        </>
      ) : (
        type !== 'end' && <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
});
const nodeTypes = {
  start: FlowNode,
  llm: FlowNode,
  retrieval: FlowNode,
  agent: FlowNode,
  condition: FlowNode,
  approval: FlowNode,
  end: FlowNode,
};
const defaultEdgeOptions = { style: { stroke: '#a5b3c7', strokeWidth: 1.7 }, type: 'smoothstep' };
const snapGrid: [number, number] = [20, 20];
export function Canvas({ benchmark = false }: { benchmark?: boolean }) {
  const nodes = useEditor((s) => s.nodes),
    edges = useEditor((s) => s.edges),
    nodeChanges = useEditor((s) => s.nodeChanges),
    edgeChanges = useEditor((s) => s.edgeChanges),
    connect = useEditor((s) => s.connect);
  const { screenToFlowPosition } = useReactFlow();
  const select = useCallback((_: unknown, node: CanvasNode) => useEditor.setState({ selected: node.id }), []);
  const clear = useCallback(() => useEditor.setState({ selected: null }), []);
  const start = useCallback(() => useEditor.getState().remember(), []),
    stop = useCallback(() => useEditor.getState().touch(), []);
  return (
    <div
      className="canvas"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const kind = e.dataTransfer.getData('agentloom/kind') as Kind;
        if (kind in kindLabels)
          useEditor.getState().add(kind, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={nodeChanges}
        onEdgesChange={edgeChanges}
        onConnect={connect}
        onNodeClick={select}
        onPaneClick={clear}
        onNodeDragStart={start}
        onNodeDragStop={stop}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        snapToGrid
        snapGrid={snapGrid}
        fitView={!benchmark}
        minZoom={0.1}
        maxZoom={2}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background gap={20} color="#d7dce5" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => (n.type === 'approval' ? '#eab76c' : n.type === 'llm' ? '#a68ce0' : '#9dbdb6')}
          maskColor="rgba(240,243,248,.65)"
          pannable
          zoomable
        />
      </ReactFlow>
      <span className="canvas-caption">拖入节点开始编排 · 拖动端口连线 · ⌘Z 撤销</span>
    </div>
  );
}
function Palette() {
  return (
    <aside className="node-panel">
      <div className="panel-label">
        节点 <span>7</span>
      </div>
      <p>拖拽到画布，或点击添加</p>
      {(Object.keys(kindLabels) as Kind[]).map((k) => (
        <button
          key={k}
          draggable
          onDragStart={(e) => e.dataTransfer.setData('agentloom/kind', k)}
          onClick={() => useEditor.getState().add(k)}
          className="palette-item"
        >
          <span className={`node-icon ${k}`}>{kindSymbol[k]}</span>
          <span>
            {kindLabels[k]}
            <small>
              {k === 'llm'
                ? 'LLM'
                : k === 'retrieval'
                  ? 'Knowledge Retrieval'
                  : k === 'approval'
                    ? 'Human Approval'
                    : k.charAt(0).toUpperCase() + k.slice(1)}
            </small>
          </span>
          <GripVertical size={13} />
        </button>
      ))}
      <div className="palette-tip">
        <WorkflowIcon size={18} />
        <strong>从简单的流程开始</strong>
        <p>画布仅支持 DAG。循环由 Agent 内部执行，并受步骤、工具数和时间限制。</p>
      </div>
    </aside>
  );
}
function Properties() {
  const selected = useEditor((s) => s.selected),
    node = useEditor((s) => s.nodes.find((n) => n.id === s.selected)),
    update = useEditor((s) => s.update);
  if (!node)
    return (
      <aside className="properties">
        <div className="panel-label">属性面板</div>
        <div className="property-empty">
          <span>⌘</span>
          <h3>选择一个节点</h3>
          <p>
            查看配置、编辑参数
            <br />
            并引用上游节点的输出。
          </p>
        </div>
        <div className="reference-help">
          <h4>变量引用</h4>
          <code>{'{{input.question}}'}</code>
          <p>输入字段</p>
          <code>{'{{节点ID.text}}'}</code>
          <p>上游节点的文本输出</p>
        </div>
      </aside>
    );
  const d = node.data;
  const field = (key: keyof NodeData, label: string, multiline = false) => (
    <label key={key}>
      {label}
      {multiline ? (
        <textarea value={String(d[key] ?? '')} onChange={(e) => update(node.id, { [key]: e.target.value })} />
      ) : (
        <input value={String(d[key] ?? '')} onChange={(e) => update(node.id, { [key]: e.target.value })} />
      )}
    </label>
  );
  return (
    <aside className="properties" key={selected}>
      <div className="panel-label">
        <span>{kindLabels[node.type!]}</span>
        <button
          aria-label="删除节点"
          className="icon-btn"
          onClick={() => useEditor.getState().removeSelected()}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="property-body">
        <code className="id-label">{node.id}</code>
        {field('label', '节点名称')}
        {node.type === 'start' && (
          <label>
            输入字段（英文，逗号分隔）
            <input
              value={(d.fields ?? []).join(',')}
              onChange={(e) => update(node.id, { fields: e.target.value.split(',').map((f) => f.trim()) })}
            />
          </label>
        )}
        {(node.type === 'llm' || node.type === 'agent') && field('prompt', '提示词模板', true)}
        {(node.type === 'retrieval' || node.type === 'agent') && field('kbId', '知识库 ID')}
        {node.type === 'retrieval' && (
          <>
            {field('query', '检索问题', true)}
            <label>
              返回分块数
              <input
                type="number"
                min={1}
                max={10}
                value={d.topK ?? 3}
                onChange={(e) => update(node.id, { topK: Number(e.target.value) })}
              />
            </label>
          </>
        )}
        {node.type === 'agent' && (
          <>
            <label>可用工具</label>
            {[
              ['calculator', '受限计算器'],
              ['knowledge_search', '指定知识库查询'],
            ].map(([id, label]) => (
              <label className="checkbox" key={id}>
                <input
                  type="checkbox"
                  checked={d.tools?.includes(id) ?? false}
                  onChange={(e) =>
                    update(node.id, {
                      tools: e.target.checked
                        ? [...(d.tools ?? []), id]
                        : (d.tools ?? []).filter((t) => t !== id),
                    })
                  }
                />
                {label}
              </label>
            ))}
            <div className="field-pair">
              {(['maxSteps', 'maxTools'] as const).map((k) => (
                <label key={k}>
                  {k === 'maxSteps' ? '最大步骤' : '最大工具数'}
                  <input
                    type="number"
                    min={1}
                    max={k === 'maxSteps' ? 12 : 10}
                    value={d[k] ?? 4}
                    onChange={(e) => update(node.id, { [k]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
          </>
        )}
        {node.type === 'condition' && (
          <>
            {field('ref', '判断变量')}
            {field('path', 'JSON 字段路径（可选，如 review.required）')}
            <label>
              判断方式
              <select
                value={d.operator ?? 'equals'}
                onChange={(e) => update(node.id, { operator: e.target.value as NodeData['operator'] })}
              >
                <option value="equals">严格相等（JSON 类型）</option>
                <option value="contains">文本包含</option>
                <option value="truthy">非空 / 真值</option>
              </select>
            </label>
            {d.operator !== 'truthy' && (
              <JsonValue value={d.value} onChange={(value) => update(node.id, { value })} />
            )}
          </>
        )}
        {node.type === 'approval' && field('text', '待审批内容模板', true)}
        {node.type === 'end' && field('template', '最终输出模板', true)}
        <div className="reference-help">
          <h4>可引用的上游输出</h4>
          <code>{'{{input.字段名}}'}</code>
          <code>{'{{节点ID.text}}'}</code>
          <p>Condition 输出 value；Retrieval 输出 hits、text。未执行分支的变量将明确报错。</p>
        </div>
      </div>
    </aside>
  );
}
function JsonValue({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(JSON.stringify(value ?? '')),
    [error, setError] = useState('');
  return (
    <label>
      比较值（JSON）
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setError('');
          } catch {
            setError('请输入合法 JSON，如 "文本"、true、10');
          }
        }}
      />
      {error && <small className="red">{error}</small>}
    </label>
  );
}
export function EditorPage() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
function Editor() {
  const { id } = useParams(),
    app = useEditor((s) => s.app),
    dirty = useEditor((s) => s.dirty),
    saved = useEditor((s) => s.saved),
    past = useEditor((s) => s.past.length),
    future = useEditor((s) => s.future.length);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [runDialog, setRunDialog] = useState(false),
    [debug, setDebug] = useState<string | null>(null),
    [showDebug, setShowDebug] = useState(true);
  const saving = useRef<Promise<AppRecord | null> | null>(null);
  useEffect(() => {
    setLoading(true);
    setDebug(null);
    useTrace.getState().reset('');
    api<AppRecord>(`/apps/${id}`)
      .then((a) => useEditor.getState().load(a))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);
  const save = useCallback(async (): Promise<AppRecord | null> => {
    if (saving.current) {
      await saving.current;
    }
    const state = useEditor.getState();
    if (!state.app) return null;
    if (state.dirty === state.saved) return state.app;
    const count = state.dirty;
    const promise = api<AppRecord>(`/apps/${state.app.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: state.app.name,
        description: state.app.description,
        graph: state.graph(),
        revision: state.app.revision,
      }),
    })
      .then((a) => {
        if (useEditor.getState().app?.id === a.id) useEditor.getState().ack(a, count);
        setError('');
        return a;
      })
      .catch((e) => {
        setError(e.message);
        return null;
      });
    saving.current = promise;
    const result = await promise;
    saving.current = null;
    return result;
  }, []);
  useEffect(() => {
    if (!loading && dirty !== saved) {
      const t = setTimeout(() => void save(), 900);
      return () => clearTimeout(t);
    }
  }, [dirty, saved, loading, save]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'z' &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        if (e.shiftKey) useEditor.getState().redo();
        else useEditor.getState().undo();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  async function validate() {
    const local = validateGraph(useEditor.getState().graph());
    if (local.length) {
      setError(local.join('；'));
      return false;
    }
    const r = await post<{ errors: string[] }>('/validate', useEditor.getState().graph());
    setError(r.errors.join('；'));
    if (!r.errors.length) setMessage('图校验通过');
    return !r.errors.length;
  }
  async function publish() {
    setBusy(true);
    setMessage('');
    try {
      if (!(await validate())) return;
      const a = await save();
      if (!a) return;
      await post(`/apps/${a.id}/publish`, { revision: a.revision });
      const fresh = await api<AppRecord>(`/apps/${a.id}`);
      useEditor.setState((s) => ({ app: { ...fresh, draft: s.graph() } }));
      setMessage('已发布不可变版本');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Loading />;
  if (!app) return <ErrorBox error={error} />;
  return (
    <div className="editor-page">
      <header className="editor-header">
        <div className="editor-identity">
          <Link to="/" className="icon-btn" aria-label="返回应用">
            <ArrowLeft size={18} />
          </Link>
          <span className="app-icon small">
            <WorkflowIcon size={18} />
          </span>
          <div>
            <input
              aria-label="应用名称"
              className="app-name"
              value={app.name}
              onChange={(e) => {
                useEditor.setState({ app: { ...app, name: e.target.value } });
                useEditor.getState().touch();
              }}
            />
            <small>
              工作流 <ChevronDown size={10} /> <span>{dirty === saved ? '草稿已保存' : '正在保存…'}</span>
            </small>
          </div>
        </div>
        <div className="actions">
          <button
            className="icon-btn"
            disabled={!past}
            title="撤销"
            onClick={() => useEditor.getState().undo()}
          >
            <Undo2 size={17} />
          </button>
          <button
            className="icon-btn"
            disabled={!future}
            title="重做"
            onClick={() => useEditor.getState().redo()}
          >
            <Redo2 size={17} />
          </button>
          <span className="divider" />
          <Button onClick={() => void save()} title="保存草稿">
            <Save size={14} />
          </Button>
          <Button onClick={() => void validate().catch((e) => setError(e.message))}>
            <Check size={14} />
            校验
          </Button>
          <Button disabled={busy} onClick={() => void publish()}>
            <UploadCloud size={14} />
            发布
          </Button>
          <Button variant="primary" onClick={() => setRunDialog(true)}>
            <Play size={14} />
            调试运行
          </Button>
        </div>
      </header>
      {(error || message) && (
        <div className="editor-notice">
          {error ? (
            <ErrorBox error={error} />
          ) : (
            <span className="success">
              <Check size={14} />
              {message}
            </span>
          )}
          <button
            aria-label="关闭提示"
            onClick={() => {
              setError('');
              setMessage('');
            }}
          >
            ×
          </button>
        </div>
      )}
      <div className="editor-main">
        <Palette />
        <Canvas />
        <Properties />
      </div>
      <div className="debug-toggle">
        <button onClick={() => setShowDebug((v) => !v)}>
          <PanelBottom size={14} />
          调试面板 {debug && <span className="tiny-dot" />}
        </button>
        <small>草稿修改不会影响正在运行的版本</small>
      </div>
      {debug && showDebug && (
        <div className="debug-dock">
          <Trace key={debug} id={debug} compact />
        </div>
      )}
      {runDialog && (
        <RunStart
          app={app}
          onClose={() => setRunDialog(false)}
          onRun={(runId) => {
            useTrace.getState().reset(runId);
            setDebug(runId);
            setShowDebug(true);
          }}
        />
      )}
    </div>
  );
}
