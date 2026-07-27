# AI SNS Manager — Personal AI Relationship Agent Architecture

**Version:** 2.0  
**Codename:** Personal AI Relationship Agent  
**Status:** Single-operator Agent Platform (Next./shared · Vercel · Supabase)  
**Supersedes:** Architecture Spec v1.3 (SaaS / multi-tenant baseline)

이 문서는 **혼자 사용하는 AI Relationship Agent**의 구현 기준선이다.  
불특정 다수 SaaS가 아니다. 회원가입·조직·결제·멀티테넌시·RBAC는 존재하지 않는다.

---

## 0. Product Definition

AI SNS Manager는 SNS 관리 앱이 아니다.

**내가 감독하는 Personal AI Relationship Agent**다.

- **Agent**가 블로그·Threads 관계를 계속 관리한다.
- **나(Supervisor)**는 Activity를 보고, 고위험만 승인한다.
- AI가 먼저 일하고, 사람은 마지막에 결정한다.

**North Star:** 하루 SNS 관리 시간 ≤ **10분**.

**Success UX:** Agent Brief 열기 → Approval 처리(또는 Inbox 0) → 종료.

**철학:** 사람 추가가 목표가 아니다. 관계 품질을 유지한 결과로 조회·반응이 따라온다.

**채널 확장 순서:** Blog → Threads → Instagram (Person 아래 Adapter).

**탭 (고정):** 오늘 | 사람들 | 발굴 | 더보기

**배포:** Next./shared + Vercel + Supabase (단일 운영자).

### Runtime axioms

> **Workflow** = 이 사람과 지금 어디까지인가  
> **ActionJob** = 그 여정에서 무엇을 했/할 것인가 (항상 `parent_workflow_id`)  
> **Decision** = Stateless Rule Pipeline → 단일 DecisionOutput  
> **Goals** = G1≻G2≻G3≻G4≻G5 최적화 기준 (UI 없음)  
> **Policy** = 수단의 한도 (Goal 순서를 바꾸지 않음)

---

## 1. Information Architecture

```
Personal Agent App
│
├─ 오늘 (= Agent Brief)
│   ├─ Agent 상태
│   ├─ Activity Summary → Timeline
│   ├─ Approval Inbox → Approval Card
│   └─ Growth Summary
│
├─ 사람들
│   ├─ Person List
│   └─ Person Detail
│       ├─ RelationshipState
│       ├─ Active Workflow (표시만 · 관리 화면 없음)
│       ├─ ChannelIdentities
│       └─ Timeline
│
├─ 발굴
│   ├─ Discover Policy (키워드 등)
│   ├─ Candidate Review
│   └─ Bulk intent → Workflow → Approval (고위험 직접 실행 금지)
│
└─ 더보기
    ├─ Growth Report
    ├─ Agent Policy (한도·프리셋·톤)
    ├─ Channel Connections
    ├─ Execution Log
    └─ Account (본인 연결 정보만 · 결제/플랜 없음)
```

### IA Rules

| Rule         | Detail                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------- |
| 탭 추가 금지 | 댓글/공감/점수/Workflow 관리 페이지 금지                                                  |
| 배치         | Perception\|Decision\|Workflow\|Action\|Policy\|Outcome → UI는 Activity\|Approval\|Person |
| 매일 동선    | **오늘**만                                                                                |
| Home         | Agent Brief (할 일 보드 아님)                                                             |

### Capability → Domain → UI

| Capability                        | Domain                     | UI             |
| --------------------------------- | -------------------------- | -------------- |
| 키워드 검색·협찬·활성·관심사·점수 | Perception + Decision      | 발굴 / Person  |
| 워밍 방문·공감                    | Workflow → Action Executed | Activity       |
| 신청/댓글 초안                    | Workflow → Approval        | Approval       |
| 새 글·요약·예약                   | Perception + Decision      | Approval 카드  |
| last touch / score / temperature  | RelationshipState          | Person, Brief  |
| 성장 인사이트                     | Outcome                    | Brief / 더보기 |
| 자동화 수준                       | Policy                     | 더보기         |

