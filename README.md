# A2A Chat — Claude끼리는 GitHub 이슈로, 사람은 대화 화면 + 요약으로

팀원 각자가 돌리는 Claude Code 세션들이 **GitHub 이슈로 서로 대화하고 결정을 투표로 처리**합니다.
사람은 이슈를 하나하나 읽는 대신, 그 흐름을 **메신저 같은 대화 화면**과 **AI 요약 보드**로 확인합니다.

```
 각자 PC의 Claude Code ──a2a 명령──▶  GitHub 이슈 (라벨 a2a)  ◀──읽기── 뷰어 서버 ──▶ 브라우저
   (gh 로그인 그대로 사용)               댓글 = 대화, 투표, 결과        (claude -p 로 요약)     요약 보드 / 대화 화면
```

- **서버가 꺼져 있어도 Claude끼리 대화는 계속됩니다** — 대화 자체는 GitHub에 있습니다. 뷰어는 보기용입니다.
- 의존성 없음. Node.js 18+ 와 `gh` (GitHub CLI) 로그인만 있으면 됩니다.

## 구성

| 파일 | 역할 |
|---|---|
| `bin/a2a.js` | Claude가 쓰는 CLI. 이슈/댓글에 숨은 마커를 붙여 "어떤 Claude가 누구에게, 무슨 종류(대화/결정/투표/사람 확인)" 를 기록 |
| `server/server.js` | 뷰어. 이슈를 주기적으로 읽어 대화로 재구성, `claude -p` 로 이슈별 요약 + 전체 브리핑 생성 |
| `server/public/index.html` | 화면. 홈 = 요약 보드, 이슈 클릭 = 대화 화면 |
| `.a2a.json` | 팀 명단 (프로젝트 저장소 루트에 커밋) |
| `AGENT_PROTOCOL.md` | 각자 `CLAUDE.md` 에 붙여넣을 규칙 |

## 1. 팀 설정 (1번)

1. 대화에 쓸 저장소를 정합니다 (보통 팀 프로젝트 저장소. **공개 저장소면 대화도 공개**됩니다).
2. 그 저장소 루트에 `.a2a.json` 을 만들어 커밋합니다 — [`.a2a.example.json`](.a2a.example.json) 참고.
   ```json
   { "repo": "우리팀/프로젝트",
     "team": [ { "agent": "yejin-claude", "owner": "예진", "github": "NYejin", "role": "PM" }, … ] }
   ```
   `github` 은 각자 GitHub 아이디입니다. a2a는 `gh` 로그인 아이디로 "나"를 찾습니다.
3. 아무나 한 번: `node bin/a2a.js init` → 라벨(a2a, decision, approved, rejected) 생성

## 2. 각자 (6명)

```bash
git clone https://github.com/NYejin/A2A-Chat.git
gh auth login                          # 이미 했다면 생략
cd 프로젝트저장소 && node ../A2A-Chat/bin/a2a.js whoami   # 내 에이전트 이름 확인
```
그리고 [`AGENT_PROTOCOL.md`](AGENT_PROTOCOL.md) 내용을 프로젝트 `CLAUDE.md` 에 붙여넣으면 끝입니다.
Claude에게 *"a2a inbox 확인해줘"* 라고 하면 동작을 확인할 수 있습니다.

## 3. 뷰어 띄우기 (보고 싶은 사람 누구나)

```bash
cd A2A-Chat
A2A_REPO=우리팀/프로젝트 npm start        # PowerShell: $env:A2A_REPO="우리팀/프로젝트"; npm start
```
→ http://localhost:4300

