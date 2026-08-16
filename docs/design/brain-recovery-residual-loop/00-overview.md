# Brain 복구 잔여 후속 루프 — 개요

> 원본: 광웅 이사님 2026-08-16 지시 “나머지 진행”, `GAP_LOG.md` GAP-OPR-01
> 전제: 운영 전체 복구 LOOP_END `dj-20260816-2020-bor5`

## 제품 가치

근거 없는 기억을 만들지 않으면서 복구 가능한 마지막 데이터와 안전하게 줄일 수 있는 의존성 위험을 끝까지 확인한다.

## 요구사항

1. 잔여 missing Raw 2건은 기존 원본·복구 증거·Git·관련 세션 로그에서 exact preimage를 다시 찾는다.
2. 후보는 DB contentHash와 SHA-256이 같을 때만 적용한다. 불일치 후보는 증거로만 남긴다.
3. exact 원문이 없으면 합성·삭제하지 않고 GAP-OPR-01을 유지한다.
4. Brain CLI high 4건과 TeleClo dev low 1건은 현재 공식 registry와 audit 결과를 다시 측정한다.
5. non-force 호환 수정만 반영하고 embedding·전체 회귀·운영 health를 검증한다.

## 범위

### 포함

- `rec_proj_clo-handoff_20260722_0283`
- `rec_proj_clo-handoff_20260811_0707`
- `src/brain-cli`, `src/clo-telegram`, `src/brain-server` dependency audit

### 제외

- H/E 드라이브와 Brain 무관 경로
- 근거 없는 Raw 합성·active record 삭제
- `npm audit fix --force`, main 병합, 외부 메시지 발송

## 아키텍처 결정

- 데이터: target ID → sourceRef/basename → transcript fragment → 후보 SHA-256의 좁은 순서로 탐색한다.
- 보안: 취약점 개수보다 실제 실행경로·fixAvailable·호환성·회귀를 함께 판정한다.
- 운영: 데이터 write가 필요한 경우에만 별도 backup/maintenance gate를 연다.

## PRISM 검토

| Layer | 판정 | 비고 |
|---|---|---|
| R | ✅ | 후보 hash, audit, test가 즉시 피드백 |
| B | ✅ | 탐색→조건부 적용→회귀→기억 갱신으로 닫힘 |
| D | ✅ | exact-only·non-force 결정 |
| S | ✅ | Raw/DB/manifest 및 package/runtime 연결 대조 |
| G | ✅ | 데이터와 의존성 범위를 분리 |
| I | ✅ | 발견·미발견·fix 없음을 별도 상태로 기록 |
| E | ✅ | 진단·처리·검증·후속 보존 포함 |

## 가정 명세

### 확정된 가정
- “나머지”는 직전 완료 보고의 Raw 2건과 dependency audit 잔여를 뜻한다.
- H/E는 확인하지 않는다.

### 기술적으로 결정한 것 (확인 불필요)
- exact hash와 non-force 호환성 게이트를 적용한다.

### 아직 열린 사항
- 두 Raw의 exact preimage가 실제로 남아 있는지는 탐색 후 확정한다.
- 상위 패키지 공식 수정본 존재 여부는 registry 실측 후 확정한다.
