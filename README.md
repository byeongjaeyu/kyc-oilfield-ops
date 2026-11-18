# 만땅 — 주유소 운영 장부

주변 가격과 마진, 기름·소모품 재고, 법정 검사 기한을 챙기는 주유소 운영 도구. 기본은 직접 운영이고, 임대 중이면 계약 일정·임대료 입금과 임대인·임차인 나눠 보기가 더해집니다.
로그인 없이 예시 데이터로 둘러볼 수 있습니다 (로그인 화면의 "로그인 없이 둘러보기").
GitHub Actions 가 정해진 시간에 데이터를 수집·요약해서 **Supabase** 에 저장하고, 텔레그램으로 알림을 보냅니다.
대시보드(`web/`)는 GitHub Pages 에 배포되는 정적 사이트이고, **초대받은 회원만 이메일 링크로 로그인**해서 봅니다.

| 역할 | 볼 수 있는 것 |
|---|---|
| 임대인 (owner) | 전부 + 회원 관리 (항상) |
| 임차인 (tenant) | 메뉴별 보기·수정을 임대인이 회원 관리 화면에서 체크로 정함 (`role_permissions` 표). 지금은 전부 허용 |

대시보드: https://byeongjaeyu.github.io/kyc-oilfield-ops/

소개 영상 (20초, 예시 데이터): [docs/media/promo.mp4](docs/media/promo.mp4)

## 로드맵 (공수 낮은 순)

