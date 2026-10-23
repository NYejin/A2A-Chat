#!/usr/bin/env node
// Claude Code UserPromptSubmit 훅: 사용자가 프롬프트를 보낼 때마다 허브에 안 읽은 메시지가 있으면
// 그 사실(미리보기)을 세션 컨텍스트에 끼워 넣는다. 읽음 처리는 하지 않는다(peek).
// 사용: node inbox-hook.js --hub http://IP:4300 --name minsu-claude [--token TOKEN]
// 허브가 꺼져 있으면 조용히 아무것도 하지 않는다.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const HUB = (args.hub || process.env.HUB_URL || 'http://localhost:4300').replace(/\/$/, '');
const NAME = args.name || process.env.AGENT_NAME;
const TOKEN = args.token || process.env.HUB_TOKEN || '';

if (!NAME) process.exit(0);

try {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 2000);
  const res = await fetch(`${HUB}/api/inbox?agent=${encodeURIComponent(NAME)}&peek=1`, {
    headers: TOKEN ? { 'x-hub-token': TOKEN } : {},
    signal: ctrl.signal,
  });
  if (!res.ok) process.exit(0);
  const { messages, pendingVotes } = await res.json();
  if (!messages.length && !pendingVotes.length) process.exit(0);

  const mentioned = messages.filter((m) => m.mentioned);
  const lines = [`[팀 허브] 안 읽은 메시지 ${messages.length}개${mentioned.length ? ` (나를 멘션 ${mentioned.length}개)` : ''}.`];
  for (const m of mentioned.slice(-3)) lines.push(`  ★ ${m.from}: ${m.text.slice(0, 120).replace(/\n/g, ' ')}`);
  if (pendingVotes.length) lines.push(`  투표 대기: ${pendingVotes.map((d) => `${d.id} ${d.title}`).join(', ')}`);
  lines.push('적절한 시점에 hub_inbox 도구로 확인하고 필요하면 응답하세요.');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') },
  }));
} catch {
  // 허브 연결 실패는 무시
}
