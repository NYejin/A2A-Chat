// A2A 메시지 형식: 이슈 본문/댓글 맨 앞에 숨은 마커를 넣어 "어떤 Claude가, 누구에게, 무슨 종류로" 썼는지 기록한다.
//   <!-- a2a {"agent":"yejin-claude","role":"프론트엔드","to":["minsu-claude"],"kind":"msg"} -->
//   **🤖 yejin-claude** (프론트엔드) → `minsu-claude`
//
//   본문...
// 마커가 없는 글은 사람이 쓴 것으로 본다.

export const LABELS = {
  thread: { name: 'a2a', color: '5319e7', description: 'Claude 에이전트 간 대화' },
  decision: { name: 'decision', color: 'fbca04', description: '결정 안건 (투표)' },
  approved: { name: 'approved', color: '0e8a16', description: '결정 승인됨' },
  rejected: { name: 'rejected', color: 'b60205', description: '결정 반려됨' },
};

export const KINDS = ['msg', 'decision', 'vote', 'result', 'ask-human'];
export const VOTE_LABEL = { approve: '✅ 찬성', reject: '❌ 반대', abstain: '➖ 기권' };
export const STATUS_LABEL = { approved: '✅ 승인', rejected: '❌ 반려', no_consensus: '⚠️ 합의 실패', withdrawn: '↩️ 철회' };

const MARK_RE = /^\s*<!--\s*a2a\s+(\{[\s\S]*?\})\s*-->\s*/;
const HEADER_RE = /^\*\*🤖[^\n]*\n?/;

export function parseBody(body) {
  const raw = String(body || '').replace(/\r\n/g, '\n');
  const m = raw.match(MARK_RE);
  if (!m) return { meta: null, text: raw.trim() };
  let meta = null;
  try { meta = JSON.parse(m[1]); } catch { return { meta: null, text: raw.trim() }; }
  const text = raw.slice(m[0].length).replace(HEADER_RE, '').trim();
  meta.to = Array.isArray(meta.to) ? meta.to : meta.to ? [meta.to] : [];
  meta.kind = KINDS.includes(meta.kind) ? meta.kind : 'msg';
  return { meta, text };
}

export function header(meta) {
  let h = `**🤖 ${meta.agent}**${meta.role ? ` (${meta.role})` : ''}`;
  if (meta.to?.length) h += ` → ${meta.to.map((t) => `\`${t}\``).join(', ')}`;
  if (meta.kind === 'decision') h += ' · 🗳 결정 요청';
  if (meta.kind === 'vote') h += ` · 투표 ${VOTE_LABEL[meta.vote] || meta.vote}`;
  if (meta.kind === 'result') h += ` · 결과 ${STATUS_LABEL[meta.status] || meta.status}`;
  if (meta.kind === 'ask-human') h += ' · 🙋 사람 확인 필요';
  return h;
}

export function formatBody(meta, text) {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
  return `<!-- a2a ${JSON.stringify(clean)} -->\n${header(meta)}\n\n${String(text || '').trim()}`;
}

// 투표 집계: 투표자 과반 찬성 → 승인, 절반 이상 반대 → 반려, 전원 투표했는데 결론 없음 → 합의 실패.
// 투표자가 2명 미만이면 자동 확정하지 않는다(사람 확정 대기).
export function tally(voters, votes) {
  const latest = new Map();
  for (const v of votes) latest.set(v.agent, v);
  const t = { approve: 0, reject: 0, abstain: 0 };
  for (const [agent, v] of latest) if (!voters.length || voters.includes(agent)) t[v.vote] = (t[v.vote] || 0) + 1;
  const n = voters.length;
  let status = null;
  if (n >= 2) {
    if (t.approve * 2 > n) status = 'approved';
    else if (t.reject * 2 >= n) status = 'rejected';
    else if (voters.every((a) => latest.has(a))) status = 'no_consensus';
  }
  return { ...t, voters, byVoter: Object.fromEntries(latest), status };
}
