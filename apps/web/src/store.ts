import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type Node,
  type Edge,
} from '@xyflow/react';
import {
  defaults,
  mergeEvents,
  type Workflow,
  type Kind,
  type NodeData,
  type RunEvent,
  type AppRecord,
} from '@agentloom/protocol';
export type CanvasNode = Node<NodeData, Kind>;
interface EditorState {
  app: AppRecord | null;
  nodes: CanvasNode[];
  edges: Edge[];
  selected: string | null;
  past: Workflow[];
  future: Workflow[];
  dirty: number;
  saved: number;
  load: (app: AppRecord) => void;
  graph: () => Workflow;
  remember: () => void;
  nodeChanges: (changes: NodeChange<CanvasNode>[]) => void;
  edgeChanges: (changes: EdgeChange[]) => void;
  connect: (c: Connection) => void;
  add: (kind: Kind, position?: { x: number; y: number }) => void;
  update: (id: string, data: Partial<NodeData>) => void;
  undo: () => void;
  redo: () => void;
  touch: () => void;
  ack: (app: AppRecord, counter: number) => void;
  removeSelected: () => void;
}
const clean = (nodes: CanvasNode[], edges: Edge[]): Workflow => ({
  nodes: nodes.map(({ id, type, position, data }) => ({ id, type: type!, position: { ...position }, data })),
  edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, sourceHandle })),
});
export const useEditor = create<EditorState>((set, get) => ({
  app: null,
  nodes: [],
  edges: [],
  selected: null,
  past: [],
  future: [],
  dirty: 0,
  saved: 0,
  graph: () => clean(get().nodes, get().edges),
  load: (app) =>
    set({
      app,
      nodes: app.draft.nodes,
      edges: app.draft.edges,
      selected: null,
      past: [],
      future: [],
      dirty: 0,
      saved: 0,
    }),
  remember: () =>
    set((s) => ({ past: [...s.past.slice(-49), structuredClone(clean(s.nodes, s.edges))], future: [] })),
  touch: () => set((s) => ({ dirty: s.dirty + 1 })),
  nodeChanges: (changes) => {
    const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
    if (removed.size) get().remember();
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes),
      edges: removed.size ? s.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)) : s.edges,
      ...(removed.size ? { dirty: s.dirty + 1 } : {}),
    }));
  },
  edgeChanges: (changes) => {
    const removesExisting = changes.some(
      (c) => c.type === 'remove' && get().edges.some((e) => e.id === c.id),
    );
    if (removesExisting) get().remember();
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges),
      ...(removesExisting ? { dirty: s.dirty + 1 } : {}),
    }));
  },
  connect: (c) => {
    get().remember();
    set((s) => ({ edges: addEdge(c, s.edges), dirty: s.dirty + 1 }));
  },
  add: (kind, position) => {
    get().remember();
    const id = `${kind}_${crypto.randomUUID().slice(0, 8)}`;
    set((s) => ({
      nodes: [
        ...s.nodes,
        {
          id,
          type: kind,
          position: position ?? { x: 200 + s.nodes.length * 30, y: 150 + s.nodes.length * 30 },
          data: structuredClone(defaults[kind]),
        },
      ],
      selected: id,
      dirty: s.dirty + 1,
    }));
  },
  update: (id, data) => {
    get().remember();
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)),
      dirty: s.dirty + 1,
    }));
  },
  undo: () => {
    const s = get(),
      g = s.past.at(-1);
    if (g)
      set({
        nodes: g.nodes,
        edges: g.edges,
        past: s.past.slice(0, -1),
        future: [s.graph(), ...s.future],
        dirty: s.dirty + 1,
      });
  },
  redo: () => {
    const s = get(),
      g = s.future[0];
    if (g)
      set({
        nodes: g.nodes,
        edges: g.edges,
        past: [...s.past, s.graph()],
        future: s.future.slice(1),
        dirty: s.dirty + 1,
      });
  },
  ack: (app, counter) => set((s) => ({ app: { ...app, draft: s.graph() }, saved: counter })),
  removeSelected: () => {
    const id = get().selected;
    if (!id) return;
    get().remember();
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
      selected: null,
      dirty: s.dirty + 1,
    }));
  },
}));
interface TraceState {
  runId: string | null;
  events: RunEvent[];
  statuses: Record<string, string>;
  texts: Record<string, string>;
  cursor: number;
  attempts: Record<string, number>;
  reset: (id: string) => void;
  ingest: (batch: RunEvent[]) => void;
}
export const useTrace = create<TraceState>((set) => ({
  runId: null,
  events: [],
  statuses: {},
  texts: {},
  cursor: 0,
  attempts: {},
  reset: (id) => set({ runId: id, events: [], statuses: {}, texts: {}, cursor: 0, attempts: {} }),
  ingest: (batch) =>
    set((s) => {
      batch = batch.filter((e) => e.runId === s.runId);
      if (!batch.length) return s;
      const events = mergeEvents(s.events, batch),
        fresh = events.filter((e) => e.eventId > s.cursor),
        statuses = { ...s.statuses },
        texts = { ...s.texts },
        attempts = { ...s.attempts };
      for (const e of fresh) {
        if (e.nodeId) {
          if (e.type.startsWith('node.') && ['started', 'completed', 'failed'].includes(e.type.split('.')[1]))
            statuses[e.nodeId] = e.type.split('.')[1];
          if (e.type === 'approval.required') statuses[e.nodeId] = 'paused';
          if (e.type === 'message.delta') {
            const attempt = Number(e.data.attempt ?? 0);
            if (attempt > (attempts[e.nodeId] ?? 0)) texts[e.nodeId] = '';
            attempts[e.nodeId] = attempt;
            texts[e.nodeId] = (texts[e.nodeId] ?? '') + String(e.data.text ?? '');
          }
        }
      }
      return {
        events,
        statuses,
        texts,
        attempts,
        cursor: Math.max(s.cursor, ...batch.map((e) => e.eventId)),
      };
    }),
}));