---

## 2. Domain Model

```
┌─────────────────────────────────────────────────────────────┐
│                    PERSONAL AGENT                            │
├──────────┬──────────┬──────────┬──────────┬────────┬────────┤
│Perception│ Decision │ Workflow │  Action │ Policy │Outcome │
│          │ (Rules + │          │          │        │+ Goals │
│          │  Goals)  │          │          │        │Feedback│
└────┬─────┴────┬─────┴────┬─────┴────┬─────┴───┬────┴───┬────┘
     ▼          ▼          ▼          ▼         ▼        ▼
  Events    DecisionOutput Workflows ActionJobs Policy  Metrics
                           │            │
                           ├─ low → execute
                           └─ high → ApprovalItem
```

### Canonical pipeline

```
Perception
  → Rule Engine (Decision + Goals)
  → DecisionOutput + DecisionRecord
  → Workflow Update
  → Action Queue / Approval Queue
  → Action Execute
  → Outcome
  → Goal Feedback (next tick)
```

| Layer      | Responsibility                                                           |
| ---------- | ------------------------------------------------------------------------ |
| Perception | 새 글·맞반응·수락/거절·터치 공백·발굴 후보 감지                          |
| Decision   | Context 읽기 → Rule Pipeline → 단일 Output (어댑터·Approval insert 금지) |
| Workflow   | 다일 여정 상태; ActionJob/ApprovalItem 생성의 주인                       |
| Action     | Channel Adapter 실행                                                     |
| Policy     | 한도·톤·프리셋·키워드 (Goal 불변)                                        |
| Outcome    | 맞반응·시간·온도 등 → Goal Score 피드백                                  |
| Goals      | G1…G5 최적화 계층 (§7)                                                   |

---

## 3. Entity Model (Single Operator)

단일 운영자. `workspace_id` / org / member / role **없음**.  
필요 시 `user_id`는 Supabase `auth.users`의 **나 하나**만 참조 (선택).

### 3.1 Person

```
Person
  id, display_name, discover_meta
  active_workflow_id?
  ChannelIdentity[]   // blog | threads | instagram
  RelationshipState   // 1:1
  Timeline            // Activity projection
```

### 3.2 RelationshipState

```
stage, score, temperature
last_visit_at, last_like_at, last_comment_at, last_touch_at
```

### 3.3 Workflow

```
id, person_id
current_stage, current_state, next_action
waiting_until?, waiting_for?, priority, blocked_reason?, goal?
last_decision_id?, created_at, updated_at
```

**Stages:** `discover` → `warming` → `waiting_new_post` → `approval_pending` → `early_relationship` → `maintain` ⇄ `vip` / `risk`

**States:** `active` | `waiting` | `blocked` | `completed` | `cancelled`

Person당 active Workflow 최대 1. Workflow **관리 화면 없음** (Person Detail 표시만).

### 3.4 ActionJob

```
id, parent_workflow_id   // REQUIRED
person_id, channel
action_type: visit | like | comment | neighbor_request | threads_reply
risk: low | high
status: planned | executed | pending_approval | approved | rejected | …
draft_body?, draft_alternatives?, target_ref, scheduled_for?
decision_id?, bundle_id?, inbox_priority, …
```

고아 ActionJob 금지.

### 3.5 ApprovalItem / ActivityItem

```
ApprovalItem: workflow_id + action_job_id + presented_context + resolved_at?
ActivityItem: workflow_id?, kind, summary, …
  kinds: executed | observed | waiting | approval_created
       | approved | rejected | blocked | stage_changed | completed
```

Approval 생성 경로:

```
DecisionOutput create_approval → Workflow Update → ActionJob → ApprovalItem
```

### 3.6 Runtime support

`PerceptionEvent`, `DecisionRecord`, `PolicyProfile` (단수), `BriefSnapshot` (단수 행), `OutcomeDaily`, `ChannelConnection`

