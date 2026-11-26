# Supabase 연결과 기기 알림

클라우드를 연결하지 않아도 메모·이미지·검색·백업은 기기에 저장됩니다. 이 문서는 같은 계정의 기기 간 동기화와 새 메모 알림을 추가하는 절차입니다. 프로젝트 코드, 설치 도구, 캐시와 로컬 설정은 `C:\Users\RnD\Desktop\pwa` 안에서 관리합니다.

## 1. 프로젝트와 데이터베이스

1. Supabase에서 Free 프로젝트를 만들고 데이터베이스 준비가 끝날 때까지 기다립니다.
2. 프로젝트의 **SQL Editor → New query**에서 `supabase/migrations/202611240001_initial.sql` 전체를 실행합니다. 파일은 `BEGIN`/`COMMIT`으로 묶여 있으며 처음 한 번 적용하는 초기 마이그레이션입니다. 일부 문장만 선택해 실행하지 마세요.
3. **Table Editor**에서 `notes`, `push_subscriptions`가 생겼는지 확인합니다.
4. **Storage**에서 `note-images` 버킷이 **Private**인지 확인합니다. SQL이 WebP 파일만 허용하고 파일당 20 MiB 제한을 설정합니다.

이미 다른 초기 버전을 적용했다면 테이블을 삭제하거나 이 파일을 반복 실행하지 말고 변경용 마이그레이션을 추가해야 합니다. 적용 실패 시 SQL Editor 오류를 확인하세요. 실행 중 하나라도 실패하면 전체 트랜잭션이 취소됩니다.

초기 SQL에는 계정별 RLS와 다음 계약이 포함됩니다.

- `notes`는 로그인한 본인만 읽을 수 있습니다. 프런트엔드의 직접 INSERT/UPDATE/DELETE는 허용하지 않습니다.
- 쓰기는 `save_note(p_id, p_data, p_version, p_expected_version, p_origin_device_id)` RPC만 사용합니다. 원격 버전을 원자적으로 비교하고 같은 요청의 재시도는 멱등 처리합니다. 충돌이면 원격 사본을 반환해 앱이 양쪽 내용을 보존합니다.
- 이미지는 `note-images/<owner UUID>/<image UUID>.webp`에 저장합니다. 다른 계정의 파일 접근과 덮어쓰기는 차단됩니다.
- `push_subscriptions`는 본인의 기기만 등록·조회·해제할 수 있습니다.
- `notes`를 기존 `supabase_realtime` publication에 추가합니다. Realtime 신호가 누락되어도 앱의 재동기화로 최신 데이터를 가져옵니다.

### 기존 프로젝트에 영구 삭제 추가

초기 설정과 [녹화 마이그레이션](../supabase/migrations/202611250001_recordings.sql)을 적용한 프로젝트에서 **SQL Editor → New query**를 열고 [영구 삭제 마이그레이션](../supabase/migrations/202611260001_permanent_delete.sql) 전체를 한 번 실행합니다. 같은 계정으로 연결한 기기는 다음 동기화 때 영구 삭제를 반영합니다. 오프라인에서 확인한 영구 삭제는 기기에 저장했다가 다시 연결하면 전송합니다.

서버는 오프라인 기기의 옛 사본이 다시 저장되지 않도록 삭제 기록을 유지합니다. 첨부파일은 해당 계정의 남은 메모에서 참조하지 않을 때 정리합니다.

## 2. 이메일 로그인 URL

**Authentication → URL Configuration**에 다음을 등록합니다. 경로 끝의 `/`까지 실제 앱 주소와 맞추세요.

| 설정 | 값 예시 |
|---|---|
| Site URL | `https://YOUR_NAME.github.io/pwa/` |
| Redirect URLs | `https://YOUR_NAME.github.io/pwa/` |
| 로컬 개발 Redirect URL | `http://127.0.0.1:5173/pwa/` |
| 로컬 빌드 미리보기 Redirect URL | `http://127.0.0.1:4173/pwa/` |

저장소 이름이나 `VITE_BASE_PATH`가 다르면 `/pwa/`도 바꿉니다. 사용자 Pages 또는 커스텀 도메인의 루트 배포라면 `/`를 사용합니다. 비밀번호 없는 이메일 Magic Link를 사용하며, 이메일 링크를 연 브라우저에 로그인 세션이 생성됩니다. 알림을 받을 설치형 PWA 안에서도 로그인 상태인지 확인하세요.

Supabase 기본 이메일 발송 서비스는 허용 수신자와 발송량이 제한되어 있습니다. 프로젝트를 만든 Supabase 조직의 구성원 이메일을 테스트에 사용하거나, 실제 사용할 이메일을 보낼 수 있도록 **Authentication → Email → SMTP Settings**에서 개인 SMTP 공급자를 설정하세요. 발송 오류가 나면 먼저 인증 로그와 기본 메일 제한을 확인합니다. 앱이 비밀번호나 service-role 키를 요구하지는 않습니다.

