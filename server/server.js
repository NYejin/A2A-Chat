// A2A 뷰어 서버: GitHub 이슈(라벨 a2a)를 주기적으로 읽어 대화 형식으로 보여주고, claude -p 로 요약한다.
// 읽기 전용 — GitHub에 아무것도 쓰지 않는다. 의존성 없음.
//
// 환경변수
//   A2A_REPO        owner/name (없으면 .a2a.json 의 repo)
//   GITHUB_TOKEN    없으면 `gh auth token` 사용 (공개 저장소는 토큰 없이도 되지만 시간당 60회 제한)
//   PORT=4300  HOST=0.0.0.0  POLL_SECONDS=30
//   SUMMARY=claude|off (기본: claude 명령이 있으면 claude)   SUMMARY_MODEL=haiku   SUMMARY_DELAY_SECONDS=60
//   DATA_DIR=./data  (요약 캐시)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '../lib/github.js';
import { loadConfig } from '../lib/config.js';
import { buildThread, transcript } from '../lib/thread.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const cfg = loadConfig();
const REPO = cfg.repo;
if (!REPO) {
  console.error('저장소를 지정하세요: A2A_REPO=owner/name npm start  (또는 .a2a.json 의 repo)');
  process.exit(1);
}
const gh = createClient();
const PORT = Number(process.env.PORT || 4300);
const HOST = process.env.HOST || '0.0.0.0';
const POLL_MS = Number(process.env.POLL_SECONDS || (gh.hasToken ? 30 : 120)) * 1000;
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'haiku';
const SUMMARY_DELAY_MS = Number(process.env.SUMMARY_DELAY_SECONDS || 60) * 1000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CACHE_FILE = path.join(DATA_DIR, `summaries-${REPO.replace('/', '__')}.json`);

// ---------- 상태 ----------
const threads = new Map(); // number → thread
let team = cfg.team;
let lastSync = null, lastError = null;
const cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return { threads: {}, digest: null }; } })();
function saveCache() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

// ---------- 실시간 ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- GitHub 동기화 ----------
async function loadTeam() {
  try {
    const f = await gh.get(`repos/${REPO}/contents/.a2a.json`);
    const json = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8'));
    if (Array.isArray(json.team)) team = json.team;
  } catch { /* 저장소에 .a2a.json 이 없으면 로컬 설정 사용 */ }
}

let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    await loadTeam();
    const issues = await gh.all(`repos/${REPO}/issues?labels=${encodeURIComponent(cfg.label)}&state=all&sort=updated&direction=desc&per_page=100`, 3);
    const changed = [];
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const prev = threads.get(issue.number);
      if (prev && prev.updatedAt === issue.updated_at) continue;
      const timeline = await gh.all(`repos/${REPO}/issues/${issue.number}/timeline?per_page=100`, 5);
      threads.set(issue.number, buildThread(issue, timeline));
      changed.push(issue.number);
    }
    lastSync = new Date().toISOString();
    lastError = null;
    if (changed.length) broadcast('update', { changed });
    else broadcast('sync', { lastSync });
    scheduleSummaries();
  } catch (e) {
    lastError = e.message;
    console.error('동기화 실패:', e.message);
    broadcast('sync', { lastSync, error: lastError });
  } finally {
    syncing = false;
  }
}

// ---------- 요약 (claude -p) ----------
let summaryMode = process.env.SUMMARY || 'claude';
const queue = [];
let running = false;

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--model', SUMMARY_MODEL, '--tools', '', '--strict-mcp-config', '--no-session-persistence'], {
      cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('요약 시간 초과')); }, 120_000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `claude 종료 코드 ${code}`));
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return reject(new Error('요약 결과에 JSON 없음'));
      try { resolve(JSON.parse(m[0])); } catch (e) { reject(e); }
    });
    p.stdin.end(prompt);
  });
}

const THREAD_PROMPT = (t) => `다음은 GitHub 이슈에서 여러 팀원의 Claude 에이전트와 사람이 나눈 대화다.
바쁜 사람 팀장이 10초 안에 파악할 수 있게 한국어로 요약해라. 반드시 아래 JSON 하나만 출력하고 다른 말은 하지 마라.
{"summary":"무슨 이야기인지와 현재 상황 2~3문장","agreed":["합의/확정된 사항 (없으면 빈 배열)"],"open":["아직 안 정해진 것·남은 질문 (없으면 빈 배열)"],"human":"사람의 판단이 필요한 내용 한 문장, 없으면 빈 문자열"}

--- 대화 ---
${transcript(t)}`;

