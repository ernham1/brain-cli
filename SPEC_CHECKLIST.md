# 스펙 체크리스트: Brain 안전 최대복구

> 원본: `docs/design/brain-recovery-maximal-loop/00-overview.md`, 광웅 이사님 2026-08-16 “나머지 루프 설계하여 진행” | 태그: `#데이터복구` | 승인: 자율(시작 게이트, `dj-20260816-2124-brm1`)
> 전제: 잔여 후속 LOOP_END `dj-20260816-2116-brf2`
> 반영한 과거 갭: GAP-OPR-01, GAP-RM-01~04, GAP-FR-01~13
> 범위 잠금: H/E 접근·합성·삭제·unfiltered bulk apply·main 변경 금지, batch 최대 10건

| ID | 항목 | 스펙 근거 | 완료 기준 | 검증 방법 | 상태 | 증거 |
|---|---|---|---|---|---|---|
| MAX-00 | 완료 루프 보존·시작 게이트 | `00-overview.md` §전제 | 이전 SPEC/STATUS archive SHA, 전제 포함 LOOP_START exact 1건 | archive hash·저널 조회 | [x] | archive SPEC `a770a2be…`, STATUS `95a86a8a…`; LOOP_START `dj-20260816-2124-brm1` exact 1건 |
| MAX-01 | fresh missing/exact inventory | `01-runbook.md` 순서2 | 현재 monitor missing 수와 전체 dry-run targets/exact/unmatched, source family 분류 합계가 같은 시점 기준으로 고정; H/E 0회 | monitor event·inventory JSON·dry-run report | [x] | missing 8,330=work-log 6,483+session 1,744+기타 103; session exact 89·unmatched 1,655·unique 89; monitor healthy/known 8,330/new 0; H/E 0 |
| MAX-02 | write 도구 allowlist 잠금 | `01-runbook.md` §배치 계약 | reconstruction·canonical repair가 recordId allowlist만 적용하고 unfiltered apply를 거부; 기존 단건 JSONL repair 계약 유지 | 신규 회귀·node check·호출 체인 | [x] | reconstruct/canonical unfiltered apply exit1, filtered plan 0; 복구 회귀 8/8·node check PASS; JSONL 단건 계약 유지 |
| MAX-03 | exact 89 batch·rollback manifest | `01-runbook.md` §배치 계약 | fresh exact 집합 전부를 중복 없이 ≤10건 batch로 분할, 모든 후보 SHA exact·target absent·path collision 0, backup/rollback 위치 기록 | batch manifest validator | [x] | exact 89→9 batches(10×8+9); duplicate ID/ref·unsafe·target exists·hash/DB mismatch 모두 0; canonical backup 필수·Raw 초기부재 rollback 계약 |
| MAX-04 | exact 89건 배치 복원 | `01-runbook.md` 순서5 | 각 batch에서 allowlist Raw 생성·canonical 보강·대상 5중 일치·안정 monitor new 0; 실패 batch에서 즉시 중단 | batch별 apply/audit/monitor 보고서 | [x] | 9 batches(10×8+9), Raw 생성 89·canonical 신규 85/기존 4, 전 대상 5중 exact; 최종 monitor 8,241/known 8,241/new 0; `MAX-04-batch-summary.json` |
| MAX-05 | 89건 독립 사후 감사 | `01-runbook.md` 순서6 | 전체 대상 5중 allExact, missing-raw가 정확히 89 감소, validate PASS, 합성·삭제 0 | fresh target audit·monitor·validate | [x] | manifest 원본 89개 unique·5중 allExact 89/89; missing 8,330→8,241(정확히 -89), monitor known 8,241/new 0, validate PASS; 합성·삭제 0 |
| MAX-06 | 잔여 유형 분류 | `01-runbook.md` 순서7 | 잔여를 scope/type/sourceRef/generator별 분류하고 분류 합계=monitor missing 수 | classification JSON·합계 assertion | [x] | 총 8,241=work-log 6,483+session-handoff 1,655+전용 생성기 없음 103; Map 카운터 결함 교정 후 scope/type/sourceFamily/generator/canonical 전수 분류·합계 PASS; `MAX-06-classification-corrected.json` |
| MAX-07 | 유형별 exact 재탐색 | `01-runbook.md` 순서8 | 허용 경로와 기존 생성기별 dry-run을 수행해 searched/exact/mismatch/unmatched를 원문 hash로 기록 | 도구별 plan·hash manifest | [x] | 전수 coverage 8,241=work-log archive 6,483+session transcript 1,655+기타 forensic 103; archive 13,197 sections, transcript 9,117 files/34,161 events, 허용 C 경로 5,980 files 탐색; exact union 0; H/E 0 |
| MAX-08 | 추가 exact 후보 조건부 복원 | `01-runbook.md` 순서9 | MAX-07에서 발견된 exact 후보만 ≤10건 allowlist batch로 5중 복원; 후보 0이면 적용 0 근거 | apply/audit/monitor·target count | [x] | exact 후보 0→batch 0·Raw 생성 0·canonical 변경 0; 네 복원기 unfiltered apply 모두 exit1; monitor 8,241/known 8,241/new 0; `MAX-08-noop.json` |
| MAX-09 | 증거 고갈 잔여 원장 | `01-runbook.md` §잔여 판정 | 미복원 전 레코드에 class·reason·searched evidence·next required evidence가 있고 합계가 monitor 잔여와 일치 | residual ledger validator | [ ] | |
| MAX-10 | 전체 회귀·종료 감사 | spec-loop 종료 게이트 | 체크리스트 11/11, Brain test/lint·TeleClo test/build·server syntax·embedding·health·monitor, LOOP_END·Brain/Wiki·recovery push·bundle | fresh audit JSON·저널·recall·remote ref | [ ] | |

## 3축 체크리스트

- 기능 명세: exact 후보 allowlist 복원, 유형별 포렌식, 증거 고갈 원장.
- 화면 명세: GUI 없음. 운영 보고서는 체크리스트·JSON·Wiki에서 열람 가능해야 한다.
- 데이터 계약: `recordId/sourceRef/contentHash`를 DB 정본으로 사용하고 Raw·JSONL·digest·manifest가 동일 레코드를 각각 1건 보유한다.
