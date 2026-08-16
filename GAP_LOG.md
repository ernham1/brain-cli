# GAP LOG — Brain 저장 경쟁 조건 및 Raw 포렌식 복구

## 진행 중

| ID | 태그 | 심각도 | 갭 | 수용 기준 |
|---|---|---|---|---|
| GAP-FR-04 | #성능 | P2 | 명시적 전체 `brain-cli validate`는 운영 데이터·시스템 부하에 따라 약 100초 소요 | 정기 감사 경로의 캐시/증분화 검토; 저장 경로는 변경 sourceRef 증분 검증 유지 |
| GAP-FR-05 | #보안 | P1 | 과거 work-log archive에 민감 설정값이 포함될 수 있음 | 관련 자격증명 회전 여부 확인 후 cold archive 접근통제 |
| GAP-RM-03 | #외부알림 | P2 | 무결성 alert는 health/local event까지만 노출되고 Telegram 자동 발송은 없음 | external-send 승인 후 알림 연결 |
| GAP-OPR-01 | #데이터복구 | P1 | 신규 missing-raw 2건(`rec_proj_clo-handoff_20260722_0283`, `rec_proj_clo-handoff_20260811_0707`)은 transcript는 있으나 당시 git status 원문이 없어 contentHash exact 재구성 불가 | 원본 사본 또는 당시 git status 근거 발견 시 exact hash 일치로만 복원; 합성·삭제 금지 |

## 보류

| ID | 태그 | 심각도 | 갭 | 보류 이유 |
|---|---|---|---|---|
| GAP-BM-08 | #보안승인 | P1 | 공식 Brain Wiki compile은 Brain Raw를 외부 Claude CLI로 전송 | 명시 승인 없는 외부 전송은 범위 밖 |

## 해결됨
- GAP-FR-14: clo-telegram 기존 실패 3건을 해결했다. `C:/Projects`를 보고 대상에서 제외하던 `D:/Projects` 고정 판정을 Projects 경계 기반으로 바꾸고, 실제 종료 hook이 대기 중일 때 합성 disappearance 이벤트가 quiet 기준시각을 덮어쓰지 않게 했다. 기존 실패 3건 16/16, 전체 218/218, build, PM2 online·watch enabled 확인.
- GAP-FR-15: 최근 미커밋 Decision Pipeline·SDK 세션 처리로 발생한 가상 `user...` 답변 혼입 회귀를 수정했다. 일반 대화 브리프 주입 0건, 번호 지정 시만 복원, 결정 브리프·오염 assistant 턴 신규 프롬프트 제외, 출력 저장 전 역할 누출 차단, 오염 SDK 세션 비파괴 격리·재생성, runner 토큰 로그 차단을 적용했다. 빌드·핵심 15 tests·전체 218 tests(현재 218 pass)·운영 dist 스모크·PM2 online 확인.
- GAP-RM-05: PM2 원문 환경 출력 금지·allowlist 진단 적용, 내부·Telegram 토큰 회전, OpenAI 로컬 제거·STT off, 전체 701 tests와 실송신 검증 완료. 공급자 OpenAI 키 삭제는 이사님 결정 dj-20260722-1412-oaix로 제외.
- GAP-RC-01: batch를 Brain Server 병렬 조회로 통합하고 강제 종료 충돌을 제거했다. 관련 3 tests·lint·전체 698 tests, 실제 5.18초 exit 0 확인.

- GAP-FR-01: 동시 write/boot 재현 FAIL→PASS, 운영 write `rec_proj_brain_20260721_0003` 및 validate PASS.
- GAP-FR-02: cleanup/session hook의 Raw unlink 경로 제거, cleanup을 읽기 전용 감사로 전환.
- GAP-FR-03: sourceRef 생략 update가 기존 Raw를 갱신하지 않던 문제를 상속 규칙과 회귀 테스트로 차단.
- GAP-FR-06: 살아 있는 PID의 락을 경과시간만으로 탈취하던 규칙 제거, 장기 validate 중 저장 충돌 차단.
- GAP-FR-07: 최종 검증에서 발견된 JSONL→DB 누락 1건을 락 안에서 재색인하고 validate PASS 확인.
- GAP-FR-08: exact 근거 13,973건 복구 완료; 잔여 8,592건은 합성하지 않고 D등급 격리 보존.
- GAP-FR-09: TeleClo 재시도의 `90_index/*.tmp` 전수 삭제를 제거하고 진단·보존으로 전환.
- GAP-FR-10: TeleClo 자식 write 제한 30초→5분, 상위 도구 제한 60초→11분으로 조정.
- GAP-FR-11: 락 소유 토큰 검증과 5분 대기를 적용해 늦은 해제가 후속 소유자의 락을 삭제하지 못하게 차단.
- GAP-FR-12: 중복 ID 검사를 O(n)으로 바꾸고 BWT tmp 검증은 변경 sourceRef만 검사하도록 분리.
- GAP-FR-13: 실제 TeleClo `brain_write`가 초기 21.34초, 최종 작업/Wiki 갱신 4.35초/3.92초에 재시도·오류 없이 저장 성공.

- 이전 `GAP-BM-*` 해결 기록은 `docs/design/brain-memory-integrity-loop/archive/20260721-completed/GAP_LOG.md`에 보존한다.
## 다음 루프 반영 (2026-07-21)