### 3.7 Risk matrix (default)

| Action                                   | Risk | Default                    |
| ---------------------------------------- | ---- | -------------------------- |
| visit, like                              | low  | 자동 → Activity            |
| comment, neighbor_request, threads_reply | high | Approval                   |
| 완전 자동                                | —    | 존재 가능, **기본값 아님** |

---

## 4. Screen Tree & Navigation

```
/(app)
  /today
  /today/activity
  /today/approvals
  /today/approvals/[jobId]
  /people
  /people/[personId]
  /discover
  /discover/[personId]
  /more
  /more/growth | policy | channels | logs | account

/(setup)   # 최초 1회: 채널 연결 · 톤 · Policy 기본값 · 기대치(10분)
```

### Happy path

```
앱 실행 → /today (Agent Brief)
  → 승인 시작 → /today/approvals → [jobId]
  → 승인/수정/거절/보류 → Inbox 비면 종료
```

Inbox 0 = **성공**. 저위험 실행 CTA를 Brief 메인으로 두지 않는다.

---

## 5. Agent Brief / Approval / Activity

### 5.1 Agent Brief (Home)

1. Agent 상태 (동기화·active/error·예상 개입 시간)
2. Activity Summary (+ 절약 시간)
3. Approval Inbox CTA
4. Growth Summary (온도·맞반응 등)

### 5.2 Approval Inbox

고위험만. 방문/공감 **절대 미포함**.

카드: 누구 · Workflow stage · why now · 요약 · 초안 · 예약 · 승인/수정/거절/보류

승인 시 Workflow advance. 거절 시 risk/wait 등 Policy 반응.

### 5.3 Activity Timeline

**보고 UI만.** 실행 콘솔 아님.  
Workflow 진행 이벤트(Executed / Waiting / Approval Created / Approved / …).

---

## 6. Decision Engine (v1.2 유지)

Decision은 거대 `if`가 아니라 **Stateless Rule Pipeline**이다.

### 6.1 Pipeline (순서 고정)

```
1  Normalize Events
2  Relationship Evaluation
3  Priority Calculation
4  Risk Evaluation
5  Goal Evaluation          ← Goal Scores (§7)
6  Workflow Transition
7  Action Candidate Generation
8  Approval Requirement Check
9  Policy Gates             ← 수단 제한
10 Outcome Feedback         ← Goal 피드백
11 Emit Output              ← Rule Priority + Goal Conflict
```

### 6.2 DecisionContext (read-only)

Person, RelationshipState, Workflow, PolicyProfile, Perceptions, recent Activity/Approvals/ActionJobs, OutcomeDaily, blackboard.

Rules는 DB를 쓰지 않는다. Engine만 DecisionOutput을 반환한다.

### 6.3 DecisionOutput (정확히 하나)

`workflow_update` | `create_action` | `create_approval` | `observe` | `skip` | `delay`

어댑터 실행·Approval insert는 Output을 소비하는 Worker가 한다.

### 6.4 Rule Priority & Conflict

Critical → High → Normal → Low.  
안전/한도 Critical이 Goal보다 앞선다(제약). 후보 선택은 **§7 Goal Conflict** 후 score.

Rule Catalog·Transition 조건의 상세는 구현 시 `domain/decision/rules/*`에 v1.2/v1.3 카탈로그를 그대로 이식한다 (SaaS 필드만 제거).

### 6.5 Agent tick

```
Perception
  → Decision (build context → runRulePipeline → DecisionRecord)
  → Workflow Update
  → Action Queue (low)
  → Approval Queue (high)
  → Action Execute
  → Outcome
  → BriefSnapshot refresh
```

`agentTick` / `decision.ts`에 비즈니스 if-사다리 금지. 판단은 `domain/decision/rules/*`만.

---

## 7. Agent Goal System (v1.3 유지)

Goals는 기능·UI가 아니다. **최적화 계층**이다.