const DIGEST_PROMPT = (items) => `다음은 팀원들의 Claude 에이전트가 GitHub 이슈로 나누고 있는 대화들의 요약이다.
사람 팀장에게 지금 상황을 브리핑해라. 한국어, 반드시 아래 JSON 하나만 출력.
{"headline":"전체 상황 한 문장","bullets":["중요한 순서로 최대 5개, 각 한 문장. 이슈 번호를 #12 처럼 포함"]}

--- 대화 목록 ---
${items.map((t) => `#${t.number} [${t.status}] ${t.title}\n${cache.threads[t.number]?.summary || t.last?.text || ''}`).join('\n\n')}`;

function scheduleSummaries() {
  if (summaryMode === 'off') return;
  const now = Date.now();
  const recent = now - 14 * 864e5;
  for (const t of threads.values()) {
    const c = cache.threads[t.number];
    if (c?.key === t.updatedAt || queue.some((q) => q.number === t.number)) continue;
    if (new Date(t.updatedAt).getTime() < recent && t.state === 'closed') continue;
    if (t.state === 'open' && now - new Date(t.updatedAt).getTime() < SUMMARY_DELAY_MS) continue; // 대화가 잠잠해지면 요약
    queue.push({ number: t.number });
  }
  pump();
}

let digestDirty = false;
async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length && summaryMode !== 'off') {
      const { number } = queue.shift();
      const t = threads.get(number);
      if (!t) continue;
      try {
        const s = await runClaude(THREAD_PROMPT(t));
        cache.threads[number] = {
          key: t.updatedAt, at: new Date().toISOString(),
          summary: String(s.summary || ''), agreed: arr(s.agreed), open: arr(s.open), human: String(s.human || ''),
        };
        saveCache();
        digestDirty = true;
        broadcast('summary', { number });
      } catch (e) {
        if (e.code === 'ENOENT') {
          summaryMode = 'off';
          console.error('claude 명령을 찾을 수 없어 요약을 끕니다 (SUMMARY=off).');
        } else console.error(`#${number} 요약 실패:`, e.message);
      }
    }
    if (digestDirty && summaryMode !== 'off') {
      digestDirty = false;
      const active = [...threads.values()].filter((t) => t.state === 'open' || Date.now() - new Date(t.updatedAt) < 2 * 864e5)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 25);
      if (active.length) {
        try {
          const d = await runClaude(DIGEST_PROMPT(active));
          cache.digest = { headline: String(d.headline || ''), bullets: arr(d.bullets), at: new Date().toISOString() };
          saveCache();
          broadcast('summary', { digest: true });
        } catch (e) { console.error('브리핑 생성 실패:', e.message); }
      }
    }
  } finally {
    running = false;
  }
}
const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

// ---------- HTTP ----------
function overview() {
  const list = [...threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ messages, ...t }) => ({ ...t, summary: cache.threads[t.number] || null }));
  return { repo: REPO, team, threads: list, digest: cache.digest, lastSync, error: lastError, summaryMode, pollSeconds: POLL_MS / 1000 };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/overview') return send(res, 200, overview());
    const m = url.pathname.match(/^\/api\/threads\/(\d+)$/);
    if (m) {
      const t = threads.get(Number(m[1]));
      return t ? send(res, 200, { ...t, summary: cache.threads[t.number] || null, team }) : send(res, 404, { error: '없는 대화' });
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') { await sync(); return send(res, 200, { ok: true, lastSync }); }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, async () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i?.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`A2A 뷰어 → http://localhost:${PORT}  (저장소 ${REPO}, ${POLL_MS / 1000}초마다 동기화, 요약 ${summaryMode})`);
  for (const ip of lan) console.log(`  같은 네트워크에서: http://${ip}:${PORT}`);
  if (!gh.hasToken) console.log('  ⚠ GitHub 토큰 없음 — 공개 저장소만, 시간당 60회 제한');
  await sync();
  setInterval(sync, POLL_MS).unref?.();
  setInterval(scheduleSummaries, 30_000).unref?.();
});

export { server, sync, threads };
