# Engram 홍보 초안 모음 (v2 — 플랫폼 분석 반영)

> 작성일: 2026-03-03
> GIF 데모: docs/img/engram-demo.gif
> 랜딩 페이지: https://ernham1.github.io/brain-cli/
> GitHub: https://github.com/ernham1/brain-cli

---

## 실행 타임라인

| 시기 | 채널 | 액션 |
|------|------|------|
| **즉시~1주** | Reddit | r/ClaudeCode, r/ClaudeAI에서 다른 사람 글에 댓글 활동 시작 |
| **1주 후** | Reddit | r/ClaudeCode에 본문 포스팅 (개발자 타겟) |
| **며칠 후** | Reddit | r/ClaudeAI에 변형 포스팅 (넓은 청중) |
| **동시** | X (Twitter) | 빌드인퍼블릭 단발 트윗 시작 (팔로워 구축) |
| **★ 10+ 달성 후** | GitHub | awesome-list 3곳 PR 제출 |
| **4~6주 후** | Product Hunt | 런칭 스쿼드 50명+, 갤러리 이미지, 데모 영상 준비 후 런칭 |

---

## 1. Reddit — r/ClaudeCode (1순위 타겟)

> r/ClaudeCode (96k, 개발자 전용)가 r/ClaudeAI (527k, 일반 포함)보다 정확한 타겟
> 플레어: "Built with Claude" 사용
> 사전 조건: 포스팅 전 최소 며칠간 해당 서브레딧에서 댓글 활동

### 사전 댓글 활동 예시 (포스팅 전 며칠간)
- 메모리/컨텍스트 관련 질문에 답변
- 다른 도구 사용 후기에 건설적 의견
- "이런 문제 겪고 있다"는 글에 공감 댓글

### Title
> I built a file-based long-term memory for Claude Code — no vector DB, no MCP server, just JSONL + Markdown

### Body (~1,200 단어 — 성공 포스트 평균 범위)

**The problem:**

I was spending the first 10~20 minutes of every Claude Code session re-explaining context from yesterday. Same bugs re-investigated, same decisions re-debated. The agent is brilliant for 4 hours, then gets total amnesia.

I tried several existing approaches:
- **CLAUDE.md auto-memory** — too unstructured, not searchable across projects
- **claude-mem** — requires ChromaDB setup
- **MemCP** — interesting but only captures on /compact
- **Cadre** — full framework when I just needed persistent recall

None of them fit what I wanted: a **simple CLI that reads and writes local files**, with no external database and no MCP server.

---

**What I built:**

**Engram** (`@ernham/brain-cli`) — persistent long-term memory for AI agents, stored as plain Markdown + JSONL on your machine.

```bash
npm install -g @ernham/brain-cli
brain-cli recall -b -g "auth bug"
# → agent instantly restores yesterday's context
```

