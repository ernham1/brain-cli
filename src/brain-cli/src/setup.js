"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { BWTEngine } = require("./bwt");
const { init } = require("./init");
const { readJsonl, getDefaultBrainRoot } = require("./utils");
const {
  getPersonalityTypes,
  getCoreTraits,
  getEmotionKeys,
  getEmotionLevels,
  getFormalityLevels,
  getDirectnessLevels,
  buildPersonaConfig,
  generateClaudeMd,
  generateBrainDoc,
  updateClaudeMd
} = require("./persona");

// --- 프롬프트 메시지 i18n ---
const MSG = {
  en: {
    title: "Brain Agent Persona Setup",
    subtitle: "Configure agent name, personality, and emotions.",
    section_agent: "Agent Basic Information",
    prompt_name: "Agent Name:",
    prompt_age: "Agent Age:",
    prompt_gender: "Agent Gender:",
    gender_female: "Female",
    gender_male: "Male",
    prompt_role: "Agent Role (e.g., Personal AI Assistant to John):",
    section_personality: "Personality Settings",
    prompt_personality_type: "Personality Type:",
    prompt_core_traits: "Core Traits (select 2-4):",
    validate_traits: "Please select 2-4 items",
    prompt_values: "Values (comma-separated):",
    default_values: "Trust, Growth, Efficiency",
    section_emotion: "Emotional Sensitivity",
    section_interaction: "Interaction Patterns",
    prompt_formality: "Formality Level:",
    prompt_directness: "Directness:",
    prompt_expression: "Emotional Expression:",
    prompt_patience: "Patience:",
    section_dialogue: "Dialogue Styles (Optional)",
    prompt_greeting: "Greeting Example:",
    prompt_success: "Success Expression:",
    prompt_error: "Error Admission Expression:",
    prompt_banned: "Banned:",
    section_user: "User Information",
    prompt_user_name: "User Name:",
    prompt_user_title: "User Title:",
    prompt_user_chars: "User Characteristics (e.g., Planner, Low coding knowledge):",
    brain_not_found: "Brain directory not found. Creating automatically...",
    save_failed: "Brain save failed:",
    unknown_error: "Unknown error",
    save_error: "Brain save error:",
    claudemd_error: "CLAUDE.md update error:",
    setup_complete: "Persona setup completed!",
    intent_title: "Agent Persona Setup",
    intent_summary_suffix: "type agent setup"
  },
  ko: {
    title: "Brain 에이전트 페르소나 설정",
    subtitle: "에이전트의 이름, 성격, 감정을 설정합니다.",
    section_agent: "에이전트 기본정보",
    prompt_name: "에이전트 이름:",
    prompt_age: "에이전트 나이:",
    prompt_gender: "에이전트 성별:",
    gender_female: "여성",
    gender_male: "남성",
    prompt_role: "에이전트 역할 (예: OOO님의 전담 AI 비서):",
    section_personality: "성격 설정",
    prompt_personality_type: "성격 유형:",
    prompt_core_traits: "핵심 특성 (2~4개 선택):",
    validate_traits: "2~4개를 선택하세요",
    prompt_values: "가치관 (쉼표로 구분):",
    default_values: "신뢰, 성장, 효율",
    section_emotion: "감정 민감도",
    section_interaction: "상호작용 패턴",
    prompt_formality: "격식 수준:",
    prompt_directness: "직설성:",
    prompt_expression: "감정 표현도:",
    prompt_patience: "인내심:",
    section_dialogue: "대화 스타일 (빈칸 가능)",
    prompt_greeting: "인사 예시:",
    prompt_success: "성공 시 표현:",
    prompt_error: "실수 인정 표현:",
    prompt_banned: "금지 사항:",
    section_user: "사용자 정보",
    prompt_user_name: "사용자 이름:",
    prompt_user_title: "사용자 직함:",
    prompt_user_chars: "사용자 특성 (예: 기획자, 코딩 이해도 낮음):",
    brain_not_found: "Brain 디렉토리가 없습니다. 자동으로 생성합니다...",
    save_failed: "Brain 저장 실패:",
    unknown_error: "알 수 없는 오류",
    save_error: "Brain 저장 오류:",
    claudemd_error: "CLAUDE.md 업데이트 오류:",
    setup_complete: "페르소나 설정 완료!",
    intent_title: "에이전트 페르소나 설정",
    intent_summary_suffix: "유형 에이전트 설정"
  }
};

/**
 * inquirer를 사용한 대화형 프롬프트 (기본 promptFn)
 */
