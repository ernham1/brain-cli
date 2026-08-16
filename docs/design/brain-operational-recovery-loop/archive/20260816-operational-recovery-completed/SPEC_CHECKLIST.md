# 스펙 체크리스트: Brain 운영 전체 복구

> 원본: `docs/design/brain-operational-recovery-loop/00-overview.md`, `01-runbook.md` | 태그: `#데이터복구` | 승인: 자율(시작 게이트 `dj-20260816-1917-bor1`)
> 전제: 저장소 복구 LOOP_END `dj-20260816-1900-brr3`
> 반영한 과거 갭: GAP-FR-01~13, GAP-RM-01~05, GAP-REC-01~07
> 3축: 기능=데이터·Git·보안·서비스·원격복구, 화면=없음, 데이터=Raw·JSONL·DB·manifest·baseline·PM2·Git ref

| ID | 항목 | 스펙 근거 | 완료 기준 | 검증 방법 | 상태 | 증거 |
|---|---|---|---|---|---|---|
| OPR-00 | 시작 게이트·이전 루프 보존 | 01 순서1 | 이전 15/15 파일 archive, 전제 저널 포함 LOOP_START exact 1 | archive hash·저널 스키마 | [x] | archive SPEC SHA-256 `a28091e2…`; LOOP_START `dj-20260816-1917-bor1` exact 1건·전제/필드 검증 |
| OPR-01 | 운영 기준선·rollback 패킷 | 00 중단조건 | 코드 delta, mutable index, PM2 4서비스, env 존재 여부를 값 노출 없이 기록; 백업 대상·용량 확정 | 해시 manifest·경로·복원 명령 dry-run | [x] | `OPR-01-baseline.json` verified; alternate delta 21, mutable 129,979,362 bytes, C: free 133,803,261,952, env 값 미수집, PM2 2 online/2 stopped |
| OPR-02 | exact Raw 3건 계약 검증 | 00 D2 | 전용 도구 테스트 PASS, 운영 dry-run targets 1749/exactMatches 3; 합성 0 | targeted test·dry-run JSON | [x] | test 1/1, dry-run targets 1749·exactMatches 3·unmatched 1746, contentPersisted=false·합성 0; `OPR-02-exact-raw-plan.json` |
| OPR-03 | JSONL→DB 단건 복구 도구 | 01 매핑 | raw/contentHash 일치+DB 부재 1건만 INSERT/FTS; 재실행 idempotent; 다른 row 변경 0 | fixture FAIL→PASS·DB 전후 count | [x] | 신규 script+test; 1차 fixture DB 부재 fail 1 → fixture 교정 후 3/3; 운영 dry-run examined 1·candidate exact 1·apply false; `OPR-03-targeted-repair-plan.json` |
| OPR-04 | 의존성 보안 복구 | 00 D3 | 공식 Transformers package 이관·non-force fix; npm ls 3/3; critical/high 0 또는 fix 불가 근거·실행경로 분리 | npm ci/ls/audit·import/embedding 스모크 | [x] | Xenova→Hugging Face 4.2.0, critical 0; server 4→0, clo 11→low 1(dev esbuild), CLI 7→high 4(`fixAvailable=false` upstream); npm ls 3/3, embedding Float32Array 384 finite; force 0 |
| OPR-05 | 격리 전체 회귀 | 01 순서6 | brain lint+전체 test, clo build+전체 test, brain-server syntax 모두 exit 0 | 원문 로그·exit code | [x] | Brain test 715/715·lint 0, clo build 0·test 222/222, server syntax 0; `OPR-05-isolated-regression.json` verified |
| OPR-06 | maintenance·mutable 백업 | 01 순서7 | writer 영향 확인 후 정지; index 6종+baseline+대상 Raw 상태 백업, hash mismatch 0 | PM2 sanitized 상태·SHA manifest | [x] | PM2 writer 2개 stopped·3849 listener 0; DB checkpoint busy 0; 필수 파일 6종+baseline+contract+Raw 백업 SHA mismatch 0; `OPR-06-maintenance-backup.json` verified |
| OPR-07 | 운영 데이터 exact 복구 | 01 순서8 | JSONL→DB 1, Raw 3(신규1/known2), canonical 1(known2는 기존 존재); 대상 recall; new 2, known 8,330, total 비증가, validate PASS; 잔여 신규2 GAP 보존 | 전후 audit·DB/JSONL/Raw/hash·recall | [x] | DB 1·Raw 3·canonical 1, synthetic/delete 0; new 4→2·known 8,332→8,330·total 8,336→8,332; target hash/canonical 4/4, recall score 1,000,000, validate exit 0; `OPR-07-data-recovery.json` |
| OPR-08 | 운영 소스 Git 복원 | 00 D1 | 역사 자산 11·테스트 계약 정합, `.git` 복원, HEAD/tag/fsck 정상; runtime/secret 추적 0 | alternate status 전후·fsck·secret scan | [x] | 자산 11 SHA 일치·stale test 정합·deleted 0; HEAD `50a58aec`·annotated tag deref 일치·fsck 0; runtime env tracked 0·ignore 4/4·diff secret 0; `OPR-08-source-git.json` verified |
| OPR-09 | 운영 경로 설치·회귀 | 01 순서10 | server/clo npm ci; Brain active MCP lock 시 격리 clean tree 배치+native hash+npm ls; audit·brain/clo 전체 회귀 exit 0 | source 경로 원문 로그 | [x] | 외부 MCP kill 0, clean tree 배치·native SHA 일치·npm ls 3/3; Brain 715/715+lint, clo 222/222+build, server syntax, embedding 384 finite, health ok; audit critical 0·server 0·잔여 CLI high4 fix불가/clo dev low1 no-op; `OPR-09-operational-regression.json` |
| OPR-10 | 복구 checkpoint·원격 안전망 | 01 순서11 | 새 commit/tag/bundle verify·재clone; origin recovery branch/tag SHA 일치; main 불변 | ls-remote·bundle verify·clone fsck | [x] | commit `134b12d`; tag deref 일치; bundle SHA `72f6e38b…` verify+clone fsck 0; origin recovery branch/tag 일치, main `18e1333d` 불변, force 0; `OPR-10-remote-push.json` verified |
| OPR-11 | PM2 서비스 정상화 | 01 순서12 | brain-server/teamengram-org-brain/monitor/clo online, 새 PID·기대 cwd, crash loop 0 | sanitized PM2·health/log | [x] | 4서비스 online·PID>0·unstable 0; clo cwd C/ watch dist; monitor restart 0; 3849/3850 health ok; `OPR-11-services.json` verified |
| OPR-12 | 실제 사용자 경로 스모크 | 01 운영 시나리오 | Brain health→write→recall·Raw/JSONL/DB, monitor 신규2 사실 기록·증가0, Telegram 인증+개인 실송신 1건 | API·파일·DB·message id | [x] | smoke `rec_proj_brain_20260816_0005` write/recall/Raw·DB·FTS·JSONL·digest 후 deprecated; monitor new2/known8330/total8332 event; Telegram `@clo_nf_bot` chat 64445716 message_id `72435`; `OPR-12-user-path-smoke.json` verified |
| OPR-13 | 종료 독립 감사 | 01 순서14 | 원문 재대조, 14/14, fresh 회귀, rollback 증거·원격 ref·서비스, LOOP_END | 동일 세션 자기감사·증거 실물 | [x] | pre-end 13/14+unchecked1 정합, fresh Brain 715/715·clo 222/222, integrity 8332/known8330/new2, PM2 4 online, health ok, remote main 불변, bundle/backup/secret gate; LOOP_END `dj-20260816-2020-bor5`; `OPR-13-pre-end-audit.json` verified |

## 범위 잠금

- 포함: 운영 데이터 신규 4건, Git, dependency, PM2 4서비스, recovery remote ref, live smoke.
- 제외: known 8,332건 합성·삭제, main 병합/force push, 복구 증거 삭제, 무관 드라이브 탐색.
- 비가역/외부 작업은 실행 시 승인 권한 게이트와 정확한 대상을 다시 제시한다.
