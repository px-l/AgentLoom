import { useEffect, useState } from 'react';
import { Save, PlugZap, ShieldCheck, Info } from 'lucide-react';
import { useResource } from './hooks';
import { api, post } from './api';
import { Button, ErrorBox, Loading, Json } from './components';
interface Config {
  model_mode: string;
  model_base_url: string;
  model_name: string;
  embedding_mode: string;
  embedding_base_url: string;
  embedding_model: string;
  embedding_dimensions: number;
  max_run_seconds: number;
  max_agent_steps: number;
  max_tool_calls: number;
  max_model_tokens: number;
  model_key_configured: boolean;
  embedding_key_configured: boolean;
  [key: string]: string | number | boolean;
}
export function SettingsPage() {
  const { data, error, loading } = useResource<Config>('/settings'),
    [form, setForm] = useState<Config | null>(null),
    [message, setMessage] = useState(''),
    [actionError, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<unknown>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  async function save() {
    setBusy(true);
    try {
      setForm(await api<Config>('/settings', { method: 'PUT', body: JSON.stringify(form) }));
      setMessage('配置已保存，新执行将使用此配置快照。');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function test(kind: string) {
    setBusy(true);
    try {
      setResult(await post(`/settings/test/${kind}`));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Loading />;
  if (!form) return <ErrorBox error={error} />;
  const input = (key: string, label: string, numeric = false) => (
    <label key={key}>
      {label}
      <input
        type={numeric ? 'number' : 'text'}
        value={String(form[key])}
        onChange={(e) => setForm({ ...form, [key]: numeric ? Number(e.target.value) : e.target.value })}
      />
    </label>
  );
  return (
    <main className="page settings-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CONFIGURATION</div>
          <h1>平台设置</h1>
          <p>模型与 Embedding 独立配置，凭据仅保留在后端。</p>
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          <Save size={15} />
          保存配置
        </Button>
      </div>
      <ErrorBox error={error || actionError} />
      {message && <div className="success-banner">{message}</div>}
      <div className="settings-grid">
        {['model', 'embedding'].map((kind) => (
          <section className="settings-card" key={kind}>
            <div className="section-title">
              <h3>{kind === 'model' ? '语言模型' : 'Embedding 模型'}</h3>
              <span className="tag">OpenAI 兼容接口</span>
            </div>
            <label>
              运行模式
              <select
                value={String(form[`${kind}_mode`])}
                onChange={(e) => setForm({ ...form, [`${kind}_mode`]: e.target.value })}
              >
                <option value="demo">演示替身（无需凭据）</option>
                <option value="openai">真实接口</option>
              </select>
            </label>
            {input(`${kind}_base_url`, '接口 Base URL')}
            {input(kind === 'model' ? 'model_name' : 'embedding_model', '模型名称')}
            {kind === 'embedding' && input('embedding_dimensions', '向量维度', true)}
            <div className="credential-state">
              <ShieldCheck size={16} />
              {form[`${kind}_key_configured`] ? '后端已配置凭据' : '后端尚未配置凭据'}
              <small>{kind === 'model' ? 'MODEL_API_KEY' : 'EMBEDDING_API_KEY'}</small>
            </div>
            <Button disabled={busy} onClick={() => void test(kind)}>
              <PlugZap size={14} />
              测试已保存配置
            </Button>
          </section>
        ))}
      </div>
      <section className="settings-card">
        <h3>执行限制</h3>
        <div className="limits">
          {input('max_run_seconds', '累计节点执行时间 / 秒', true)}
          {input('max_agent_steps', 'Agent 最大步骤', true)}
          {input('max_tool_calls', '单 Agent 工具调用上限', true)}
          {input('max_model_tokens', '单次模型输出 Token 上限', true)}
        </div>
      </section>
      <div className="info-note">
        <Info size={18} />
        <p>
          真实模式需在根目录 .env 配置密钥并重启 API 与 worker。切换 Embedding 后需要重新索引资料。演示
          Embedding
          是确定性字符特征替身，不代表真实语义检索能力。此版本面向本地单用户，未实现登录认证，请仅在本机使用。
        </p>
      </div>
      {result !== null && (
        <section className="settings-card">
          <h3>连接测试结果</h3>
          <Json value={result} />
        </section>
      )}
    </main>
  );
}
