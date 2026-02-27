"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { BWTEngine } = require("./bwt");
const { init } = require("./init");
const { readJsonl, getDefaultBrainRoot } = require("./utils");
const {
  PERSONALITY_TYPES,
  CORE_TRAITS,
  EMOTION_KEYS,
  EMOTION_LEVELS,
  FORMALITY_LEVELS,
  DIRECTNESS_LEVELS,
  buildPersonaConfig,
  generateClaudeMd,
  generateBrainDoc,
  updateClaudeMd
} = require("./persona");

/**
 * inquirer를 사용한 대화형 프롬프트 (기본 promptFn)
 */
async function defaultPromptFn(existing = null) {
  const { input, select, checkbox } = require("@inquirer/prompts");

  console.log("\n🧠 Brain 에이전트 페르소나 설정\n");
  console.log("━".repeat(40));
  console.log("  에이전트의 이름, 성격, 감정을 설정합니다.");
  console.log("━".repeat(40) + "\n");

  // --- 에이전트 기본정보 ---
  console.log("📌 에이전트 기본정보\n");

  const agentName = await input({
    message: "에이전트 이름:",
    default: existing?.agent?.name || ""
  });

  const agentAge = await input({
    message: "에이전트 나이:",
    default: String(existing?.agent?.age || 30)
  });

  const agentGender = await select({
    message: "에이전트 성별:",
    choices: [
      { name: "여성", value: "female" },
      { name: "남성", value: "male" }
    ],
    default: existing?.agent?.gender || "female"
  });

  const agentRole = await input({
    message: "에이전트 역할 (예: OOO님의 전담 AI 비서):",
    default: existing?.agent?.role || ""
  });

  // --- 성격 ---
  console.log("\n📌 성격 설정\n");

  const personalityType = await select({
    message: "성격 유형:",
    choices: PERSONALITY_TYPES,
    default: existing?.agent?.personalityType || "warm_professional"
  });

  const coreTraits = await checkbox({
    message: "핵심 특성 (2~4개 선택):",
    choices: CORE_TRAITS.map(t => ({ name: t, value: t })),
    validate: (arr) => arr.length >= 2 && arr.length <= 4 ? true : "2~4개를 선택하세요"
  });

  const values = await input({
    message: "가치관 (쉼표로 구분):",
    default: existing?.agent?.values || "신뢰, 성장, 효율"
  });

  // --- 감정 민감도 ---
  console.log("\n📌 감정 민감도\n");

  const emotions = {};
  for (const ek of EMOTION_KEYS) {
    const existingVal = existing?.emotionalSensitivity?.[ek.key];
    const defaultChoice = existingVal
      ? EMOTION_LEVELS.find(l => l.value === existingVal)?.value
      : ek.defaultVal;
    const closest = EMOTION_LEVELS.reduce((prev, curr) =>
      Math.abs(curr.value - (defaultChoice || 0.6)) < Math.abs(prev.value - (defaultChoice || 0.6)) ? curr : prev
    );

    emotions[ek.key] = await select({
      message: `${ek.label}:`,
      choices: EMOTION_LEVELS,
      default: closest.value
    });
  }

  // --- 상호작용 패턴 ---
  console.log("\n📌 상호작용 패턴\n");

  const formalityLevel = await select({
    message: "격식 수준:",
    choices: FORMALITY_LEVELS,
    default: existing?.interactionPatterns?.formalityLevel || "medium"
  });

  const directness = await select({
    message: "직설성:",
    choices: DIRECTNESS_LEVELS,
    default: existing?.interactionPatterns?.directness || 0.7
  });

  const emotionalExpression = await select({
    message: "감정 표현도:",
    choices: EMOTION_LEVELS,
    default: existing?.interactionPatterns?.emotionalExpression || 0.8
  });

  const patienceLevel = await select({
    message: "인내심:",
    choices: EMOTION_LEVELS,
    default: existing?.interactionPatterns?.patienceLevel || 0.8
  });

  // --- 대화 스타일 ---
  console.log("\n📌 대화 스타일 (빈칸 가능)\n");

  const greeting = await input({
    message: "인사 예시:",
    default: existing?.dialogueStyles?.greeting || ""
  });

  const onSuccess = await input({
    message: "성공 시 표현:",
    default: existing?.dialogueStyles?.onSuccess || ""
  });

  const onError = await input({
    message: "실수 인정 표현:",
    default: existing?.dialogueStyles?.onError || ""
  });

  const banned = await input({
    message: "금지 사항:",
    default: existing?.dialogueStyles?.banned || ""
  });

  // --- 사용자 정보 ---
  console.log("\n📌 사용자 정보\n");

  const userName = await input({
    message: "사용자 이름:",
    default: existing?.user?.name || ""
  });

  const userTitle = await input({
    message: "사용자 직함:",
    default: existing?.user?.title || ""
  });

  const userCharacteristics = await input({
    message: "사용자 특성 (예: 기획자, 코딩 이해도 낮음):",
    default: existing?.user?.characteristics || ""
  });

  return {
    agentName, agentAge, agentGender, agentRole,
    personalityType, coreTraits, values,
    emotions,
    formalityLevel, directness, emotionalExpression, patienceLevel,
    greeting, onSuccess, onError, banned,
    userName, userTitle, userCharacteristics
  };
}

