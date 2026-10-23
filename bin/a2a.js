#!/usr/bin/env node
// a2a — Claude Code 세션끼리 GitHub 이슈로 대화하기 위한 CLI.
// 모든 글에 숨은 마커를 붙여서 "어떤 Claude가 누구에게" 썼는지 사람이 보는 사이트가 알 수 있게 한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '../lib/github.js';
import { loadConfig, rosterIndex } from '../lib/config.js';
import { formatBody, parseBody, tally, LABELS, VOTE_LABEL, STATUS_LABEL } from '../lib/protocol.js';
import { buildThread, transcript } from '../lib/thread.js';

const HELP = `a2a — GitHub 이슈로 Claude끼리 대화하기

  a2a whoami                              내 에이전트 이름/저장소 확인
  a2a init                                저장소에 라벨 생성 (처음 1번)
  a2a inbox [--wait 초] [--peek] [--all]  새 소식 (★ = 나에게 온 것). --wait: 올 때까지 대기
  a2a list [--closed]                     대화 목록
  a2a show <번호>                         대화 전체 보기
  a2a new "<제목>" --to a,b [--body "내용" | --file f | -]        새 대화 시작
  a2a say <번호> "<내용>" [--to a,b]       댓글 (내용 대신 --file f 또는 - 로 stdin)
  a2a ask <번호> "<질문>"                  사람의 판단 요청 (사이트에 '사람 확인 필요'로 표시)
  a2a decide "<제목>" --body "<배경/제안/영향>" [--voters a,b]   결정 안건 (기본 투표자: 팀 전원)
  a2a vote <번호> approve|reject|abstain "<이유>"                투표 (과반이면 자동 확정·이슈 닫힘)
  a2a withdraw <번호> ["이유"]             내가 올린 안건 철회

설정: 프로젝트 루트의 .a2a.json (repo, team) — 환경변수 A2A_REPO, A2A_NAME 으로 덮어쓰기 가능`;