| Rank | Code                 | Name                 |
| ---- | -------------------- | -------------------- |
| G1   | relationship_quality | 관계 품질 유지       |
| G2   | natural_interaction  | 자연스러운 상호작용  |
| G3   | minimize_user_time   | 사용자 시간 최소화   |
| G4   | sustained_growth     | 지속적 성장          |
| G5   | lagging_reach        | 조회·반응 (**후행**) |

**G5는 G1–G3를 이기지 못한다.**

### Goal Scores (내부 전용, UI 없음)

`relationship_health`, `trust_level`, `user_time_cost`(↑=나쁨), `growth_opportunity`, `engagement_potential`, `lagging_reach_proxy`

MVP: 결정적 공식. ML/LLM Goal 최적화는 이후.

### Conflict (요약)

유지/VIP vs 신규 발굴 → **G1**  
워밍 전 신청 → **G2**  
Approval 과다 vs 10분 → **G3**  
조회수 휴리스틱 vs G1–G3 → **G1–G3**

Policy는 Goal 순서를 바꾸지 않고 일일 한도 등 **수단만** 제한한다.  
Outcome은 Goal 달성 증거로 다음 tick Score에만 반영한다.

---

## 8. Data Flow

```
Channel Adapters (Blog / Threads / …)
  → PerceptionEvent
  → DecisionContext → RulePipeline → DecisionOutput
  → Workflow
       ├─ create_action  → ActionJob(planned) → Execute
       └─ create_approval → ActionJob(pending) → ApprovalItem → 나 승인 → Execute
  → ActivityItem + RelationshipState + OutcomeDaily + BriefSnapshot
  → (next tick) Goal Feedback
```

읽기 모델: `brief_snapshots` (단일), Approval inbox 쿼리, Activity feed.

---

## 9. Supabase Schema (Single User)

`workspace_id` / `organization_id` / member / role 컬럼 **없음**.  
RLS: **인증된 단일 운영자만** 전체 테이블 접근 (또는 서비스 롤 + 앱 서버만 접근). 테넌트 격리 불필요.

### 9.1 테이블 목록 (생성 권장 순서)

1. `channel_connections`
2. `policy_profile` (단일 행)
3. `persons`
4. `relationship_states`
5. `workflows`
6. `action_jobs`
7. `perception_events`
8. `decision_records`
9. `activity_items`
10. `approval_items`
11. `brief_snapshots` (단일 행)
12. `outcome_daily`
13. `channel_identities`

선택: `profiles`에 `auth.users.id` 1행 (표시 이름만).

### 9.2 DDL sketch

