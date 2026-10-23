// Agent Hub 서버: 팀원 각자의 Claude Code 세션(MCP 브리지)과 사람(웹 UI)이 같은 대화방을 공유한다.
// 의존성 없음. 실행: node server/hub.js  (환경변수 PORT, HOST, TEAM_TOKEN, TEAM_NAME, DATA_DIR)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 4300);
const HOST = process.env.HOST || '0.0.0.0';
const TEAM_TOKEN = process.env.TEAM_TOKEN || '';
const TEAM_NAME = process.env.TEAM_NAME || '';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ONLINE_MS = 90_000;
const MAX_WAIT_S = 110;

// ---------- 저장소 ----------
function emptyDb() {
  return {
    seq: 0,
    decisionSeq: 0,
    members: {},
    channels: { general: { id: 'general', topic: '전체 공지 및 조율', createdAt: Date.now() } },
    messages: [],
    decisions: {},
    cursors: {},
  };
}

function loadDb() {
  try {
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    return emptyDb();
  }
}

const db = loadDb();
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}

// ---------- 실시간 알림 ----------
const sseClients = new Set();
const waiters = new Set(); // 롱폴링 중인 inbox 요청

function broadcast(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(data);
}

function wakeWaiters() {
  for (const w of [...waiters]) w();
}

// ---------- 도메인 로직 ----------
const NAME_RE = /^[\p{L}\p{N}_.\-]{1,32}$/u;
const CHANNEL_RE = /^[\p{L}\p{N}_\-]{1,32}$/u;

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function normName(name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) throw badRequest(`잘못된 이름: "${name}" (문자/숫자/_.- 1~32자)`);
  return n;
}

function normChannel(ch) {
  const c = String(ch || 'general').trim().replace(/^#/, '').toLowerCase();
  if (!CHANNEL_RE.test(c)) throw badRequest(`잘못된 채널명: "${ch}"`);
  return c;
}

function touchMember(name, info = {}) {
  name = normName(name);
  const prev = db.members[name];
  const m = {
    name,
    kind: info.kind || prev?.kind || 'agent',
    owner: info.owner ?? prev?.owner ?? '',
    role: info.role ?? prev?.role ?? '',
    joinedAt: prev?.joinedAt || Date.now(),
    lastSeen: Date.now(),
  };
  db.members[name] = m;
  if (!prev || prev.kind !== m.kind || prev.owner !== m.owner || prev.role !== m.role
      || Date.now() - prev.lastSeen > ONLINE_MS) {
    broadcast('member', publicMember(m));
  }
  save();
  return m;
}

function publicMember(m) {
  return { ...m, online: Date.now() - m.lastSeen < ONLINE_MS };
}

function ensureChannel(id, topic) {
  if (!db.channels[id]) {
    db.channels[id] = { id, topic: topic || '', createdAt: Date.now() };
    broadcast('channel', db.channels[id]);
  }
  return db.channels[id];
}

function extractMentions(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/@([\p{L}\p{N}_.\-]{1,32})/gu)) {
    const n = m[1].replace(/[.\-]+$/, '');
    if (db.members[n] || n === 'all' || n === 'everyone') out.add(n);
  }
  return [...out];
}

function postMessage({ from, channel, text, to, replyTo, kind = 'text', decisionId, meta }) {
  if (kind === 'text' && !String(text || '').trim()) throw badRequest('text가 비었습니다');
  const ch = normChannel(channel);
  ensureChannel(ch);
  const mentions = new Set([...(Array.isArray(to) ? to : to ? [to] : []), ...extractMentions(text || '')]);
  const msg = {
    id: ++db.seq,
    ts: Date.now(),
    channel: ch,
    from,
    kind,
    text: String(text || '').slice(0, 20000),
    to: [...mentions].map(String),
    replyTo: replyTo ? Number(replyTo) : null,
    decisionId: decisionId || null,
    meta: meta || null,
  };
  db.messages.push(msg);
  save();
  broadcast('message', msg);
  wakeWaiters();
  return msg;
}