| # | 모듈 | 상태 |
|---|---|---|
| 1 | 업계 정책 주간 요약 (#6) | ✅ 가동 |
| 2 | 경쟁 주유소 가격 — 오피넷 반경 5km (#4) | ✅ 가동 |
| 3 | 부지가치 — 실거래가·개발 뉴스 (#5) | ✅ 가동 (공시지가는 추가 예정) |
| 4 | 법정검사·보험 D-DAY + 결과 보관 (#3) | ✅ 가동 (Supabase) |
| 5 | 계약서 PDF → 조항 추출 → 일정·캘린더 구독 (#2) | ✅ 가동 |
| 6 | 입금 대사 + 미입금 알림 (#1) | ✅ 가동 |

## 구조

```
jobs/                  수집·요약 잡 (Node 22 + TypeScript, tsx 로 실행)
  config/              키워드·반경·알림 기준 등 설정
  lib/store.ts         결과 저장 — Supabase datasets 테이블 (키 없으면 로컬 파일)
  policy-weekly.ts     #6 주간 정책 리포트
  prices-daily.ts      #4 반경 5km 휘발유·경유 가격 + 경쟁력 알림 (주유소별)
  urea.ts              오피넷 요소수 판매처 재고·가격 → 주유소별 반경 5km 시세·품절 감시
  markets.ts           국제유가(WTI·브렌트)·원/달러·전국 평균 판매가 → market/latest.json (공통)
  land-weekly.ts       #5 주유소 주변 토지 실거래가 + 개발·도시계획 뉴스
  inspections-daily.ts #3 법정 검사 + #2 계약 일정 + #1 임대료 미납 텔레그램
supabase/
  migrations/          DB 스키마·권한(RLS). main 에 푸시하면 자동 적용
  functions/
    extract-contract/  계약서 PDF → Gemini → 만기·갱신·인상·원상복구 + 원문 인용 (임대인만)
    calendar-ics/      비밀 토큰 주소로 계약·검사 일정 캘린더 구독 피드
    bank-notify/       휴대폰이 넘긴 은행 입금 문자 → 입금 기록 (비밀 토큰 주소, 계약 입금자만 저장)
    opinet-search/     주유소 등록 신청 화면의 오피넷 주유소 검색
    ai-summarize/      잡의 뉴스 요약용 Gemini 프록시 (서비스 키로만 호출)
                       bankParse.ts 는 대시보드의 통장 엑셀 읽기와 같이 씀
web/                   대시보드 (Vite + React + supabase-js)
.github/workflows/
  policy-weekly.yml    매주 월 07:17 KST
  prices-daily.yml     4시간마다 (01·05·09·13·17·21시 17분 KST)
  land-weekly.yml      매주 월 07:47 KST
  inspections-daily.yml 매일 08:13 KST (법정 검사·계약 기한·임대료 미납)
  supabase-migrations.yml  supabase/migrations 변경 시 DB 적용
  deploy-pages.yml     web/ 변경 시 Pages 배포
```

## 처음 설정

1. **Pages 켜기**: Settings → Pages → Source 를 **GitHub Actions** 로
2. **Secrets 등록**: Settings → Secrets and variables → Actions → New repository secret

   | 이름 | 필수 | 용도 |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | 권장 | 텔레그램 알림 (@BotFather 로 봇 생성) |
   | `TELEGRAM_CHAT_ID` | 권장 | 알림 받을 채팅 ID |
   | `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` | 선택 | 네이버 뉴스 검색 API. 없으면 Google 뉴스 RSS 사용 |
   | `OPINET_API_KEY` | #4 필수 | 오피넷 유가정보 API 키 |
   | `SUPABASE_DATA_KEY` | 필수 | Supabase **secret(service_role) 키**. 잡이 데이터를 쓰고 읽을 때 사용 |
   | `SUPABASE_ACCESS_TOKEN` | 마이그레이션 자동 적용 | supabase.com → Account → Access Tokens |
   | `SUPABASE_DB_PASSWORD` | 마이그레이션 자동 적용 | 프로젝트 만들 때 정한 DB 비밀번호 |
   | `DATA_GO_KR_KEY` | #5 필수 | 공공데이터포털 인증키 (국토교통부 토지 매매 실거래가 활용신청). Decoding/Encoding 어느 쪽이든 됨 |

   뉴스 AI 요약은 Supabase Edge Function Secrets 의 `GEMINI_API_KEY` 를 `ai-summarize` 함수로 경유해서 씁니다 (GitHub 에 키를 따로 넣지 않음).
   모델은 Supabase Secrets 의 `GEMINI_SUMMARY_MODEL` (기본 `gemini-3.8-flash`).
   오피넷 이름 검색이 다른 주유소를 잡으면 Variables 에 `OPINET_STATION_ID` (오피넷 주유소 ID) 지정.
3. **첫 실행**: Actions → *Weekly policy report*, *Competitor prices* → Run workflow

### 텔레그램 채팅 ID 얻기
봇에게 아무 메시지나 보낸 뒤 `https://api.telegram.org/bot<토큰>/getUpdates` 를 열면 `chat.id` 가 보입니다.

## 오피넷 호출 한도 관리

오피넷 키는 하루 호출 한도(300회)가 있습니다. 대시보드는 오피넷을 직접 부르지 않고, 저장소에 커밋된 JSON 만 읽습니다.
API 를 부르는 곳은 `prices-daily` 잡 하나뿐이고 한 번에 2회(휘발유·경유 반경 조회), 4시간마다 돌아 하루 약 12회입니다.

- **수집 캐시**: 마지막 수집 후 3시간 안에는 잡을 다시 돌려도 오피넷을 부르지 않습니다. 수동 실행에서 `force` 를 체크하면 무시
- **호출 예산**: `prices/usage.json`(Supabase datasets)에 오늘 호출 수를 기록하고, 250회에 닿으면 더 부르지 않고 멈춥니다
- **알림 중복 방지**: 같은 조건(예: 평균보다 30원 이상 비쌈)은 처음 생길 때 한 번만 알림
- 기준값은 `jobs/config/prices.ts` 의 `CACHE`

## 로컬 실행

```bash
npm install
cp .env.example .env        # 키 입력
npm run policy:weekly       # 실제 수집 (+ 텔레그램)
npm run policy:sample       # 샘플 기사로 테스트 → .sample-data/ (커밋 안 됨)
npm run prices:daily        # 오피넷 반경 가격 (SUPABASE_DATA_KEY 없으면 data/ 로컬 파일)
npm run land:weekly         # 실거래가 + 개발 뉴스

cd web && npm install
npm run dev                 # 대시보드 (Supabase 에 로그인해서 봄)
```

## Edge Functions

`supabase/functions/` 는 기록용 원본이고, 배포는 Supabase 에 직접 합니다 (Claude 가 Supabase 연결로 배포).
계약서 AI 추출에는 Supabase → Edge Functions → Secrets 의 `GEMINI_API_KEY` 가 필요합니다 (모델 기본값 `gemini-3.8-flash`, `GEMINI_MODEL` 로 변경).
키가 없으면 계약 항목을 직접 입력합니다. 계약서처럼 민감한 문서이므로 결제를 등록한 유료 등급 키를 쓰세요. 비용은 계약서 한 건에 수십 원 수준입니다.

## 입금 확인 (#1)

- 확정한 계약의 월 임대료·지급일·인상 조항·부가세로 월별 받을 금액(`rent_charges`)을 DB 트리거가 만든다. 인상분은 추정치라 대시보드에서 월별로 고칠 수 있음 (고친 금액은 자동 계산이 덮어쓰지 않음)
- 입금은 두 경로로 들어온다
  - 통장 내역 엑셀/CSV 업로드: 파일은 브라우저에서만 읽고, 계약 입금자명과 맞는 입금만 저장 (SheetJS, EUC-KR CSV 지원)
  - 입금 문자 자동 전달: 아이폰 단축어 / 안드로이드 MacroDroid 가 문자 본문을 `bank-notify` 로 POST
- 입금이 들어오면 DB 트리거가 입금자명(㈜·주식회사·띄어쓰기 무시)으로 계약을 찾고, 납기 전후의 가장 이른 미납 월에 연결. 여러 번 나눠 낸 입금은 합산
- 같은 날·같은 금액·같은 입금자는 한 건으로 봄 (문자와 엑셀로 두 번 들어와도 중복 없음)
- 미납 알림: 납기 다음 날, 3·7·14일 지남, 그 뒤 매주 텔레그램
- 임차인은 기본 보기만 가능 (자기 임대료를 완납 처리하지 못하게). 회원 관리에서 바꿀 수 있음

## 소모품 재고·주문

- 품목: 주유소에서 흔히 쓰는 소모품 기본 목록(요소수·불스원샷·워셔액·비닐장갑·롤지·흡착포 등)에서 고르거나 직접 추가. 분류·단위·발주점·주문 수량·거래처·바코드
- 기록: 입고·판매·실사(그 수로 맞춤)·보정. 트리거가 재고를 고치고, 실사로 줄어든 양은 사용량으로 보고 "약 N일분"을 계산
- 바코드: 휴대폰 카메라(아이폰은 읽기 엔진을 그때 불러옴) 또는 블루투스·USB 리더기
- 주문: 발주점 이하 품목을 거래처별 주문서로 묶어 문자·이메일 앱을 바로 열거나 복사, 보낸 주문은 "받음"으로 입고
- 알림: 발주점 이하로 새로 떨어진 품목은 아침 기한 알림에 같이, 주변 요소수 품절이 늘면 경고

## 계정·주유소 (여러 주유소)

- **사이트 관리자**(개발자): 주유소 등록 신청을 승인·반려하고 의견·버그에 답한다. 주유소 데이터(계약·입금·검사 등)는 그 주유소 회원만 볼 수 있어 사이트 관리 화면에 나오지 않는다. 버그는 **데모 주유소**(임대인·임차인 역할 둘 다)에서 재현한다
- **가입**: 누구나 이메일 링크로 로그인할 수 있다. 주유소 회원이 되기 전에는 아무 데이터도 보이지 않는다
- **주유소 등록**: 로그인 → 오피넷에서 주유소 검색 → 내 역할(임대인/임차인) → 사업자등록번호·사업자등록증 → 사이트 관리자 승인 → 신청자가 그 주유소의 **관리자**
- **주유소 관리자**: 임대인·임차인 초대(이미 가입했으면 바로, 아니면 그 이메일로 첫 로그인 때 합류), 관리자 지정·해제(최소 1명), 역할별 메뉴 권한, 알림 받을 텔레그램 채팅
- 모든 데이터에 `station_id` 가 있고 RLS 로 회원인 주유소만 보인다. 수집 데이터 키는 `st/<주유소 id>/prices/…`, `st/<주유소 id>/land/…`, 업계 정책은 공통 `policy/…`
- 잡은 승인된 주유소마다 돈다. 가격은 오피넷 ID, 부지는 실거래가 지역코드(법정동코드 앞 5자리)가 있어야 모인다 (승인할 때 사이트 관리자가 확인)
- 알림은 주유소별 텔레그램 채팅으로. 데모 주유소와 업계 정책 리포트는 개발자 채팅(`TELEGRAM_CHAT_ID`)으로도 간다
- Edge Function `opinet-search`(등록 신청 화면의 주유소 검색)에는 Supabase Secrets 의 `OPINET_API_KEY` 가 필요하다. 없으면 신청자가 이름·주소를 직접 입력하고 관리자가 오피넷 ID 를 넣는다
- Supabase → Authentication → URL Configuration 의 Site URL 과 Redirect URLs 에
  `https://byeongjaeyu.github.io/kyc-oilfield-ops/` 가 있어야 로그인 링크가 이 사이트로 돌아옴

## ⚠️ 보안 원칙

이 저장소는 **공개**입니다. 데이터는 저장소가 아니라 Supabase 에만 두고, 저장소에는 코드만 커밋합니다.
서비스 키(`SUPABASE_DATA_KEY`)는 GitHub Secrets 에만 둡니다. 브라우저 코드에 넣으면 RLS 가 무력화됩니다.