```sql
-- 단일 Policy
policy_profile (
  id boolean primary key default true check (id),  -- singleton
  preset text not null default 'default',
  low_risk_auto boolean not null default true,
  high_risk_auto_comment boolean not null default false,
  high_risk_auto_request boolean not null default false,
  daily_limits jsonb not null default '{}',
  quiet_hours jsonb not null default '{}',
  tone jsonb not null default '{}',
  banned_phrases text[] not null default '{}',
  weekly_goals jsonb not null default '{}',
  discover_keywords text[] not null default '{}',
  updated_at timestamptz not null default now()
);

channel_connections (
  id uuid primary key,
  channel text not null check (channel in ('blog','threads','instagram')),
  status text not null,
  credentials_encrypted jsonb,
  last_synced_at timestamptz,
  unique (channel)
);

persons (
  id uuid primary key,
  display_name text not null,
  active_workflow_id uuid,
  discover_meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

relationship_states (
  person_id uuid primary key references persons on delete cascade,
  stage text not null,
  score numeric not null default 0,
  temperature numeric not null default 0,
  last_visit_at timestamptz,
  last_like_at timestamptz,
  last_comment_at timestamptz,
  last_touch_at timestamptz,
  updated_at timestamptz not null default now()
);

workflows (
  id uuid primary key,
  person_id uuid not null references persons on delete cascade,
  current_stage text not null,
  current_state text not null,
  next_action text not null default 'none',
  waiting_until timestamptz,
  waiting_for text,
  priority int not null default 0,
  blocked_reason text,
  goal text,
  last_decision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index workflows_one_active_per_person
  on workflows (person_id)
  where current_state in ('active','waiting','blocked');

action_jobs (
  id uuid primary key,
  parent_workflow_id uuid not null references workflows on delete cascade,
  person_id uuid not null references persons,
  channel text not null,
  action_type text not null,
  risk text not null,
  status text not null,
  draft_body text,
  draft_alternatives jsonb,
  target_ref jsonb not null default '{}',
  scheduled_for timestamptz,
  decision_id uuid,
  bundle_id uuid,
  inbox_priority int not null default 0,
  reject_reason text,
  executed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

perception_events (
  id uuid primary key,
  person_id uuid references persons,
  channel text not null,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  ingested_at timestamptz not null default now()
);

decision_records (
  id uuid primary key,
  person_id uuid references persons,
  workflow_id uuid references workflows,
  perception_event_id uuid references perception_events,
  decision_type text not null,
  reason_short text not null,
  reason_detail jsonb not null default '{}',  -- includes goal.scores, rule_ids
  inputs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

activity_items (
  id uuid primary key,
  workflow_id uuid references workflows,
  person_id uuid references persons,
  action_job_id uuid references action_jobs,
  decision_id uuid references decision_records,
  kind text not null,
  summary text not null,
  created_at timestamptz not null default now()
);

approval_items (
  id uuid primary key,
  workflow_id uuid not null references workflows on delete cascade,
  action_job_id uuid not null references action_jobs on delete cascade unique,
  person_id uuid not null references persons,
  inbox_priority int not null default 0,
  bundle_id uuid,
  presented_context jsonb not null default '{}',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

brief_snapshots (
  id boolean primary key default true check (id),  -- singleton
  agent_status text not null,
  status_detail jsonb not null default '{}',
  activity_summary jsonb not null default '{}',
  approval_count int not null default 0,
  intervention_minutes_est numeric not null default 0,
  time_saved_minutes_est numeric not null default 0,
  growth_summary jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

outcome_daily (
  date date primary key,
  intervention_minutes_est numeric not null default 0,
  time_saved_minutes_est numeric not null default 0,
  auto_visit_count int not null default 0,
  auto_like_count int not null default 0,
  observe_count int not null default 0,
  waiting_count int not null default 0,
  approval_pending_count int not null default 0,
  approval_done_count int not null default 0,
  temperature_up_count int not null default 0,
  mutual_reaction_count int not null default 0,
  lagging_metrics jsonb not null default '{}'
);

channel_identities (
  id uuid primary key,
  person_id uuid not null references persons on delete cascade,
  channel text not null,
  external_key text not null,
  state jsonb not null default '{}',
  profile_snapshot jsonb not null default '{}',
  unique (channel, external_key)
);
```

stage/action check 제약은 v1.1과 동일 enum을 사용한다.

### 9.3 Access

- 브라우저 → Next./shared Route Handlers / Server Actions → Supabase.
- Agent tick: Vercel Cron → Route Handler (secret) 또는 Supabase Edge + service role.
- “테넌트 RLS 정책 트리” 불필요. 단일 DB = 내 Agent DB.

---

## 10. API (Personal Supervisor)

Workspace 경로·테넌트 헤더 없음.

