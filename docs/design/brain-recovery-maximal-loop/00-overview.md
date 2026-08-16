# Brain 안전 최대복구 루프 — 개요

> 요청: 광웅 이사님 2026-08-16 “나머지 루프 설계하여 진행”
> 전제: 잔여 후속 LOOP_END `dj-20260816-2116-brf2`

## 제품 가치

복구 가능한 기억은 SHA-256 원문 증거로 끝까지 되살리고, 증거가 없는 기억은 만들거나 지우지 않은 채 다음 증거 요구사항이 명확한 상태로 보존한다.

## 요구사항

1. 현재 `missing-raw` 전체와 exact 후보를 fresh inventory로 다시 확정한다.
2. 이미 exact가 확인된 89건은 recordId 범위를 잠근 10건 이하 배치로 복원한다.
3. 각 배치는 Raw 생성, canonical index 보강, 5중 일치, monitor 신규 0을 즉시 검증한다.
4. 남은 기록은 sourceRef·record type·생성기별로 분류하고 기존 복구기를 유형별로 재실행한다.
5. 추가 후보도 DB contentHash와 SHA-256이 같은 경우에만 복원한다.
6. 최종 잔여는 대상, 실패 이유, 필요한 외부 증거를 원장으로 남긴다.

## 범위

### 포함

- `C:/Users/ernham/Brain`의 `missing-raw` known 집합
- `C:/Brain-Recovery/20260816`, `C:/Projects/Brain` Git·복구 보고서
- 관련 `C:/Users/ernham/.claude/projects`, `C:/Users/ernham/.codex` 세션 증거
- `reconstruct-session-handoff-raw`, `reconstruct-work-log-archive-raw`, `reconstruct-auto-brain-raw`, `forensic-raw-recovery`

### 제외

- H/E 드라이브와 Brain 무관 경로
- hash 불일치 원문 적용, 내용 합성, active record 삭제
- unfiltered bulk apply, main 변경, force update, 외부 메시지 발송

## 설계 결정

| 결정 | 근거 | 트레이드오프 |
|---|---|---|
| exact 89건 선복원 | 이미 저장 contentHash와 일치한 고확신 집합 | 배치 검증 때문에 단일 bulk보다 느림 |
| 배치당 최대 10건 | 경합·롤백 영향 범위를 작게 유지 | 백업과 monitor 횟수 증가 |
| recordId allowlist 필수 | 광범위 드라이런 91건 탐지 시 범위 확장 위험 실측 | 도구 옵션·회귀 테스트 추가 필요 |
| 잔여는 유형별 포렌식 | 생성 형식이 달라 단일 재구성기가 모든 Raw를 복원할 수 없음 | 일부는 증거 고갈로 남을 수 있음 |

## 읽기-쓰기 매핑

| 읽기 속성 | 값 | 쓰기 동작 | 구현 위치 |
|---|---|---|---|
| `recordId` | allowlist 포함 | 해당 ID만 후보·적용 | 각 reconstruction/repair CLI |
| `sourceRef` | Brain 내부 안전 경로 | 동일 경로 Raw 생성 | reconstruction apply |
| `contentHash` | 후보 SHA와 같음 | write 허용 | reconstruction plan/apply |
| `contentHash` | 불일치·없음 | write 금지, 잔여 원장 | forensic report |
| `recentBrainSource` | adjacent Raw 등 | evidence에 출처 보존 | session handoff plan |
| canonical 존재 상태 | DB-only | JSONL·digest·manifest 보강 | canonical repair |
| canonical 존재 상태 | JSONL-only | DB·FTS 단건 보강 | jsonl-missing-db repair |

## PRISM 검토

| Layer | 판정 | 비고 |
|---|---|---|
| R | ✅ | 각 배치 SHA·5중 audit·monitor 즉시 피드백 |
| B | ✅ | inventory→allowlist→복원→감사→잔여 원장으로 닫힘 |
| D | ✅ | exact-only와 합성 금지를 데이터 결정으로 고정 |
| S | ✅ | Raw·DB·JSONL·digest·manifest·writer 경합을 함께 검증 |
| G | ✅ | 고확신 89건과 미확정 잔여를 분리 |
| I | ✅ | 유형·실패 이유·다음 필요 증거로 사용자 관점 원장화 |
| E | ✅ | 진단·복구·검증·보존·후속 인계 포함 |

## 가정 명세

### 확정된 가정
- 이사님은 exact 89건 복원과 남은 기록의 안전 최대 포렌식을 요청했다.
- H/E는 확인하지 않는다.

### 기술적으로 결정한 것 (확인 불필요)
- 배치 크기는 최대 10건이며 매 배치 실패 시 다음 배치로 넘어가지 않는다.
- 전체 숫자 0보다 hash 증거와 비파괴 보존을 우선한다.

### 아직 열린 사항
- 89건 이후 유형별 탐색에서 추가 exact 후보가 몇 건 나올지는 inventory 후 확정한다.
- exact 원문이 없는 기록은 외부 백업 없이는 복구 불가능할 수 있다.
