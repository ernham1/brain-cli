# Brain 운영 전체 복구 루프 — 개요

> 원본: 광웅 이사님 2026-08-16 지시 “전체 복구 루프 수행” 및 저장소 복구 종료 `dj-20260816-1900-brr3`
> 선행: `docs/design/brain-repository-recovery-loop/00-overview.md`, `01-runbook.md`
> 디자인 토큰: 없음 (운영·데이터 레이어)

## 제품 가치

Brain의 코드·기억 데이터·운영 서비스가 각각 복구 가능하고 실제 write/recall 경로가 닫힌 상태로 동작한다.

## 요구사항

1. 운영 변경 전 코드·인덱스·설정 rollback 증거를 만든다.
2. 신규 무결성 4건을 exact 근거로 분류하고, exact 근거가 있는 DB 1건+Raw 1건을 수리한다. 원문이 없는 신규 Raw 2건은 합성·삭제하지 않고 미해결로 보존한다.
3. 원문 증거 없는 known 8,332건은 합성하지 않고 baseline으로 격리 보존한다.
4. 복구 commit을 현재 운영 경로에 연결해 `.git`과 추적 파일을 정합화한다.
5. 취약 의존성을 공식 패키지로 교체하고 non-force 범위에서 보안 갱신한다.
6. 전체 회귀를 통과한 코드로 Brain·TeamEngram Brain·무결성 감시·텔레클로를 정상화한다.
7. health→write→recall과 Telegram 인증/실송신으로 사용자 경로를 검증한다.
8. 복구 브랜치·태그·bundle을 원격/로컬에 이중 보존한다.

## 현재 실측

- 복구 기준: `C:\Brain-Recovery\20260816\repo`, commit `50a58aecddfe5de86a666c179e2d1c9a00246d7d`.
- 운영 코드: `C:\Projects\Brain`(물리 실체 D:), `.git` 없음.
- 운영 데이터: `C:\Users\ernham\Brain`; health ok, integrity 8,336건(known 8,332/new 4).
- 신규 4건: JSONL→DB 1건은 Raw hash exact. missing Raw 3건 중 신규와 겹치는 exact match는 1건이며 나머지 2건은 과거 known 결손이다. 신규 Raw 2건은 현재 근거로 exact 복구 불가다.
- 서비스: brain-server·teamengram-org-brain online, monitor·clo-telegram stopped.
- 보안: brain-cli 9건, brain-server 4건, clo-telegram 11건.

## 아키텍처 결정

### D1. 운영 경로 유지 + Git 복원

> **WHAT**: 현재 PM2 경로를 유지하고 복구 `.git`과 추적 파일만 정합화한다.
> **WHERE**: `C:\Projects\Brain`, `C:\Brain-Recovery\20260816\repo`
> **GUI TOKEN**: 없음 (운영 레이어)
> **VERIFY**: 현재 경로에서 HEAD·tag·fsck·clean과 PM2 실행 경로 일치를 확인한다.
> **DEPENDS**: rollback 백업, 격리 전체 회귀

- 환경파일·브리지 데이터·PM2 cwd를 새 위치로 옮기지 않아 상태 이동을 최소화한다.
- PM2를 C: 복구 repo로 재배선하는 대안은 runtime overlay 이관 위험 때문에 채택하지 않는다.

### D2. 데이터는 exact 근거만 복구

> **WHAT**: JSONL-only 1건 단건 삽입 + 전체 결손 중 contentHash exact Raw 3건(신규 1·known 2) 재구성 + canonical index 복원.
> **WHERE**: `src/brain-cli/scripts/`, `C:\Users\ernham\Brain`
> **GUI TOKEN**: 없음 (데이터 레이어)
> **VERIFY**: DB 1건·Raw 3건·canonical 누락 1건의 hash 일치, 신규 issue 4→2, known 8,332→8,330, total issue 비증가. known Raw 2건은 canonical이 이미 존재하므로 추가 쓰기 0건. 잔여 신규 Raw 2건은 sourceRef·contentHash·탐색 근거를 GAP에 보존.
> **DEPENDS**: writer 정지, mutable index 백업

- `repair-source-refs`로 known 8,332건을 메타 문서로 합성하지 않는다.
- backup→임시 검증→원자 교체→validate 순서를 지킨다.

### D3. 의존성 보안

> **WHAT**: `@xenova/transformers`를 공식 `@huggingface/transformers`로 교체하고 나머지는 non-force audit fix.
> **WHERE**: `src/brain-cli/package.json`, lockfiles, `src/brain-cli/src/db.js`
> **GUI TOKEN**: 없음 (런타임 레이어)
> **VERIFY**: 동적 import·임베딩 스모크·전체 테스트·audit를 통과한다.
> **DEPENDS**: 격리 clean install, npm transport 실측

- 공식 Hugging Face v3+는 Node.js CJS 동적 `import()`를 지원한다.
- `--force`는 사용하지 않고 남는 취약점은 악용 경로와 fix 가능성을 기록한다.

## 범위

### 포함

- 운영 데이터 신규 4건 exact 분류와 복구 가능 2건 수리, 과거 known Raw 2건 exact 수리
- 운영 소스 Git/추적 파일 복원
- dependency 보안 정리와 전체 회귀
- PM2 brain-server, teamengram-org-brain, brain-integrity-monitor, clo-telegram 정상화
- 실제 Brain write/recall 및 Telegram 개인 채팅 1회 실송신
- recovery branch/tag 원격 백업과 새 bundle

### 제외

- known 8,332건 합성·삭제
- main/master 병합 또는 force push
- 복구 증거·백업 삭제
- Brain과 무관한 드라이브 탐색
- TeamEngram 제품 코드 변경

## 중단·rollback 조건

- 백업 해시 불일치, exact Raw 3건 미만, 신규 issue가 2건보다 많음, total issue 증가, validate FAIL이면 데이터 적용 중단·백업 복원.
- 회귀 실패면 서비스 전환 금지.
- 재시작 뒤 health/write/recall 실패면 직전 코드·인덱스로 rollback.
- push는 recovery branch/tag만 허용한다.

## PRISM 검토

| Layer | 판정 | 비고 |
|---|---|---|
| R | ✅ | health·monitor·Telegram 즉시 피드백 |
| B | ✅ | 백업→복구→검증→운영→감시로 루프 닫힘 |
| D | ✅ | 운영 경로 유지, main 미병합, exact-only |
| S | ✅ | Raw/JSONL/DB↔PM2↔Telegram 연결 식별 |
| G | ✅ | Git·데이터·서비스·원격 백업 경계 분리 |
| I | ✅ | known/new/rollback 증거 구분 |
| E | ✅ | 진단→복구→확인→감시 여정 포함 |

## 가정 명세

### 확정된 가정

- “전체 복구”는 데이터·Git·서비스·보안·원격 안전망을 포함한다.
- 원문 증거 없는 8,332건은 합성하지 않는다.

### 기술적으로 결정한 것 (확인 불필요)

- 운영 경로 유지, exact hash gate, non-force update, recovery branch push를 사용한다.

### 아직 열린 사항

- 공식 fix가 없는 취약점은 위험도와 실행 경로를 근거로 별도 보안 루프로 분리한다.
- Telegram 실송신은 복구 확인 1건만 보낸다.