본인만 사용할 경우 본인 계정을 만든 다음 **Authentication → Sign In / Providers**에서 신규 가입을 끌 수 있습니다. 이미 만들어진 계정의 로그인은 유지합니다. RLS는 각 계정의 데이터를 격리하지만, 그 자체로 새 계정 생성을 막는 설정은 아닙니다.

## 3. 앱 연결

프로젝트의 **Connect / API Keys** 또는 **Project Settings → API**에서 다음 공개 값을 확인합니다. 대시보드 메뉴 이름은 버전에 따라 조금 다를 수 있습니다.

- Project URL: `https://YOUR_PROJECT.supabase.co`
- Publishable key: `sb_publishable_...` 또는 legacy `anon` 키

앱의 설정에서 이 값을 입력한 뒤 본인 이메일로 로그인합니다. 각 기기에 같은 프로젝트와 같은 이메일 계정을 연결합니다. 코드에 기본값을 넣고 싶다면 무시되는 `.env.local`에 설정합니다.

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
VITE_VAPID_PUBLIC_KEY=
VITE_BASE_PATH=/pwa/
```

이름이 `ANON_KEY`여도 새 publishable key를 사용할 수 있습니다. 공개 키는 접근 비밀이 아니며 사용자 로그인과 RLS가 실제 권한을 제한합니다. `service_role`, `sb_secret_...`, 데이터베이스 비밀번호, VAPID private key는 앱 설정이나 `VITE_` 변수에 넣지 않습니다. `.env.local`을 변경한 경우 개발 서버를 재시작하거나 다시 빌드하세요.

## 4. 새 메모 알림 키

알림은 선택 사항입니다. 동기화만 사용할 때는 이후 단계를 생략할 수 있습니다.

프로젝트 루트에서 다음 명령을 실행합니다.

```powershell
npm run keys
```

`.env.push.local`에 VAPID 키가 생성됩니다. 기존 파일이 있으면 덮어쓰지 않습니다. `VAPID_SUBJECT`를 실제 연락 이메일인 `mailto:you@example.com` 형태로 바꾸세요. **Public key만** 앱의 알림 설정 또는 `VITE_VAPID_PUBLIC_KEY`로 복사합니다. 같은 public/private 키 쌍을 모든 기기에 사용합니다. 키를 바꾸면 기존 브라우저 구독을 해제하고 다시 등록해야 합니다.

같은 파일에 다음 환경값도 추가합니다. `WEBHOOK_SECRET`은 직접 생성한 32자 이상의 무작위 비밀입니다. 이 파일은 Git에서 제외됩니다.

```dotenv
APP_URL=https://YOUR_NAME.github.io/pwa/
WEBHOOK_SECRET=REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS
```

알림 본문에는 메모 내용이나 제목을 넣지 않습니다. 잠금 화면에는 “새 메모가 도착했습니다”라고 표시하며, 누르면 해당 메모를 엽니다.

## 5. 알림 함수 배포

별도의 CLI 로그인 파일을 사용자 폴더에 만들지 않도록 Supabase 대시보드에서 배포합니다. **Edge Functions → Deploy a new function → Editor**에서 함수 이름을 `notify`로 지정하고 아래 세 파일을 같은 상대 경로로 추가한 뒤 배포하세요. 테스트 파일은 배포하지 않습니다.

- `supabase/functions/notify/index.ts`
- `supabase/functions/notify/handler.ts`
- `supabase/functions/notify/validation.ts`

함수의 **Verify JWT / Enforce JWT verification**은 끕니다. `supabase/config.toml`에도 `notify` 함수의 `verify_jwt = false`를 설정해 두었습니다. 인증은 Database Webhook의 전용 `x-webhook-secret` 헤더를 고정 길이 SHA-256 비교로 검증합니다. 비밀이 없거나 다르면 알림을 발송하지 않습니다.

필수 환경값 `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `APP_URL`, `WEBHOOK_SECRET`을 `.env.push.local`에서 확인한 뒤 **Project Settings / Edge Functions → Secrets**에 각각 설정합니다. Supabase가 함수 런타임에 제공하는 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`는 프런트엔드에 복사하지 않습니다. 이 프로젝트를 준비하는 과정에서 원격 함수가 자동 배포되지는 않습니다.

함수는 표준 Google·Mozilla·Apple·Windows Push 서비스 호스트만 허용합니다. 다른 브라우저의 정당한 Push 서비스가 추가로 필요하면 `PUSH_ALLOWED_HOSTS=push.example.com`처럼 정확한 호스트를 추가하세요. 사용자 입력으로 임의 호스트를 허용하지 않습니다.

## 6. Database Webhook

**Database → Webhooks → Create a webhook**에서 다음을 설정합니다. HTTP 타입을 선택하면 필요한 사용자 지정 헤더를 명확하게 설정할 수 있습니다.

| 항목 | 설정 |
|---|---|
| 이름 | `notify-new-note` |
| Schema / Table | `public` / `notes` |
| Events | **INSERT만 선택** |
| HTTP Method | `POST` |
| URL | `https://YOUR_PROJECT.supabase.co/functions/v1/notify` |
| Header | `Content-Type: application/json` |
| Header | `x-webhook-secret: 위에서 설정한 WEBHOOK_SECRET과 동일한 값` |
| Timeout | 대시보드 허용 범위에서 10,000ms 이상 권장 |

