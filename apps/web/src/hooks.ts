import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useTrace } from './store';
import type { RunEvent } from '@agentloom/protocol';
export function useResource<T>(path: string, interval = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(true);
    setData(null);
    void reload();
    if (interval) {
      const t = setInterval(reload, interval);
      return () => clearInterval(t);
    }
  }, [reload, interval]);
  return { data, error, loading, reload };
}
export function useRunStream(id: string | null) {
  const [connection, setConnection] = useState('连接中');
  useEffect(() => {
    if (!id) return;
    if (useTrace.getState().runId !== id) useTrace.getState().reset(id);
    let batch: RunEvent[] = [],
      closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (batch.length) {
        useTrace.getState().ingest(batch);
        batch = [];
      }
      timer = undefined;
    };
    let source: EventSource;
    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/runs/${id}/stream?after=${useTrace.getState().cursor}`);
      source.onopen = () => setConnection('实时连接');
      source.addEventListener('settled', () => {
        flush();
        source.close();
        setConnection('已同步');
      });
      source.onmessage = (m) => {
        const e = JSON.parse(m.data) as RunEvent;
        batch.push(e);
        if (!timer) timer = setTimeout(flush, 70);
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(e.type)) {
          flush();
          source.close();
          setConnection('已同步');
        }
      };
      source.onerror = () => {
        source.close();
        flush();
        setConnection('断线重连中');
        if (!closed) timer = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (timer) clearTimeout(timer);
      flush();
    };
  }, [id]);
  return connection;
}
