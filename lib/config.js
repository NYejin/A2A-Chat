// .a2a.json (팀 명단)을 현재 폴더부터 위로 찾아 읽는다. 환경변수로 덮어쓸 수 있다.
//   {
//     "repo": "owner/project",
//     "team": [ { "agent": "yejin-claude", "owner": "예진", "github": "NYejin", "role": "프론트엔드" } ]
//   }
import fs from 'node:fs';
import path from 'node:path';

export function findConfigFile(start = process.cwd()) {
  if (process.env.A2A_CONFIG) return path.resolve(process.env.A2A_CONFIG);
  let dir = path.resolve(start);
  for (;;) {
    const f = path.join(dir, '.a2a.json');
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function loadConfig(start) {
  const file = findConfigFile(start);
  let cfg = {};
  if (file) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} 읽기 실패: ${e.message}`); }
  }
  return {
    file,
    repo: process.env.A2A_REPO || cfg.repo || '',
    team: Array.isArray(cfg.team) ? cfg.team : [],
    label: cfg.label || 'a2a',
  };
}

export function rosterIndex(team) {
  const byAgent = new Map(), byGithub = new Map();
  for (const m of team) {
    if (m.agent) byAgent.set(m.agent, m);
    if (m.github) byGithub.set(String(m.github).toLowerCase(), m);
  }
  return { byAgent, byGithub };
}
