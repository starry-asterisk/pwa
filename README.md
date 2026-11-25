# 모아 · 나의 작은 기록함

GitHub Pages에서 실행하는 개인용 메모 PWA입니다. 메모와 이미지를 기기에 먼저 저장하고, 원할 때 Supabase 계정으로 내 기기를 연결합니다.

## 현재 기능

- 텍스트/Markdown 자동 저장, 제목·본문·태그 검색, 고정, 휴지통과 복원
- PNG/JPEG/정지 WebP 입력, 붙여넣기, 드래그앤드롭
- 이미지는 WebP로만 보관: PNG는 무손실, JPEG는 기본 품질 82, 해상도는 기본 유지
- 다운로드할 때 기기에서 PNG 생성. PNG 변환으로 손실 압축 이전 화질이 복구되지는 않습니다.
- 오프라인 앱과 IndexedDB, 기기 보관·저장 권한 요청
- 메모와 WebP를 함께 ZIP으로 백업/가져오기. 가져오기는 새 ID로 추가하며 기존 메모를 덮어쓰지 않습니다.
- Supabase 이메일 로그인, 이미지 선업로드, 변경 재시도, 버전 충돌 사본, 계정별 접근 제한
- 메모 편집기의 **공유**에서 텍스트와 PNG를 기기의 공유 메뉴로 보내기. 지원되는 기기에 설치하면 다른 앱의 텍스트와 이미지도 받을 수 있습니다.
- 모바일 뒤로가기로 열린 메모의 수정 내용을 저장하고 이전 앱 화면으로 복귀
- 선택적 Web Push. 알림이 꺼진 기기는 로그인마다 한 번 안내하며, **설정 → 알림**에서 서버 등록을 확인할 수 있습니다.
- Windows 보조 앱으로 화면 영역을 캡처하고, 이미지와 기기에서 추출한 텍스트를 하나의 메모에 저장

## 개발 환경

Node.js **22.12 이상**과 npm을 사용합니다. 모든 프로젝트 파일은 이 폴더에 있습니다.

이 컴퓨터의 기본 Node.js가 오래되어, 프로젝트 내부 `.tools/`에 별도의 Node.js를 준비했습니다. Windows에서는 다음 명령이 프로젝트 도구를 자동 선택합니다.

```powershell
cd C:\Users\RnD\Desktop\pwa
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1
```

Node.js 22.12 이상이 기본 환경에 있다면:

```sh
npm ci
npm run dev
npm test
npm run test:backend
npm run test:db
npm run build
npm run preview
```

개발 주소는 터미널에 표시되는 `/pwa/` 경로입니다. 오프라인/PWA 동작은 `npm run build` 후 `npm run preview`에서 확인합니다.

브라우저 테스트:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache\browsers'
npx playwright install chromium
npm run build
npm run test:e2e
```

테스트 브라우저와 npm 캐시는 `.cache/`에 저장하며 Git에서 제외됩니다.

## Supabase 연결

완전 로컬 모드에서는 계정이나 서버 설정이 필요하지 않습니다. 설정 → 동기화에서 프로젝트 URL과 Publishable/anon 공개 키를 입력할 수도 있고, `.env.example`을 `.env.local`로 복사해 빌드 기본값으로 사용할 수도 있습니다.

1. SQL Editor에서 [`supabase/migrations/202611240001_initial.sql`](supabase/migrations/202611240001_initial.sql)을 전체 실행합니다.
2. Auth → URL Configuration에서 개발·배포 주소를 허용합니다.
3. 앱 설정에서 본인 이메일로 로그인합니다.
4. 기존 로컬 메모는 **이 기기의 로컬 메모도 연결**을 선택해야 계정으로 업로드됩니다.

세부 절차와 알림 서버 배포는 [`docs/SUPABASE.md`](docs/SUPABASE.md)에 있습니다. 관리자 키와 데이터베이스 비밀번호는 프런트엔드에 사용하지 않습니다.

로컬 메모와 계정 메모는 분리합니다. 로그아웃하면 계정 메모는 화면에서 숨기고 기기 캐시는 보존합니다. 같은 계정으로 로그인하면 다시 표시됩니다. 동기화 실패 시 기기의 변경 내용은 남아 있으며 다음 연결에서 재시도합니다.

## GitHub Pages 배포

1. 저장소 Settings → Pages → Source를 **GitHub Actions**로 설정합니다.
2. `main`에 변경을 반영하면 `.github/workflows/pages.yml`이 검사·빌드·배포합니다.
3. 기본 배포 경로는 `https://starry-asterisk.github.io/pwa/`입니다. 저장소 이름을 변경하면 workflow가 해당 경로를 사용합니다.
4. 선택적으로 Settings → Secrets and variables → Actions → Variables에 `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VAPID_PUBLIC_KEY`를 등록합니다. 공개 설정값만 사용합니다.
5. 배포 변수 없이도 앱은 로컬 모드로 실행되며 앱 설정에서 Supabase를 연결할 수 있습니다.

