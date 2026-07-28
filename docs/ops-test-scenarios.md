# Ops test scenarios — CDP Worker (like / comment / neighbor)

운영 수정 반영 후 확인 체크리스트. Worker 로그와 Admin `/admin/actions` UI를 함께 본다.

## 사전 준비

1. Chrome CDP (전용 프로필, headless):

```bash
./scripts/start-cdp-chrome.sh
# 최초 로그인만:
# CDP_HEADLESS=0 ./scripts/start-cdp-chrome.sh
# → 네이버 로그인 후 스크립트/Chrome 재시작은 headless 기본값으로
```

프로필 경로: `~/ai-sns-manager/chrome-profile` (기본 Chrome 프로필과 분리)

2. Worker / 앱 실행은 로컬에서 사용자가 기동.

---

## 1) 공감 없는 글 + like 단독

**기대**
- `action_jobs.status = skipped` (실패 아님)
- `target_ref.execution_result`:
  - `outcome: not_available`
  - `reason_code: LIKE_BUTTON_NOT_AVAILABLE`
  - `reason_message: 공감 버튼이 없는 게시글`
- UI: **공감 불가 (버튼 없음)**
- 오늘 성공/처리량 카운트 **제외**

**로그 예**
```
[worker] like skipped job=… reason=LIKE_BUTTON_NOT_AVAILABLE
phase=result result=skipped skipReason=LIKE_BUTTON_NOT_AVAILABLE
```

---

## 2) 공감 없는 글 + comment 같이 실행 (both)

**기대**
- comment: `executed`
- like: `skipped` + `LIKE_BUTTON_NOT_AVAILABLE`
- 승인/번들 전체는 **성공** 처리
- 기록 개념: `{ comment: executed, like: skipped, reason: LIKE_BUTTON_NOT_AVAILABLE }`

**로그 예**
```
[worker] comment … result=executed
[worker] like skipped … LIKE_BUTTON_NOT_AVAILABLE
```

---

## 3) 서로이웃 버튼 없는 블로그

**기대**
- `status = excluded` (또는 skipped → UI 제외)
- `reason_code: NEIGHBOR_BUTTON_NOT_AVAILABLE`
- 실패 카운트 **제외**, 재시도 대상 아님
- `neighbor_exclusions`에 candidate 제외 기록
- Admin: `failed_step: button_search`, trail에 `page_loaded → relation_detect → button_search`

**로그 예**
```
[worker] neighbor_request excluded … NEIGHBOR_BUTTON_NOT_AVAILABLE
[cdp-worker] candidate excluded blogId=… reason=NEIGHBOR_BUTTON_NOT_AVAILABLE
```

---

## 4) 정상 서로이웃 신청

**기대**
- `status = executed`
- trail: `page_loaded → relation_detect → button_search → button_click → … → verify`
- 오늘 성공 카운트 +1, 남은 한도 −1

---

## 5) Chrome 프로필 오류 재현 / 방지

**재현 (하지 말 것 — 참고만)**
- 기본 Chrome 프로필(`~/Library/Application Support/Google/Chrome`)에 `--remote-debugging-port`로 두 번째 인스턴스 실행
- 또는 동일 `user-data-dir`로 Chrome을 두 개 띄움 → “프로필을 여는 동안 문제가 발생했습니다”

**정상**
- `./scripts/start-cdp-chrome.sh`만 사용
- 이미 CDP가 떠 있으면 **재사용** (두 번째 launch 없음)
- stale `SingletonLock`은 스크립트가 정리하거나, 다른 프로세스가 잡고 있으면 명확한 ERROR 로그

**로그인 유지**
- 전용 프로필에 쿠키 저장 → headless 재시작 후에도 세션 유지
- CDP `connectOverCDP`만 사용 (새 visible window 없음)

---

## 처리량 표시

오늘 서로이웃 예:

```
성공 N · 실패 N · 제외 N · 남은 한도 N
```

- 성공 = `executed`
- 실패 = `failed` / `permanently_failed`
- 제외 = `excluded` / `skipped` (버튼 없음 등)
- 한도 차감 = 성공만
