import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './Editor';
import { useEditor } from './store';
import type { Workflow, GraphNode } from '@agentloom/protocol';
interface Metrics {
  nodeCount: number;
  edgeCount: number;
  loadMs: number;
  frames: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  longTasks: number;
  historyEntries: number;
  saveSignals: number;
  userAgent: string;
}
declare global {
  interface Window {
    agentloomPerf?: { start: () => void; finish: () => Metrics };
  }
}
export default function Benchmark() {
  const [ready, setReady] = useState(false),
    count = Math.max(2, Math.min(500, Number(new URLSearchParams(location.search).get('nodes') ?? 100)));
  useEffect(() => {
    const start = performance.now();
    const nodes: GraphNode[] = Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      type: i === 0 ? 'start' : i === count - 1 ? 'end' : 'llm',
      position: { x: 70 + (i % 10) * 250, y: 100 + Math.floor(i / 10) * 160 },
      data:
        i === 0
          ? { label: '输入', fields: ['question'] }
          : i === count - 1
            ? { label: '输出', template: `{{n${i - 1}.text}}` }
            : { label: `模型节点 ${i}`, prompt: '{{input.question}}' },
    }));
    const graph: Workflow = {
      nodes,
      edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: `n${i}`, target: n.id })),
    };
    useEditor
      .getState()
      .load({
        id: 'benchmark',
        name: '画布性能场景',
        description: '',
        draft: graph,
        revision: 1,
        createdAt: '',
        versions: [],
      });
    let raf = 0,
      previous = 0,
      frames: number[] = [],
      longTasks = 0,
      active = false,
      loadMs = 0;
    const observer = new PerformanceObserver((list) => {
      if (active) longTasks += list.getEntries().length;
    });
    try {
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      /* browser may not expose long tasks */
    }
    const sample = (t: number) => {
      if (active && previous) frames.push(t - previous);
      previous = t;
      raf = requestAnimationFrame(sample);
    };
    raf = requestAnimationFrame(sample);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        loadMs = performance.now() - start;
        setReady(true);
      }),
    );
    window.agentloomPerf = {
      start: () => {
        active = true;
        frames = [];
        previous = 0;
        longTasks = 0;
      },
      finish: () => {
        active = false;
        const sorted = frames.slice().sort((a, b) => a - b);
        const percentile = (q: number) =>
          Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0).toFixed(2));
        return {
          nodeCount: count,
          edgeCount: count - 1,
          loadMs: Number(loadMs.toFixed(2)),
          frames: frames.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          maxMs: percentile(1),
          longTasks,
          historyEntries: useEditor.getState().past.length,
          saveSignals: useEditor.getState().dirty,
          userAgent: navigator.userAgent,
        };
      },
    };
    return () => {
      delete window.agentloomPerf;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [count]);
  return (
    <div className="editor-page">
      <header className="editor-header">
        <strong>
          画布性能测试 · {count} 节点 / {count - 1} 连线
        </strong>
        <span data-testid="perf-ready">{ready ? 'ready' : 'loading'}</span>
        <small>与编辑器共用画布、节点和状态管理；不连接数据库。</small>
      </header>
      <ReactFlowProvider>
        <Canvas benchmark />
      </ReactFlowProvider>
    </div>
  );
}