Webhook 비밀값을 SQL 파일에 하드코딩하거나 GitHub Actions 공개 변수로 넣지 않습니다. Supabase의 비동기 `pg_net` 확장을 사용하며, 함수는 `public.notes`의 INSERT 형식과 UUID를 검증한 뒤 실제 DB의 owner/id를 다시 확인합니다. 그 소유자의 등록된 다른 기기에만 알림을 보냅니다.

초기 알림 범위는 **새로 만들어져 클라우드에 저장된 메모**입니다. 입력 중 자동 저장이나 기존 메모 편집은 INSERT가 아니므로 알림이 반복되지 않습니다. 기존 로컬 메모를 처음 동기화할 때는 원격에서 새 메모로 생성되므로 알림이 올 수 있습니다. 만료된 Push 구독(404/410 응답)은 자동 정리합니다. 클라우드 저장에 실패한 로컬 메모는 아직 다른 기기에 알리지 않습니다.

## 7. 실제 기기 확인

1. 기기 A와 B에 동일한 프로젝트·계정으로 로그인합니다.
2. 기기 B의 로그인 안내 또는 **설정 → 알림**에서 **이 기기에서 알림 켜기**를 눌러 권한을 허용합니다. **서버 등록 완료**가 보이면 기기 등록을 마친 상태입니다. iPhone/iPad에서는 홈 화면에 추가한 웹 앱에서 진행합니다.
3. 기기 A에서 새 메모를 만들고 클라우드 저장이 완료될 때까지 기다립니다.
4. B에서 알림을 눌러 메모가 열리고 실제 동기화된 내용과 이미지가 보이는지 확인합니다.
5. 같은 메모를 두 기기에서 오프라인 편집한 다음 연결해 양쪽 사본이 보존되는지 확인합니다.

알림이 오지 않으면 `push_subscriptions`에 B의 행이 있는지, Webhook이 INSERT에만 연결됐는지, 함수 Secrets가 모두 설정됐는지, 비밀 헤더가 일치하는지, Edge Function 로그에 실패 건수가 남는지 확인합니다. 함수 로그에는 구독 endpoint·키·메모 본문을 남기지 않습니다. Web Push는 OS·브라우저·네트워크 정책에 영향을 받으며 강제 종료나 알림 차단 상태에서 즉시 도착을 보장하지 않습니다. 앱을 다시 열면 서버 데이터로 재동기화합니다.

## 8. 검증과 운영 범위

로컬에서 webhook 입력·비밀 비교·Push 목적지 검증을 실행할 수 있습니다.

```powershell
npm run test:backend
```

마이그레이션은 실제 PostgreSQL 엔진인 PGlite에서 최소 auth/storage 스키마를 구성해 검사합니다. 테스트 의존성은 개발용 패키지에 포함되어 있으며 `npm ci`로 함께 설치됩니다.

```powershell
npm run test:db
```

이 검사는 계정 격리·CAS 충돌·멱등 재시도·잘못된 데이터·구독 권한·이미지 권한을 확인합니다. Supabase 원격 환경의 이메일 발송·실제 Web Push 전송·브라우저 종료 상태는 실제 프로젝트와 기기에서 별도로 확인해야 합니다.

Supabase Free 프로젝트는 사용량·파일 용량 한도가 있고 장기 미사용 시 일시 중지될 수 있습니다. 메모는 기기 로컬에서도 유지하며 독립 백업을 권장합니다. 현재 구현은 서버의 RLS 및 HTTPS를 사용하고, 서버가 메모를 읽을 수 없는 종단간 암호화까지 구현한 상태는 아닙니다.

## 공식 문서

- [Supabase Passwordless email / Magic Link](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [기본 SMTP 제한](https://supabase.com/docs/guides/auth/auth-smtp)
- [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Storage 접근 제어](https://supabase.com/docs/guides/storage/security/access-control)
- [Database Webhooks](https://supabase.com/docs/guides/database/webhooks)
- [Edge Function Secrets](https://supabase.com/docs/guides/functions/secrets)
