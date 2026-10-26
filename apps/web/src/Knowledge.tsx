import { useState } from 'react';
import { BookOpen, Plus, Upload, Search, FileText, RotateCw, Layers, ChevronRight } from 'lucide-react';
import { useResource } from './hooks';
import { api, post } from './api';
import { Button, Empty, ErrorBox, Loading, Modal, Status } from './components';
import type { Citation } from '@agentloom/protocol';
interface KB {
  id: string;
  name: string;
}
interface Doc {
  id: string;
  name: string;
  status: string;
  error: string | null;
  chunks: number;
  indexVersion: string;
}
interface Chunk {
  chunkId: string;
  text: string;
  page: number | null;
  ordinal: number;
  indexVersion: string;
}
export function KnowledgePage() {
  const { data: kbs, error, reload } = useResource<KB[]>('/knowledge'),
    [selected, setSelected] = useState(''),
    [create, setCreate] = useState(false),
    [name, setName] = useState(''),
    [actionError, setError] = useState('');
  const id = selected || kbs?.[0]?.id;
  async function add() {
    try {
      const k = await post<KB>('/knowledge', { name });
      setSelected(k.id);
      setCreate(false);
      setName('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">KNOWLEDGE</div>
          <h1>知识库</h1>
          <p>把资料变成可检索、可引用的知识。</p>
        </div>
        <Button variant="primary" onClick={() => setCreate(true)}>
          <Plus size={16} />
          新建知识库
        </Button>
      </div>
      <ErrorBox error={error || actionError} />
      <div className="knowledge-layout">
        <aside className="kb-list">
          <div className="panel-label">所有知识库</div>
          {kbs?.map((k) => (
            <button className={k.id === id ? 'active' : ''} onClick={() => setSelected(k.id)} key={k.id}>
              <BookOpen size={16} />
              <span>
                {k.name}
                <small>{k.id}</small>
              </span>
              <ChevronRight size={13} />
            </button>
          ))}
        </aside>
        {id ? (
          <KnowledgeDetail key={id} id={id} />
        ) : (
          <Empty title="还没有知识库" description="创建后即可上传资料。" />
        )}
      </div>
      {create && (
        <Modal title="新建知识库" onClose={() => setCreate(false)}>
          <label>
            名称
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：产品需求资料"
            />
          </label>
          <footer>
            <Button onClick={() => setCreate(false)}>取消</Button>
            <Button disabled={!name.trim()} variant="primary" onClick={() => void add()}>
              创建
            </Button>
          </footer>
        </Modal>
      )}
    </main>
  );
}
function KnowledgeDetail({ id }: { id: string }) {
  const { data: docs, error, loading, reload } = useResource<Doc[]>(`/knowledge/${id}/documents`, 2000),
    [tab, setTab] = useState('files'),
    [query, setQuery] = useState(''),
    [hits, setHits] = useState<Citation[] | null>(null),
    [selectedChunks, setChunks] = useState<Chunk[] | null>(null),
    [selectedName, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [actionError, setError] = useState('');
  async function upload(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    try {
      for (const f of files) {
        const form = new FormData();
        form.append('file', f);
        await api(`/knowledge/${id}/documents`, { method: 'POST', body: form });
      }
      await reload();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function search() {
    setBusy(true);
    try {
      const r = await post<{ hits: Citation[] }>(`/knowledge/${id}/search`, { query, k: 3 });
      setHits(r.hits);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function chunks(d: Doc) {
    try {
      setChunks(await api<Chunk[]>(`/documents/${d.id}/chunks`));
      setName(d.name);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="knowledge-detail">
      <div className="trace-tabs">
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
          <FileText size={15} />
          文件与分块
        </button>
        <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
          <Search size={15} />
          检索测试
        </button>
      </div>
      <ErrorBox error={error || actionError} />
      {tab === 'files' ? (
        <>
          <label className={`upload-zone ${busy ? 'disabled' : ''}`}>
            <Upload size={27} />
            <strong>{busy ? '正在上传…' : '上传知识文件'}</strong>
            <span>TXT、Markdown、可提取文本的 PDF · 最大 10 MiB</span>
            <small>暂不支持扫描件 OCR。资料将由 worker 异步索引。</small>
            <input
              aria-label="上传知识文件"
              type="file"
              accept=".txt,.md,.markdown,.pdf"
              multiple
              disabled={busy}
              onChange={(e) => void upload(e.target.files)}
            />
          </label>
          {loading ? (
            <Loading />
          ) : docs?.length ? (
            <div className="document-list">
              {docs.map((d) => (
                <article key={d.id}>
                  <span className="file-icon">
                    <FileText size={20} />
                  </span>
                  <div className="document-name">
                    <strong>{d.name}</strong>
                    <small>
                      {d.chunks} 个分块 · {d.indexVersion || '尚未索引'}
                    </small>
                    {d.error && <p className="red">{d.error}</p>}
                  </div>
                  <Status value={d.status} />
                  <button className="btn" onClick={() => void chunks(d)}>
                    <Layers size={13} />
                    分块
                  </button>
                  <button
                    aria-label={`重新索引 ${d.name}`}
                    title="切换 Embedding 后重新索引"
                    className="icon-btn"
                    disabled={['queued', 'indexing'].includes(d.status)}
                    onClick={() =>
                      void post(`/documents/${d.id}/reindex`)
                        .then(reload)
                        .catch((e) => setError(e.message))
                    }
                  >
                    <RotateCw size={15} />
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <Empty title="添加第一份资料" description="索引完成后，工作流即可通过此知识库 ID 检索。" />
          )}
        </>
      ) : (
        <div className="search-test">
          <h3>测试检索结果</h3>
          <p className="muted">使用当前 Embedding 配置返回最相关的 3 个分块。切换模型后请重新索引。</p>
          <div className="search-input">
            <Search size={17} />
            <input
              aria-label="检索问题"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query.trim()) void search();
              }}
              placeholder="例如：人工审批如何在重启后恢复？"
            />
            <Button variant="primary" disabled={busy || !query.trim()} onClick={() => void search()}>
              {busy ? '检索中…' : '检索'}
            </Button>
          </div>
          {hits === null ? (
            <Empty title="输入一个问题" description="查看原文、来源位置和相似度分数。" />
          ) : hits.length ? (
            hits.map((h, i) => (
              <article className="hit-card" key={h.chunkId}>
                <header>
                  <span className="rank">{i + 1}</span>
                  <strong>{h.file}</strong>
                  <span className="score">相似度 {h.score.toFixed(3)}</span>
                </header>
                <p>{h.text}</p>
                <footer>
                  <code>{h.chunkId}</code>
                  <span>{h.page ? `第 ${h.page} 页` : `第 ${h.ordinal + 1} 块`}</span>
                </footer>
              </article>
            ))
          ) : (
            <Empty
              title="没有匹配分块"
              description="请确认文件已完成索引，且索引版本与当前 Embedding 配置一致。"
            />
          )}
        </div>
      )}
      {selectedChunks && (
        <Modal title={`${selectedName} · 分块`} onClose={() => setChunks(null)}>
          <div className="chunk-modal">
            {selectedChunks.length ? (
              selectedChunks.map((c) => (
                <article className="hit-card" key={c.chunkId}>
                  <header>
                    <strong>第 {c.ordinal + 1} 块</strong>
                    <code>{c.chunkId}</code>
                  </header>
                  <p>{c.text}</p>
                  <small>
                    {c.page ? `第 ${c.page} 页` : '文本段落'} · {c.indexVersion}
                  </small>
                </article>
              ))
            ) : (
              <Empty title="尚无分块" description="请等待索引完成，或检查失败原因。" />
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
