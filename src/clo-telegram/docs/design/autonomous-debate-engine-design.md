# 이어온 자율 토론 엔진 상세 설계서

- 작성일: 2026-08-03
- 작성자: 클로
- 상태: 초안 (구현 전 검토용)
- 대상 코드베이스: `Brain/src/clo-telegram/`
- 레퍼런스 실물: `src/debate-watcher.ts`, `src/debate-log.ts`

---

## 0. 배경과 목표

현재 자율 토론은 `DebateWatcher`가 10초 폴링으로 공유 로그를 감시하고, 순번제(`BOT_ORDER = ["클로","제미","지피"]`)로 "마지막 발언 봇의 다음 봇"이 발화하는 구조다. 이 방식은 세 가지 한계가 있다.

1. 발화 순서가 고정이라 대화 내용과 무관하게 돌아간다. 낄 필요 없는 봇도 자기 차례면 발화한다.
2. 종료 기준이 시간(30분)과 체인 길이(봇 30연속)뿐이라, 내용상 수렴했는데도 계속 돌거나 반대로 토론이 살아있는데 끊긴다.
3. 소집 개념이 없다. 사람이 던진 문장의 성격에 맞는 에이전트를 골라 부르는 단계가 없다.

목표는 순번제를 폐기하고 **자기판단 발화 + 라우터 소집 + 수렴 감지 종료** 구조로 교체하는 것이다. 기존 산출물 제작 파이프라인과 물리적으로 격리해 성능·프롬프트·산출물 로직에 영향을 주지 않는다.

---

## 1. 레퍼런스 요소 교체/유지/폐기 매핑

`debate-watcher.ts`·`debate-log.ts`의 현재 요소를 새 설계에서 어떻게 처리하는지 명시한다.

| 현재 요소 | 위치 | 새 설계 처리 | 근거 |
|---|---|---|---|
| `BOT_ORDER` 순번제 | debate-watcher.ts 10, 87-91 | **폐기** | 자기판단으로 완전 대체. 순번 잔존 없음 |
| 10초 `setInterval` 폴링 | debate-watcher.ts 32-39 | **유지** | 폴링 골격은 유지하되 check() 내부 판정만 교체. 이벤트화는 축3 옵션에서 논의 |
| 0~3초 랜덤 지연(jitter) | debate-watcher.ts 34 | **유지** | 봇 인스턴스 동시 발화 분산 목적. 자기판단으로 바뀌어도 여전히 필요 |
| 8초 쿨다운(`lastRespondedAt`) | debate-watcher.ts 80-95 | **유지** | 단일 봇 연속 독점 방지. 축5 감쇠 로직과 병행 |
| 최근 30개 전부 봇이면 정지 | debate-watcher.ts 97-100 | **교체** | 하드 상한은 최종 안전판으로 유지하되, 1차 종료는 수렴 감지(축7)가 담당 |
| 30분 경과 시 종료 | debate-watcher.ts 7, 78 | **유지** | 유휴 세션 정리용 백스톱. 내용 종료는 수렴 감지가 먼저 판단 |
| `DebateLog` = `dataDir/debate/{chatId}.jsonl` | debate-log.ts 19-25 | **유지·확장** | 이미 별도 디렉토리로 격리됨. 격리 요건(6장)의 기반 |
| `mainHandling` / `processing` 가드 | debate-watcher.ts 22-23, 102-106 | **유지** | 메인 핸들러·중복 실행 방지. 신규 게이트와 병행 |

핵심: **check() 함수의 판정 로직만 교체**하고, 폴링·격리·중복가드 인프라는 그대로 재사용한다. 이것이 "기존에 영향 없음"의 구조적 근거다.

---

## 2. 모듈 구조

신규 모듈은 `src/debate/engine/` 하위에 둔다. `[ASSUMPTION-1]` 실제 디렉토리 컨벤션은 프로젝트 확인 전까지 가정.

