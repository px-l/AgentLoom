import { useEffect, useState, type ReactNode } from 'react';
import { X, LoaderCircle, AlertCircle, Play, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import type { AppRecord, Workflow } from '@agentloom/protocol';
export function Button({
  children,
  onClick,
  variant = '',
  disabled = false,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  return (
    <button type={type} title={title} className={`btn ${variant}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
export function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div role="alert" className="error">
      <AlertCircle size={16} />
      <span>{error}</span>
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="empty">
      <LoaderCircle className="spin" size={24} />
      <p>正在加载…</p>
    </div>
  );
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">◇</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export const statusLabels: Record<string, string> = {
  queued: '等待执行',
  running: '执行中',
  started: '执行中',
  paused: '等待审批',
  cancelling: '取消请求中',
  cancelled: '已取消',
  completed: '已完成',
  failed: '执行失败',
  needs_attention: '需人工检查',
  ready: '已索引',
  indexing: '索引中',
  pending: '待处理',
  resolved: '已处理',
};
export function Status({ value }: { value: string }) {
  return (
    <span className={`status ${value}`}>
      <i />
      {statusLabels[value] ?? value}
    </span>
  );
}
export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
export function RunStart({
  app,
  onClose,
  onRun,
}: {
  app: AppRecord;
  onClose: () => void;
  onRun?: (id: string) => void;
}) {
  const navigate = useNavigate(),
    [version, setVersion] = useState(app.versions[0]?.id ?? ''),
    [graph, setGraph] = useState<Workflow | null>(null),
    [input, setInput] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  // A request retry keeps this key. Closing/reopening the dialog creates a new execution key.
  const [key] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    setGraph(null);
    setInput({});
    if (version)
      api<{ graph: Workflow }>(`/versions/${version}`)
        .then((r) => {
          if (active) setGraph(r.graph);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [version]);
  const fields = graph?.nodes.find((n) => n.type === 'start')?.data.fields ?? [];
  async function submit() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ id: string }>('/runs', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ versionId: version, input }),
      });
      onClose();
      if (onRun) onRun(r.id);
      else navigate(`/runs/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="创建执行" onClose={onClose}>
      <p className="muted">执行将绑定已发布的版本和当前配置快照。</p>
      <ErrorBox error={error} />
      {!version ? (
        <Empty title="还没有发布版本" description="请在编辑器中校验并发布工作流。" />
      ) : (
        <>
          <label>
            工作流版本
            <select value={version} onChange={(e) => setVersion(e.target.value)}>
              {app.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.number} · {new Date(v.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {fields.map((f) => (
            <label key={f}>
              {f}
              <textarea
                autoFocus
                value={input[f] ?? ''}
                placeholder="输入本次执行内容…"
                onChange={(e) => setInput({ ...input, [f]: e.target.value })}
              />
            </label>
          ))}
          <footer>
            <Button onClick={onClose}>取消</Button>
            <Button
              variant="primary"
              disabled={busy || !fields.length || fields.some((f) => !input[f]?.trim())}
              onClick={submit}
            >
              <Play size={15} />
              {busy ? '提交中…' : '开始执行'}
              <ChevronRight size={14} />
            </Button>
          </footer>
        </>
      )}
    </Modal>
  );
}
