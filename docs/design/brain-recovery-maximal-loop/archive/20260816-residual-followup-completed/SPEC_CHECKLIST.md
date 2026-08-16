# 스펙 체크리스트: Brain 복구 잔여 후속

> 원본: `GAP_LOG.md` GAP-OPR-01, 광웅 이사님 2026-08-16 지시 “나머지 진행” | 태그: `#데이터복구` | 승인: 자율(시작 게이트, `dj-20260816-2039-brf1`)
> 전제: 운영 전체 복구 LOOP_END `dj-20260816-2020-bor5`
> 반영한 과거 갭: GAP-OPR-01, GAP-REC-03~05, GAP-FR-01~13
> 범위 잠금: H/E 접근 금지, 합성·삭제 금지, `npm audit fix --force` 금지, main 변경 금지

| ID | 항목 | 스펙 근거 | 완료 기준 | 검증 방법 | 상태 | 증거 |
|---|---|---|---|---|---|---|
| RES-00 | 완료 루프 보존·시작 게이트 | `00-overview.md` §범위 | 이전 SPEC/STATUS archive SHA 확보, 전제 포함 LOOP_START exact 1건 | archive hash·저널 조회 | [x] | archive SPEC `550a1178…`, STATUS `42d7ff20…`; LOOP_START `dj-20260816-2039-brf1` append 성공 |
| RES-01 | Raw 2건 exact 증거 재탐색 | GAP-OPR-01 | 허용된 Brain/복구/Git/세션 증거 경로를 target ID·sourceRef·contentHash로 전수 검색하고 후보별 SHA 판정; H/E 0회 | 검색 manifest·후보 hash 보고서 | [x] | targeted plan: targets 2 / exact 2 / unmatched 0; SHA `6734f02b…`, `5677ad10…`; adjacent Raw `0282`,`0706`; 회귀 2/2; 범위 밖 89건 미적용 |
| RES-02 | exact 발견분 조건부 복구 | `01-runbook.md` §조건부 적용 | 발견분만 사전 백업 후 hash exact로 Raw/canonical 복구; 미발견분은 합성·삭제 0, integrity issue 비증가 | backup hash·target audit·monitor·validate | [x] | pre-state 부재 2건 보존; canonical backup `_backup-memory-integrity-2026-08-16T11-58-42-565Z`; 5중 audit allExact; monitor 8,330/known 8,330/new 0; validate PASS |
| RES-03 | 의존성 잔여 non-force 처리 | 운영 완료 보고 | npm transport 실측, 세 패키지 audit/ls; 호환 가능한 수정만 적용; fix 없음은 실행경로·상위 이슈 근거; 전체 회귀 신규 실패 0 | npm view/audit/ls·embedding·test/build/lint | [x] | clo low 1→0 (`tsx 4.23.12`,`esbuild 0.28.2`); server 0; CLI high4 모두 fixAvailable=false·critical0, embedding 384 finite; Brain 716/716·lint, clo 222/222·build, server syntax PASS; force 0 |
| RES-04 | 종료 독립 감사·기억 갱신 | spec-loop 종료 게이트 | 5/5 증거 실물 대조, 서비스/health/원격 recovery ref 불변, LOOP_END·Brain project_state·Wiki 반영 | fresh audit JSON·저널·recall | [x] | `RES-04-pre-end-audit.json`; health ok·monitor 8,330/known 8,330/new 0; Brain `rec_proj_brain_20260816_0007` recall·Wiki 확인; LOOP_END `dj-20260816-2116-brf2` |

## 범위 잠금

- 포함: `rec_proj_clo-handoff_20260722_0283`, `rec_proj_clo-handoff_20260811_0707`, Brain CLI high 4, TeleClo dev low 1.
- 제외: H/E 드라이브, known 8,330건 합성·삭제, main 병합, force update, unrelated GAP.
- exact 후보가 없거나 공식 수정본이 없으면 보존 근거를 완료 증거로 남긴다. “숫자 0”을 위해 데이터를 만들거나 호환성을 깨지 않는다.