| 모듈 | 파일 | 역할 |
|---|---|---|
| 자기판단 게이트 | `engine/self-judgment.ts` | 봇이 "지금 낄 가치가 있나"를 점수화. 2단 게이트(축8) 진입점 |
| 라우터 소집 | `engine/convener.ts` | 사람 문장 분석 → 필요 봇 N명 선정 → 맞춤 요청 생성(축2) |
| 수렴 감지 | `engine/convergence-detector.ts` | 새 관점 고갈 판정 → 토론 종료 신호(축7) |
| 상한/자름 | `engine/turn-cap.ts` | 개입강도+관점다양성 2축 스코어링, 감쇠(축4·축5) |
| 강제 멘션 | `engine/mention-override.ts` | @지정 시 게이트·상한 우회(축6) |
| 세션 상태 | `engine/debate-session-store.ts` | 라운드 상태·개입 카운트·관점 이력. `DebateLog`와 분리된 휘발성 상태(6장) |
| 감시자(개편) | `debate-watcher.ts` (기존 교체) | 폴링 유지, check() 내부를 위 모듈 호출로 재구성 |

기존 `DebateLog`(로그 영속)와 신규 `DebateSessionStore`(라운드 상태)를 **역할 분리**한다. 로그는 대화 기록, 세션 스토어는 "이번 라운드에서 누가 몇 번 말했나·어떤 관점이 나왔나" 같은 판정용 휘발 상태다.

---

## 3. 데이터 흐름 (코드 레벨 시퀀스)

```
사람 발언 도착 (메인 핸들러)
  └─ DebateLog.append(chatId, "사용자", text, mentions, msgId, human=true)

[분기 A] 사람이 @지정 → mention-override
  └─ if (mentions.length > 0)
       for (m of mentions) forceRespond(m)   // 게이트·상한 우회 (축6)

[분기 B] 지정 없음 → 라우터 1차 소집 (축2)
  └─ convener.convene(chatId, humanText)
       1. analyze(humanText) → { topicType, requiredExpertise[] }
       2. selectAgents(requiredExpertise, N)  → agentIds[]  (N=상한, 축4)
       3. for (a of agentIds) tailoredPrompt = personalize(humanText, a)
       4. return [{agentId, tailoredPrompt}]
  └─ 각 소집 봇: agent.debateChat(chatId, context + tailoredPrompt)

폴링 루프 (DebateWatcher.check, 10초). 자율 개입·수렴 판정 담당
  for (chatId of activeChatIds):
    last = DebateLog.getLastEntry(chatId)
    if (last.sender === self) continue          // 자기 직후 skip (유지)
    if (age > 30분) continue                     // 백스톱 (유지)
    if (mainHandling.has) continue               // 메인 처리중 (유지)

    ── [게이트 1: 값싼 필터] self-judgment.cheapFilter() ──  (축8-1)
    if (!cheapFilter(self, context)) continue    // 저비용 조기 탈락

    ── [수렴 판정] convergence-detector.hasConverged() ──   (축7)
    if (hasConverged(chatId)) { markClosed(chatId); continue }

    ── [상한/자름] turn-cap.canSpeak() ──                    (축4·5)
    score = intensityDiversityScore(self, chatId)
    if (score < THRESHOLD) continue              // 독점·저가치 개입 차단

    ── [게이트 2: LLM 판단] self-judgment.llmJudge() ──     (축8-2)
    if (!(await llmJudge(self, context))) continue

    ── 발화 ──
    resp = await agent.debateChat(chatId, context)
    if (resp && resp !== "[QUIET]") {
      bot.sendMessage(chatId, resp)
      DebateLog.append(chatId, self, resp)
      sessionStore.recordTurn(chatId, self, extractPerspective(resp))  // 판정용
      lastRespondedAt.set(chatId, now)           // 쿨다운 (유지)
    }
```

순서가 중요하다. **값싼 필터 → 수렴 판정 → 상한 → LLM 판단** 순으로, 비용이 낮고 탈락 가능성이 높은 관문을 앞에 둔다. 대부분의 봇은 게이트 1에서 걸러져 LLM 호출까지 가지 않는다.

---

## 4. 축별 상세 설계

### 축1. 발화 트리거: 순번제 폐기, 자기판단

`BOT_ORDER` 및 87-91번의 next-bot 로직을 완전 삭제한다. 대체 함수:

