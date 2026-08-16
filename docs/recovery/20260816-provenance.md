# Brain 저장소 복구 provenance

> 작성: 2026-08-16 | 복구 작업공간: `C:\Brain-Recovery\20260816` | 상태: REC-07 증거 확정

## 판정

- 정상 원격의 20개 커밋은 손상되지 않은 Git 기반선이다.
- Recuva Git의 추가 3개 커밋은 commit·tree 메타데이터가 살아 있지만 blob 손상이 커서 원래 diff를 정상 이력으로 재생성할 수 없다.
- 최신 파일 내용의 정본은 생존 워킹 트리다. 복구 repo에는 보존 후보 376개를 SHA-256 일치 상태로 반영했고, 현재 `.gitignore` 기준 298개는 Git 대상, 78개는 evidence/worktree 보존 전용이다.
- 추가 3개 커밋을 가짜 빈 커밋이나 새 해시로 재현하지 않는다. 이 문서와 원시 보고서로 provenance만 보존한다.

## 소스 관계

| 소스 | 확인 결과 | 복구에서의 역할 |
|---|---:|---|
| 공개 원격 fresh clone | 20 commits, `git fsck --full` exit 0 | 정상 Git 객체 기반선 |
| `C:\recover\Projects\Brain\.git` | 23 commits, 원격 중첩 20 + 로컬 3 | 커밋 메시지·부모·브랜치·객체 손상 증거 |
| 생존 워킹 트리 | 보존 후보 376개, 해시 불일치 0 | 최신 파일 내용 정본 |
| C: evidence snapshot | manifest 20,019건, missing/extra/mismatch 0 | 원본 변경 없는 포렌식 사본 |

## 커밋 계보

```text
원격 main 20개 ... → 18e1333d784fd5d6c6605c96f064bed19cdd187b
                      → c93db6f8b0908de957025c737550f9b1ec275da6
                      → 117d42664819f404dd288dd0e89cf25ecf4891e4
                      → 4bdb05cc13b918d393afb514dddc5c22c4b2c1fe  (feature/team-brain)
                      → [Git 대상 298개 overlay + Git 제외 78개 evidence/worktree 보존]
```

로컬 추가 3개는 23개 commit 객체와 부모 연결로 확인했으며, 원격 20개와의 교집합도 정확히 20개다. 6,035개 loose object 중 3,106개는 SHA-1·크기가 정상이고 2,929개는 손상으로 분류했다.

## 7월 28일 이후 소스 12개

| 파일 | 원본 수정시각(KST) | SHA-256 | 복구 |
|---|---|---|---|
| `src/brain-cli/src/codex-image.js` | 2026-08-13 16:27:41 | `f5e64f71ef9ff94d2d2dc0d5466e8aaa49a3c1ae6fdebe84e78d6c930087fa4c` | 일치 |
| `src/brain-cli/src/index.js` | 2026-07-30 01:17:17 | `a60e3ee1fbccb0ee8ddee5fa0b143387ca639a785af82ba480cb293400ae9242` | 일치 |
| `src/brain-cli/src/mcp-server.js` | 2026-08-13 15:55:18 | `2d891efe152c1a1f4f5c3ad0f4c78b84b07a3269b5962db92658bb8fa3744614` | 일치 |
| `src/brain-cli/test/mcp-server.test.js` | 2026-08-04 17:13:03 | `da9c294b3ea74a1b1520e9f42054e9f6bc3535dd8c8230aeb1257ddc9e9a7fc7` | 일치 |
| `src/brain-cli/test/recall-server-batch.test.js` | 2026-07-30 01:16:48 | `8083c5761e94fa38383e8add5530b6b9c649469c0a5f1480f7977361b12e9c0a` | 일치 |
| `src/clo-telegram/src/agent.ts` | 2026-08-11 18:47:30 | `62cea6c7ec1d523b4598b68878186864a71492be538ad0831cce437ec9f3d67e` | 일치 |
| `src/clo-telegram/src/bot.ts` | 2026-08-05 18:42:48 | `e89f82112098ced0f5e340601fc37c37ccb3e687ff1ce1d6c7cc7e30ab18e6a1` | 일치 |
| `src/clo-telegram/src/config.ts` | 2026-08-11 18:47:35 | `6dfd2e19373e988e96b48a61884c7fe122e953d5c33384ce5aa2311e7d55be6a` | 일치 |
| `src/clo-telegram/src/providers.ts` | 2026-08-11 18:47:22 | `f2e77f02260062677708d5768ef198d0d0eebc6698376c97a01ccc00828a4cbc` | 일치 |
| `src/clo-telegram/src/session-engine.ts` | 2026-08-10 23:49:01 | `b2471ed91dab742424cb1df5eb902e807196a3322068b25fbc6f931121bafa90` | 일치 |
| `src/clo-telegram/src/tools.ts` | 2026-08-10 23:49:30 | `f946be8c44fe5c8c50f7350fe6f38b62992c3e305b8ee30ff9cbc3072b477865` | 일치 |
| `src/clo-telegram/test/multi-bot-routing.test.mjs` | 2026-07-30 00:55:24 | `700f6340a7e937b9ebf7bb95e96cf00f51f0342f09781feaff18929022fea963` | 일치 |

