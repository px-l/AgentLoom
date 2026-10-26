export type Kind = 'start' | 'llm' | 'retrieval' | 'agent' | 'condition' | 'approval' | 'end';
export interface NodeData extends Record<string, unknown> {
  label: string;
  fields?: string[];
  prompt?: string;
  query?: string;
  kbId?: string;
  topK?: number;
  tools?: string[];
  maxSteps?: number;
  maxTools?: number;
  text?: string;
  template?: string;
  ref?: string;
  path?: string;
  operator?: 'equals' | 'contains' | 'truthy';
  value?: unknown;
}
export interface GraphNode {
  id: string;
  type: Kind;
  position: { x: number; y: number };
  data: NodeData;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}
export interface Workflow {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface AppRecord {
  id: string;
  name: string;
  description: string;
  draft: Workflow;
  revision: number;
  createdAt: string;
  versions: { id: string; number: number; createdAt: string }[];
}
export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'needs_attention';
export interface Citation {
  chunkId: string;
  documentId: string;
  file: string;
  page: number | null;
  ordinal: number;
  text: string;
  indexVersion: string;
  score: number;
}
export interface RunEvent {
  runId: string;
  eventId: number;
  nodeId: string | null;
  time: string;
  type: string;
  data: Record<string, unknown>;
}
export interface NodeRecord {
  nodeId: string;
  status: string;
  input: unknown;
  output: unknown;
  elapsedMs: number | null;
  retries: number;
  modelSteps: number;
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    unknown_requests?: number;
  } | null;
}
export interface Approval {
  id: string;
  nodeId: string;
  status: string;
  proposed: string;
  decision: unknown;
}
export interface RunRecord {
  id: string;
  versionId: string;
  appId: string;
  version: number;
  status: RunStatus;
  input: Record<string, string>;
  output: { text: string; citations: Citation[] } | null;
  error: string | null;
  createdAt: string;
  config: Record<string, unknown>;
  eventCursor: number;
  nodes: NodeRecord[];
  approvals: Approval[];
  tools: unknown[];
}
export const kindLabels: Record<Kind, string> = {
  start: '开始',
  llm: '大语言模型',
  retrieval: '知识检索',
  agent: 'Agent 分析',
  condition: '条件分支',
  approval: '人工审批',
  end: '结束',
};
export const defaults: Record<Kind, NodeData> = {
  start: { label: '开始', fields: ['question'] },
  llm: { label: '大语言模型', prompt: '{{input.question}}' },
  retrieval: { label: '知识检索', kbId: 'example-knowledge', query: '{{input.question}}', topK: 3 },
  agent: {
    label: 'Agent 分析',
    prompt: '{{input.question}}',
    tools: ['calculator'],
    maxSteps: 4,
    maxTools: 3,
    kbId: 'example-knowledge',
  },
  condition: { label: '条件分支', ref: '{{input.question}}', operator: 'contains', value: '是' },
  approval: { label: '人工审批', text: '{{input.question}}' },
  end: { label: '结束', template: '{{input.question}}' },
};
export function validateGraph(g: Workflow): string[] {
  const errors: string[] = [];
  const map = new Map(g.nodes.map((n) => [n.id, n]));
  if (map.size !== g.nodes.length) errors.push('节点 ID 重复');
  const starts = g.nodes.filter((n) => n.type === 'start'),
    ends = g.nodes.filter((n) => n.type === 'end');
  if (starts.length !== 1 || ends.length !== 1) errors.push('需要且只能有一个 Start 和 End');
  if (g.nodes.length > 500 || g.edges.length > 2000) errors.push('节点或连线超过限制');
  const incoming = new Map(g.nodes.map((n) => [n.id, g.edges.filter((e) => e.target === n.id)]));
  const outgoing = new Map(g.nodes.map((n) => [n.id, g.edges.filter((e) => e.source === n.id)]));
  for (const e of g.edges) {
    if (!map.has(e.source) || !map.has(e.target)) errors.push('连线引用不存在的节点');
    if (map.get(e.source)?.type !== 'condition' && e.sourceHandle) errors.push('只有 Condition 支持分支端口');
  }
  if (
    new Set(g.edges.map((e) => e.id)).size !== g.edges.length ||
    new Set(g.edges.map((e) => `${e.source}:${e.target}:${e.sourceHandle ?? ''}`)).size !== g.edges.length
  )
    errors.push('连线重复');
  const order: string[] = [],
    ancestors = new Map<string, Set<string>>();
  while (order.length < map.size) {
    const ready = [...map.keys()].filter(
      (id) => !order.includes(id) && (incoming.get(id) ?? []).every((e) => order.includes(e.source)),
    );
    if (!ready.length) {
      errors.push('工作流必须为有向无环图');
      break;
    }
    order.push(...ready);
  }
  for (const id of order) {
    const a = new Set<string>();
    for (const e of incoming.get(id) ?? []) {
      a.add(e.source);
      for (const x of ancestors.get(e.source) ?? []) a.add(x);
    }
    ancestors.set(id, a);
  }
  const fields = starts[0]?.data.fields ?? [];
  const outputs: Record<Kind, string[]> = {
    start: ['text'],
    llm: ['text', 'citations'],
    agent: ['text', 'citations'],
    retrieval: ['text', 'hits'],
    condition: ['value'],
    approval: ['text', 'approved'],
    end: ['text', 'citations'],
  };
  for (const n of g.nodes) {
    const d = n.data;
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(n.id) ||
      ['router', 'input', '__start__', '__end__'].includes(n.id)
    )
      errors.push(`${n.id}: 无效或保留的节点 ID`);
    if (!d.label?.trim()) errors.push(`${n.id}: 节点名称必填`);
    if (
      n.type === 'start' &&
      (!fields.length ||
        new Set(fields).size !== fields.length ||
        fields.some((f) => !/^[a-zA-Z]\w*$/.test(f)))
    )
      errors.push('输入字段需为不重复的英文标识符列表');
    if (n.type === 'start' && (incoming.get(n.id)?.length ?? 0) > 0) errors.push('Start 不可有输入连线');
    if (n.type === 'end' && (outgoing.get(n.id)?.length ?? 0) > 0) errors.push('End 不可有输出连线');
    if (n.type !== 'start' && !incoming.get(n.id)?.length) errors.push(`${n.id}: 节点没有输入连线`);
    if (n.type !== 'end' && !outgoing.get(n.id)?.length) errors.push(`${n.id}: 节点没有输出连线`);
    if (starts[0] && n.id !== starts[0].id && !ancestors.get(n.id)?.has(starts[0].id))
      errors.push(`${n.id}: 无法从 Start 到达`);
    if (ends[0] && n.id !== ends[0].id && !ancestors.get(ends[0].id)?.has(n.id))
      errors.push(`${n.id}: 无法到达 End`);
    const required: Partial<Record<Kind, string[]>> = {
      llm: ['prompt'],
      agent: ['prompt'],
      retrieval: ['query', 'kbId'],
      condition: ['ref'],
      approval: ['text'],
      end: ['template'],
    };
    for (const key of required[n.type] ?? [])
      if (typeof d[key] !== 'string' || !(d[key] as string).trim()) errors.push(`${n.id}: ${key} 必填`);
    if (n.type === 'condition') {
      if (d.path && !/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(d.path))
        errors.push(`${n.id}: JSON 字段路径无效`);
      if (
        (outgoing.get(n.id) ?? [])
          .map((e) => e.sourceHandle ?? '')
          .sort()
          .join(',') !== 'false,true'
      )
        errors.push(`${n.id}: 需要 true / false 各一条分支`);
      if (!['equals', 'contains', 'truthy'].includes(d.operator ?? ''))
        errors.push(`${n.id}: 不支持的条件操作符`);
      if (d.operator === 'equals' && !('value' in d)) errors.push(`${n.id}: equals 缺少 value`);
    }
    if (n.type === 'retrieval' && (!Number.isInteger(d.topK ?? 3) || (d.topK ?? 3) < 1 || (d.topK ?? 3) > 10))
      errors.push(`${n.id}: topK 范围为 1–10`);
    if (n.type === 'agent') {
      if ((d.tools ?? []).some((t) => !['calculator', 'knowledge_search'].includes(t)))
        errors.push(`${n.id}: 工具不在白名单`);
      for (const [key, cap] of [
        ['maxSteps', 12],
        ['maxTools', 10],
      ] as const) {
        const v = d[key] ?? 4;
        if (!Number.isInteger(v) || v < 1 || v > cap) errors.push(`${n.id}: ${key} 超出范围`);
      }
    }
    for (const [key, v] of Object.entries(d))
      if (typeof v === 'string' && key !== 'label') {
        const pattern = /{{\s*([\w-]+)\.([\w]+)\s*}}/g;
        if (v.replace(pattern, '').includes('{{') || v.replace(pattern, '').includes('}}'))
          errors.push(`${n.id}: 无效变量语法`);
        for (const m of v.matchAll(pattern)) {
          const [, src, field] = m;
          if (
            src === 'input'
              ? !fields.includes(field)
              : !ancestors.get(n.id)?.has(src) ||
                !(map.get(src)?.type === 'start' ? fields : outputs[map.get(src)?.type ?? 'end']).includes(
                  field,
                )
          )
            errors.push(`${n.id}: 无效的上游变量 ${src}.${field}`);
        }
      }
  }
  return [...new Set(errors)];
}
export function mergeEvents(previous: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const byId = new Map(previous.map((e) => [e.eventId, e]));
  for (const e of incoming) byId.set(e.eventId, e);
  return [...byId.values()].sort((a, b) => a.eventId - b.eventId);
}
