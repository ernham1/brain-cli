#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const BRAIN_PARENT = os.homedir();
const BRAIN_ROOT = path.join(BRAIN_PARENT, "Brain");
const CLAUDE_MD = path.join(os.homedir(), ".claude", "CLAUDE.md");
const MARKER = "## Brain 장기기억 시스템";

console.log("=== brain-cli postinstall ===\n");

// --- 1. Brain 디렉토리 초기화 ---
try {
  const { init } = require("../src/init");
  const result = init(BRAIN_PARENT);

  if (result.created.length > 0) {
    console.log(`Brain 초기화 완료: ${BRAIN_ROOT}`);
    console.log(`  생성됨: ${result.created.length}개`);
  } else {
    console.log(`Brain 이미 존재: ${BRAIN_ROOT} (스킵)`);
  }
} catch (err) {
  console.log(`Brain 초기화 스킵: ${err.message}`);
}

// --- 2. ~/.claude/CLAUDE.md에 Brain 지침 추가 ---
const brainClaudeBlock = `
---

${MARKER}

> Brain은 세션/프로젝트를 넘어 지속되는 외부 장기기억 저장소입니다.
> 위치: \`~/Brain/\`

### 세션 시작 시 (필수)

\`\`\`
brain-cli recall -g "<현재 작업 키워드>"
\`\`\`
이 한 줄로 부트 + 검색이 완료됩니다. 결과가 있으면 이전 맥락을 참조하세요.

### 기억 저장 트리거 (아래 상황 발생 시 즉시 저장)

1. **버그를 해결했을 때** — 원인과 해결법을 저장 (다음에 같은 문제 방지)
2. **사용자가 선호를 표현했을 때** — "이렇게 해줘", "이건 싫어" 등
3. **아키텍처 결정을 내렸을 때** — 기술 선택, 패턴 결정, 설계 방향
4. **프로젝트 규칙을 발견했을 때** — 코드 컨벤션, 배포 절차, 환경 설정
5. **세션 종료 전** — 진행 중인 작업의 현황과 다음 단계를 요약 저장

\`\`\`bash
brain-cli write '<Intent JSON>'
\`\`\`

**저장 제외**: 일회성 질문, 임시 디버그 로그, CLAUDE.md에 이미 있는 내용

Intent JSON 형식:
\`\`\`json
{
  "action": "create",
  "sourceRef": "<폴더>/<스코프ID>/<파일명>.md",
  "content": "<문서 본문>",
  "record": {
    "scopeType": "topic|project|user|agent",
    "scopeId": "<식별자>",
    "type": "note|rule|decision",
    "title": "<제목>",
    "summary": "<1줄 요약>",
    "tags": ["domain/<값>", "intent/<값>"],
    "sourceType": "candidate"
  }
}
\`\`\`

### 폴더 선택 기준

| scopeType | 폴더 | 용도 |
|-----------|------|------|
| user | 00_user/ | 사용자 성향, 전역 규칙 |
| project | 10_projects/ | 특정 프로젝트 한정 기억 |
| topic | 30_topics/ | 범용 주제 (자동 폴더 생성 가능) |

### 태그 (2축만 허용)

- **domain**: memory, auth, ui, infra, data, devops
- **intent**: retrieval, decision, debug, onboarding, reference

### 금지 사항

- \`90_index/\` 직접 수정 금지 (brain-cli만 사용)
- inference 타입을 rule/decision에 혼입 금지
- records.jsonl 전량 로드 금지 (검색은 digest 사용)
`;

try {
  const claudeDir = path.dirname(CLAUDE_MD);

  // ~/.claude/ 폴더 없으면 생성
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  if (fs.existsSync(CLAUDE_MD)) {
    const existing = fs.readFileSync(CLAUDE_MD, "utf-8");

    if (existing.includes(MARKER)) {
      console.log(`\nCLAUDE.md: Brain 지침 이미 존재 (스킵)`);
    } else {
      fs.appendFileSync(CLAUDE_MD, brainClaudeBlock, "utf-8");
      console.log(`\nCLAUDE.md: Brain 지침 추가 완료`);
      console.log(`  경로: ${CLAUDE_MD}`);
    }
  } else {
    fs.writeFileSync(CLAUDE_MD, brainClaudeBlock.trimStart(), "utf-8");
    console.log(`\nCLAUDE.md: 신규 생성 + Brain 지침 추가`);
    console.log(`  경로: ${CLAUDE_MD}`);
  }
} catch (err) {
  console.log(`\nCLAUDE.md 설정 스킵: ${err.message}`);
  console.log(`  수동으로 추가하세요: ${CLAUDE_MD}`);
}

console.log(`
=== 설치 완료 ===

Brain 경로: ${BRAIN_ROOT}

처음 사용이라면:
  brain-cli setup                  # 대화형 페르소나 설정 (권장)

사용법:
  brain-cli recall -b -g "키워드"  # 세션 시작 시 기억 회수
  brain-cli write '<JSON>'         # 기억 저장
  brain-cli search -g "키워드"     # 기억 검색
  brain-cli validate               # 정합성 검증

커스텀 경로 사용 시:
  export BRAIN_ROOT=/path/to/Brain
  또는 brain-cli recall --root /path/to/Brain
`);