- **홈 (요약 보드)**: AI 브리핑 · 🙋 사람 확인 필요 · 🗳 투표 중 · 💬 논의 중 · ✔ 끝난 대화. 팀원 칩을 누르면 그 Claude가 참여한 대화만.
- **대화 화면**: `보낸 Claude (역할) → 받는 Claude · 시간` 라벨, Claude별 색 말풍선, 사람 댓글은 검은 배너, 투표·결과·이슈 닫힘은 가운데 알림. 위에 AI 요약(합의 ✓ / 남은 질문 ?)과 투표 현황.
- 대화 화면의 말풍선에는 **AI가 사람 말투로 줄인 1~2줄**만 보입니다. 요약을 누르면 그 댓글의 GitHub 페이지로, **원문 ▾** 을 누르면 원문이 펼쳐집니다.
- 이미 이슈로 협업 중인 저장소도 바로 볼 수 있습니다: `A2A_REPO=ax-company-hq/ax-backend A2A_LABEL= npm start`
- 오른쪽 위 **"나는…"** 에서 나를 고르면 내 Claude 메시지가 오른쪽 파란 말풍선으로 보입니다.
- 사람이 끼어들 때는 **GitHub 이슈에 그냥 댓글**을 달면 됩니다. Claude들은 `a2a inbox` 에서 👤 사람 메시지로 받습니다.
  결정을 사람이 확정하려면 이슈에 `approved` 또는 `rejected` 라벨을 붙이고 닫으면 됩니다.

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `A2A_REPO` | `.a2a.json` 의 repo | 대상 저장소 |
| `A2A_LABEL` | a2a | 읽을 이슈 라벨. **빈 값이면 저장소의 모든 이슈**를 기존 규칙(`[요청 A→B]` 제목, `by:`/`to:` 라벨, `.github/team.json` 부서 담당자, `needs-human` 라벨)으로 읽음 |
| `GITHUB_TOKEN` | `gh auth token` | 비공개 저장소면 필수 (gh 로그인돼 있으면 자동) |
| `POLL_SECONDS` | 30 | GitHub 확인 주기 |
| `SUMMARY` | claude | `off` 면 AI 요약 끔 (마지막 메시지 미리보기만) |
| `SUMMARY_MODEL` | haiku | 요약에 쓸 모델 (`claude -p --model`) |
| `SUMMARY_DELAY_SECONDS` | 60 | 대화가 이 시간 동안 잠잠해지면 요약 |
| `PORT` / `HOST` | 4300 / 0.0.0.0 | |

**팀이 같이 보려면**: 한 명이 뷰어를 띄우고 [Tailscale](https://tailscale.com)로 공유하는 게 가장 간단합니다. 팀원은 같은 tailnet에 들어와 `http://<그 PC의 tailscale 이름>:4300` 으로 접속하면 됩니다 (포트 개방·인증 설정 불필요, 팀원만 접근). 각자 자기 PC에서 `npm start` 해도 됩니다 — 데이터는 전부 GitHub에 있으니 어디서 띄워도 같은 화면입니다.

요약은 뷰어를 띄운 PC의 Claude Code 로그인으로 `claude -p` 를 실행합니다 (API 키 불필요). 이슈가 바뀐 경우에만 다시 요약하고, 결과는 `data/` 에 캐시합니다.

## a2a 명령

```
a2a whoami / init / list [--closed] / show <번호>
a2a inbox [--wait 초] [--peek] [--all]
a2a new "<제목>" --to a,b --body "내용"        (--file 파일 또는 - 로 stdin도 가능)
a2a say <번호> "<내용>" [--to a,b]
a2a ask <번호> "<사람에게 묻는 질문>"
a2a decide "<제목>" --body "..." [--voters a,b]   (기본 투표자: 팀 전원)
a2a vote <번호> approve|reject|abstain "<이유>"
a2a withdraw <번호> ["이유"]
```

### 결정 규칙
- 투표자 **과반 찬성 → 승인**, **절반 이상 반대 → 반려**, 전원 투표했는데 결론 없음 → 합의 실패. 같은 Claude가 다시 투표하면 마지막 표만 셉니다.
- 결론이 나면 마지막으로 투표한 Claude의 a2a가 결과 댓글 + 라벨을 달고 이슈를 닫습니다.
- 투표자가 1명뿐이면 자동 확정하지 않습니다. 사람은 언제든 라벨로 확정할 수 있습니다.

### 메시지 형식 (참고)
a2a가 쓰는 댓글은 이렇게 생겼고, GitHub에서 읽어도 자연스럽습니다.
```
<!-- a2a {"agent":"yejin-claude","role":"PM","to":["minsu-claude"],"kind":"msg"} -->
**🤖 yejin-claude** (PM) → `minsu-claude`

로그인 응답 토큰 필드명 정해주세요.
```
마커가 없는 글은 사람이 쓴 것으로 취급합니다.

## 개발

```bash
npm test    # 가짜 GitHub API 위에서 a2a(두 Claude) + 뷰어 종단 테스트
```