function agentMembers() {
  return Object.values(db.members).filter((m) => m.kind === 'agent');
}

function proposeDecision({ from, title, description, channel, voters, deadlineMinutes }) {
  if (!String(title || '').trim()) throw badRequest('title이 필요합니다');
  let voterList = Array.isArray(voters) && voters.length
    ? voters.map(normName)
    : agentMembers().filter((m) => publicMember(m).online || m.name === from).map((m) => m.name);
  if (!voterList.includes(from) && db.members[from]?.kind === 'agent') voterList.push(from);
  voterList = [...new Set(voterList)];
  const id = `D-${++db.decisionSeq}`;
  const d = {
    id,
    title: String(title).slice(0, 200),
    description: String(description || '').slice(0, 10000),
    proposer: from,
    channel: normChannel(channel),
    voters: voterList,
    votes: {},
    status: 'open',
    createdAt: Date.now(),
    deadline: deadlineMinutes ? Date.now() + Number(deadlineMinutes) * 60_000 : null,
    resolvedAt: null,
    resolution: '',
    resolvedBy: null,
  };
  // 제안자는 자동 찬성
  if (voterList.includes(from)) d.votes[from] = { vote: 'approve', reason: '제안자', ts: Date.now() };
  db.decisions[id] = d;
  postMessage({
    from, channel: d.channel, kind: 'decision', decisionId: id,
    text: `[결정 요청 ${id}] ${d.title}`, to: voterList.filter((v) => v !== from),
  });
  evaluateDecision(d);
  broadcast('decision', d);
  save();
  return d;
}

function evaluateDecision(d) {
  if (d.status !== 'open') return;
  const n = d.voters.length;
  const tally = { approve: 0, reject: 0, abstain: 0 };
  for (const v of Object.values(d.votes)) tally[v.vote]++;
  const voted = Object.keys(d.votes).filter((v) => d.voters.includes(v)).length;
  const expired = d.deadline && Date.now() > d.deadline;
  let status = null;
  // 투표자가 1명(제안자뿐)이면 자동 확정하지 않고 다른 참여자의 투표나 사람의 확정을 기다린다
  if (n < 2) status = expired ? 'no_consensus' : null;
  else if (tally.approve * 2 > n) status = 'approved';
  else if (tally.reject * 2 >= n) status = 'rejected';
  else if (voted >= n || expired) status = 'no_consensus';
  if (status) resolveDecision(d, status, `투표 결과 찬성 ${tally.approve} / 반대 ${tally.reject} / 기권 ${tally.abstain}`, 'hub');
}

const STATUS_KO = { approved: '승인', rejected: '반려', no_consensus: '합의 실패', withdrawn: '철회' };

function resolveDecision(d, status, resolution, by) {
  d.status = status;
  d.resolution = resolution || '';
  d.resolvedAt = Date.now();
  d.resolvedBy = by;
  postMessage({
    from: 'hub', channel: d.channel, kind: 'system', decisionId: d.id,
    text: `[${d.id} ${STATUS_KO[status] || status}] ${d.title}${resolution ? `\n${resolution}` : ''}`,
    to: [...new Set([d.proposer, ...d.voters])],
  });
  broadcast('decision', d);
  save();
}

function castVote({ from, id, vote, reason }) {
  const d = db.decisions[id];
  if (!d) throw Object.assign(new Error(`결정 ${id} 없음`), { status: 404 });
  if (d.status !== 'open') throw badRequest(`${id}는 이미 종료됨 (${d.status})`);
  if (!['approve', 'reject', 'abstain'].includes(vote)) throw badRequest('vote는 approve|reject|abstain');
  if (!d.voters.includes(from)) d.voters.push(from); // 투표권 없던 참여자도 의견 반영
  d.votes[from] = { vote, reason: String(reason || '').slice(0, 2000), ts: Date.now() };
  const label = { approve: '✅ 찬성', reject: '❌ 반대', abstain: '➖ 기권' }[vote];
  postMessage({
    from, channel: d.channel, kind: 'vote', decisionId: id,
    text: `${label} · ${id}${reason ? ` — ${reason}` : ''}`, to: [d.proposer],
  });
  evaluateDecision(d);
  broadcast('decision', d);
  save();
  return d;
}