async function defaultPromptFn(existing = null) {
  const { input, select, checkbox } = require("@inquirer/prompts");

  // --- 언어 선택 (첫 번째 질문) ---
  const lang = await select({
    message: "Language / 언어:",
    choices: [
      { name: "English", value: "en" },
      { name: "한국어", value: "ko" }
    ],
    default: "en"
  });

  const m = MSG[lang];

  console.log(`\n🧠 ${m.title}\n`);
  console.log("━".repeat(40));
  console.log(`  ${m.subtitle}`);
  console.log("━".repeat(40) + "\n");

  // --- 에이전트 기본정보 ---
  console.log(`📌 ${m.section_agent}\n`);

  const agentName = await input({
    message: m.prompt_name,
    default: existing?.agent?.name || ""
  });

  const agentAge = await input({
    message: m.prompt_age,
    default: String(existing?.agent?.age || 30)
  });

  const agentGender = await select({
    message: m.prompt_gender,
    choices: [
      { name: m.gender_female, value: "female" },
      { name: m.gender_male, value: "male" }
    ],
    default: existing?.agent?.gender || "female"
  });

  const agentRole = await input({
    message: m.prompt_role,
    default: existing?.agent?.role || ""
  });

  // --- 성격 ---
  console.log(`\n📌 ${m.section_personality}\n`);

  const personalityType = await select({
    message: m.prompt_personality_type,
    choices: getPersonalityTypes(lang),
    default: existing?.agent?.personalityType || "warm_professional"
  });

  const coreTraitChoices = getCoreTraits(lang);
  const coreTraits = await checkbox({
    message: m.prompt_core_traits,
    choices: coreTraitChoices.map(t => ({ name: t, value: t })),
    validate: (arr) => arr.length >= 2 && arr.length <= 4 ? true : m.validate_traits
  });

  const values = await input({
    message: m.prompt_values,
    default: existing?.agent?.values || m.default_values
  });

  // --- 감정 민감도 ---
  console.log(`\n📌 ${m.section_emotion}\n`);

  const emotionLevels = getEmotionLevels(lang);
  const emotionKeys = getEmotionKeys(lang);
  const emotions = {};
  for (const ek of emotionKeys) {
    const existingVal = existing?.emotionalSensitivity?.[ek.key];
    const defaultChoice = existingVal || ek.defaultVal;
    const closest = emotionLevels.reduce((prev, curr) =>
      Math.abs(curr.value - defaultChoice) < Math.abs(prev.value - defaultChoice) ? curr : prev
    );

    emotions[ek.key] = await select({
      message: `${ek.label}:`,
      choices: emotionLevels,
      default: closest.value
    });
  }

  // --- 상호작용 패턴 ---
  console.log(`\n📌 ${m.section_interaction}\n`);

  const formalityLevel = await select({
    message: m.prompt_formality,
    choices: getFormalityLevels(lang),
    default: existing?.interactionPatterns?.formalityLevel || "medium"
  });

  const directness = await select({
    message: m.prompt_directness,
    choices: getDirectnessLevels(lang),
    default: existing?.interactionPatterns?.directness || 0.7
  });

  const emotionalExpression = await select({
    message: m.prompt_expression,
    choices: emotionLevels,
    default: existing?.interactionPatterns?.emotionalExpression || 0.8
  });

  const patienceLevel = await select({
    message: m.prompt_patience,
    choices: emotionLevels,
    default: existing?.interactionPatterns?.patienceLevel || 0.8
  });

  // --- 대화 스타일 ---
  console.log(`\n📌 ${m.section_dialogue}\n`);

  const greeting = await input({
    message: m.prompt_greeting,
    default: existing?.dialogueStyles?.greeting || ""
  });

  const onSuccess = await input({
    message: m.prompt_success,
    default: existing?.dialogueStyles?.onSuccess || ""
  });

  const onError = await input({
    message: m.prompt_error,
    default: existing?.dialogueStyles?.onError || ""
  });

  const banned = await input({
    message: m.prompt_banned,
    default: existing?.dialogueStyles?.banned || ""
  });

  // --- 사용자 정보 ---
  console.log(`\n📌 ${m.section_user}\n`);

  const userName = await input({
    message: m.prompt_user_name,
    default: existing?.user?.name || ""
  });

  const userTitle = await input({
    message: m.prompt_user_title,
    default: existing?.user?.title || ""
  });

  const userCharacteristics = await input({
    message: m.prompt_user_chars,
    default: existing?.user?.characteristics || ""
  });

  return {
    lang,
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
    console.log("Brain directory not found. Creating automatically...");
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
  const lang = config.lang || "ko";
  const m = MSG[lang] || MSG.ko;

  // 5. Brain에 BWT로 저장
  let brainResult = null;
  try {
    const existingRecordId = _findPersonaRecordId(brainRoot);
    const intent = _buildIntent(config, existingRecordId, lang);
    const engine = new BWTEngine(brainRoot);
    const result = engine.execute(intent);

    if (result.success) {
      brainResult = { recordId: result.recordId || existingRecordId, sourceRef: intent.sourceRef };
    } else {
      errors.push(`${m.save_failed} ${result.report?.message || m.unknown_error}`);
    }
  } catch (err) {
    errors.push(`${m.save_error} ${err.message}`);
  }

  // 6. CLAUDE.md 업데이트
  let claudeMdUpdated = false;
  const claudeMdPath = options.claudeMdPath || path.join(os.homedir(), ".claude", "CLAUDE.md");

  try {
    const section = generateClaudeMd(config, lang);
    const result = updateClaudeMd(claudeMdPath, section);
    claudeMdUpdated = result.updated;
  } catch (err) {
    errors.push(`${m.claudemd_error} ${err.message}`);
  }

  // 7. 결과 출력
  if (errors.length === 0) {
    console.log("\n" + "━".repeat(40));
    console.log(`  ✅ ${m.setup_complete}`);
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
function _buildIntent(config, existingRecordId, lang) {
  const m = MSG[lang] || MSG.ko;
  const content = generateBrainDoc(config, lang);
  const summary = `${config.agent.name} — ${config.agent.personalityType} ${m.intent_summary_suffix}`;

  if (existingRecordId) {
    return {
      action: "update",
      recordId: existingRecordId,
      sourceRef: "00_user/persona/config.md",
      content,
      record: {
        title: m.intent_title,
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
      title: m.intent_title,
      summary,
      tags: ["domain/memory", "intent/onboarding"],
      sourceType: "user_confirmed"
    }
  };
}

module.exports = { setup, defaultPromptFn, MSG };
