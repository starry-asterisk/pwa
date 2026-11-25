# Windows 설치와 자동 업데이트

Windows x64 설치본은 Velopack으로 패키징해 이 저장소의 GitHub Releases에 배포합니다. .NET 10 런타임과 한국어·영어 OCR 모델을 포함하며, 필요한 경우 설치 프로그램이 Microsoft Visual C++ 런타임 설치를 안내합니다.

MSIX와 `.appinstaller` 자동 업데이트에는 대상 Windows에서 신뢰하는 서명 인증서가 필요합니다. 현재 이 프로젝트에는 해당 인증서가 없으므로 첫 배포는 EXE 설치본을 사용합니다. 초기 EXE가 서명되지 않았다면 Windows SmartScreen이나 조직 정책에서 실행을 막을 수 있습니다. 이 프로젝트의 스크립트는 인증서를 설치하거나 Windows 보안 설정을 변경하지 않습니다. [Microsoft의 MSIX 서명 요건](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview), [Velopack 서명 안내](https://docs.velopack.io/packaging/signing)

## 배포 파일 계약

PWA의 Windows 다운로드 버튼은 다음 주소를 직접 여는 링크를 사용합니다.

```text
https://github.com/starry-asterisk/pwa/releases/latest/download/Moa-Setup.exe
```

버전 태그는 `windows-v0.1.0` 형태이며 이후에는 `windows-v0.1.1`처럼 증가시킵니다. 각 안정 릴리스는 아래 파일을 모두 포함합니다.

| 파일 | 용도 |
| --- | --- |
| `Moa-Setup.exe` | 최초 설치 및 수동 재설치 |
| `StarryAsterisk.MoaCapture-…-full.nupkg` | 설치된 앱이 내려받는 전체 업데이트 |
| `releases.win.json` | Velopack `win` 채널 업데이트 목록과 크기·해시 |
| `windows-release.json` | 버전, 원본 커밋, 설치 파일 URL·크기·SHA256·서명 여부 |
| `SHA256SUMS.txt` | 설치 파일과 배포 메타데이터·업데이트 패키지 SHA256 |

`windows-release.json`의 `schemaVersion`은 `1`입니다. `installer.downloadUrl`은 특정 버전의 불변 다운로드 주소이고, `autoUpdate`는 저장소 URL·패키지 ID·채널·피드 파일 이름을 제공합니다. PWA 링크는 최신 설치 URL만 필요하며, 메타데이터를 읽기 위한 인증이나 토큰은 필요하지 않습니다. 이후 다른 종류의 안정 릴리스를 추가한다면 최신 릴리스에도 Windows 파일을 포함하거나 다운로드 링크 정책을 함께 변경해야 합니다.

## 로컬 빌드와 검증

저장소 루트에서 .NET 10 SDK를 사용합니다. `.tools/dotnet/dotnet.exe`가 있으면 스크립트가 해당 SDK를 선택하며, 없으면 PATH의 `dotnet`을 사용합니다.

```powershell
pwsh -File ./scripts/windows/Build-Release.ps1 -Version 0.1.0
```

결과는 `.cache/windows/releases/0.1.0/`에 생성됩니다. 기존 배포 파일을 덮어쓰지 않으므로 재빌드할 때는 `-OutputDirectory .cache/windows/review-build-2`와 같이 새 출력 경로를 지정하세요. 빌드·NuGet·Velopack·임시 파일은 저장소의 `.cache/` 안에 보관합니다.

빌드 과정은 다음을 확인합니다.

1. 고정한 tessdata_fast 커밋의 OCR 모델과 라이선스를 SHA256으로 검증합니다.
2. Windows 앱을 self-contained로 게시하고 Velopack 시작 코드 검증을 유지한 채 설치본을 만듭니다.
3. 설치 파일 및 업데이트 패키지의 버전·ID·해시·필수 파일을 확인합니다.
4. 실제 Velopack SDK의 테스트 locator로 업데이트 발견·다운로드·이미 최신인 경우를 검사합니다. 설치본과 같은 `GithubSource`도 외부 요청 없는 release 응답 fixture로 검증하여 공개 asset 이름과 토큰 없는 다운로드 계약을 확인합니다.
5. 손상된 업데이트 다운로드가 checksum 검증으로 거부되는지 확인합니다.

검증은 저장소 내부의 가상 설치 경로를 사용하며 사용자 PC에 앱을 설치하지 않습니다. 이미 생성된 파일은 다음 명령으로 다시 검사할 수 있습니다.

```powershell
pwsh -File ./scripts/windows/Test-Release.ps1 -ReleaseDirectory .cache/windows/releases/0.1.0
```

## 자동 업데이트 동작

앱은 WPF 초기화·뮤텍스·설정 읽기보다 먼저 `VelopackApp.Build().SetAutoApplyOnStartup(false).Run()`을 호출합니다. 그 뒤 단일 인스턴스 여부를 확인하고, 기존 앱이 실행 중이지 않은 시작에서만 준비된 업데이트를 적용합니다. 설치된 앱의 `UpdateManager`는 공개 저장소의 `GithubSource`와 `win` 채널을 사용합니다. 새 버전은 내려받은 뒤 다음 정상 시작 때 적용하므로 작업 중인 캡처를 강제로 종료하지 않습니다. 개발 빌드에서는 `IsInstalled`를 검사해 설치본 전용 업데이트 경로를 실행하지 않습니다.

저장할 메모·이미지·사용자 설정은 실행 파일이 있는 `current` 폴더 밖에 보관해야 합니다. 업데이트는 앱 폴더를 교체하므로 앱 데이터 경로를 이후 릴리스에서도 유지하세요. [Velopack 초기화와 업데이트 계약](https://docs.velopack.io/integrating/overview), [공개 GitHub 업데이트 소스](https://docs.velopack.io/integrating/update-sources)

## GitHub Actions로 공개

`.github/workflows/windows-release.yml`은 다음 두 경로를 제공합니다.

- Actions에서 수동 실행: 버전과 `publish=false`로 설치본을 빌드·검사하고 artifact로 보관합니다.
- `windows-v0.1.0` 같은 태그 push 또는 `publish=true` 수동 실행: 검사된 결과를 draft 릴리스에 올린 뒤 모든 파일이 준비된 시점에 안정 릴리스로 공개합니다.

공개하려면 소스 변경을 먼저 커밋해야 합니다. 배포 스크립트는 변경 사항이 남은 소스로 만든 설치본, 원본 커밋과 다른 태그, 이미 공개한 버전의 덮어쓰기와 버전 역행을 거부합니다. 첫 배포 태그는 `windows-v0.1.0`입니다. 소스와 테스트가 준비된 후 유지 관리자가 태그를 push하면 됩니다.

빌드 작업의 권한은 `contents: read`이며, 공개 작업만 `contents: write`를 받습니다. 공개 작업은 저장소 전체의 공통 잠금으로 직렬 실행합니다. GitHub가 제공하는 `GITHUB_TOKEN`을 `gh` 프로세스의 환경 변수로 전달하므로 PAT를 앱에 넣지 않습니다. 로컬에서 공개 스크립트를 직접 실행하려면 `GH_TOKEN` 또는 `GITHUB_TOKEN` 환경 변수가 필요하며, Git Credential Manager의 git 인증과 Releases API 인증은 별개입니다. 설치된 앱의 공개 업데이트 확인에는 GCM이나 GitHub 토큰이 필요하지 않습니다. [Velopack GitHub Actions 안내](https://docs.velopack.io/distributing/github-actions)

## 추후 신뢰된 서명 추가

Azure Artifact Signing을 준비한 경우 저장소 변수 `WINDOWS_SIGNING_METADATA_JSON`에 `Endpoint`, `CodeSigningAccountName`, `CertificateProfileName`만 담은 JSON을 설정하고, `WINDOWS_SIGNING_TENANT_ID`, `WINDOWS_SIGNING_CLIENT_ID`, `WINDOWS_SIGNING_CLIENT_SECRET`을 Actions Secrets에 설정할 수 있습니다. 인증서 프로필 서명 권한만 가진 자격 증명을 사용합니다.

서명 메타데이터는 빌드 중 `.cache/` 아래에만 생성되고 배포 파일에 포함되지 않습니다. 서명을 설정했다면 생성된 설치 파일의 Authenticode 검증이 `Valid`가 아니면 빌드가 실패합니다. 서명 자격 증명이 없는 현재 빌드에는 임의의 인증서나 신뢰 설정을 추가하지 않습니다.