function inboxFor(agent, { channel, limit = 50 } = {}) {
  const cursor = db.cursors[agent] || 0;
  return db.messages
    .filter((m) => m.id > cursor && m.from !== agent && (!channel || m.channel === channel))
    .slice(0, limit)
    .map((m) => ({
      ...m,
      mentioned: m.to.includes(agent) || m.to.includes('all') || m.to.includes('everyone'),
    }));
}

function checkDeadlines() {
  for (const d of Object.values(db.decisions)) if (d.status === 'open' && d.deadline) evaluateDecision(d);
}
setInterval(checkDeadlines, 30_000).unref();

// ---------- HTTP ----------
function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw badRequest('요청이 너무 큽니다');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw badRequest('JSON 파싱 실패'); }
}

function authorized(req, url) {
  if (!TEAM_TOKEN) return true;
  return req.headers['x-hub-token'] === TEAM_TOKEN || url.searchParams.get('token') === TEAM_TOKEN;
}

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
};

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
}

route('GET', '/api/health', () => ({ ok: true, name: 'agent-hub', time: Date.now() }));

route('GET', '/api/state', () => ({
  members: Object.values(db.members).map(publicMember),
  channels: Object.values(db.channels),
  decisions: Object.values(db.decisions),
  lastId: db.seq,
  team: TEAM_NAME,
}));

route('GET', '/api/messages', ({ url }) => {
  const channel = url.searchParams.get('channel');
  const before = Number(url.searchParams.get('before') || Infinity);
  const after = Number(url.searchParams.get('after') || 0);
  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
  let list = db.messages.filter((m) => m.id > after && m.id < before && (!channel || m.channel === normChannel(channel)));
  return { messages: list.slice(-limit) };
});

route('POST', '/api/messages', ({ body }) => {
  const from = normName(body.from);
  touchMember(from, body.kind === 'human' || body.human ? { kind: 'human' } : {});
  return { message: postMessage({ from, channel: body.channel, text: body.text, to: body.to, replyTo: body.replyTo }) };
});

route('POST', '/api/members/heartbeat', ({ body }) => {
  const m = touchMember(body.name, { kind: body.kind, owner: body.owner, role: body.role });
  if (body.kind !== 'human' && db.cursors[m.name] === undefined) db.cursors[m.name] = 0;
  return { member: publicMember(m) };
});

route('GET', '/api/members', () => ({ members: Object.values(db.members).map(publicMember) }));

route('POST', '/api/channels', ({ body }) => ({ channel: ensureChannel(normChannel(body.id || body.name), body.topic) }));

route('GET', '/api/inbox', async ({ url, req }) => {
  const agent = normName(url.searchParams.get('agent'));
  const peek = url.searchParams.get('peek') === '1';
  const channel = url.searchParams.get('channel') ? normChannel(url.searchParams.get('channel')) : null;
  const wait = Math.min(Number(url.searchParams.get('wait') || 0), MAX_WAIT_S);
  if (!peek) touchMember(agent);
  let items = inboxFor(agent, { channel });
  if (!items.length && wait > 0) {
    items = await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        waiters.delete(check);
        clearTimeout(timer);
        resolve(inboxFor(agent, { channel }));
      };
      const check = () => { if (inboxFor(agent, { channel }).length) finish(); };
      const timer = setTimeout(finish, wait * 1000);
      waiters.add(check);
      req.on('close', finish);
    });
  }
  if (!peek && items.length) {
    db.cursors[agent] = items[items.length - 1].id;
    save();
  }
  const openForMe = Object.values(db.decisions)
    .filter((d) => d.status === 'open' && !d.votes[agent])
    .map((d) => ({ id: d.id, title: d.title, proposer: d.proposer, required: d.voters.includes(agent) }));
  return { messages: items, pendingVotes: openForMe, remaining: inboxFor(agent, { channel }).length };
});

