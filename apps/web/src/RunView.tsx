import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Square, Activity, Check, FileText, RefreshCw } from 'lucide-react';
import type { RunRecord, Citation } from '@agentloom/protocol';
import { useResource, useRunStream } from './hooks';
import { useTrace } from './store';
import { Button, ErrorBox, Loading, Status, Json, Empty } from './components';
import { post } from './api';
export function Trace({ id, compact = false }: { id: string; compact?: boolean }) {
  const { data: run, error, loading, reload } = useResource<RunRecord>(`/runs/${id}`, 1500),
    connection = useRunStream(id);
  const events = useTrace((s) => s.events),
    texts = useTrace((s) => s.texts);
  const [tab, setTab] = useState('output'),
    [actionError, setActionError] = useState(''),
    [edit, setEdit] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);
  const terminal = run && ['completed', 'failed', 'cancelled', 'needs_attention'].includes(run.status);
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    try {
      await post(path, body);
      setActionError('');
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (run?.status === 'paused') setTab('output');
  }, [run?.status]);
  if (loading) return <Loading />;
  if (!run) return <ErrorBox error={error} />;
  const pending = run.approvals?.filter((a) => a.status === 'pending') ?? [];
  return (
    <div className={`trace ${compact ? 'compact' : ''}`}>
      <div className="trace-toolbar">
        <span className="trace-title">
          <Activity size={16} />
          执行调试 <code>{id.slice(0, 8)}</code>
          <Status value={run.status} />
        </span>
        <div className="actions">
          <span className="live">
            <i />
            {terminal ? '历史记录' : connection}
          </span>
          {compact && (
            <Link to={`/runs/${id}`} className="text-link">
              完整追踪 ↗
            </Link>
          )}
          {!terminal && (
            <Button disabled={busy} onClick={() => action(`/runs/${id}/cancel`)}>
              <Square size={12} />
              取消
            </Button>
          )}
        </div>
      </div>
      <ErrorBox error={error || actionError} />
      <div className="trace-tabs">
        {[
          ['output', '输出与审批'],
          ['nodes', '节点详情'],
          ['events', '事件时间线'],
          ['tools', '工具调用'],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
            {key === 'events' && <small>{events.length}</small>}
          </button>
        ))}
      </div>
      <div className="trace-content">
        {tab === 'output' && (
          <>
            {run.config.model_mode === 'demo' && (
              <div className="demo-notice">
                演示模型 · 确定性替身，无真实 Token 用量；执行、检索、审批和事件均已持久化。
              </div>
            )}
            {run.error && <ErrorBox error={run.error} />}
            {pending.map((a) => (
              <section key={a.id} className="approval-box">
                <div className="section-title">
                  <span className="approval-symbol">✓</span>
                  <div>
                    <h3>需要你的确认</h3>
                    <p>任务已暂停。内容可修改，关闭页面后仍可继续。</p>
                  </div>
                  <Status value={run.status} />
                </div>
                <textarea
                  aria-label="审批内容"
                  className="approval-text"
                  value={edit[a.id] ?? a.proposed}
                  onChange={(e) => setEdit({ ...edit, [a.id]: e.target.value })}
                />
                <div className="actions">
                  <Button
                    disabled={busy || run.status !== 'paused'}
                    variant="danger"
                    onClick={() => action(`/approvals/${a.id}/resolve`, { approved: false })}
                  >
                    拒绝
                  </Button>
                  <Button
                    disabled={busy || run.status !== 'paused'}
                    variant="primary"
                    onClick={() =>
                      action(`/approvals/${a.id}/resolve`, { approved: true, text: edit[a.id] ?? a.proposed })
                    }
                  >
                    <Check size={15} />
                    确认并继续
                  </Button>
                </div>
              </section>
            ))}
            {run.output ? (
              <>
                <div className="section-title">
                  <h3>
                    <FileText size={17} />
                    执行结果
                  </h3>
                  <a className="btn" href={`/api/runs/${id}/report`} download>
                    <Download size={14} />
                    保存 Markdown
                  </a>
                </div>
                <pre className="report">{run.output.text}</pre>
                <Sources sources={run.output.citations ?? []} />
              </>
            ) : (
              !pending.length && (
                <>
                  {Object.keys(texts).length ? (
                    Object.entries(texts).map(([node, text]) => (
                      <section key={node}>
                        <div className="eyebrow">{node} · 已接收文本（引用尚待校验）</div>
                        <pre className="report streaming">{text}</pre>
                      </section>
                    ))
                  ) : (
                    <Empty
                      title={run.status === 'queued' ? '任务已入队' : '暂无文本输出'}
                      description={
                        run.status === 'queued'
                          ? '独立 worker 将领取任务。若长时间等待，请确认 worker 已启动。'
                          : '节点结果与已接收的内容会保存在这里。'
                      }
                    />
                  )}
                </>
              )
            )}
          </>
        )}
        {tab === 'nodes' &&
          (run.nodes?.length ? (
            run.nodes.map((n) => (
              <details className="detail-row" key={n.nodeId}>
                <summary>
                  <span className="mono">{n.nodeId}</span>
                  <Status value={n.status} />
                  <span>{n.elapsedMs === null ? '耗时未知' : `${n.elapsedMs} ms`}</span>
                  <span>重试 {n.retries}</span>
                  <span>模型请求 {n.modelSteps ?? 0}</span>
                  <span>
                    Token{' '}
                    {n.usage
                      ? `${n.usage.total_tokens ?? '未知'}${n.usage.unknown_requests ? ' + 未知请求' : ''}`
                      : '未知'}
                  </span>
                </summary>
                <h4>输入</h4>
                <Json value={n.input} />
                <h4>输出</h4>
                <Json value={n.output} />
                {n.usage && (
                  <>
                    <h4>模型实际用量</h4>
                    <Json value={n.usage} />
                  </>
                )}
              </details>
            ))
          ) : (
            <Empty title="暂无节点记录" />
          ))}
        {tab === 'events' && (
          <div className="timeline">
            {events.map((e) => (
              <details key={e.eventId}>
                <summary>
                  <span className={`event-dot ${e.type.includes('failed') ? 'failed' : ''}`} />
                  <span className="mono event-name">{e.type}</span>
                  <span className="muted">{e.nodeId ?? '运行'}</span>
                  <time>{new Date(e.time).toLocaleTimeString()}</time>
                  <code>#{e.eventId}</code>
                </summary>
                <Json value={e.data} />
              </details>
            ))}
            {!events.length && <Empty title="等待事件" description="连接恢复后将通过游标补拉历史。" />}
          </div>
        )}
        {tab === 'tools' &&
          (run.tools?.length ? (
            run.tools.map((t, i) => (
              <details className="detail-row" key={i}>
                <summary>
                  工具调用 {i + 1}
                  <span className="muted">参数、摘要与结果</span>
                </summary>
                <Json value={t} />
              </details>
            ))
          ) : (
            <Empty title="本次执行没有工具调用" description="Agent 节点仅允许调用节点配置中的白名单工具。" />
          ))}
      </div>
    </div>
  );
}
function Sources({ sources }: { sources: Citation[] }) {
  return (
    <section className="sources">
      <h4>
        真实来源 <span>{sources.length}</span>
      </h4>
      {sources.length ? (
        sources.map((s) => (
          <details key={s.chunkId}>
            <summary>
              <FileText size={15} />
              <strong>{s.file}</strong>
              <span>{s.page ? `第 ${s.page} 页` : `第 ${s.ordinal + 1} 块`}</span>
              <code>{s.chunkId}</code>
            </summary>
            <p>{s.text}</p>
            <small>索引版本：{s.indexVersion}</small>
            <a href={`/api/documents/${s.documentId}/source`} className="text-link">
              下载来源文件
            </a>
          </details>
        ))
      ) : (
        <p className="muted">输出未关联有效检索引用。</p>
      )}
    </section>
  );
}
export function RunPage() {
  const { id } = useParams();
  return (
    <main className="page run-page">
      <Link to="/runs" className="back">
        <ArrowLeft size={14} />
        所有执行
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">EXECUTION TRACE</div>
          <h1>运行详情</h1>
          <p>从输入到结果，每一步都有迹可循。</p>
        </div>
      </div>
      {id && <Trace key={id} id={id} />}
    </main>
  );
}
export function RunsPage() {
  const { data, error, loading, reload } = useResource<RunRecord[]>('/runs', 3000);
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">OBSERVABILITY</div>
          <h1>执行记录</h1>
          <p>查看任务进度，继续审批，追溯完整执行过程。</p>
        </div>
        <Button onClick={() => void reload()}>
          <RefreshCw size={15} />
          刷新
        </Button>
      </div>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>执行 ID / 版本</th>
                <th>输入</th>
                <th>状态</th>
                <th>创建时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link className="mono text-link" to={`/runs/${r.id}`}>
                      {r.id.slice(0, 8)}
                    </Link>
                    <small>v{r.version}</small>
                  </td>
                  <td className="truncate-cell">{Object.values(r.input).join(' · ')}</td>
                  <td>
                    <Status value={r.status} />
                  </td>
                  <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    <Link className="text-link" to={`/runs/${r.id}`}>
                      查看 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="还没有执行记录" description="从应用列表运行一个已发布的工作流。">
          <Link className="btn primary" to="/">
            前往应用
          </Link>
        </Empty>
      )}
    </main>
  );
}