[GIF demo — before vs. after](https://ernham1.github.io/brain-cli/img/engram-demo.gif)

---

**How it actually works:**

At session start, the agent runs `brain-cli recall`. This loads a JSONL index and searches by keyword, type, and tags. No embeddings — just structured text search against a flat file. Sub-100ms on 1k+ records.

When something important happens (bug fix, decision, config change), the agent writes a memory through a **9-step transaction engine**:

```
Backup → write .tmp → update index .tmp → validate → atomic rename
```

If anything fails at any step, it rolls back. Think SQLite-style crash safety for Markdown files.

```
~/Brain/
  10_projects/    # per-project memories
  30_topics/      # general topics
  90_index/       # records.jsonl + digest
```

---

**The design choice I'm most opinionated about:**

No embeddings, no vector search. The tradeoff is no fuzzy semantic recall — but in practice, AI agents write precise tags and keywords when you give them a structured schema. And the upside is huge: zero dependencies, fully inspectable (`cat records.jsonl`), and Git-friendly.

---

**What makes it different from existing tools:**

- **Multi-agent shared memory** — VS Code Claude Code and a separate terminal agent read/write the same `~/Brain/`. No sync needed, no drift.
- **Memory graph** — memories link to each other (`depends_on`, `related`, `replaced_by`). Recalling one surfaces connected ones.
- **Self-improving meta-learning** — agents register thinking strategies, rate effectiveness, and auto-adjust. Niche feature, but it compounds.

---

**Current state:**

- v1.5.0, MIT license, 557 monthly npm downloads
- 87 unit tests
- Works with Claude Code (primary), Cursor, Windsurf, or any agent that can shell out
- Zero external runtime dependencies beyond Node.js

---

**Links:**

- GitHub: https://github.com/ernham1/brain-cli
- Landing page: https://ernham1.github.io/brain-cli/

Still early — honest feedback and issues welcome. If it's useful to you, a star helps a lot.

### r/ClaudeAI 변형 포인트 (며칠 후 별도 포스팅)
- 톤을 약간 더 접근 가능하게 (비개발자도 읽는 서브레딧)
- 기술 상세(BWT 단계, JSONL) 줄이고 문제-해결 스토리 강화
- Title 변형: "I gave Claude Code persistent memory that survives across sessions — here's how it works"

---

## 2. X (Twitter) — 빌드인퍼블릭 → 런칭 스레드

> 현재 팔로워 기반 없으면 스레드 바이럴 확률 극히 낮음
> 전략: 2~3주간 빌드인퍼블릭 단발 트윗으로 500명 구축 → 그 후 런칭 스레드

### Phase 1: 빌드인퍼블릭 단발 트윗 (매일 1개, 2~3주)

**게시 시간**: PST 화~목 오전 9~11시 (한국 시간 새벽 2~4시)

예시 트윗들:
```
Day 1: "Every AI coding agent has amnesia by default. Working on fixing that."

Day 3: "TIL: AI agents write surprisingly precise tags when you give them a structured schema. No embeddings needed."

Day 5: "Built a 9-step transaction engine for writing Markdown files. Overkill? Maybe. But your memory store will never corrupt on crash."

Day 7: "557 developers installed brain-cli last month. Zero of them needed an API key, a vector DB, or a cloud subscription."

Day 10: "The most underrated feature: multi-agent memory sharing. VS Code and terminal agents reading the same Brain. No sync, no drift."
```

### Phase 2: 런칭 스레드 (팔로워 500+ 달성 후)

**해시태그: 2개만** (4개 이상은 참여율 17% 하락)

### 1/7 [후크 + GIF]
Your AI agent just mass a 3-hour session.

Tomorrow it remembers nothing.

Not the decisions. Not the bugs. Not the patterns.

Every session starts from zero.

[engram-demo.gif 첨부]

### 2/7 [해결책 + 설치]
I built Engram — persistent `~/Brain/` for your AI agent.

```
npm install -g @ernham/brain-cli
brain-cli recall -b -g "auth bug"
```

One command. No cloud. No API keys. Just local files.

### 3/7 [안전성]
"What if it crashes mid-write?"

9-step transaction. Backup → temp write → validate → atomic rename.

Fails at any step → full rollback.

Your Brain never corrupts. Ever.

### 4/7 [와우 포인트]
The wild part: it gets smarter over time.

meta-seed → meta-feedback → meta-learn

Your agent learns which thinking strategies actually work for you. Winners get boosted. Losers get demoted. Automatically.

### 5/7 [비교 — 공격 없이 포지셔닝]
How it compares:

Mem0: cloud API, great for scale
Letta: self-hosted, powerful
Engram: `npm install` — done. Fully local.

Different tools for different needs. Engram is for devs who want memory that just works, no infra.

### 6/7 [사회적 증거]
557 monthly installs. 87 tests. MIT licensed.

Zero external dependencies. Just Node.js and your filesystem.

### 7/7 [CTA — 구체적 요청 1개만]
Try it in 30 seconds:

brain-cli init && brain-cli recall -b -g "your project"

⭐ https://github.com/ernham1/brain-cli

#AIAgents #OpenSource

---

## 3. Product Hunt — 4~6주 후 런칭

> 지금 런칭하면 안 되는 이유:
> - 런칭 스쿼드 없음 (최소 50~100명 필요)
> - 갤러리 이미지 없음 (4~6장 필요)
> - 데모 영상 없음 (90초 필요)
> - GitHub ★ 0 (사회적 증거 부족)
> - 헌터 미섭외
>
> "Engram" 동명 프로젝트가 최소 3개 존재 — 검색 차별화 필요

### 사전 준비 체크리스트

**4~6주 전:**
- [ ] 런칭 스쿼드 50~100명 확보 (Reddit/X 활동에서 모집)
- [ ] 헌터 섭외 (개발자 도구 분야 상위 헌터 2~3주 전 접촉)
- [ ] Product Hunt "Coming Soon" 페이지 생성

**2~3주 전:**
- [ ] 갤러리 이미지 제작 (4~6장)
  1. 포지셔닝 이미지 (Engram이 뭔지 한눈에)
  2. 워크플로우 GIF (recall → write 루프)
  3. 실제 출력 스크린샷
  4. 설치 과정
  5. 비교표 (vs Mem0, Letta)
  6. CTA 이미지
- [ ] 90초 데모 영상 제작
- [ ] GitHub ★ 10+ 달성 확인

**1주 전:**
- [ ] Maker Comment 최종 작성 (800자 이내)
- [ ] Q&A 치트시트 (설치법, 보안, 가격, 호환성)
- [ ] 런칭 스쿼드에 "Product Hunt에서 검색해달라" 안내 (직접 링크 X)
- [ ] 12:01 AM PST 화~목 스케줄 예약

### 런칭 콘텐츠 (준비 완료 시 사용)

**Tagline (49 chars):**
> Persistent long-term memory for AI coding agents

**Tagline 대안:**
> Your AI agent forgets everything. Engram fixes that. (52 chars)

**Description:**

Every time you close a session with Claude Code, Cursor, or Windsurf, your agent loses everything. The bug fix from last Tuesday. The architectural decision you debated for an hour. Tomorrow, you start from zero — again.

Engram is an open-source CLI that gives AI coding agents persistent long-term memory. Install it once, and your agent can recall past context across every session:

```
brain-cli recall -b -g "auth bug"
```

Memories are stored as plain Markdown files in `~/Brain/`. No cloud, no API keys, no subscriptions. 100% local and free, forever.

**What makes Engram different:**

- **Crash-safe writes** — 9-step BWT transaction with auto-rollback
- **Multi-agent sharing** — multiple agents read/write the same Brain
- **Memory graph** — recall one memory, surface everything related
- **Self-improving** — agents learn which strategies work and auto-adjust
- **Zero dependencies** — Node.js only. No vector DB, no external services

**Maker Comment (800자 이내):**

Hey PH! I built Engram after spending the first 20 minutes of every coding session re-explaining context to my AI agent. Same bugs re-investigated, same decisions re-debated. Brilliant colleague with amnesia.

So I built a CLI that stores memories as local Markdown files. The agent calls `recall` at session start, picks up where it left off. When something important happens, it writes a memory. That's the whole loop.

The part I'm proudest of: every write goes through a 9-step transaction with auto-rollback. Your memory store never corrupts on crash.

What I'd love feedback on: Is the setup clear enough? Which AI editors need first-class support? Is meta-learning useful or over-engineering?

MIT licensed, fully open source, always free. — Gwang-ung (NeuralFlux)

**Topics:** Developer Tools, Artificial Intelligence, Open Source, Productivity

---

## 분석 출처

### Reddit
- r/ClaudeAI (527k), r/ClaudeCode (96k) — 성공 포스트는 "교육 80% + 홍보 20%" 비율
- 90/10 규칙: 활동의 90%는 가치 제공, 10%만 자기 홍보
- 경쟁 도구: claude-mem, MemCP, Cadre, Continuum, Recall 등 6개+
- "Built with Claude" 플레어 사용 가능

### X (Twitter)
- 스레드는 단일 트윗 대비 54~63% 높은 참여율
- 해시태그 3개 이상 → 참여율 17% 하락
- 팔로워 500 미만이면 스레드 ROI 극히 낮음 (실사례: 3일 투자 → 6 다운로드)
- 게시 시간: PST 화~목 오전 9~11시

### Product Hunt
- POTD 달성: 200~500표 필요, 시간당 업보트 속도가 총 수보다 중요
- 필수: 런칭 스쿼드 50~100명, 갤러리 4~6장, 데모 영상 90초
- 12:01 AM PST 화~목 런칭
- 직접 링크 공유 금지 — "Product Hunt에서 검색" 유도
- "Engram" 동명 프로젝트 3개+ 존재 (검색 차별화 리스크)
