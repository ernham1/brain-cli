# 스펙 체크리스트: Brain 자격증명 노출 후속 격리·회전 검증

> 상태: COMPLETE — 승인된 대상 회전·검증 및 제외 결정 반영 | 원본: `docs/design/brain-credential-rotation-followup/00-overview.md` | 승인: 이사님 2026-07-22 (`dj-20260722-1206-sec0`)
> 반영 갭: GAP-RM-05, GAP-FR-05 | 3축: 기능=안전 진단·회전·검증, 화면=없음, 데이터=값 없는 보안 감사 메타데이터

| ID | 항목 | 스펙 근거 | 완료 기준 | 검증 방법 | 상태 | 증거 |
|---|---|---|---|---|---|---|
| SEC-00 | 시작 승인·범위 고정 | 00 §목표 | 이사님 승인, 대상 서비스 범위, LOOP_START 저널 존재 | 승인·저널 확인 | [x] | `dj-20260722-1206-sec0`; Brain Server·clo-telegram 설정 진단, 실제 회전 별도 승인 |
| SEC-01 | 값 없는 영향 인벤토리 | 01 §인벤토리 | 자격증명 값을 읽거나 출력하지 않고 이름·소유 서비스·저장 유형·검증 경로만 고정 | 산출물 비밀 패턴 검사 | [x] | `02-credential-inventory.md`; 8 rows; 민감 패턴 0건 |
| SEC-02 | PM2 안전 진단 경로 | 01 §인벤토리 | 환경변수 전체 덤프 없이 allowlist 상태만 확인 | 회귀 테스트·실호출 | [x] | `scripts/safe-pm2-status.js`; 수정 전 2 FAIL→2 PASS; 실호출 2 services online |
| SEC-03 | 회전 승인 게이트 | 01 §승인 | 회전 대상별 이사님 승인, 미승인 대상 변경 0 | 승인 기록·전후 변경표 | [x] | 7개 후보 전체 순차 회전 승인; `dj-20260722-1218-rot7` |
| SEC-04 | 승인 대상 순차 회전·서비스 검증 | 01 §완료 | 한 건씩 회전 후 관련 health·핵심 호출 통과 | 공급자 완료 시각·서비스 smoke | [x] | 내부 토큰 완료; Telegram getMe·PM2 clean recreate·실송신 완료; OpenAI 로컬 제거·STT off 완료, 공급자 키 삭제 제외 `dj-20260722-1412-oaix` |
| SEC-05 | 감사·Brain/Wiki·종료 | 01 §완료 | 비밀값 노출 0, 남은 항목 명시, Brain/Wiki 5계층, LOOP_END | 패턴 검사·recall·저널 | [x] | 민감 패턴 0; 3 services online; Brain health ok; 701/701 tests; rec_proj_brain_20260722_0009; dj-20260722-1416-sec5 |

## 범위 잠금

- 포함: 값 없는 영향 인벤토리, 안전 진단, 승인된 자격증명 회전과 서비스 검증.
- 제외: 미승인 토큰 회전, 과거 로그 삭제, 기록 내용 재출력, 무관 서비스 재시작.