```
// self-judgment.ts
function shouldIntervene(agentId, context): number {   // 0.0 ~ 1.0
  signals = {
    relevance:   자신의 전문성과 최근 발언 주제의 매칭도,   // 임베딩 or 키워드
    novelty:     자신이 낼 관점이 기존 발언과 얼마나 다른가,  // 축5·축7과 공유
    addressed:   자신이 직접 언급/질문받았는가,
    recency:     자신이 최근 몇 턴 안에 이미 말했는가 (음의 가중)
  }
  return weightedSum(signals)   // 가중치는 [설계 제안값-가정]
}
```

`novelty` 신호는 수렴 감지(축7)·자름 기준(축5)과 같은 관점 벡터를 재사용한다. 세 곳이 하나의 "관점 다양성" 계산을 공유해 비용을 아낀다.

### 축2. 1차 소집: 라우터 B안

```
// convener.ts
function convene(chatId, humanText): {agentId, tailoredPrompt}[] {
  { topicType, requiredExpertise } = analyze(humanText)
  candidates = selectAgents(requiredExpertise)
  chosen = candidates.slice(0, N)               // N = 발화 상한 (축4)
  return chosen.map(a => ({
    agentId: a,
    tailoredPrompt: personalize(humanText, a)   // a의 역할에 맞춰 문장 변형
  }))
}
```

`personalize`는 같은 사람 문장을 봇별 역할에 맞게 재서술한다. 예: "이 API 설계 어때?"를 보안 봇에게는 "이 API의 인증·인가 취약점 관점에서 평가하라", 성능 봇에게는 "이 API의 지연·처리량 관점에서 평가하라"로 변형.

### 축3. 자율 개입 보충: 2개 옵션

1차 소집 후, 다른 답변을 본 봇이 스스로 추가 발화하는 방식.

| 옵션 | 방식 | 장점 | 단점 |
|---|---|---|---|
| **A. 폴링 재사용** | 기존 10초 setInterval 유지, check()에서 자기판단 | 인프라 그대로, 구현 최소 | 최대 10초 지연, 반응 느림 |
| **B. 이벤트 콜백** | 봇 발화 시 emit → 구독 봇이 즉시 자기판단 | 즉각 반응, 자연스러운 흐름 | 이벤트 버스 신설, 동시 발화·경합 관리 부담 |

**권장: A(폴링 재사용)로 시작.** 근거는 DP-019(최소 구현). 기존 폴링 골격을 그대로 쓰면 신규 인프라 0이다. 10초 지연은 토론 맥락에서 치명적이지 않다. 반응성이 문제로 드러나면 B로 전환한다.

### 축4. 발화 상한 N

라운드당 소집·발화 인원 상한. **`N = 3` `[설계 제안값-가정]`** (이전 논의에서 2~3 언급, 외부 검증값 아님). 봇 3인 체제이므로 사실상 전원 소집 가능하되, 봇이 늘어나면 상한이 실효를 갖는다. `turn-cap.ts`에서 라운드별 발화 카운트를 세션 스토어로 관리한다.

### 축5. 자름 기준: 개입강도 + 관점다양성 2축

```
// turn-cap.ts
function intensityDiversityScore(agentId, chatId): number {
  history = sessionStore.getTurns(chatId)
  recentByMe = history.filter(t => t.agent === agentId).slice(-5)

  intensity = recentByMe.length                       // 최근 내 발화 빈도
  decay = INTENSITY_DECAY ** intensity                // 많이 말할수록 감쇠

  myPerspective = pendingPerspective(agentId)
  diversity = 1 - maxSimilarity(myPerspective, history.perspectives)
              // 이미 나온 관점과 겹치면 낮음

  return decay * diversity        // 독점(감쇠↓) + 중복(다양성↓) → 점수↓
}
```

목소리 큰 봇은 `intensity`가 쌓여 `decay`로 점수가 깎이고, 남 얘기 반복하는 봇은 `diversity`가 낮아 깎인다. 둘 다 통과해야 발화. `INTENSITY_DECAY`, `THRESHOLD`는 `[설계 제안값-가정]`.