사용자 지정 도메인이라면 `VITE_BASE_PATH=/`로 변경하고 Supabase의 허용 URL도 함께 변경해야 합니다. 오리진이 바뀌면 브라우저 저장소도 달라지므로 먼저 백업을 내보냅니다.

## Windows 화면 캡처

1. Windows의 Chrome 또는 Edge에서 모아를 앱으로 설치합니다.
2. 모아의 **설정 → 일반 → Windows 화면 캡처**에서 보조 앱 설치 파일을 내려받아 엽니다.
3. 보조 앱의 반투명 버튼을 누르고 저장할 영역을 드래그합니다. 처음 캡처 파일을 열 때 연결 앱을 묻는다면 모아를 선택합니다.
4. 파일 연결을 사용할 수 없으면 **캡처 파일 열기**에서 보조 앱이 저장한 `.moacapture` 파일을 엽니다.

캡처 이미지는 WebP로 저장하고 추출한 한글·영어 텍스트는 편집 가능한 본문에 넣습니다. OCR과 캡처 파일 전달은 PC 안에서 처리합니다. 로그인한 기기에서는 기존 메모 동기화가 적용됩니다.

보조 앱은 GitHub Releases에서 Windows용 새 버전을 확인합니다. Windows 릴리스는 `windows-v<버전>` 태그로 배포하고, 모아의 설치 버튼은 최신 릴리스의 설치 파일을 가리킵니다.

## 데이터와 제한

- IndexedDB는 브라우저의 저장소 삭제/기기 분실에 대비한 백업을 대신하지 않습니다. 중요한 기록은 ZIP 백업을 별도로 보관하세요.
- 백업 ZIP은 모바일 메모리 보호를 위해 **50MiB**, 이미지 입력은 **25MiB**, 저장 WebP는 **20MiB**, 한 메모의 첨부는 **100개**로 제한합니다.
- GIF·움직이는 WebP/APNG는 정지 이미지로 조용히 바꾸지 않고 안내 후 거절합니다.
- 영구 삭제 기능은 아직 없습니다. 휴지통은 복원 가능하며 첨부파일도 보관하므로 사용 용량에 포함됩니다.
- 메모 원문과 이미지는 별도 종단간 암호화를 적용하지 않았습니다. Supabase 비공개 저장소·RLS·HTTPS를 사용합니다.
- Supabase 무료 요금제의 DB·파일·전송량·휴면 정책은 별도 적용됩니다.
- 알림은 앱을 강제로 종료한 상태의 완전한 백그라운드 동기화를 보장하지 않습니다. 앱을 열 때도 최신 상태를 확인합니다.
- iPhone/iPad의 Push는 홈 화면에 설치하고 알림을 허용한 앱에서 사용합니다. 공유 수신 지원은 운영체제·브라우저에 따라 다릅니다.

## 구조

- `src/lib/db.ts`: 기기 저장소
- `src/lib/media.ts`: WebP 최적화·PNG 변환
- `src/lib/backup.ts`: ZIP 백업·검증·복원
- `src/lib/sync.ts`: 버전 비교·재시도·충돌 보존
- `src/sw.ts`: 오프라인 캐시·공유 수신·알림
- `supabase/`: 테이블·접근 정책·알림 함수

원격 저장소 접근 인증과 실제 배포는 이 컴퓨터의 GitHub 연결 상태에 따라 별도로 확인해야 합니다.
