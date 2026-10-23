#!/usr/bin/env node
// 팀원 PC에서 1회 실행: 이 PC의 Claude Code에 허브 MCP 브리지(+선택: 알림 훅)를 등록한다.
// 사용: node setup.js --name minsu-claude --owner 김민수 --role 백엔드 --hub http://192.168.0.10:4300 [--token 비밀] [--hook] [--dry]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k, d = '') => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const name = opt('name');
const hub = opt('hub', 'http://localhost:4300').replace(/\/$/, '');
const owner = opt('owner');
const role = opt('role');
const token = opt('token');
const scope = opt('scope', 'user');
const dry = flag('dry');

if (!name) {
  console.error('사용법: node setup.js --name <세션이름> --hub http://<허브IP>:4300 [--owner 이름] [--role 담당] [--token 토큰] [--hook]');
  process.exit(1);
}

// 슬래시 경로는 Windows의 node와 Git Bash(훅 실행 셸) 모두에서 동작한다
const slash = (p) => p.replace(/\\/g, '/');
const bridge = slash(path.join(ROOT, 'bridge', 'mcp-bridge.js'));
const hookScript = slash(path.join(ROOT, 'bridge', 'inbox-hook.js'));
const nodeBin = slash(process.execPath);

// 1) 허브 연결 확인
try {
  const res = await fetch(`${hub}/api/health`, { signal: AbortSignal.timeout(3000) });
  console.log(res.ok ? `✓ 허브 연결 확인: ${hub}` : `⚠ 허브 응답 이상 (${res.status})`);
} catch {
  console.log(`⚠ 허브(${hub})에 지금 연결되지 않습니다. 등록은 진행하지만 허브가 켜져 있어야 동작합니다.`);
}

// 2) MCP 서버 등록
const envs = { HUB_URL: hub, AGENT_NAME: name, AGENT_OWNER: owner, AGENT_ROLE: role, HUB_TOKEN: token };
const args = ['mcp', 'add', '--scope', scope, 'agent-hub'];
for (const [k, v] of Object.entries(envs)) if (v) args.push('-e', `${k}=${v}`);
args.push('--', nodeBin, bridge);

const shown = `claude ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
if (dry) {
  console.log('\n[dry] 실행할 명령:\n' + shown);
} else {
  // Windows에서는 claude가 .cmd 래퍼라 셸을 거쳐야 하므로 공백 있는 인자를 직접 따옴표로 감싼다
  const win = process.platform === 'win32';
  const q = (a) => (win && /[\s&|<>^]/.test(a) ? `"${a}"` : a);
  const exec = (a, stdio) => execFileSync('claude', win ? a.map(q) : a, { stdio, shell: win });
  const run = (a) => exec(a, 'inherit');
  try { exec(['mcp', 'remove', '--scope', scope, 'agent-hub'], 'ignore'); } catch {}
  try {
    run(args);
    console.log(`✓ MCP 서버 "agent-hub" 등록 완료 (scope: ${scope}, 이름: ${name})`);
  } catch {
    console.error('✗ claude mcp add 실패. 아래 명령을 직접 실행해 보세요:\n' + shown);
    process.exit(1);
  }
}

// 3) 선택: 프롬프트마다 안 읽은 허브 메시지를 알려주는 훅
if (flag('hook')) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const command = `"${nodeBin}" "${hookScript}" --hub ${hub} --name ${name}${token ? ` --token ${token}` : ''}`;
  if (dry) {
    console.log(`\n[dry] ${settingsPath} 의 hooks.UserPromptSubmit 에 추가할 명령:\n${command}`);
  } else {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    settings.hooks ??= {};
    const list = (settings.hooks.UserPromptSubmit ??= []);
    const filtered = list.filter((g) => !(g.hooks || []).some((h) => String(h.command || '').includes('inbox-hook.js')));
    filtered.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
    settings.hooks.UserPromptSubmit = filtered;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.bak');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`✓ 알림 훅 등록 완료 (${settingsPath}, 백업: settings.json.bak)`);
  }
}

console.log(`
다음 단계:
  1. Claude Code를 새로 시작하고 /mcp 로 agent-hub 가 connected 인지 확인
  2. 프로젝트 CLAUDE.md 에 AGENT_PROTOCOL.md 내용을 붙여넣기 (권장)
  3. Claude에게: "허브에 인사하고 팀원 목록 확인해줘"
  4. 대화 보기: ${hub}${token ? `/?token=${token}` : ''}
`);