| Method | Path                     | Purpose                                                   |
| ------ | ------------------------ | --------------------------------------------------------- |
| GET    | `/today`                 | BriefSnapshot + 요약                                      |
| GET    | `/activity`              | Activity timeline                                         |
| GET    | `/approvals`             | Open ApprovalItems                                        |
| GET    | `/approvals/:id`         | Card (+ workflow context)                                 |
| POST   | `/approvals/:id/approve` | body: draft?/schedule?                                    |
| POST   | `/approvals/:id/reject`  | body: reason?                                             |
| POST   | `/approvals/:id/snooze`  | body: until                                               |
| GET    | `/people`                | filters: stage, q                                         |
| GET    | `/people/:id`            | Person + Relationship + Active Workflow + recent Activity |
| GET    | `/discover`              | policy keywords + candidates                              |
| PATCH  | `/discover`              | keywords / dismiss candidate                              |
| GET    | `/policy`                | PolicyProfile                                             |
| PATCH  | `/policy`                | limits, tone, preset, …                                   |
| GET    | `/growth`                | outcome_daily 주간                                        |
| GET    | `/channels`              | connections                                               |
| POST   | `/channels`              | connect / reconnect                                       |
| GET    | `/logs`                  | action_jobs audit                                         |
| POST   | `/agent/tick`            | cron/manual Agent loop (secret)                           |
| POST   | `/agent/execute/:jobId`  | execute planned/approved job                              |

Approve → execute → Workflow advance → Activity → Brief refresh (v1.1과 동일 의미, workspace 없음).

---

## 11. State Management & Components

### Client

- TanStack Query. Keys: `today`, `activity`, `approvals`, `approval`, `people`, `person`, `discover`, `policy`, `growth`.
- Realtime optional: `approval_items` (unresolved), `brief_snapshots`.
- “오늘 할 일” 스토어 없음. 저위험 낙관적 실행 없음.

### Layout

```
src/
  app/(app)/today|people|discover|more/...
  app/(setup)/...
  components/brief|activity|approval|person|discover|policy|shell
  domain/
    person|relationshipState|workflow|actionJob|approval|activity|policy
    decision/
      context|output|engine|conflict|goals
      rules/*  (pipeline stages)
  services/api|adapters
  workers/agentTick + steps/*
```

TabBar: 오늘·사람들·발굴·더보기만.

---

## 12. Deployment

| Piece     | Choice                                                   |
| --------- | -------------------------------------------------------- |
| App       | Next./shared on **Vercel**                               |
| DB / Auth | **Supabase** (단일 프로젝트)                             |
| Cron      | Vercel Cron → `POST /agent/tick`                         |
| Secrets   | 채널 자격증명·tick secret·Supabase service role (서버만) |

멀티 리전 테넌시·조직 빌링·Seat 없음.

---

## 13. MVP

| In                                                             | Out                      |
| -------------------------------------------------------------- | ------------------------ |
| Blog 채널 + visit/like 자동                                    | Instagram                |
| comment + neighbor_request Approval                            | DM                       |
| Agent Brief / Activity / Approval / People / Discover / Policy | 결제·플랜·팀             |
| Workflow + Rule Engine + Goals                                 | Workflow 관리 UI         |
| Goal 결정적 공식                                               | ML Goal 최적화           |
| Vercel Cron tick                                               | SaaS onboarding / invite |

**Done when:** 앱 없이도 Agent tick 동작 · 저위험은 Activity만 · 고위험은 Approval만 · Brief 4블록 · 개입 ≤10분 추정 · 탭 4개 · DB에 workspace 없음.

---

## 14. Future (Personal 확장)

| 단계 | 내용                                                      |
| ---- | --------------------------------------------------------- |
| F1   | Threads 전체 Adapter                                      |
| F2   | Realtime push · 개입시간 학습                             |
| F3   | Expanded/Max 자동 프리셋 (명시 동의)                      |
| F4   | Outcome → Policy 제안 · Goal 공식 가중치 튜닝 (계층 고정) |
| F5   | Instagram under Person                                    |
| F6   | DM Approval                                               |

새 탭·SaaS 기능 추가 없음.

---

## 15. Engineering Invariants

1. Domain bucket: Perception | Decision | Workflow | Action | Policy | Outcome.
2. UI: Activity | Approval | Person (+ Policy in 더보기).
3. 탭 4개만. Workflow 관리 페이지 없음.
4. ActionJob에 `parent_workflow_id` 필수.
5. ApprovalItem은 Workflow Approval Queue만 생성.
6. Default: 저위험 자동 / 고위험 승인.
7. Brief 순서: Status → Activity → Approval → Growth.
8. Decision = Rule Pipeline only.
9. Goals G1≻G2≻G3≻G4≻G5 고정. G5 < G1–G3.
10. Goal Score UI 없음 (MVP).
11. **Workspace / Billing / RBAC / multi-tenant 코드·스키마 도입 금지.**
12. API에 workspace 세그먼트 금지.

