export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const data = await response.json();
      message = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* non-json proxy error */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
