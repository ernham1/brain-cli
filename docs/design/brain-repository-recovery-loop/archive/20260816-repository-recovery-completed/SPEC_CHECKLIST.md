# 스펙 체크리스트: Brain 저장소 재해복구

> 원본: `docs/design/brain-repository-recovery-loop/00-overview.md`, `01-runbook.md` | 태그: `#데이터복구` | 승인: 자율(시작 게이트 `dj-20260816-1731-brr1`, 재시도 `dj-20260816-1755-brr2`)
> 반영한 과거 갭: GAP-RM-01, GAP-RM-02, GAP-FR-08, GAP-FR-09, GAP-REC-01~07
> 3축: 기능=보존·Git 재구성·검증·bundle, 화면=없음, 데이터=경로·해시·커밋·테스트·API 증거

| ID | 항목 | 스펙 근거 | 완료 기준 | 검증 방법 | 상태 | 증거 |
|---|---|---|---|---|---|---|
| REC-00A | 결정 저널 최소 부트스트랩 | GAP-REC-02 | 삭제된 `journal-append.mjs`와 project=`brain` 매핑을 과거 실행 계약·생존 저널로 최소 복원; 운영 저널 원문은 수정하지 않음 | 임시 `--dir` 정상 행 성공·축약 접두 거부·live+twin:null 거부 후 기본 경로 append 준비 확인 | [x] | `D:/Projects/decision-pipeline/test/journal-append-bootstrap-smoke.mjs`: `ok 4`; 기본 경로 생존 저널 확인 |
| REC-00 | 시작 게이트·범위 잠금 | 00 §범위·중단 조건 | `#데이터복구` 익숙한 타입 근거와 `전제: dj-20260722-1416-sec5`를 포함한 LOOP_START 저널 생성; 원본 write/delete/reset 금지 고정 | 저널 행 스키마·ID·project=`brain` 확인 | [x] | `dj-20260816-1731-brr1`; 저널 exact 1건·계약 전 필드 확인 |
| REC-01 | 격리 볼륨 안전성 실측 | 00 §복구 아키텍처 | 원본 실체 D:와 대상 C:의 Volume UniqueId가 다르고 C:가 Healthy/OK이며 여유 공간이 원본 크기×2 이상; 대상 절대경로가 `C:\Brain-Recovery\20260816` 하위 | 링크 target·볼륨·경로·용량 출력 저장 | [x] | `C:\Projects`→`D:\Projects`; C/D UniqueId 상이; C Healthy/OK·free 135,598,837,760; 원본 795,912,381 bytes; 대상 부재; `dj-20260816-1755-brr2` |
| REC-02 | 원본 증거 스냅샷 | 01 §산출물 | 원본 전체 파일을 C: evidence로 복사; D: 원본 변경 0; 재분석 가능한 파일·시간·크기 보존 | 복사 exit code, 전후 파일 수·총크기 | [x] | `C:\Brain-Recovery\20260816\reports\REC-02-robocopy.log`; robocopy exit 1(정상 복사), 실패 0; 원본=사본 20,019 files / 795,914,500 bytes; 독립 `/L` 비교 mismatch·failed·extras 0, exit 0 |
| REC-03 | 스냅샷 manifest 검증 | 00 §성공 조건 | 상대경로·크기·SHA-256 manifest 생성; 원본과 evidence 불일치 0 | 독립 비교 스크립트 exit 0, 불일치 0 | [x] | `C:\Brain-Recovery\20260816\evidence\manifest.sha256.jsonl`; `reports\REC-03-manifest-verification.json`; 20,019 entries, missing 0, extra 0, mismatch 0, `verified=true`; 변동 브리지 파일 2건은 바이트 캡처 방식·시각·해시 기록 |
| REC-04 | 정상 원격 기반선 확보 | 00 §기술 결정 | GitHub fresh clone 성공, 20 commits 확인, `git fsck --full` exit 0 | clone 로그·commit count·fsck | [x] | `C:\Brain-Recovery\20260816\repo`; origin=`https://github.com/ernham1/brain-cli.git`; clone exit 0; commit count 20; fsck exit 0; `reports\REC-04-clone.log`, `REC-04-git-verification.log` |
| REC-05 | 손상 Git 이력 증거 회수 | 01 §실행 순서 | 23개 commit ID·메시지·부모·브랜치와 회수 가능 객체 목록 저장; 손상 객체는 손실로 표기 | `cat-file` 개별 exit code, provenance 대조 | [x] | `reports\REC-05-git-history-evidence.json`; commit metadata 23행, `cat-file` 실패 0; feature 23/main 20, 원격 중첩 20+로컬 3; loose objects 6,035 중 recoverable 3,106/corrupt 2,929; 객체 전수 목록 JSONL |
| REC-06 | 최신 워킹 트리 재구성 | 00 §성공 조건 | fresh clone 위에 추적 대상 소스 복원; node_modules·logs·data·temp·시크릿은 커밋 제외; 7/28 이후 12개 소스 해시 일치 | 원본↔repo 해시, 제외 패턴·시크릿 추적 0 | [x] | `reports\REC-06-reconstruction-verification.json`; 보존 후보 376개 전수 hash mismatch 0, Git 대상 298/`.gitignore` 보존 전용 78, 핵심 12개 모두 Git 대상·해시 일치; 제외 19,643개(`.env` 5 포함); stage 금지 경로·시크릿 0; 원격 전용 역사 자산 10개 보존 |
| REC-07 | 이력·변경 provenance 확정 | 01 §산출물 | 원격 20/복구 23/최신 워킹 트리 관계, 복원·미복원 범위, 12개 변경 근거를 문서화 | 커밋 그래프·세션 증거·파일 해시 교차검증 | [x] | `repo\docs\recovery\20260816-provenance.md` SHA-256 `47a52d5b…`; `reports\REC-07-provenance-verification.json` verified; 원격 20/손상 계보 23/중첩 20+로컬 3, 12개 해시·mtime, 세션 근거의 보조적 한계 명시 |
| REC-08 | 격리 의존성 복원 | 00 §성공 조건 | 복구 repo에서 lockfile 기반 clean install 성공; 누락 의존성 0; audit 결과 기록 | install exit 0, `npm ls --all`, audit | [x] | 3패키지 `npm ci --ignore-scripts` exit 0·각 cwd 검증, `npm ls --all` 3/3 exit 0, node_modules Git 상태 0; audit 기록: brain-cli 9(critical 1), brain-server 4, clo-telegram 11; `reports\REC-08-dependency-verification.json`; REC-10에서 `better-sqlite3` native binding 후속 rebuild·712/712로 실행 가능성 확인 |
| REC-09 | stale 테스트 계약 정정 | 00 §확정 가정 | 현재 의도와 어긋난 clo digest 테스트 2건만 정정; 제품 소스 변경 0 | targeted test FAIL→PASS, 관련 패턴 전수 검색 | [x] | `orchestrator-decision-digest.test.mjs`만 변경; before exit 1/fail 2 → after exit 0/pass 4/fail 0; 구형 패턴 0; 제품 소스 변경 0; `reports\REC-09-test-contract-verification.json` |
| REC-10 | 전체 빌드·테스트 | 00 §성공 조건 | brain-cli 712/712, clo-telegram 222/222, TypeScript build 모두 exit 0 | 전체 명령별 원문 로그·exit code | [x] | brain-cli lint 0·712/712, clo build 0·222/222; 초기 56 fail은 `--ignore-scripts`로 빠진 better-sqlite3 binding 원인, dependency rebuild 후 대표 22/22·전체 712/712; `reports\REC-10-full-verification.json` |
| REC-11 | 격리 기능 스모크 | 00 §성공 조건 | 임시 데이터·별도 포트에서 health→write→recall 성공; 운영 데이터·서비스 변경 0 | API 실호출 응답·임시 경로·포트 확인 | [x] | 임시 `smoke\run-20260816-184717\Brain`, 포트 55236; health ok→write `rec_proj_recovery-smoke_20260816_0001`→recall 동일 ID, Raw·index 확인; PID 종료·포트 폐쇄, 운영 3849 health ok; `reports\REC-11-isolated-smoke.json` |
| REC-12 | 복구 체크포인트·bundle | 01 §산출물 | provenance 포함 새 커밋·태그·bundle 생성; bundle verify와 재-clone 성공 | commit hash, `git bundle verify`, 재-clone fsck | [x] | branch `recovery/20260816`, commit `50a58aecddfe5de86a666c179e2d1c9a00246d7d`, tag `brain-recovery-20260816`; bundle 1,492,860 bytes·verify 0; 재-clone checkout·HEAD 일치·fsck 0·clean; push 0; `reports\REC-12-checkpoint-bundle.json` |
| REC-13 | 종료 독립 감사 | 00 §성공 조건 | 원문 재대조, 증거 실물 확인, 전체 회귀 재실행, LOOP_END 저널 | 체크리스트 15/15, 불일치 0, 종료 저널 | [x] | 동일 세션 자기감사(독립 에이전트 미사용) 명시; 핵심 12파일 mismatch 0, commit·tag·bundle·재-clone 재검증, 커밋 트리 금지 경로·시크릿 0; fresh Brain CLI 712/712·lint 0, 텔레클로 build 0·222/222; `reports\REC-13-final-audit.json`; LOOP_END `dj-20260816-1900-brr3` exact 1건 |

## 범위 잠금

- 포함: 별도 볼륨 보존, Git 재구성, 격리 테스트·스모크, bundle.
- 제외: 현재 원본 수정, 운영 재시작·전환, 운영 데이터 수리, push·배포.
- 체크리스트 밖 작업은 먼저 항목을 추가한 뒤 수행한다.