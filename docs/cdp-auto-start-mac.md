# macOS: CDP Chrome 자동 실행 (로그인 시)

AI SNS Manager는 Playwright가 **이미 실행 중인 Chrome**에 CDP로 붙습니다.  
재부팅·로그인 후 Chrome을 수동으로 띄우지 않도록, 이 문서는 **전용 CDP Chrome**을 로그인 시 자동 기동하는 방법을 정리합니다.

> 범위: 운영 스크립트 / launchd / 문서만.  
> Playwright · Approval · ActionJob · CDP Adapter · 네이버 자동화 코드는 **변경하지 않습니다**.

---

## 1. 현재 프로젝트가 기대하는 CDP 방식

| 항목 | 값 |
|------|-----|
| 연결 URL | `http://127.0.0.1:9222` |
| 환경변수 | `USE_CDP=true`, `CDP_URL=http://127.0.0.1:9222` |
| 연결 API | `chromium.connectOverCDP(CDP_URL)` (`BrowserSessionManager`) |
| 프로필 | **기본 Chrome 프로필이 아닌** 별도 `--user-data-dir` |
| 권장 프로필 경로 | `$HOME/ai-sns-manager/chrome-profile` |
| 실행 | `./scripts/start-cdp-chrome.sh` (기본 headless, 프로필 lock 처리) |

로그인 세션이 필요하면 최초 1회만:

```bash
CDP_HEADLESS=0 ./scripts/start-cdp-chrome.sh
# 네이버 로그인 후, 이후에는 기본(headless)으로 재기동
```

`.env` / `.env.example` 예시:

```bash
USE_CDP=true
CDP_URL=http://127.0.0.1:9222
```

Chrome recent 빌드는 **기본 프로필 경로**에서 remote debugging을 막는 경우가 많습니다.  
그래서 일상용 Chrome과 **분리된 user-data-dir**로 띄워야 합니다.

수동 실행(기존 문서와 동일 계열):

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$HOME/chrome-cdp-profile" \
  --no-first-run \
  --no-default-browser-check
```

확인:

```bash
curl -s http://127.0.0.1:9222/json/version
# JSON이 보이면 OK
```

그 Chrome 창에서 **네이버 로그인**을 한 번 해 두면, 같은 user-data-dir를 쓰는 한 세션이 유지됩니다.

---

## 2. 자동 실행 구성 요소

| 파일 | 역할 |
|------|------|
| `scripts/start-cdp-chrome.sh` | CDP Chrome 기동 (이미 9222면 skip) |
| `scripts/com.naver.cdp.chrome.plist.example` | launchd 로그인 시 실행 예시 |
| 이 문서 | 설치·검증·주의사항 |

---

## 3. 스크립트 수동 테스트

프로젝트 루트에서:

```bash
chmod +x scripts/start-cdp-chrome.sh
./scripts/start-cdp-chrome.sh
curl -s http://127.0.0.1:9222/json/version
```

환경변수(선택):

```bash
export CDP_PORT=9222
export CDP_HOST=127.0.0.1
export CDP_USER_DATA_DIR="$HOME/chrome-cdp-profile"
# export CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
./scripts/start-cdp-chrome.sh
```

로그:

- 스크립트 stdout: `[cdp-chrome] ...`
- Chrome 상세: `/tmp/cdp-chrome.log`

---

## 4. launchd 등록 (로그인 시 자동 실행)

### 4.1 plist 복사

```bash
# 프로젝트 루트에서 — 절대 경로로 바꿔 넣으세요
PROJECT_ROOT="/Users/YOUR_USER/.../AI SNS Manager"   # ← 교체
HOME_DIR="$HOME"

cp "$PROJECT_ROOT/scripts/com.naver.cdp.chrome.plist.example" \
  ~/Library/LaunchAgents/com.naver.cdp.chrome.plist