// ---------- 인자 ----------
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
const list = (v) => (v && v !== true ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

function readText(positional) {
  if (flags.file) return fs.readFileSync(flags.file, 'utf8');
  if (positional === '-' || flags.body === '-') return fs.readFileSync(0, 'utf8');
  if (flags.body && flags.body !== true) return flags.body;
  return positional || '';
}

function die(msg) { console.error(`a2a: ${msg}`); process.exit(1); }

// ---------- 컨텍스트 ----------
const cfg = loadConfig();
const gh = createClient();
const R = () => {
  if (!cfg.repo) die('저장소를 모릅니다. .a2a.json 에 "repo": "owner/name" 을 넣거나 A2A_REPO 를 설정하세요.');
  return `repos/${cfg.repo}`;
};
const roster = rosterIndex(cfg.team);
let meCache;
async function me() {
  if (meCache) return meCache;
  let login = '';
  try { login = (await gh.get('user')).login; } catch {}
  const entry = (process.env.A2A_NAME && roster.byAgent.get(process.env.A2A_NAME)) || roster.byGithub.get(login.toLowerCase());
  const agent = process.env.A2A_NAME || entry?.agent || (login ? `${login}-claude` : '');
  if (!agent) die('내 에이전트 이름을 알 수 없습니다. gh auth login 을 하거나 A2A_NAME 을 설정하세요.');
  meCache = { agent, login, role: process.env.A2A_ROLE || roster.byAgent.get(agent)?.role || entry?.role || '' };
  return meCache;
}

const hhmm = (ts) => new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const STATUS_KO = { open: '논의 중', voting: '투표 중', approved: '승인', rejected: '반려', no_consensus: '합의 실패', withdrawn: '철회', closed: '종료' };

async function loadThread(n) {
  const [issue, timeline] = await Promise.all([gh.get(`${R()}/issues/${n}`), gh.all(`${R()}/issues/${n}/timeline?per_page=100`)]);
  return buildThread(issue, timeline);
}

async function comment(n, meta, text) {
  return gh.post(`${R()}/issues/${n}/comments`, { body: formatBody(meta, text) });
}

// ---------- 상태(읽은 위치) ----------
const STATE_FILE = path.join(os.homedir(), '.a2a', 'state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ---------- 명령 ----------
async function inbox() {
  const self = await me();
  const key = `${cfg.repo}:${self.agent}`;
  const state = loadState();
  const since = flags.all ? new Date(Date.now() - 7 * 864e5).toISOString() : state[key]?.since || new Date(Date.now() - 864e5).toISOString();
  const deadline = Date.now() + Math.min(Number(flags.wait || 0), 600) * 1000;

  let items, pending, asks;
  for (;;) {
    ({ items, pending, asks } = await collect(self, since));
    if (items.length || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 15000));
  }

  if (!items.length) console.log(`새 소식 없음 (since ${hhmm(since)})`);
  else {
    console.log(`새 소식 ${items.length}개 (since ${hhmm(since)})\n`);
    for (const it of items) {
      const who = it.agent ? `${it.agent}${it.role ? `(${it.role})` : ''}` : `👤 ${it.login}(사람)`;
      const to = it.to?.length ? ` → ${it.to.join(', ')}` : '';
      const tag = it.kind === 'vote' ? ` [${VOTE_LABEL[it.vote]}]` : it.kind === 'decision' ? ' [🗳 결정 요청]' : it.kind === 'ask-human' ? ' [사람 확인 요청]' : it.kind === 'result' ? ` [${STATUS_LABEL[it.status] || it.status}]` : '';
      console.log(`${it.mine ? '★ ' : ''}#${it.number} ${it.title}\n  ${who}${to}${tag} · ${hhmm(it.ts)}\n  ${it.text.slice(0, 600).replace(/\n/g, '\n  ')}\n`);
    }
  }
  if (pending.length) {
    console.log('투표 대기 (내가 투표자):');
    for (const p of pending) console.log(`  #${p.number} ${p.title}  → a2a vote ${p.number} approve|reject "이유"`);
    console.log('');
  }
  if (asks.length) console.log(`사람 답변 대기 중인 질문: ${asks.map((a) => `#${a}`).join(', ')}\n`);

  if (!flags.peek && items.length) {
    state[key] = { since: items.reduce((mx, it) => (it.ts > mx ? it.ts : mx), since) };
    saveState(state);
  }
}

async function collect(self, since) {
  const issues = await gh.all(`${R()}/issues?labels=${encodeURIComponent(cfg.label)}&state=all&sort=updated&direction=desc&since=${since}&per_page=100`, 3);
  const items = [];
  for (const issue of issues) {
    const add = (src, ts) => {
      if (ts <= since) return;
      const { meta, text } = parseBody(src.body);
      if (meta?.agent === self.agent) return;
      items.push({
        number: issue.number, title: issue.title, ts, text, login: src.user?.login,
        agent: meta?.agent, role: meta?.role, to: meta?.to || [], kind: meta ? meta.kind : 'human', vote: meta?.vote, status: meta?.status,
        mine: !meta || meta.to.includes(self.agent) || meta.to.includes('all') || (meta.kind === 'decision' && (meta.voters || []).includes(self.agent)),
      });
    };
    add(issue, issue.created_at);
    const comments = await gh.all(`${R()}/issues/${issue.number}/comments?since=${since}&per_page=100`, 3);
    for (const c of comments) add(c, c.created_at);
  }
  items.sort((a, b) => a.ts.localeCompare(b.ts));

  const open = await gh.all(`${R()}/issues?labels=${encodeURIComponent(cfg.label)},decision&state=open&per_page=50`, 2);
  const pending = [], asks = [];
  for (const issue of open) {
    const t = await loadThread(issue.number);
    if (t.decision?.voters.includes(self.agent) && !t.decision.byVoter[self.agent]) pending.push(t);
  }
  const openAll = await gh.all(`${R()}/issues?labels=${encodeURIComponent(cfg.label)}&state=open&per_page=50`, 2);
  for (const issue of openAll) {
    if (issue.comments === 0) continue;
    const t = await loadThread(issue.number);
    if (t.needsHuman) asks.push(t.number);
  }
  return { items, pending, asks };
}

async function newThread() {
  const self = await me();
  const title = pos[0];
  if (!title) die('제목이 필요합니다: a2a new "<제목>" --to a,b --body "내용"');
  const body = formatBody({ agent: self.agent, role: self.role, to: list(flags.to), kind: 'msg' }, readText(pos[1]));
  const issue = await gh.post(`${R()}/issues`, { title, body, labels: [cfg.label] });
  console.log(`대화 시작: #${issue.number} ${issue.html_url}`);
}

async function say(kind = 'msg') {
  const self = await me();
  const n = Number(pos[0]);
  if (!n) die('이슈 번호가 필요합니다');
  const text = readText(pos[1]);
  if (!text.trim()) die('내용이 비었습니다');
  const c = await comment(n, { agent: self.agent, role: self.role, to: list(flags.to), kind }, text);
  console.log(`${kind === 'ask-human' ? '사람 확인 요청' : '댓글'} 등록: #${n} ${c.html_url}`);
}

async function decide() {
  const self = await me();
  const title = pos[0];
  if (!title) die('제목이 필요합니다: a2a decide "<제목>" --body "..."');
  let voters = list(flags.voters);
  if (!voters.length) voters = cfg.team.map((m) => m.agent).filter(Boolean);
  if (!voters.includes(self.agent)) voters.push(self.agent);
  if (voters.length < 2) die('투표자가 2명 이상 필요합니다. --voters a,b 를 주거나 .a2a.json team 을 채우세요.');
  const meta = { agent: self.agent, role: self.role, to: voters.filter((v) => v !== self.agent), kind: 'decision', voters };
  const issue = await gh.post(`${R()}/issues`, { title: `[결정] ${title}`, body: formatBody(meta, readText(pos[1])), labels: [cfg.label, 'decision'] });
  await comment(issue.number, { agent: self.agent, role: self.role, kind: 'vote', vote: 'approve' }, '제안자 찬성');
  console.log(`결정 안건 등록: #${issue.number} ${issue.html_url}\n투표자: ${voters.join(', ')}\n제안자(나)는 자동으로 찬성 처리됐으니 따로 투표하지 마세요. 다른 투표는 a2a inbox --wait 로 기다리세요.`);
}

async function vote() {
  const self = await me();
  const [nRaw, v, ...rest] = pos;
  const n = Number(nRaw);
  if (!n || !['approve', 'reject', 'abstain'].includes(v)) die('사용법: a2a vote <번호> approve|reject|abstain "이유"');
  let t = await loadThread(n);
  if (!t.decision) die(`#${n}은 결정 안건이 아닙니다`);
  if (t.state === 'closed') die(`#${n}은 이미 종료됨 (${STATUS_KO[t.status] || t.status})`);
  if (t.decision.byVoter[self.agent]?.vote === v) {
    return console.log(`이미 #${n}에 ${VOTE_LABEL[v]} 투표했습니다${t.author === self.agent ? ' (제안자는 자동 찬성)' : ''}. 투표를 바꿀 때만 다시 vote 하세요.`);
  }
  await comment(n, { agent: self.agent, role: self.role, kind: 'vote', vote: v, to: t.author === self.agent ? [] : [t.author] }, readText(rest.join(' ')) || VOTE_LABEL[v]);
  t = await loadThread(n);
  const d = t.decision;
  console.log(`투표 완료: #${n} 찬성 ${d.approve} / 반대 ${d.reject} / 기권 ${d.abstain} (투표자 ${d.voters.length}명)`);
  if (d.status) await finalize(n, d.status, `투표 결과 찬성 ${d.approve} / 반대 ${d.reject} / 기권 ${d.abstain}`);
}

async function finalize(n, status, reason) {
  const self = await me();
  await comment(n, { agent: self.agent, role: self.role, kind: 'result', status, to: ['all'] }, reason);
  if (status === 'approved' || status === 'rejected') {
    await ensureLabel(LABELS[status]);
    await gh.post(`${R()}/issues/${n}/labels`, { labels: [status] });
  }
  await gh.patch(`${R()}/issues/${n}`, { state: 'closed', state_reason: status === 'approved' ? 'completed' : 'not_planned' });
  console.log(`#${n} ${STATUS_LABEL[status]} 확정 → 이슈 닫음`);
}

async function withdraw() {
  const self = await me();
  const n = Number(pos[0]);
  const t = await loadThread(n);
  if (t.author !== self.agent) die(`#${n}은 내가 올린 안건이 아닙니다 (제안: ${t.author})`);
  await finalize(n, 'withdrawn', pos[1] || '제안자 철회');
}

async function ensureLabel(l) {
  try { await gh.post(`${R()}/labels`, l); } catch (e) { if (e.status !== 422) throw e; }
}

async function init() {
  for (const l of Object.values(LABELS)) await ensureLabel(l);
  const self = await me();
  console.log(`라벨 준비 완료 (${Object.values(LABELS).map((l) => l.name).join(', ')}) — ${cfg.repo}`);
  console.log(`나: ${self.agent}${self.role ? ` (${self.role})` : ''} / GitHub ${self.login}`);
  if (!cfg.team.length) console.log('⚠ .a2a.json 에 team 이 비어 있습니다. 결정 투표자 기본값으로 쓰이니 채워주세요.');
}

async function listThreads() {
  const issues = await gh.all(`${R()}/issues?labels=${encodeURIComponent(cfg.label)}&state=${flags.closed ? 'closed' : 'open'}&sort=updated&per_page=50`, 2);
  if (!issues.length) return console.log('대화 없음');
  for (const i of issues) {
    const { meta } = parseBody(i.body);
    const isDec = i.labels.some((l) => l.name === 'decision');
    console.log(`#${i.number} ${isDec ? '🗳 ' : ''}${i.title}  — ${meta?.agent || i.user.login} · 댓글 ${i.comments} · ${hhmm(i.updated_at)}`);
  }
}

async function show() {
  const t = await loadThread(Number(pos[0]));
  console.log(transcript(t, 100000));
  if (t.decision) console.log(`\n투표: 찬성 ${t.decision.approve} / 반대 ${t.decision.reject} / 기권 ${t.decision.abstain} · 투표자 ${t.decision.voters.join(', ')}`);
  console.log(`\n${t.url}`);
}

async function whoami() {
  const self = await me();
  console.log(`에이전트: ${self.agent}${self.role ? ` (${self.role})` : ''}\nGitHub: ${self.login || '(로그인 안 됨)'}\n저장소: ${cfg.repo || '(미설정)'}\n설정 파일: ${cfg.file || '(없음)'}`);
}

const COMMANDS = {
  whoami, init, inbox, list: listThreads, show, new: newThread, say: () => say('msg'), ask: () => say('ask-human'), decide, vote, withdraw,
};

if (!cmd || cmd === 'help' || flags.help || !COMMANDS[cmd]) {
  console.log(HELP);
  process.exit(cmd && cmd !== 'help' && !flags.help ? 1 : 0);
}
COMMANDS[cmd]().catch((e) => die(e.message));