/**
 * setup 커맨드 메인 함수
 */
async function setup(options = {}) {
  const errors = [];

  // 1. Brain 루트 확인
  let brainRoot = options.brainRoot || getDefaultBrainRoot();
  if (!brainRoot) {
    console.log("Brain 디렉토리가 없습니다. 자동으로 생성합니다...");
    const homeDir = os.homedir();
    init(homeDir);
    brainRoot = path.join(homeDir, "Brain");
  }

  // 2. 기존 persona 로드
  const existing = _loadExistingPersona(brainRoot);

  // 3. 대화형 입력
  const promptFn = options.promptFn || defaultPromptFn;
  const answers = await promptFn(existing);

  // 4. 설정 객체 생성
  const config = buildPersonaConfig(answers);

  // 5. Brain에 BWT로 저장
  let brainResult = null;
  try {
    const existingRecordId = _findPersonaRecordId(brainRoot);
    const intent = _buildIntent(config, existingRecordId);
    const engine = new BWTEngine(brainRoot);
    const result = engine.execute(intent);

    if (result.success) {
      brainResult = { recordId: result.recordId || existingRecordId, sourceRef: intent.sourceRef };
    } else {
      errors.push(`Brain 저장 실패: ${result.report?.message || "알 수 없는 오류"}`);
    }
  } catch (err) {
    errors.push(`Brain 저장 오류: ${err.message}`);
  }

  // 6. CLAUDE.md 업데이트
  let claudeMdUpdated = false;
  const claudeMdPath = options.claudeMdPath || path.join(os.homedir(), ".claude", "CLAUDE.md");

  try {
    const section = generateClaudeMd(config);
    const result = updateClaudeMd(claudeMdPath, section);
    claudeMdUpdated = result.updated;
  } catch (err) {
    errors.push(`CLAUDE.md 업데이트 오류: ${err.message}`);
  }

  // 7. 결과 출력
  if (errors.length === 0) {
    console.log("\n" + "━".repeat(40));
    console.log("  ✅ 페르소나 설정 완료!");
    console.log("━".repeat(40));
    if (brainResult) {
      console.log(`  Brain: ${brainResult.sourceRef}`);
    }
    if (claudeMdUpdated) {
      console.log(`  CLAUDE.md: ${claudeMdPath}`);
    }
    console.log();
  }

  return {
    success: errors.length === 0,
    personaConfig: config,
    brainResult,
    claudeMdUpdated,
    errors
  };
}

/**
 * 기존 persona 설정 로드 (있으면)
 */
function _loadExistingPersona(brainRoot) {
  const configPath = path.join(brainRoot, "00_user", "persona", "config.md");
  if (!fs.existsSync(configPath)) return null;

  // 간단히 존재 여부만 확인 — 상세 파싱은 추후 확장
  return null;
}

/**
 * 기존 persona recordId 찾기
 */
function _findPersonaRecordId(brainRoot) {
  const recordsPath = path.join(brainRoot, "90_index", "records.jsonl");
  if (!fs.existsSync(recordsPath)) return null;

  const records = readJsonl(recordsPath);
  const found = records.find(r =>
    r.scopeType === "user" && r.scopeId === "persona" && r.status === "active"
  );
  return found ? found.recordId : null;
}

/**
 * BWT Intent 빌드
 */
function _buildIntent(config, existingRecordId) {
  const content = generateBrainDoc(config);
  const summary = `${config.agent.name} — ${config.agent.personalityType} 유형 에이전트 설정`;

  if (existingRecordId) {
    return {
      action: "update",
      recordId: existingRecordId,
      sourceRef: "00_user/persona/config.md",
      content,
      record: {
        title: "에이전트 페르소나 설정",
        summary,
        tags: ["domain/memory", "intent/onboarding"]
      }
    };
  }

  return {
    action: "create",
    sourceRef: "00_user/persona/config.md",
    content,
    record: {
      scopeType: "user",
      scopeId: "persona",
      type: "profile",
      title: "에이전트 페르소나 설정",
      summary,
      tags: ["domain/memory", "intent/onboarding"],
      sourceType: "user_confirmed"
    }
  };
}

module.exports = { setup, defaultPromptFn };
