import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  Boxes,
  Workflow,
  BookOpen,
  Settings,
  Activity,
  Plus,
  ArrowUpRight,
  Copy,
  Play,
  ArrowRight,
  ChevronRight,
  Command,
  Search,
} from 'lucide-react';
import type { AppRecord, Workflow as Graph } from '@agentloom/protocol';
import { useResource } from './hooks';
import { Button, Empty, ErrorBox, Loading, Modal, RunStart } from './components';
import { post } from './api';
import { EditorPage } from './Editor';
import { RunsPage, RunPage } from './RunView';
import { KnowledgePage } from './Knowledge';
import { SettingsPage } from './Settings';
const BenchmarkPage = lazy(() => import('./Benchmark'));
const initialGraph: Graph = {
  nodes: [
    {
      id: 'start',
      type: 'start',
      position: { x: 100, y: 180 },
      data: { label: '开始', fields: ['question'] },
    },
    {
      id: 'end',
      type: 'end',
      position: { x: 430, y: 180 },
      data: { label: '结束', template: '{{input.question}}' },
    },
  ],
  edges: [{ id: 'start-end', source: 'start', target: 'end' }],
};
function Shell() {
  const location = useLocation();
  const { data } = useResource<{ model_mode: string; embedding_mode: string }>('/settings', 10000);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/">
          <span className="logo-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            AgentLoom<small>智织 · AGENT WORKSPACE</small>
          </span>
        </Link>
        <div className="workspace-switch">
          <span className="workspace-avatar">P</span>
          <div>
            个人工作空间<small>Local workspace</small>
          </div>
          <ChevronRight size={14} />
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          {[
            ['/', '应用', Boxes],
            ['/runs', '执行记录', Activity],
            ['/knowledge', '知识库', BookOpen],
          ].map(([path, label, Icon]) => (
            <NavLink
              key={String(path)}
              to={String(path)}
              end={path === '/'}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {typeof Icon !== 'string' && <Icon size={18} />}
              <span>{String(label)}</span>
              {path === '/' && <kbd>⌘ 1</kbd>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-notice">
            <span className="local-dot" />
            <strong>本地单用户环境</strong>
            <p>
              {data
                ? `模型：${data.model_mode === 'demo' ? '演示替身' : '真实接口'} · 向量：${data.embedding_mode === 'demo' ? '演示' : '真实'}`
                : '等待服务连接'}
            </p>
          </div>
          <NavLink to="/settings" className={({ isActive }) => `settings-link ${isActive ? 'active' : ''}`}>
            <Settings size={17} />
            设置<span>⌘ ,</span>
          </NavLink>
          <div className="sidebar-footer">
            AgentLoom <span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <div className={`main-shell ${location.pathname.startsWith('/apps/') ? 'is-editor' : ''}`}>
        <Routes>
          <Route path="/" element={<AppsPage />} />
          <Route path="/apps/:id" element={<EditorPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="/benchmark"
            element={
              <Suspense fallback={<Loading />}>
                <BenchmarkPage />
              </Suspense>
            }
          />
          <Route
            path="*"
            element={
              <Empty title="页面不存在">
                <Link to="/">返回应用</Link>
              </Empty>
            }
          />
        </Routes>
      </div>
    </div>
  );
}
function AppsPage() {
  const { data, error, loading, reload } = useResource<AppRecord[]>('/apps'),
    [search, setSearch] = useState(''),
    [create, setCreate] = useState(false),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [actionError, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [runApp, setRunApp] = useState<AppRecord | null>(null);
  const navigate = useNavigate();
  async function add() {
    setBusy(true);
    try {
      const a = await post<AppRecord>('/apps', { name, description, graph: initialGraph });
      navigate(`/apps/${a.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(id: string) {
    try {
      await post(`/apps/${id}/duplicate`);
      await reload();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const filtered = data?.filter((a) =>
    `${a.name}${a.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <main className="page apps-page">
      <div className="breadcrumb">
        工作空间 <ChevronRight size={12} />
        <span>应用</span>
      </div>
      <div className="page-heading">
        <div>
          <div className="eyebrow">BUILD WITH PURPOSE</div>
          <h1>
            把想法，织成应用<span className="mint-period">.</span>
          </h1>
          <p>编排工作流，连接知识与工具，让 Agent 可靠地完成任务。</p>
        </div>
        <Button variant="primary" onClick={() => setCreate(true)}>
          <Plus size={17} />
          创建应用
        </Button>
      </div>
      <ErrorBox error={error || actionError} />
      <section className="welcome-banner">
        <div className="welcome-content">
          <span className="tag">从工作流到可观测的执行</span>
          <h2>让每一步，都可见、可控、可继续。</h2>
          <p>从预置场景开始探索，或构建属于你的 Agent 工作流。</p>
          <Link to="/runs">
            探索执行追踪 <ArrowRight size={15} />
          </Link>
        </div>
        <div className="mini-flow" aria-hidden="true">
          <div className="mini-step">
            <span>↗</span>输入
          </div>
          <i />
          <div className="mini-step model">
            <span>✦</span>Agent
          </div>
          <i />
          <div className="mini-step human">
            <span>✓</span>人工确认
          </div>
          <div className="flow-dot one" />
          <div className="flow-dot two" />
        </div>
      </section>
      <div className="collection-heading">
        <h2>
          我的应用 <span>{data?.length ?? '—'}</span>
        </h2>
        <div className="search-box">
          <Search size={15} />
          <input
            aria-label="搜索应用"
            placeholder="搜索应用…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>⌕</kbd>
        </div>
      </div>
      {loading ? (
        <Loading />
      ) : filtered?.length ? (
        <div className="app-grid">
          {filtered.map((a, i) => (
            <article className="app-card" key={a.id}>
              <div className="app-card-top">
                <span className={`app-icon ${i % 2 ? 'violet' : ''}`}>
                  <Workflow size={23} />
                </span>
                <span className={`tag ${a.versions.length ? 'published' : ''}`}>
                  {a.versions.length ? `已发布 · v${a.versions[0].number}` : '草稿'}
                </span>
                <button
                  className="icon-btn"
                  title="复制应用"
                  aria-label={`复制 ${a.name}`}
                  onClick={() => void copy(a.id)}
                >
                  <Copy size={15} />
                </button>
              </div>
              <Link to={`/apps/${a.id}`} className="app-title">
                {a.name}
                <ArrowUpRight size={18} />
              </Link>
              <p>{a.description || '尚未添加应用描述'}</p>
              <div className="app-meta">
                <Workflow size={13} />
                {a.draft.nodes.length} 个节点
                <span />
                工作流应用
              </div>
              <footer>
                <Link to={`/apps/${a.id}`}>
                  <Command size={13} />
                  编辑工作流
                </Link>
                <button disabled={!a.versions.length} onClick={() => setRunApp(a)}>
                  <Play size={12} />
                  运行
                </button>
              </footer>
            </article>
          ))}
          <button className="new-app-card" onClick={() => setCreate(true)}>
            <span>
              <Plus size={23} />
            </span>
            <strong>创建新应用</strong>
            <small>从一个简单的想法开始</small>
          </button>
        </div>
      ) : (
        <Empty
          title={search ? '没有找到应用' : '创建你的第一个应用'}
          description="可视化编排与可靠执行，从这里开始。"
        >
          <Button variant="primary" onClick={() => setCreate(true)}>
            <Plus size={15} />
            创建应用
          </Button>
        </Empty>
      )}
      <div className="learning-note">
        <BookOpen size={17} />
        <div>
          <strong>内置两条完整场景</strong>
          <p>知识问答验证来源引用，需求评审验证 Agent 工具调用与可恢复的人工审批。</p>
        </div>
        <Link to="/knowledge">
          查看示例知识 <ArrowUpRight size={14} />
        </Link>
      </div>
      {create && (
        <Modal title="创建应用" onClose={() => setCreate(false)}>
          <ErrorBox error={actionError} />
          <label>
            应用名称
            <input
              autoFocus
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="给你的 Agent 起个名字"
            />
          </label>
          <label>
            应用描述
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="它将解决什么问题？"
            />
          </label>
          <footer>
            <Button onClick={() => setCreate(false)}>取消</Button>
            <Button disabled={busy || !name.trim()} variant="primary" onClick={() => void add()}>
              {busy ? '创建中…' : '创建并编排'}
            </Button>
          </footer>
        </Modal>
      )}
      {runApp && <RunStart app={runApp} onClose={() => setRunApp(null)} />}
    </main>
  );
}
export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