route('GET', '/api/decisions', ({ url }) => {
  const status = url.searchParams.get('status');
  return { decisions: Object.values(db.decisions).filter((d) => !status || d.status === status) };
});

route('GET', '/api/decisions/:id', ({ params }) => {
  const d = db.decisions[params.id];
  if (!d) throw Object.assign(new Error('없음'), { status: 404 });
  return { decision: d };
});

route('POST', '/api/decisions', ({ body }) => {
  const from = normName(body.from);
  touchMember(from, body.human ? { kind: 'human' } : {});
  return { decision: proposeDecision({ ...body, from }) };
});

route('POST', '/api/decisions/:id/vote', ({ body, params }) => {
  const from = normName(body.from);
  touchMember(from, body.human ? { kind: 'human' } : {});
  return { decision: castVote({ from, id: params.id, vote: body.vote, reason: body.reason }) };
});

route('POST', '/api/decisions/:id/resolve', ({ body, params }) => {
  const from = normName(body.from);
  const d = db.decisions[params.id];
  if (!d) throw Object.assign(new Error('없음'), { status: 404 });
  if (d.status !== 'open') throw badRequest(`${d.id}는 이미 종료됨`);
  const status = body.status;
  if (!['approved', 'rejected', 'withdrawn'].includes(status)) throw badRequest('status는 approved|rejected|withdrawn');
  const member = touchMember(from, body.human ? { kind: 'human' } : {});
  if (status === 'withdrawn' && from !== d.proposer && member.kind !== 'human') {
    throw badRequest('철회는 제안자나 사람만 할 수 있습니다');
  }
  if (status !== 'withdrawn' && member.kind !== 'human') {
    throw badRequest('강제 승인/반려는 사람(UI)만 할 수 있습니다. 에이전트는 투표하세요.');
  }
  resolveDecision(d, status, body.resolution || `${from}님이 직접 ${STATUS_KO[status]}`, from);
  return { decision: d };
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'access-control-allow-headers': 'content-type, x-hub-token',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
  }

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return send(res, 200, fs.readFileSync(path.join(__dirname, file)), { 'content-type': type });
  }
  // 팀원이 브리지 파일을 바로 내려받을 수 있게 제공
  if (req.method === 'GET' && (url.pathname === '/bridge.js' || url.pathname === '/inbox-hook.js')) {
    const file = url.pathname === '/bridge.js' ? 'mcp-bridge.js' : 'inbox-hook.js';
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'bridge', file)), { 'content-type': 'text/javascript; charset=utf-8' });
  }

  if (!url.pathname.startsWith('/api/')) return send(res, 404, 'not found');
  if (!authorized(req, url)) return send(res, 401, { error: 'TEAM_TOKEN이 필요합니다' });

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await r.handler({ req, res, url, params, body });
      if (!res.writableEnded) send(res, 200, result);
    } catch (err) {
      if (!res.writableEnded) send(res, err.status || 500, { error: err.message });
    }
    return;
  }
  send(res, 404, { error: 'unknown endpoint' });
});

// 접속 상태 변화(온라인→오프라인)를 UI에 반영
setInterval(() => broadcast('members', Object.values(db.members).map(publicMember)), 30_000).unref();

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`Agent Hub 실행 중 → http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  팀원 접속 주소: http://${ip}:${PORT}`);
  console.log(TEAM_TOKEN ? '  TEAM_TOKEN 인증 사용 중' : '  ⚠ TEAM_TOKEN 미설정 (같은 네트워크 누구나 접근 가능)');
});

export { server };
