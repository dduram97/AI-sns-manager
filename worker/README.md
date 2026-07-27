# CDP Worker

Vercel 앱(판단·Approval·`action_jobs` 생성)과 분리된 **로컬 Chrome CDP 실행기**입니다.

이번 단계(phase 1) 목표:

1. Worker 실행
2. Chrome CDP 연결 성공
3. 실행 대기 `action_jobs` 감지(like / comment / neighbor_request)

Phase 2-1: 네이버 세션 검증

```bash
cd worker
npm run check:naver
```

- CDP 연결 → `https://www.naver.com` → URL/title/로그인 여부 로그
- 실패 구분: Chrome 미실행 · CDP 연결 실패 · 네이버 미로그인

Phase 2-2: `visit` job 실행 (`npm start`)

- 로그인 확인 후 `action_type=visit` + `planned|approved` job claim → CDP 방문 → `executed` / `failed`
- 성공 DB status는 스키마상 **`executed`** (앱과 동일; 로그에는 `visit completed`)

Phase 2-3: `like` job 실행 (ops 안전: **최대 1개**/run)

- `action_type=like` → claim → 공감 클릭(이미 좋아요면 성공) → `executed` / `failed`
- `postUrl` 없으면 skip (claim 안 함)
- comment / neighbor_request 는 감지만 (실행·status 변경 없음)

## 구조

```
worker/
├── src/
│   ├── index.ts
│   ├── checkNaver.ts
│   ├── browser/cdpClient.ts
│   ├── naver/naverSessionChecker.ts
│   ├── naver/actions/visit.ts
│   ├── naver/actions/like.ts
│   ├── jobs/actionJobRunner.ts
│   └── lib/supabase.ts
├── package.json
├── tsconfig.json
└── README.md
```

## 사전 준비

1. **Chrome CDP** (앱과 동일)

```bash
# repo root
./scripts/start-cdp-chrome.sh
# http://127.0.0.1:9222/json/version 이 JSON을 반환해야 함
```

2. **환경 변수** — repo root `.env`를 그대로 읽습니다.

| 변수 | 필수 | 설명 |
|------|------|------|
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | service role |
| `CDP_URL` | 선택 | 기본 `http://127.0.0.1:9222` |

`worker/.env`가 있으면 root `.env` 위에 override 됩니다.

## 설치 · 실행

```bash
cd worker
npm install
npm start              # phase 1+2: CDP + session + visit 실행
npm run check:naver    # phase 2-1: 네이버 로그인 세션 검증
npm run test:create-visit -- --url=https://m.blog.naver.com/{blogId}/{logNo}
npm run test:create-like -- --url=https://m.blog.naver.com/{blogId}/{logNo}
```

`test:create-visit` / `test:create-like` 은 검증용으로 `planned` job을 만듭니다.  
(필요 시 person/workflow 픽스처도 생성; `WORKER_TEST_PERSON_ID`로 재사용 가능)

성공 시 로그 예:

```
[cdp-worker] connectOverCDP url=http://127.0.0.1:9222
[cdp-worker] Chrome CDP connected contexts=1 pages=...
[cdp-worker] Chrome CDP connection: OK
[cdp-worker] runnable jobs detected count=N ...
[cdp-worker] job { id, action_type, status, ... }
```

## Job 상태 참고

DB에는 `pending` status가 **없습니다.**  
Worker가 보는 “대기 작업”은:

- `status` ∈ `planned` | `approved`
- `action_type` ∈ `like` | `comment` | `neighbor_request`

(`pending_approval`은 승인 전이라 실행 대상이 아닙니다.)

## typecheck

```bash
cd worker
npm run typecheck
```

## 다음 단계 (미구현)

- CDP로 like / comment / neighbor_request DOM 실행
- claim(`running`) → 성공/실패 시 `updateJobResult`
- Vercel Tick과 중복 실행 방지(락 또는 전용 worker 플래그)

## 앱과의 경계

| 레이어 | 역할 |
|--------|------|
| Next.js / Agent Tick | 판단, Approval, `action_jobs` 생성 |
| CDP Worker (이 폴더) | Chrome에 붙어 네이버 행동 실행 (예정) |

Next.js 앱 · Agent Tick · DB schema는 이 Worker 추가로 변경하지 않습니다.