### 축6. 강제 멘션 오버라이드

```
// mention-override.ts
function resolveGate(agentId, chatId): { skipGate, skipCap } {
  last = DebateLog.getLastEntry(chatId)
  if (last.mentions?.includes(agentId))
    return { skipGate: true, skipCap: true }   // 게이트·상한 모두 우회
  return { skipGate: false, skipCap: false }
}
```

사람이 `@지피`로 지정하면 자기판단 게이트(축1·8)와 상한(축4·5)을 모두 건너뛰고 강제 발화한다. 단 수렴 판정과 무한체인 백스톱은 우회하지 않는다(안전판 유지).

### 축7. 연쇄 제어: 수렴 감지

M턴 고정을 폐기하고, 새 관점 고갈을 감지한다.

```
// convergence-detector.ts
function hasConverged(chatId): boolean {
  turns = sessionStore.getTurns(chatId).slice(-K)   // 최근 K턴
  if (turns.length < MIN_TURNS) return false        // 충분히 안 돌았으면 미수렴

  perspectives = turns.map(t => t.perspective)       // 관점 벡터/키워드셋
  novelty = avgPairwiseDistance(recent perspectives) // 최근 관점들의 상호 거리
  return novelty < CONVERGENCE_THRESHOLD             // 새 관점이 안 나옴 = 수렴
}
```

토론형(관점이 계속 갈림)은 `novelty`가 유지돼 오래 지속되고, 단순 질의(한 번 답하면 끝)는 관점이 금방 수렴해 짧게 끝난다. **턴 수 없이 내용으로 길이가 자동 조절**된다. `K`, `MIN_TURNS`, `CONVERGENCE_THRESHOLD`는 `[설계 제안값-가정]`.

관점 표현(`perspective`)은 임베딩 벡터가 정석이나, 초기엔 키워드 집합(Jaccard 거리)으로 저비용 구현 가능. `[ASSUMPTION-2]`

### 축8. 판단 비용: 2단 게이트

```
// self-judgment.ts
// 게이트 1 (값싼 필터, 규칙+임베딩, LLM 미사용)
function cheapFilter(agentId, context): boolean {
  if (recentlySpoke(agentId, within=2턴)) return false   // 방금 말함
  if (keywordRelevance(agentId, context) < LOW) return false // 명백히 무관
  return true   // 애매하면 통과 → 게이트 2로
}

// 게이트 2 (LLM 판단, 게이트 1 통과분만)
async function llmJudge(agentId, context): boolean {
  return await agent.selfEvaluate(
    "이 대화에 지금 네가 추가할 새 관점이 있는가? 없으면 [QUIET]"
  )
}
```

값싼 필터가 명백한 탈락(방금 말함·완전 무관)을 LLM 호출 없이 걸러낸다. LLM은 애매한 경계 케이스만 판단한다. 3인 방에서는 절감이 작지만, 수십 명 방에서 비용이 선형이 아니라 필터 통과분에만 비례하게 억제된다.

---

## 5. 인터페이스: 기존 코드와의 접점

| 기존 함수/구조 | 접점 처리 |
|---|---|
| `DebateWatcher.check()` | **내부 재구성.** 87-100번(순번+체인) 삭제, 3장 게이트 시퀀스로 교체 |
| `DebateWatcher.checkChat()` | 게이트 통과 후에만 기존 `agent.debateChat()` 호출. 발화 실행부는 그대로 |
| `DebateLog.append/getContext` | **그대로 재사용.** 로그 읽기·쓰기 API 변경 없음 |
| `DebateLog.getRecentEntries` | 수렴 감지·상한 판정의 입력으로 재사용 |
| `agent.debateChat()` | **변경 없음.** 이것이 "에이전트 성능·프롬프트 무영향"의 실체 |
| `suppress/startHandling/endHandling` | 그대로 유지. 메인 핸들러 연동부 불변 |

신규 모듈은 전부 `check()` **앞단(판정)**에만 붙는다. 발화 실행부(`debateChat` 이하)는 한 줄도 안 바뀐다.

---

## 6. 상태 격리 (핵심 안전 요건)

