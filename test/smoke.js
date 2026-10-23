// 종단 테스트: 허브를 띄우고 MCP 브리지 2개(두 Claude 세션 역할)가 대화·결정·투표하는 흐름을 검증한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4300 + Math.floor(Math.random() * 1000) + 100;
const HUB = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'));
const procs = [];

function startHub() {
  const p = spawn(process.execPath, [path.join(ROOT, 'server/hub.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, TEAM_TOKEN: 'secret' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(p);
  return new Promise((res) => p.stdout.on('data', (d) => d.toString().includes('실행 중') && res()));
}

function startBridge(name) {
  const p = spawn(process.execPath, [path.join(ROOT, 'bridge/mcp-bridge.js')], {
    env: { ...process.env, HUB_URL: HUB, AGENT_NAME: name, AGENT_OWNER: name + '-owner', HUB_TOKEN: 'secret' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  procs.push(p);
  let buf = '', nextId = 1;
  const pending = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  const rpc = (method, params) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result.content[0].text;
    if (r.result.isError) throw new Error(text);
    return text;
  };
  return { rpc, call };
}

try {
  await startHub();

  const unauth = await fetch(`${HUB}/api/state`);
  assert.equal(unauth.status, 401, '토큰 없으면 401');

  const a = startBridge('alice-claude');
  const b = startBridge('bob-claude');

  const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'agent-hub');
  assert.match(init.result.instructions, /alice-claude/);
  await b.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });

  const list = await a.rpc('tools/list', {});
  assert.ok(list.result.tools.some((t) => t.name === 'hub_propose_decision'));

  await new Promise((r) => setTimeout(r, 300)); // heartbeat 반영 대기
  const members = await a.call('hub_members');
  assert.match(members, /alice-claude \(나\)/);
  assert.match(members, /bob-claude/);

  // bob이 기다리는 동안 alice가 멘션
  const waiting = b.call('hub_inbox', { wait_seconds: 10 });
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  await a.call('hub_send', { text: '@bob-claude 로그인 API 응답 포맷 정했어?', channel: 'backend' });
  const got = await waiting;
  assert.ok(Date.now() - t0 < 3000, '롱폴링이 즉시 깨어나야 함');
  assert.match(got, /★ #\d+ .*#backend alice-claude → @bob-claude/);

  // 이미 읽은 메시지는 다시 안 나옴
  assert.match(await b.call('hub_inbox'), /새 메시지 없음/);

  // 결정 → 투표 → 자동 승인
  const prop = await a.call('hub_propose_decision', { title: '응답은 camelCase JSON', description: '모든 API 응답 키를 camelCase로' });
  const id = prop.match(/D-\d+/)[0];
  assert.match(await b.call('hub_inbox'), new RegExp(`투표 대기 중인 결정:[\\s\\S]*${id}`));
  const voted = await b.call('hub_vote', { decision_id: id, vote: 'approve', reason: '프론트도 camelCase 씀' });
  assert.match(voted, /\[approved\]/);

  const approved = await a.call('hub_decisions', { status: 'approved' });
  assert.match(approved, /응답은 camelCase JSON/);
  assert.match(await a.call('hub_inbox'), /D-\d+ 승인/);

  // 투표자가 제안자 혼자면 자동 승인되지 않음
  const solo = await a.call('hub_propose_decision', { title: '혼자 올린 안건', description: 'x', voters: ['alice-claude'] });
  assert.match(solo, /\[open\]/);
  const soloId = solo.match(/D-\d+/)[0];
  assert.match(await b.call('hub_inbox'), new RegExp(`${soloId} 혼자 올린 안건.*투표자 지정 안 됨`));
  assert.match(await b.call('hub_vote', { decision_id: soloId, vote: 'approve' }), /\[approved\]/);
  await a.call('hub_inbox');

  // 사람이 UI에서 메시지 + 강제 반려
  const H = { 'content-type': 'application/json', 'x-hub-token': 'secret' };
  const d2 = await (await fetch(`${HUB}/api/decisions`, { method: 'POST', headers: H, body: JSON.stringify({ from: 'bob-claude', title: '테스트 안건', description: 'x', voters: ['alice-claude', 'bob-claude', 'carol'] }) })).json();
  const forbid = await fetch(`${HUB}/api/decisions/${d2.decision.id}/resolve`, { method: 'POST', headers: H, body: JSON.stringify({ from: 'alice-claude', status: 'approved' }) });
  assert.equal(forbid.status, 400, '에이전트는 강제 확정 불가');
  const ok = await fetch(`${HUB}/api/decisions/${d2.decision.id}/resolve`, { method: 'POST', headers: H, body: JSON.stringify({ from: '예진', status: 'rejected', human: true }) });
  assert.equal(ok.status, 200);
  await fetch(`${HUB}/api/messages`, { method: 'POST', headers: H, body: JSON.stringify({ from: '예진', text: '@alice-claude 수고했어', human: true }) });
  const aliceInbox = await a.call('hub_inbox');
  assert.match(aliceInbox, /반려/);
  assert.match(aliceInbox, /★ .*예진/);

  // 피크(훅) 모드는 읽음 처리 안 함
  await a.call('hub_send', { text: 'peek test' });
  const peek1 = await (await fetch(`${HUB}/api/inbox?agent=bob-claude&peek=1`, { headers: H })).json();
  const peek2 = await (await fetch(`${HUB}/api/inbox?agent=bob-claude&peek=1`, { headers: H })).json();
  assert.ok(peek1.messages.length > 0 && peek1.messages.length === peek2.messages.length);

  // UI 페이지 제공
  const page = await (await fetch(`${HUB}/`)).text();
  assert.match(page, /A2A Chat/);

  console.log('✓ 모든 테스트 통과');
} catch (e) {
  console.error('✗ 테스트 실패:', e);
  process.exitCode = 1;
} finally {
  for (const p of procs) p.kill();
  setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
}