12개 판정은 최신 커밋 시각(2026-07-28 19:04:15 KST) 이후의 코드·테스트 파일 수정시각과 원본↔복구 repo SHA-256을 교차 확인한 결과다. 12개는 모두 Git 대상이다. 같은 기간의 설계 문서 1개는 소스 12개 집계에서 분리했고, 보존 후보 376개에는 포함되지만 `.gitignore`에 따라 bundle에서는 제외된다.

## 세션 근거와 한계

- Brain 검증 기록 `rec_proj_brain_20260816_0001`은 8월 4일 Codex 연속 세션의 `mcp-server.test.js` 편집 성공 로그를 확인한 기록이다.
- 원시 세션 `C:\Users\ernham\.codex\sessions\2026\08\04\rollout-2026-08-04T17-12-26-019fcbd4-c4b9-7772-8a7e-6993b1637095.jsonl` 7~8행에는 2026-08-04T08:12:28.875Z 시각의 해당 파일 패치 마커가 남아 있다.
- 다만 이 세션 포맷의 해당 행은 구조화된 도구 호출이 아니라 연속 세션의 carry-forward 사용자 메시지다. 세션 증거는 보조 근거이며, 복구 채택의 주 근거는 파일 실물·mtime·SHA-256이다.
- 나머지 11개 파일의 정확한 작성자·요청 문구까지는 현재 증거만으로 단정하지 않는다.

## 복원·보존 범위

- worktree 보존: 일반 프로젝트 파일 376개(기존 68개 덮어쓰기, 신규 308개).
- Git 체크포인트 대상: 후보 376개 중 298개. stage 변화는 277개이며 21개는 Git 정규화 후 원격과 동일하다.
- Git 제외 보존: `.gitignore` 대상 78개는 evidence/worktree에는 남기고 bundle에는 넣지 않는다. 원격에만 남은 문서·이미지 10개도 삭제하지 않았다.
- 제외: `node_modules`, 운영 `data`, `temp/tmp`, coverage/build/dist, 루트 임시 파일, 실제 `.env` 5개. stage의 금지 디렉터리·시크릿 이름·고신뢰 자격증명 패턴은 0이다.
- 미복원: 손상 객체 2,929개의 원래 blob 내용, 로컬 추가 3개 커밋의 완전한 diff, 운영 데이터와 자격증명.

## 증거 파일

- `C:\Brain-Recovery\20260816\reports\REC-03-manifest-verification.json`
- `C:\Brain-Recovery\20260816\reports\REC-04-git-verification.log`
- `C:\Brain-Recovery\20260816\reports\REC-05-git-history-evidence.json`
- `C:\Brain-Recovery\20260816\reports\REC-05-commit-metadata.jsonl`
- `C:\Brain-Recovery\20260816\reports\REC-05-loose-object-inventory.jsonl`
- `C:\Brain-Recovery\20260816\reports\REC-06-reconstruction-verification.json`

## 가정 명세

### 확정된 가정

- 원격은 20개, 손상 Git 계보는 23개, 최신 파일 내용은 생존 워킹 트리다.
- 최신 소스 12개는 원본과 복구 repo에서 SHA-256이 일치한다.

### 기술적으로 결정한 것 (확인 불필요)

- 정상 원격 20개 위에 Git 대상 298개를 overlay하고, Git 제외 78개는 evidence/worktree에서만 보존하며, 복구 불가능한 3개 커밋은 provenance로 보존한다.
- 원격 전용 역사 자산 10개는 삭제 사고 가능성을 고려해 보존한다.

### 아직 열린 사항

- 12개 중 세션 원문으로 직접 작성 의도를 복원하지 못한 11개의 정확한 요청·작성자.
- 손상 blob 2,929개의 추가 물리 복구 가능성.
- 운영 전환·push·배포는 이 복구 루프 범위 밖이며 별도 승인 대상이다.
