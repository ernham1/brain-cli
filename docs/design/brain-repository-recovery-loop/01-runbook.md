# Brain 저장소 재해복구 루프 — 실행 지시서

> 원본: `00-overview.md`
> WHERE: 현재 원본 `C:\Projects\Brain`(실체 `D:\Projects\Brain`), 격리 대상 `C:\Brain-Recovery\20260816`
> GUI TOKEN: 없음 (저장소·데이터 레이어)
> VERIFY: 각 REC 항목의 측정 가능한 완료 기준과 증거를 `SPEC_CHECKLIST.md`에 즉시 기록
> DEPENDS: 결정 저널 시작 게이트

## 실행 순서

1. 게이트와 볼륨 안전성을 확인한다.
2. 원본을 읽기 전용 증거로 고정하고 별도 볼륨에 복사한다.
3. 원격 clone을 정상 Git 기반선으로 만든다.
4. 손상 저장소에서 이력 증거를 회수한다.
5. 최신 워킹 트리를 정상 기반선 위에 복원한다.
6. 의존성·테스트·기능 흐름을 격리 환경에서 검증한다.
7. provenance·복구 커밋·bundle을 만들고 전체를 다시 감사한다.

## 안전 계약

- 원본 경로에서 금지: `.git` 복사, `git reset`, `git checkout`, `git clean`, 삭제, 이동, `npm ci`.
- 복구 명령은 `C:\Brain-Recovery\20260816` 아래에서만 실행한다.
- 복사 전 대상 절대경로·볼륨 UniqueId·여유 공간을 증거로 남긴다.
- 원본과 복구 대상의 해시 검증 전 다음 항목으로 넘어가지 않는다.
- 손상 객체는 정상으로 가정하지 않고 `git cat-file` 성공 객체만 증거로 인정한다.
- 시크릿 값은 읽거나 출력하지 않고 파일 존재·이름·추적 여부만 검사한다.

## 3축 체크리스트

| 축 | 요구 |
|---|---|
| 기능 명세 | 최신 소스 보존, Git 이력 재구성, 테스트·스모크, bundle 생성 |
| 화면 명세 | 없음 |
| 데이터 계약 | 파일 수·상대경로·SHA-256, commit/parent/tree, 테스트 exit code, API health/write/recall 결과 |

## 산출물

| 산출물 | 위치 |
|---|---|
| 원본 증거 사본 | `C:\Brain-Recovery\20260816\evidence\Brain-working-tree` |
| 해시 manifest | `C:\Brain-Recovery\20260816\evidence\manifest.sha256.jsonl` |
| 정상 복구 저장소 | `C:\Brain-Recovery\20260816\repo` |
| 손상 이력 분석 | `C:\Brain-Recovery\20260816\reports\RECOVERY_PROVENANCE.md` |
| 테스트 결과 | `C:\Brain-Recovery\20260816\reports\TEST_REPORT.md` |
| Git bundle | `C:\Brain-Recovery\20260816\artifacts\brain-recovered.bundle` |

## 완료 후 운영 전환

이번 루프는 운영 전환을 수행하지 않는다. 복구 저장소가 독립 검증을 통과하면 다음 루프에서 PM2 경로 전환, 운영 데이터 무결성 복구, health·실사용 확인을 별도 승인·검증한다.