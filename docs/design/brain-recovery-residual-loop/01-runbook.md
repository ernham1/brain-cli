# Brain 복구 잔여 후속 루프 — 실행·검증

> 원본: `00-overview.md`

## 실행 순서

| 순서 | ID | 작업 | 즉시 검증 |
|---|---|---|---|
| 1 | RES-00 | 완료 SPEC/STATUS archive, LOOP_START | SHA-256·저널 exact 1 |
| 2 | RES-01 | target 2건 exact 후보 재탐색 | searched root/file count·candidate hash |
| 3 | RES-02 | exact 발견분만 조건부 적용 | backup·hash·monitor·validate |
| 4 | RES-03 | non-force dependency 재감사·가능분 수정 | audit/ls/import/embedding·전체 회귀 |
| 5 | RES-04 | fresh 독립 감사·LOOP_END·Brain/Wiki | 체크리스트 5/5·서비스·health |

## 허용된 증거 경로

- `C:/Brain-Recovery/20260816`
- `C:/Projects/Brain` Git history와 프로젝트 내부 handoff/session 증거
- `C:/Users/ernham/Brain`의 index·Raw·integrity event
- target sourceRef와 연결된 `C:/Users/ernham/.claude/projects`, `C:/Users/ernham/.codex`의 관련 세션 파일

H/E와 전 드라이브 재귀 탐색은 금지한다.

## 데이터 조건부 적용

| 판정 | 동작 |
|---|---|
| 후보 SHA-256 = DB contentHash | 운영 writer 영향 확인→백업→Raw write→canonical/validate |
| 후보는 있으나 hash 불일치 | 적용 0, 후보 경로·hash만 보고 |
| 후보 없음 | GAP-OPR-01 유지, 합성·삭제 0 |

## 의존성 조건부 적용

| 판정 | 동작 |
|---|---|
| non-force compatible fix available | lock/package 최소 갱신 후 전체 회귀 |
| fixAvailable=false | 상위 advisory·실행경로·완화 근거 기록 |
| major/force only | 적용 금지, 후속 분리 |

## 완료 보고 계약

- 완료: exact 복구 건수, 미발견 건수, audit 전후, 테스트 수, 서비스 상태를 제시한다.
- 보류: 공식 수정본 또는 exact 원문 부재를 대상별로 명시한다.
- 미검증: registry·운영 경로 등 실측하지 못한 항목을 분리한다.