---

## 16. Entity diagram

```
(auth.users — me only, optional)
PolicyProfile (singleton)
BriefSnapshot (singleton)
Person 1──1 RelationshipState
Person 1──0..1 active Workflow
Person 1──* ChannelIdentity
Workflow 1──* ActionJob
Workflow 1──* ApprovalItem
Workflow 1──* ActivityItem
Goals → RulePipeline → DecisionOutput → Workflow → Action/Approval
OutcomeDaily → Goal Feedback
```

---

## v1.4 변경사항

v1.3 (SaaS Multi-tenant Spec) → **v2.0 Personal AI Relationship Agent** 로의 전환 요약.  
(요청상 변경 기록 섹션명: **v1.4 변경사항**)

### 제거함

| 제거                                                      | 이유                          |
| --------------------------------------------------------- | ----------------------------- |
| Workspace / Organization / Team / Member / Owner / Invite | 단일 운영자                   |
| Billing / Subscription / Plan / Seat                      | Personal                      |
| Multi-tenant / Tenant Isolation                           | 단일 DB                       |
| Workspace Settings / Workspace API / Workspace Context    | 불필요                        |
| Role / RBAC / ACL / 복잡한 사용자 RLS                     | 나 혼자                       |
| `workspace_id` 및 테넌트 FK 전면                          | 스키마 단순화                 |
| `workspaces`, `profiles` 팀 모델                          | singleton policy/brief로 대체 |
| 멀티유저 권한·초대 온보딩                                 | setup 1회만                   |
| SaaS 마케팅용 “플랜 쿼터” 서사                            | Policy 일일 한도로 충분       |

### 유지함

| 유지                                           | 비고                              |
| ---------------------------------------------- | --------------------------------- |
| AI Agent Platform 철학                         | Supervisor + Agent                |
| Agent Brief / Approval / Activity / Person CRM | UI 철학                           |
| 탭: 오늘·사람들·발굴·더보기                    | IA                                |
| Workflow stages/states                         | discover…risk                     |
| ActionJob ⊂ Workflow                           | parent_workflow_id                |
| Approval = 고위험만                            | visit/like 자동                   |
| Decision Rule Pipeline                         | §6 순서 고정                      |
| Goal Hierarchy G1…G5                           | §7                                |
| Perception→…→Outcome→Goal Feedback             | 런타임                            |
| Next./shared + Vercel + Supabase               | 배포만 명시적으로 Personal에 고정 |
| North Star ≤10분                               | KPI                               |

### 단순화함

| 영역           | Before (v1.3)                   | After (v2.0)                |
| -------------- | ------------------------------- | --------------------------- |
| 테넌시         | workspace 스코프 전 테이블      | 스코프 없음 / singleton     |
| API            | `/brief` + workspace 암시       | `/today`, `/people`, … 평면 |
| Policy         | `policy_profiles` per workspace | `policy_profile` 1행        |
| Brief          | per workspace_id PK             | singleton 1행               |
| Outcome        | (workspace_id, date)            | (date) PK                   |
| Auth           | 멤버십 RLS                      | 단일 운영자 또는 서버-only  |
| 더보기·Account | 구독·플랜                       | 채널·Policy·로그만          |
| 문서 톤        | SaaS 제품 명세                  | Personal Agent 운영 명세    |

### 의도적으로 안 한 것

- Agent/Workflow/Decision/Goal/Approval UX 동작 변경 없음
- 새 메뉴·새 기능 추가 없음
- Goal·Rule 알고리즘 폐기 없음 (SaaS 필드 참조만 제거)

---

**End of Specification v2.0 — Personal AI Relationship Agent**
