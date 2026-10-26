import { describe, it, expect, beforeEach } from 'vitest';
import { validateGraph, mergeEvents, type Workflow, type RunEvent } from '@agentloom/protocol';
import { useEditor, useTrace } from './store';
const graph: Workflow = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: '开始', fields: ['question'] } },
    {
      id: 'end',
      type: 'end',
      position: { x: 300, y: 0 },
      data: { label: '结束', template: '{{input.question}}' },
    },
  ],
  edges: [{ id: 'e', source: 'start', target: 'end' }],
};
const event = (id: number, text: string): RunEvent => ({
  runId: 'r',
  eventId: id,
  nodeId: 'a',
  time: '2026-10-26',
  type: 'message.delta',
  data: { text },
});
describe('共同图校验', () => {
  it('接受有效 DAG', () => expect(validateGraph(graph)).toEqual([]));
  it('拒绝环及无效引用', () => {
    const g = structuredClone(graph);
    g.edges.push({ id: 'back', source: 'end', target: 'start' });
    g.nodes[1].data.template = '{{missing.text}}';
    expect(validateGraph(g).join()).toContain('无环');
    expect(validateGraph(g).join()).toContain('上游变量');
  });
  it('拒绝没有真假端口的条件节点', () => {
    const g = structuredClone(graph);
    g.nodes.splice(1, 0, {
      id: 'branch',
      type: 'condition',
      position: { x: 0, y: 0 },
      data: { label: '判断', ref: '{{input.question}}', operator: 'truthy' },
    });
    g.edges = [
      { id: 'e1', source: 'start', target: 'branch' },
      { id: 'e2', source: 'branch', target: 'end' },
    ];
    expect(validateGraph(g).join()).toContain('true / false');
  });
});
describe('编辑历史与拖拽', () => {
  beforeEach(() =>
    useEditor.getState().load({
      id: 'a',
      name: 'App',
      description: '',
      draft: structuredClone(graph),
      revision: 1,
      createdAt: '',
      versions: [],
    }),
  );
  it('拖动每帧只更新位置，结束后才标记保存', () => {
    const s = useEditor.getState();
    s.remember();
    for (let x = 0; x < 100; x++)
      s.nodeChanges([{ id: 'start', type: 'position', position: { x, y: 0 }, dragging: true }]);
    expect(useEditor.getState().past).toHaveLength(1);
    expect(useEditor.getState().dirty).toBe(0);
    s.touch();
    s.undo();
    expect(useEditor.getState().nodes[0].position.x).toBe(0);
    s.redo();
    expect(useEditor.getState().nodes[0].position.x).toBe(99);
  });
  it('更新一个节点保持其他节点对象引用', () => {
    const old = useEditor.getState().nodes[1];
    useEditor.getState().update('start', { label: '新名称' });
    expect(useEditor.getState().nodes[1]).toBe(old);
  });
});
describe('SSE 断线补拉与去重', () => {
  it('按 ID 排序去重', () =>
    expect(
      mergeEvents([event(1, 'a'), event(2, 'b')], [event(2, 'b'), event(3, 'c')]).map((e) => e.eventId),
    ).toEqual([1, 2, 3]));
  it('重连不重复追加增量', () => {
    const s = useTrace.getState();
    s.reset('r');
    s.ingest([event(1, '你'), event(2, '好')]);
    s.ingest([event(2, '好'), event(3, '！')]);
    expect(useTrace.getState().texts.a).toBe('你好！');
    expect(useTrace.getState().cursor).toBe(3);
  });
  it('重试保留事件但显示新一轮文本', () => {
    const s = useTrace.getState();
    s.reset('r');
    s.ingest([event(1, 'partial')]);
    s.ingest([{ ...event(2, 'retry'), data: { text: 'retry', attempt: 1 } }]);
    expect(useTrace.getState().texts.a).toBe('retry');
    expect(useTrace.getState().events).toHaveLength(2);
  });
});

describe('节点与连线删除的原子撤销', () => {
  it('一次撤销恢复节点及相连边', () => {
    useEditor.getState().load({
      id: 'a',
      name: 'App',
      description: '',
      draft: structuredClone(graph),
      revision: 1,
      createdAt: '',
      versions: [],
    });
    const s = useEditor.getState();
    s.nodeChanges([{ id: 'start', type: 'remove' }]);
    // React Flow may separately report the incident edge removal; it must not create a second history item.
    s.edgeChanges([{ id: 'e', type: 'remove' }]);
    expect(useEditor.getState().past).toHaveLength(1);
    s.undo();
    expect(useEditor.getState().nodes).toHaveLength(2);
    expect(useEditor.getState().edges).toHaveLength(1);
  });
});

describe('切换执行的事件隔离', () => {
  it('忽略旧连接延迟到达的事件', () => {
    const s = useTrace.getState();
    s.reset('new');
    s.ingest([event(1, '旧任务')]);
    expect(useTrace.getState().events).toHaveLength(0);
    s.ingest([{ ...event(1, '新任务'), runId: 'new' }]);
    expect(useTrace.getState().texts.a).toBe('新任务');
  });
});
