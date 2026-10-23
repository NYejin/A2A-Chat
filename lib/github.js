// 최소 GitHub REST 클라이언트. 토큰은 GITHUB_TOKEN/GH_TOKEN 또는 `gh auth token`에서 가져온다.
import { execFileSync } from 'node:child_process';

export function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function createClient({ token = resolveToken(), apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com' } = {}) {
  const base = apiUrl.replace(/\/$/, '');

  async function request(method, path, body) {
    const url = path.startsWith('http') ? path : `${base}/${path.replace(/^\//, '')}`;
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'a2a-chat',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} → ${res.status}: ${data?.message || text}`);
      err.status = res.status;
      throw err;
    }
    return { data, res };
  }

  return {
    hasToken: Boolean(token),
    get: async (path) => (await request('GET', path)).data,
    post: async (path, body) => (await request('POST', path, body)).data,
    patch: async (path, body) => (await request('PATCH', path, body)).data,
    put: async (path, body) => (await request('PUT', path, body)).data,
    // Link 헤더를 따라 모든 페이지를 모은다 (max 페이지 제한)
    async all(path, maxPages = 10) {
      let next = path, out = [], pages = 0;
      while (next && pages++ < maxPages) {
        const { data, res } = await request('GET', next);
        out = out.concat(data);
        next = (res.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
      }
      return out;
    },
    async rateLimit() {
      try { return (await request('GET', 'rate_limit')).data.resources.core; } catch { return null; }
    },
  };
}
