# Brain 운영 전체 복구 루프 — 실행·검증

> 원본: `00-overview.md`
> 선행: 저장소 복구 LOOP_END `dj-20260816-1900-brr3`
> 디자인 토큰: 없음 (운영·데이터 레이어)

## 실행 순서

| 순서 | ID | 작업 | 즉시 검증 | rollback |
|---|---|---|---|---|
| 1 | OPR-00 | 이전 루프 archive, LOOP_START | archive 해시, 저널 exact 1 | 신규 루프 파일 제거 |
| 2 | OPR-01 | 코드·데이터·PM2 기준선/백업 설계 | 대상·크기·해시·경로 | 쓰기 없음 |
| 3 | OPR-02 | Raw 3건 exact 재구성 dry-run/테스트 | exactMatches=3, hash gate | 쓰기 없음 |
| 4 | OPR-03 | JSONL→DB 단건 복구 도구·회귀 테스트 | 대상 1건만 INSERT, 재실행 0건 | fixture 삭제 |
| 5 | OPR-04 | 의존성 보안 이관·non-force fix | npm ls/audit, 임베딩 스모크 | lock/package 되돌림 |
| 6 | OPR-05 | 복구 repo 전체 격리 회귀 | brain 712+, clo 222+, build/lint | 운영 전환 금지 |
| 7 | OPR-06 | maintenance gate, writer 정지, mutable backup | writer stopped, 백업 해시 | PM2 재시작 |
| 8 | OPR-07 | exact 가능 데이터 적용 | DB 1·Raw 3(신규1/known2)·canonical 1·recall, new=2·known=8,330·total 비증가 | 백업 원자 복원 |
| 9 | OPR-08 | 운영 트리 tracked 정합 + `.git` 복원 | HEAD/tag/fsck, 시크릿 추적 0 | `.git`·추적파일 복원 |
| 10 | OPR-09 | 운영 경로 dependency 정합·전체 회귀 | server/clo npm ci; Brain은 active MCP native lock 시 격리 clean tree 비삭제 배치+npm ls/native hash; audit/test/build/lint | 이전 dependency/코드 복원 |
| 11 | OPR-10 | commit/tag/bundle + 원격 recovery 백업 | remote SHA, bundle clone | remote ref 별도 보고 |
| 12 | OPR-11 | PM2 4서비스 정상화 | online·PID·cwd·health | 직전 PM2 정의로 복원 |
| 13 | OPR-12 | 실제 기능 스모크 | Brain 실호출·monitor·Telegram 실송신 | 시험 record deprecated |
| 14 | OPR-13 | 최종 감사·LOOP_END | 14/14·fresh 회귀·증거 실물 | 불일치 항목 재개 |

## 데이터 읽기→쓰기 매핑

| 읽기 속성 | 값 | 쓰기 동작 | 구현 위치 |
|---|---|---|---|
| integrity type | `jsonl-missing-db` | JSONL row·Raw hash 일치 시 DB/FTS 단건 INSERT | 신규 targeted repair script |
| integrity type | `missing-raw` + exact hash | 임시 파일 hash 검증 후 Raw 생성 | `reconstruct-session-handoff-raw.js` |
| DB-only + Raw 있음 | 신규 exact Raw 1건(known 2건은 canonical 기존 존재) | JSONL/digest/manifest canonical 1건 복원 | `repair-canonical-index-from-db.js` |
| known missing Raw | 8,332건 | baseline 격리 보존; 생성·삭제 0 | integrity baseline |
| dependency | `@xenova/transformers` | 공식 namespace로 import/package 교체 | `db.js`, package/lock |
| audit fix | non-breaking available | `npm audit fix` 후 lock diff·회귀 | 각 package |
| audit fix | force/major only | 자동 적용 금지, 잔여 리포트 | audit report |

## 외부 의존 전제

- npm: registry 단건 조회/설치 성공, 명령 timeout·실패 로그 기록.
- GitHub: origin read 확인 후 recovery branch/tag만 push; main ref 불변 확인.
- Telegram: bot 인증 read 성공 후 개인 채팅 1건 실송신; 실패 시 clo 항목만 보류.

## 운영 검증 시나리오

1. brain-server와 teamengram-org-brain이 복구 코드에서 online이 된다.
2. `/api/health`가 응답하고 integrity는 근거 없는 합성 없이 `newIssues=2`, known 8,330, total 비증가를 사실대로 노출한다.
3. recovery-smoke record를 write하면 같은 ID가 recall되고 Raw·JSONL·DB에 존재한다.
4. monitor 1회 실행 후 event가 신규 2건을 사실대로 기록하고 복구 전 대비 issue 증가가 없다.
5. 텔레클로가 인증되고 개인 채팅에 복구 확인 1건을 보낸다.
6. 시험 레코드는 삭제하지 않고 deprecated 처리해 감사 흔적을 남긴다.

## 완료 보고 계약

- 완료: SHA·테스트 수·API 응답·PM2 상태·원격 ref를 제시한다.
- 보류: 외부 의존 실패나 fix 없는 취약점은 대상만 보류하고 이유를 명시한다.
- 미검증: 실제 실행 증거가 없는 항목은 완료 처리하지 않는다.

## 가정 명세

### 확정된 가정
- 운영 downtime은 writer 정지부터 서비스 재기동까지 최소화한다.

### 기술적으로 결정한 것 (확인 불필요)
- 데이터 복구와 코드 cutover를 같은 maintenance window에서 수행하되 각각 rollback 포인트를 둔다.

### 아직 열린 사항
- 실제 audit 결과의 잔여 취약점은 OPR-04에서 확정한다.
