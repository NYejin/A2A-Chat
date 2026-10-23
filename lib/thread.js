// GitHub 이슈 + 타임라인 → 대화 스레드(메시지 목록, 결정 상태, 사람 확인 필요 여부)
import { parseBody, tally } from './protocol.js';

function messageFrom(src, { id, ts, url }) {
  const { meta, text } = parseBody(src.body);
  const user = src.user || src.actor || {};
  const base = { id, ts, url, login: user.login || '', avatar: user.avatar_url || '', text };
  if (!meta) return { ...base, kind: 'human', to: [] };
  return {
    ...base,
    kind: meta.kind,
    agent: meta.agent,
    role: meta.role || '',
    to: meta.to,
    vote: meta.vote,
    status: meta.status,
    voters: meta.voters,
  };
}

const EVENT_TEXT = {
  closed: (e) => `${e.actor?.login || ''}님이 이슈를 닫음${e.state_reason === 'not_planned' ? ' (진행 안 함)' : ''}`,
  reopened: (e) => `${e.actor?.login || ''}님이 이슈를 다시 열음`,
  labeled: (e) => `라벨 ${e.label?.name} 추가`,
  renamed: (e) => `제목 변경: ${e.rename?.to}`,
  'cross-referenced': (e) => `#${e.source?.issue?.number} ${e.source?.issue?.title || ''} 에서 언급됨`,
  referenced: (e) => `커밋 ${String(e.commit_id || '').slice(0, 7)} 에서 참조됨`,
};
const SHOW_LABELS = new Set(['approved', 'rejected']);

export function buildThread(issue, timeline = []) {
  const messages = [messageFrom(issue, { id: `i${issue.number}`, ts: issue.created_at, url: issue.html_url })];
  for (const e of timeline) {
    if (e.event === 'commented') {
      messages.push(messageFrom(e, { id: `c${e.id}`, ts: e.created_at, url: e.html_url }));
    } else if (EVENT_TEXT[e.event]) {
      if (e.event === 'labeled' && !SHOW_LABELS.has(e.label?.name)) continue;
      messages.push({ id: `e${e.id || e.created_at}`, kind: 'event', ts: e.created_at, text: EVENT_TEXT[e.event](e), event: e.event, login: e.actor?.login || '' });
    }
  }
  messages.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  // a2a가 결과 댓글을 단 직후의 라벨/닫힘 이벤트는 결과 알림과 중복이라 숨긴다
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i];
    if (m.kind !== 'event' || !['closed', 'labeled'].includes(m.event)) continue;
    const result = messages.slice(0, i).reverse().find((x) => x.kind !== 'event');
    if (result?.kind === 'result' && new Date(m.ts) - new Date(result.ts) < 120_000) messages.splice(i, 1);
  }

  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const first = messages[0];
  const isDecision = labels.includes('decision') || first.kind === 'decision';
  let decision = null;
  if (isDecision) {
    const voters = first.voters || [];
    const votes = messages.filter((m) => m.kind === 'vote' && m.agent && m.vote).map((m) => ({ agent: m.agent, vote: m.vote }));
    const t = tally(voters, votes);
    const result = [...messages].reverse().find((m) => m.kind === 'result');
    const final = labels.includes('approved') ? 'approved' : labels.includes('rejected') ? 'rejected' : result?.status || null;
    decision = { ...t, final: issue.state === 'closed' || final ? final || 'closed' : null };
  }

  let status;
  if (decision) status = decision.final || (issue.state === 'closed' ? 'closed' : 'voting');
  else status = issue.state === 'closed' ? 'closed' : 'open';

  // 마지막 "사람 확인 요청" 이후 사람 댓글이 없으면 사람 확인 필요
  const lastAsk = messages.map((m, i) => (m.kind === 'ask-human' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const needsHuman = issue.state === 'open' && lastAsk >= 0 && !messages.slice(lastAsk + 1).some((m) => m.kind === 'human');

  const chat = messages.filter((m) => m.kind !== 'event');
  const participants = [...new Set(chat.map((m) => m.agent || m.login).filter(Boolean))];
  const last = chat[chat.length - 1];
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    labels,
    author: first.agent || first.login,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    status,
    decision,
    needsHuman,
    participants,
    messageCount: chat.length,
    last: last ? { who: last.agent || last.login, kind: last.kind, text: last.text.slice(0, 200), ts: last.ts } : null,
    messages,
  };
}

// 요약 프롬프트용 대화록
export function transcript(thread, maxChars = 14000) {
  const lines = [`이슈 #${thread.number}: ${thread.title} (상태: ${thread.status})`];
  for (const m of thread.messages) {
    if (m.kind === 'event') { lines.push(`[이벤트] ${m.text}`); continue; }
    const who = m.agent ? `${m.agent}${m.role ? `(${m.role})` : ''}` : `사람 ${m.login}`;
    const to = m.to?.length ? ` → ${m.to.join(', ')}` : '';
    const tag = m.kind === 'vote' ? ` [투표: ${m.vote}]` : m.kind === 'decision' ? ' [결정 요청]' : m.kind === 'ask-human' ? ' [사람 확인 요청]' : m.kind === 'result' ? ` [결과: ${m.status}]` : '';
    lines.push(`${who}${to}${tag}: ${m.text}`);
  }
  let out = lines.join('\n\n');
  if (out.length > maxChars) out = out.slice(0, 2000) + '\n\n…(중략)…\n\n' + out.slice(-(maxChars - 2000));
  return out;
}