```

### 4.2 경로 치환

`~/Library/LaunchAgents/com.naver.cdp.chrome.plist` 안의 플레이스홀더를 모두 교체합니다.

| 플레이스홀더 | 예시 |
|--------------|------|
| `REPLACE_WITH_ABSOLUTE_PROJECT_ROOT` | `/Users/dohee/Desktop/바이브코딩/AI SNS Manager` |
| `REPLACE_WITH_HOME` | `/Users/dohee` |

예 (macOS `sed`):

```bash
PLIST="$HOME/Library/LaunchAgents/com.naver.cdp.chrome.plist"
# PROJECT_ROOT / HOME_DIR 은 위에서 설정한 값
sed -i '' "s|REPLACE_WITH_ABSOLUTE_PROJECT_ROOT|${PROJECT_ROOT}|g" "$PLIST"
sed -i '' "s|REPLACE_WITH_HOME|${HOME_DIR}|g" "$PLIST"
```

### 4.3 로드

```bash
launchctl unload ~/Library/LaunchAgents/com.naver.cdp.chrome.plist 2>/dev/null || true
launchctl load  ~/Library/LaunchAgents/com.naver.cdp.chrome.plist
```

즉시 한 번 실행(로드만으로 안 뜬 경우):

```bash
launchctl start com.naver.cdp.chrome
```

### 4.4 검증

```bash
curl -s http://127.0.0.1:9222/json/version
cat /tmp/com.naver.cdp.chrome.out.log
cat /tmp/com.naver.cdp.chrome.err.log
```

앱에서는 `USE_CDP=true` 상태로 이웃/승인 실행이 기존처럼 붙으면 성공입니다.

### 4.5 해제

```bash
launchctl unload ~/Library/LaunchAgents/com.naver.cdp.chrome.plist
rm ~/Library/LaunchAgents/com.naver.cdp.chrome.plist
```

---

## 5. 네이버 세션 유지

1. CDP Chrome이 **`$HOME/chrome-cdp-profile`** 을 쓰는지 확인  
2. 그 창에서 naver.com / blog.naver.com 로그인  
3. 재부팅 후 같은 프로필로 다시 뜨면 쿠키·세션이 이어짐  

주의:

- 일상용 Chrome(`~/Library/Application Support/Google/Chrome`)과 **섞지 말 것**
- CDP 프로필을 지우고 다시 만들면 로그인이 풀림  
- 일반 Chrome만 켜고 CDP 플래그 없이 쓰면 `connectOverCDP` 실패

(선택) 일상 프로필을 **한 번만** 복사해 CDP 프로필 시드로 쓰는 방법:

```bash
# Chrome을 완전히 종료한 뒤
killall "Google Chrome" 2>/dev/null || true
sleep 2
rm -rf "$HOME/chrome-cdp-profile"
cp -R "$HOME/Library/Application Support/Google/Chrome" "$HOME/chrome-cdp-profile"
./scripts/start-cdp-chrome.sh
```

이후에는 복사본(`chrome-cdp-profile`)만 CDP용으로 쓰면 됩니다.

---

## 6. CDP 주소 / 환경변수 확인 결과

코드(`BrowserSessionManager`)는 이미 환경변수 우선입니다.

```text
CDP_URL  = process.env.CDP_URL  || "http://127.0.0.1:9222"
USE_CDP  = true|1|yes 일 때만 connectOverCDP
```

| 결론 | 내용 |
|------|------|
| 하드코딩 | 기본값만 `http://127.0.0.1:9222` (fallback) |
| 운영 권장 | `.env`에 `CDP_URL` 명시 (이미 권장됨) |
| 포트 변경 시 | `start-cdp-chrome.sh`의 `CDP_PORT`와 `.env`의 `CDP_URL`을 **같이** 맞출 것 |
| 코드 변경 | **불필요** (이 작업 범위에서 Adapter 수정하지 않음) |

---

## 7. 트러블슈팅

| 증상 | 확인 |
|------|------|
| `connectOverCDP` 실패 | `curl http://127.0.0.1:9222/json/version` |
| 포트는 열렸는데 contexts empty | Chrome이 다른 user-data-dir로 떠 있는지 / 완전 종료 후 스크립트 재실행 |
| 로그인 안 됨 | CDP Chrome 창에서 수동 로그인 (Adapter는 CDP 모드에서 자동 재로그인하지 않음) |
| launchd가 안 뜸 | plist 절대 경로, `chmod +x scripts/start-cdp-chrome.sh`, `/tmp/com.naver.cdp.chrome.*.log` |
| 일반 Chrome과 충돌 | 일반 Chrome은 기본 프로필, CDP는 `chrome-cdp-profile` — 둘 다 동시 사용 가능 |

---

## 8. 하지 않는 것 (의도적)

- Playwright 실행 로직 / Approval / ActionJob / CDP Adapter 변경 없음  
- 앱 서버가 Chrome을 대신 띄우지 않음 (항상 **외부 Chrome + connectOverCDP**)  
- 기본 시스템 Chrome 프로필에 `--remote-debugging-port`를 걸지 않음  
