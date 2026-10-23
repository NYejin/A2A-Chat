// 종단 테스트: 가짜 GitHub API 위에서 a2a CLI(두 Claude 역할)와 뷰어 서버를 함께 검증한다.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseBody, formatBody, tally } from '../lib/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

// ---------- 1. 프로토콜 단위 테스트 ----------
{
  const body = formatBody({ agent: 'a-claude', role: '백엔드', to: ['b-claude'], kind: 'msg' }, '안녕\n둘째 줄');
  assert.match(body, /^<!-- a2a \{.*\} -->\n\*\*🤖 a-claude\*\* \(백엔드\) → `b-claude`\n\n안녕/);
  const p = parseBody(body);
  assert.equal(p.meta.agent, 'a-claude');
  assert.deepEqual(p.meta.to, ['b-claude']);
  assert.equal(p.text, '안녕\n둘째 줄');
  assert.equal(parseBody('그냥 사람 댓글').meta, null);
  assert.equal(parseBody('<!-- a2a {깨진json} -->\n본문').meta, null);

  assert.equal(tally(['a', 'b', 'c'], [{ agent: 'a', vote: 'approve' }, { agent: 'b', vote: 'approve' }]).status, 'approved');
  assert.equal(tally(['a', 'b'], [{ agent: 'a', vote: 'approve' }]).status, null);
  assert.equal(tally(['a', 'b'], [{ agent: 'a', vote: 'approve' }, { agent: 'b', vote: 'reject' }]).status, 'rejected');
  assert.equal(tally(['a', 'b', 'c'], [{ agent: 'a', vote: 'approve' }, { agent: 'b', vote: 'reject' }, { agent: 'c', vote: 'abstain' }]).status, 'no_consensus');
  assert.equal(tally(['a'], [{ agent: 'a', vote: 'approve' }]).status, null, '투표자 1명이면 자동 확정 안 함');
  assert.equal(tally(['a', 'b', 'c'], [{ agent: 'a', vote: 'reject' }, { agent: 'a', vote: 'approve' }, { agent: 'b', vote: 'approve' }]).status, 'approved', '마지막 표만 반영');
}

// ---------- 2. 가짜 GitHub ----------
const REPO = 'team/proj';
let clock = Date.parse('2026-10-23T05:00:00Z');
const now = () => new Date((clock += 1000)).toISOString();
const users = { 'tok-alice': 'alice', 'tok-bob': 'bob', 'tok-human': 'boss' };
const db = { issues: [], comments: [], events: [], labels: new Set(), seq: 0 };
const user = (login) => ({ login, avatar_url: `https://avatars.example/${login}?v=4` });
const roster = { repo: REPO, team: [
  { agent: 'alice-claude', owner: '앨리스', github: 'alice', role: '프론트엔드' },
  { agent: 'bob-claude', owner: '밥', github: 'bob', role: '백엔드' },
] };