- GAP-RM-01 #데이터복구: 임의 evidence root의 동일 basename+SHA-256 exact 탐색 경로 부재 → RM-01/03.
- GAP-RM-02 #운영모니터링: known 8,592건과 신규 누락을 분리하는 baseline/delta·append-only 사건 기록 부재 → RM-04/05/06.
- GAP-RM-01 해결: 64,054파일 중 basename 후보 407개만 hash하여 exact Raw 347개·record 360건을 추가 복구하고 잔여 8,233건을 확정.
- GAP-RM-02 해결: baseline/delta CLI, append-only event, 15분 PM2 감시, health latest event 노출을 운영화함.
- GAP-RM-04 해결: JSONL-only 4건 정정, persistent 4건 BWT 흡수, mutable 2건 source contract 명시 후 monitor hash-contract 0·resolved 10·new 0을 확인함.
- GAP-RM-03은 진행 중으로 승격: Telegram 자동 발송은 external-send 승인 전 보류.


## Brain 저장소 재해복구 갭 (2026-08-16)

### GAP-REC-01
- 태그: #데이터복구
- 프로젝트: brain
- 지적: C와 D를 독립 사본으로 오판한 삭제 사고가 발생했다.
- 원인: 경로 문자열만 비교하고 물리 파일 ID·볼륨 관계를 삭제 전 확인하지 않았다.
- 수정: 현 위치 직접 수리 → 별도 H 볼륨에서만 복구하고 원본은 불변 증거로 고정.
- 다음 루프 반영법: 삭제·이동·reset 전 파일 ID, Volume UniqueId, 절대경로를 필수 증거로 둔다.

### GAP-REC-02
- 태그: #데이터복구
- 프로젝트: brain
- 지적: LOOP_START를 기록할 decision-pipeline 도구와 매핑이 삭제·손상됐다.
- 원인: 복구 절차가 결정 인프라 생존을 전제로 했다.
- 수정: 게이트 생략 → REC-00을 명시적 블로커로 두고 도구가 정상화될 때까지 구현 금지.
- 다음 루프 반영법: 시작 전 journal tool 존재·NUL·스키마 실행 검증을 완료 기준에 포함한다.

### GAP-REC-03
- 태그: #데이터복구
- 프로젝트: brain
- 지적: 복구 `.git`의 객체 2,929개와 index가 손상됐다.
- 원인: Recuva 복구본을 정상 Git 저장소로 간주할 수 없다.
- 수정: `.git` 결합·reset → 정상 원격 clone 기반선 + 회수 가능한 메타데이터만 채택.
- 다음 루프 반영법: 객체별 `cat-file` 성공과 전체 `fsck`를 별도 게이트로 둔다.

### GAP-REC-04
- 태그: #데이터복구
- 프로젝트: brain
- 지적: 7월 28일 이후 수정이 없다는 핸드오프 판단이 세션 파일 생성일 기준 검색 때문에 틀렸다.
- 원인: 장기 세션 JSONL 내부 이벤트 시각을 확인하지 않았다.
- 수정: 세션 생성일 검색 → 이벤트 timestamp·파일 mtime·Brain 기록의 3중 대조.
- 다음 루프 반영법: 확인된 12개 파일을 해시 체크 항목으로 고정한다.

### GAP-REC-05
- 태그: #데이터복구
- 프로젝트: brain
- 지적: 생존 node_modules는 81개 의존성 문제를 포함하고 테스트 3건이 실패한다.
- 원인: 삭제가 중단된 의존성 트리와 오래된 테스트 기대값이 최신 소스와 불일치한다.
- 수정: live tree 재설치 → 격리 repo clean install 후 stale 테스트 2건만 계약 기준으로 정정.
- 다음 루프 반영법: install·npm ls·targeted FAIL→PASS·전체 회귀를 분리한다.

### GAP-REC-06
- 태그: #데이터복구
- 프로젝트: brain
- 지적: 저장소 복구와 운영 서비스·데이터 복구를 한 번에 수행하면 원인과 영향 범위가 섞인다.
- 원인: 코드 보존, Git 복원, 서비스 cutover, 데이터 무결성은 실패 위험과 되돌리기 방식이 다르다.
- 수정: 단일 대형 복구 → 이번 저장소 복구와 다음 운영 전환·데이터 복구 루프로 분리.
- 다음 루프 반영법: 이번 루프의 금지 목록에 PM2 재시작·운영 데이터 수정·push를 둔다.
### GAP-REC-07
- 태그: #데이터복구
- 프로젝트: brain
- 지적: 설계된 격리 대상 H:는 용량·물리 분리 기준을 통과하지만 볼륨 상태가 `Warning / Full Repair Needed`다.
- 원인: 초기 설계가 Volume UniqueId와 여유 공간만 기준으로 삼고 파일시스템 HealthStatus·OperationalStatus를 완료 기준에 포함하지 않았다.
- 수정: REC-02 복사를 시작하지 않고 REC-01을 BLOCKED로 유지했다. 별도 건강한 E:는 15.38GB 여유지만 설계 경로 변경 승인이 필요하다.
- 다음 루프 반영법: 증거 저장 볼륨은 물리 분리·용량뿐 아니라 `HealthStatus=Healthy`, `OperationalStatus=OK`를 모두 통과해야 한다.
- 후속 교정: 광웅 이사님 지적에 따라 Brain과 무관한 H/E 탐색을 중단했다. `C:\Projects`가 실제 `D:\Projects` 링크임을 증명하고, 링크 밖의 Healthy/OK C: NTFS `C:\Brain-Recovery\20260816`으로 재시도해 REC-01을 통과했다. ← `dj-20260816-1755-brr2`