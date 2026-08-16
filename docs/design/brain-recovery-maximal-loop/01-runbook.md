# Brain 안전 최대복구 루프 — 실행·검증

> 기준: `00-overview.md`

## 실행 순서

| 순서 | ID | 작업 | 즉시 검증 |
|---|---|---|---|
| 1 | MAX-00 | 완료 루프 archive·LOOP_START | archive SHA·저널 exact 1 |
| 2 | MAX-01 | fresh missing/exact inventory | monitor·dry-run·분류 합계 |
| 3 | MAX-02 | 모든 write 도구 allowlist 잠금 | 회귀 테스트·unfiltered apply 거부 |
| 4 | MAX-03 | 89건 batch/rollback manifest | batch≤10·hash exact·충돌 0 |
| 5 | MAX-04 | 89건 배치 복원 | 배치별 backup·canonical·monitor |
| 6 | MAX-05 | 89건 독립 5중 감사 | 대상 allExact·validate·감소량 89 |
| 7 | MAX-06 | 잔여 유형 분류 | 분류 합계=monitor 잔여 |
| 8 | MAX-07 | 유형별 exact 재탐색 | 도구별 searched/exact/unmatched |
| 9 | MAX-08 | 추가 exact 후보 조건부 복원 | 발견분만 5중 일치·new 0 |
| 10 | MAX-09 | 증거 고갈 잔여 원장 | 대상별 class·reason·next evidence |
| 11 | MAX-10 | 전체 회귀·종료 감사 | test/lint/build/health·LOOP_END·Brain/Wiki |

## 배치 계약

1. fresh plan에서 `recordId/sourceRef/contentHash/content/evidence`를 확정한다.
2. recordId를 정렬해 최대 10건의 고정 batch JSON으로 저장한다.
3. 적용 전 대상 Raw 부재와 canonical 현황, mutable index backup을 기록한다.
4. reconstruction apply에는 batch recordId allowlist를 전달한다.
5. canonical repair에도 같은 allowlist를 전달한다.
6. batch 대상별 Raw·DB·JSONL·digest·manifest 1건 및 hash 일치를 확인한다.
7. monitor가 안정 시점 `new=0`이 아니면 다음 batch를 중단한다.

## 경합 처리

- monitor가 live writer의 중간 상태를 포착하면 해당 recordId를 단건 plan으로 조회한다.
- writer가 완료해 `already-in-db` 또는 recoverable 0이면 재감사한다.
- 지속 불일치만 전용 단건 repair로 처리하며 다른 레코드를 함께 고치지 않는다.
- 같은 batch 3회 실패 시 접근 전환 저널을 기록하고 batch를 중단한다.

## 잔여 판정

| 상태 | 판정 | 동작 |
|---|---|---|
| exact candidate | 복구 가능 | allowlist batch 복원 |
| 후보 있으나 hash 불일치 | 복구 불가(현재 증거) | 후보 hash·경로만 원장 |
| 생성기 입력 일부 존재 | 재탐색 필요 | 유형 전용 재구성기 dry-run |
| 입력·원본 모두 없음 | 증거 고갈 | 필요한 외부 backup 식별 |

## 완료 조건

- 허용 경로에서 확인된 exact 후보는 모두 5중 일치로 복원된다.
- monitor 신규 문제는 0이며 전체 validate가 PASS다.
- 적용되지 않은 모든 잔여는 합계가 맞는 유형·이유·다음 증거 원장을 갖는다.
- 합성·삭제·unfiltered apply·H/E 접근은 0회다.