function issueJson(i) {
  return { ...i, labels: i.labels.map((name) => ({ name })), comments: db.comments.filter((c) => c.issue === i.number).length, html_url: `https://github.com/${REPO}/issues/${i.number}` };
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const login = users[(req.headers.authorization || '').replace('Bearer ', '')];
  let body = '';
  for await (const c of req) body += c;
  body = body ? JSON.parse(body) : null;
  const ok = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const p = url.pathname.replace(`/repos/${REPO}`, '');
  let m;
  if (url.pathname === '/user') return ok(user(login));
  if (p === '/contents/.a2a.json') return ok({ content: Buffer.from(JSON.stringify(roster)).toString('base64') });
  if (p === '/labels' && req.method === 'POST') { if (db.labels.has(body.name)) return ok({ message: 'exists' }, 422); db.labels.add(body.name); return ok(body, 201); }
  if (p === '/issues' && req.method === 'POST') {
    const t = now();
    const i = { number: ++db.seq, title: body.title, body: body.body, labels: body.labels || [], state: 'open', user: user(login), created_at: t, updated_at: t, closed_at: null };
    db.issues.push(i);
    return ok(issueJson(i), 201);
  }
  if (p === '/issues' && req.method === 'GET') {
    const labels = (url.searchParams.get('labels') || '').split(',').filter(Boolean);
    const state = url.searchParams.get('state') || 'open';
    const since = url.searchParams.get('since');
    const list = db.issues.filter((i) => labels.every((l) => i.labels.includes(l)) && (state === 'all' || i.state === state) && (!since || i.updated_at >= since));
    return ok(list.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(issueJson));
  }
  if ((m = p.match(/^\/issues\/(\d+)$/))) {
    const i = db.issues.find((x) => x.number === Number(m[1]));
    if (!i) return ok({ message: 'Not Found' }, 404);
    if (req.method === 'PATCH') {
      if (body.state === 'closed' && i.state !== 'closed') { i.state = 'closed'; i.closed_at = now(); db.events.push({ issue: i.number, event: 'closed', actor: user(login), created_at: i.closed_at, state_reason: body.state_reason, id: db.events.length + 1 }); }
      i.updated_at = now();
    }
    return ok(issueJson(i));
  }
  if ((m = p.match(/^\/issues\/(\d+)\/comments$/))) {
    const n = Number(m[1]);
    const i = db.issues.find((x) => x.number === n);
    if (req.method === 'POST') {
      const c = { id: db.comments.length + 100, issue: n, body: body.body, user: user(login), created_at: now(), html_url: `https://github.com/${REPO}/issues/${n}#c` };
      c.updated_at = c.created_at;
      db.comments.push(c);
      i.updated_at = c.created_at;
      return ok(c, 201);
    }
    const since = url.searchParams.get('since');
    return ok(db.comments.filter((c) => c.issue === n && (!since || c.updated_at >= since)));
  }
  if ((m = p.match(/^\/issues\/(\d+)\/labels$/))) {
    const i = db.issues.find((x) => x.number === Number(m[1]));
    for (const l of body.labels) if (!i.labels.includes(l)) { i.labels.push(l); db.events.push({ issue: i.number, event: 'labeled', label: { name: l }, actor: user(login), created_at: now(), id: db.events.length + 1 }); }
    i.updated_at = now();
    return ok(i.labels.map((name) => ({ name })));
  }
  if ((m = p.match(/^\/issues\/(\d+)\/timeline$/))) {
    const n = Number(m[1]);
    const items = [
      ...db.comments.filter((c) => c.issue === n).map((c) => ({ ...c, event: 'commented', actor: c.user })),
      ...db.events.filter((e) => e.issue === n),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return ok(items);
  }
  ok({ message: `fake: ${req.method} ${url.pathname}` }, 404);
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${fake.address().port}`;

// ---------- 3. CLI ----------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-test-'));
fs.writeFileSync(path.join(HOME, '.a2a.json'), JSON.stringify(roster));
async function a2a(who, ...args) {
  const env = { ...process.env, GITHUB_API_URL: API, GITHUB_TOKEN: `tok-${who}`, HOME, USERPROFILE: HOME, A2A_NAME: '', A2A_REPO: '' };
  delete env.A2A_NAME;
  const { stdout } = await run(process.execPath, [path.join(ROOT, 'bin/a2a.js'), ...args], { env, cwd: HOME });
  return stdout;
}

let viewer;
try {
  assert.match(await a2a('alice', 'whoami'), /에이전트: alice-claude \(프론트엔드\)/);
  assert.match(await a2a('alice', 'init'), /라벨 준비 완료/);
  assert.ok(db.labels.has('a2a') && db.labels.has('decision'));

  // 일반 대화
  assert.match(await a2a('alice', 'new', '로그인 응답 포맷', '--to', 'bob-claude', '--body', '토큰 필드명 뭐로 할까요?'), /대화 시작: #1/);
  let out = await a2a('bob', 'inbox');
  assert.match(out, /★ #1 로그인 응답 포맷\n  alice-claude\(프론트엔드\) → bob-claude/);
  assert.match(await a2a('bob', 'inbox'), /새 소식 없음/, '읽은 건 다시 안 나옴');
  await a2a('bob', 'say', '1', 'accessToken 으로 갑시다', '--to', 'alice-claude');
  assert.match(await a2a('alice', 'inbox', '--peek'), /★ #1[\s\S]*bob-claude\(백엔드\) → alice-claude[\s\S]*accessToken/);
  assert.match(await a2a('alice', 'inbox', '--peek'), /accessToken/, 'peek은 읽음 처리 안 함');

  // 사람 확인 요청 → 사람 답변
  await a2a('alice', 'ask', '1', '만료 시간은 사람이 정해주세요');
  assert.match(await a2a('bob', 'inbox'), /사람 답변 대기 중인 질문: #1/);

  // 결정 → 투표 → 자동 승인
  assert.match(await a2a('alice', 'decide', 'API 키는 camelCase', '--body', '전부 camelCase로'), /결정 안건 등록: #2[\s\S]*투표자: alice-claude, bob-claude/);
  out = await a2a('bob', 'inbox');
  assert.match(out, /투표 대기[\s\S]*#2 \[결정\] API 키는 camelCase/);
  out = await a2a('bob', 'vote', '2', 'approve', '프론트와 맞춤');
  assert.match(out, /찬성 2 \/ 반대 0[\s\S]*승인 확정 → 이슈 닫음/);
  const i2 = db.issues.find((i) => i.number === 2);
  assert.equal(i2.state, 'closed');
  assert.ok(i2.labels.includes('approved'));
  await assert.rejects(a2a('alice', 'vote', '2', 'reject'), /이미 종료/);

  // 제안자 중복 투표 방지
  assert.match(await a2a('alice', 'decide', '중복 테스트', '--body', 'x'), /자동으로 찬성/);
  assert.match(await a2a('alice', 'vote', '3', 'approve'), /이미 #3에 ✅ 찬성 투표했습니다 \(제안자는 자동 찬성\)/);

  // 철회는 제안자만
  await a2a('bob', 'decide', '배포는 금요일', '--body', 'x');
  await assert.rejects(a2a('alice', 'withdraw', '4'), /내가 올린 안건이 아닙니다/);

  // ---------- 4. 뷰어 서버 ----------
  const port = 4300 + Math.floor(Math.random() * 900) + 50;
  viewer = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    env: { ...process.env, GITHUB_API_URL: API, GITHUB_TOKEN: 'tok-human', A2A_REPO: REPO, PORT: String(port), HOST: '127.0.0.1', SUMMARY: 'off', DATA_DIR: HOME },
    cwd: HOME, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => viewer.stdout.on('data', (d) => d.toString().includes('A2A 뷰어') && r()));
  const V = `http://127.0.0.1:${port}`;
  let ov;
  for (let k = 0; k < 20; k++) { ov = await (await fetch(`${V}/api/overview`)).json(); if (ov.lastSync) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(ov.threads.length, 4);
  assert.equal(ov.team.length, 2, '저장소의 .a2a.json 에서 팀 명단 로드');
  const byN = Object.fromEntries(ov.threads.map((t) => [t.number, t]));
  assert.equal(byN[1].status, 'open');
  assert.equal(byN[1].needsHuman, true);
  assert.equal(byN[2].status, 'approved');
  assert.equal(byN[3].status, 'voting');
  assert.equal(byN[1].messages, undefined, '목록에는 메시지 본문 제외');

  const t2 = await (await fetch(`${V}/api/threads/2`)).json();
  assert.deepEqual(t2.messages.map((m) => m.kind), ['decision', 'vote', 'vote', 'result'], '결과 직후 라벨/닫힘 이벤트는 숨김');
  assert.equal(t2.decision.approve, 2);

  // 사람 댓글이 달리면 '사람 확인 필요' 해제
  const hres = await fetch(`${API}/repos/${REPO}/issues/1/comments`, { method: 'POST', headers: { authorization: 'Bearer tok-human', 'content-type': 'application/json' }, body: JSON.stringify({ body: '만료는 1시간으로 하죠' }) });
  assert.equal(hres.status, 201);
  await fetch(`${V}/api/refresh`, { method: 'POST' });
  const t1 = await (await fetch(`${V}/api/threads/1`)).json();
  assert.equal(t1.needsHuman, false);
  assert.equal(t1.messages.at(-1).kind, 'human');
  assert.match(await a2a('alice', 'inbox'), /👤 boss\(사람\)[\s\S]*만료는 1시간/);

  const page = await (await fetch(V)).text();
  assert.match(page, /에이전트 대화/);
  console.log('✓ 모든 테스트 통과');
} catch (e) {
  console.error('✗ 테스트 실패:', e);
  process.exitCode = 1;
} finally {
  viewer?.kill();
  fake.close();
  setTimeout(() => { fs.rmSync(HOME, { recursive: true, force: true }); process.exit(); }, 300);
}