### 6.1 이미 격리된 부분

`DebateLog`는 생성자에서 `path.join(dataDir, "debate")`로 **별도 디렉토리**를 만들고 `{chatId}.jsonl`에 append한다(debate-log.ts 19-25). 즉 토론 로그는 이미 산출물 파이프라인과 물리 경로가 분리돼 있다. 이 패턴을 확장한다.

### 6.2 신규 상태의 격리

`DebateSessionStore`(라운드 상태·개입 카운트·관점 이력)는 다음 원칙으로 격리한다.

1. **휘발성 우선.** 라운드 판정용 상태는 인메모리(`Map<chatId, RoundState>`)로 두고, 영속이 필요하면 `dataDir/debate/session/` 하위에만 쓴다. 산출물 파이프라인의 상태 저장소(DB·별도 경로)에 절대 쓰지 않는다.
2. **네임스페이스 분리.** 파일·키·이벤트 채널 모두 `debate:` 접두사로 격리. 산출물 파이프라인 키와 충돌 불가.
3. **읽기 단방향.** 토론 엔진은 산출물 파이프라인 상태를 읽지도 쓰지도 않는다. 필요한 입력은 `DebateLog`와 사람 메시지뿐.

### 6.3 격리 검증 기준 (군사 검토 필수 항목)

- 토론 엔진 코드에서 산출물 파이프라인 상태 경로·DB·전역 변수를 참조하는 import가 0건인가
- `DebateSessionStore`의 쓰기 경로가 `dataDir/debate/` 밖으로 나가지 않는가
- 토론 세션 폭주 시 산출물 파이프라인 실행에 영향 가능한 공유 자원(락·큐·전역 카운터)이 있는가

이 3항이 전부 통과해야 "기존 무영향"이 보장된다.

---

## 7. [ASSUMPTION] 목록

| # | 가정 | reason | riskIfWrong |
|---|---|---|---|
| A-1 | 신규 모듈 경로는 `src/debate/engine/` | 기존 debate 코드가 `src/`에 평면 배치돼 있어 하위 디렉토리 신설을 가정 | 실제 컨벤션과 다르면 경로만 수정. 설계 논리엔 영향 없음 |
| A-2 | 관점(perspective) 표현은 초기 키워드셋(Jaccard), 후에 임베딩 | 임베딩은 비용·의존성이 커 최소 구현 우선(DP-019) | 키워드가 관점 구분에 부정확하면 수렴·다양성 판정 품질 저하. 임베딩 전환 필요 |
| A-3 | 발화 상한 N=3 | 이전 대화에서 2~3 언급, 현 봇 3인 | 봇 증가 시 재튜닝 필요. 외부 검증값 아님 |
| A-4 | `agent.debateChat` 시그니처·역할은 변경 불필요 | 발화 실행부를 건드리지 않는 것이 무영향의 전제 | debateChat이 순번 전제에 의존하고 있으면 일부 수정 필요 |
| A-5 | 봇 인스턴스가 각자 독립 폴링(현 구조 유지) | debate-watcher가 봇마다 개별 인스턴스로 도는 현 패턴 | 중앙 오케스트레이터로 바꾸려면 게이트 위치 재설계 |
| A-6 | 수렴·상한 임계값은 실측 튜닝 대상 | 초기값은 근거 없는 제안값 | 초기값이 부적절하면 조기 종료 또는 과다 발화. 로그 기반 튜닝 필요 |
| A-7 | `personalize`(맞춤 요청 변형)를 LLM으로 처리 | 봇별 역할 반영은 규칙만으론 한계 | 소집마다 LLM 1회 추가 비용. 규칙 템플릿으로 대체 검토 가능 |

---

## 8. 미결 사항 (열린 결정)

- 축3 자율 개입을 A(폴링)로 시작하지만, 이벤트 전환 트리거(어느 지연 시간부터 B로 갈지) 기준 미정
- `personalize` LLM 비용과 규칙 템플릿의 품질 트레이드오프 미측정
- 수렴 임계값 초기값은 실제 토론 로그로 튜닝해야 확정 가능. 현 설계엔 튜닝 훅만 존재
