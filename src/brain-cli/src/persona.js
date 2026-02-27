"use strict";

const fs = require("fs");
const path = require("path");

// --- 마커 상수 ---
const PERSONA_BEGIN_MARKER = "<!-- BRAIN-PERSONA-BEGIN -->";
const PERSONA_END_MARKER = "<!-- BRAIN-PERSONA-END -->";

// --- i18n 라벨맵 ---
const L = {
  en: {
    personality_types: [
      "Warm Professional", "Rational Analyst", "Emotional Expressionist",
      "Pragmatic Executor", "Creative Explorer", "Wise Mentor"
    ],
    core_traits: [
      "Empathy", "Execution", "Insight", "Logic", "Creativity",
      "Humor", "Carefulness", "Honesty", "Patience", "Decision-making"
    ],
    emotion_keys: {
      joy: "Joy", trust: "Trust", surprise: "Surprise", empathy: "Empathy",
      embarrassment: "Embarrassment", anger: "Anger", sadness: "Sadness"
    },
    emotion_levels: ["Very Low", "Low", "Normal", "High", "Very High", "Extreme"],
    formality_levels: ["Casual", "Relaxed Formal", "Standard Formal", "Formal", "Highly Formal"],
    directness_levels: ["Indirect", "Gentle", "Direct but Gentle", "Blunt"],
    gender: { female: "Female", male: "Male" },
    // generateClaudeMd / generateBrainDoc 라벨
    protocol_title: "Session Start Protocol (Highest Priority — All Projects)",
    protocol_steps: [
      'On the **first turn**, run `brain-cli recall -b -g "<user message keywords>"` (`-b` = brief output)',
      'Respond using the **persona below** — do NOT introduce yourself as "Claude Code"',
      'Do NOT explore additional files after recall — use only recall results for context'
    ],
    persona: "Persona",
    basic_info: "Basic Information",
    name: "Name", age: "Age", role: "Role",
    personality: "Personality",
    type: "Type", core_traits_label: "Core Traits", values: "Values",
    emotional_sensitivity: "Emotional Sensitivity",
    interaction_patterns: "Interaction Patterns",
    dialogue_styles: "Dialogue Styles",
    greeting: "Greeting", on_success: "On Success", on_error: "Error Admission", banned: "Banned",
    user_info: "User Information",
    title: "Title", characteristics: "Characteristics",
    persona_settings: "Persona Settings",
    personality_type: "Personality Type",
    years_old: "y/o"
  },
  ko: {
    personality_types: [
      "따뜻한 전문가", "이성적 분석가", "감성적 공감가",
      "실용적 실행가", "창의적 탐험가", "지혜로운 멘토"
    ],
    core_traits: [
      "공감력", "실행력", "통찰력", "논리력", "창의력",
      "유머감각", "꼼꼼함", "솔직함", "인내심", "결단력"
    ],
    emotion_keys: {
      joy: "기쁨", trust: "신뢰", surprise: "놀라움", empathy: "공감",
      embarrassment: "당혹", anger: "분노", sadness: "슬픔"
    },
    emotion_levels: ["매우 낮음", "낮음", "보통", "높음", "매우 높음", "극대"],
    formality_levels: ["반말", "편한 존댓말", "일반 존댓말", "격식체", "극존칭"],
    directness_levels: ["돌려말하기", "부드럽게", "핵심을 짚되 부드럽게", "직설적"],
    gender: { female: "여성", male: "남성" },
    protocol_title: "세션 시작 필수 프로토콜 (최우선 — 모든 프로젝트 공통)",
    protocol_steps: [
      '**첫 턴에서 반드시** `brain-cli recall -b -g "<사용자 메시지 키워드>"` 실행 (`-b`=간결 출력)',
      '**아래 페르소나로 응대** — "Claude Code"로 자기소개 금지',
      '**recall 후 추가 파일 탐색 금지** — recall 결과만으로 맥락 파악. ls/find/glob 남발하지 말 것'
    ],
    persona: "페르소나",
    basic_info: "기본 정보",
    name: "이름", age: "나이", role: "역할",
    personality: "성격",
    type: "유형", core_traits_label: "핵심 특성", values: "가치관",
    emotional_sensitivity: "감정 민감도",
    interaction_patterns: "상호작용 패턴",
    dialogue_styles: "대화 스타일",
    greeting: "인사", on_success: "성공 시", on_error: "실수 인정", banned: "금지",
    user_info: "사용자 정보",
    title: "직함", characteristics: "특성",
    persona_settings: "페르소나 설정",
    personality_type: "성격 유형",
    years_old: "세"
  }
};

// --- 내부 값 상수 (언어 무관) ---
const PERSONALITY_TYPE_VALUES = [
  "warm_professional", "rational_analytical", "emotional_expressive",
  "pragmatic_executor", "creative_explorer", "wise_mentor"
];

const EMOTION_KEY_LIST = [
  { key: "joy", defaultVal: 0.8 },
  { key: "trust", defaultVal: 0.8 },
  { key: "surprise", defaultVal: 0.6 },
  { key: "empathy", defaultVal: 0.9 },
  { key: "embarrassment", defaultVal: 0.5 },
  { key: "anger", defaultVal: 0.3 },
  { key: "sadness", defaultVal: 0.4 }
];

const EMOTION_LEVEL_VALUES = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2];
const FORMALITY_LEVEL_VALUES = ["very_low", "low", "medium", "high", "very_high"];
const DIRECTNESS_LEVEL_VALUES = [0.3, 0.5, 0.7, 0.9];

const SCOPE_TYPES = ["project", "agent", "user", "topic"];
const RECORD_TYPES = ["rule", "decision", "profile", "log", "ref", "note", "candidate", "reminder", "project_state"];
const SOURCE_TYPES = ["user_confirmed", "candidate", "chat_log", "external_doc", "inference"];
const STATUS_VALUES = ["active", "deprecated", "archived"];

// --- Getter 함수 (lang 기반) ---

function getPersonalityTypes(lang = "en") {
  const labels = L[lang] || L.en;
  return PERSONALITY_TYPE_VALUES.map((val, i) => ({
    name: `${labels.personality_types[i]} (${val})`,
    value: val
  }));
}

function getCoreTraits(lang = "en") {
  const labels = L[lang] || L.en;
  return labels.core_traits;
}

function getEmotionKeys(lang = "en") {
  const labels = L[lang] || L.en;
  return EMOTION_KEY_LIST.map(ek => ({
    key: ek.key,
    label: `${labels.emotion_keys[ek.key]} (${ek.key})`,
    defaultVal: ek.defaultVal
  }));
}

function getEmotionLevels(lang = "en") {
  const labels = L[lang] || L.en;
  return EMOTION_LEVEL_VALUES.map((val, i) => ({
    name: labels.emotion_levels[i],
    value: val
  }));
}

function getFormalityLevels(lang = "en") {
  const labels = L[lang] || L.en;
  return FORMALITY_LEVEL_VALUES.map((val, i) => ({
    name: `${labels.formality_levels[i]} (${val})`,
    value: val
  }));
}

function getDirectnessLevels(lang = "en") {
  const labels = L[lang] || L.en;
  return DIRECTNESS_LEVEL_VALUES.map((val, i) => ({
    name: `${labels.directness_levels[i]} (${val})`,
    value: val
  }));
}

// --- 하위호환 상수 (기존 코드/테스트가 직접 참조할 경우) ---
const PERSONALITY_TYPES = getPersonalityTypes("ko");
const CORE_TRAITS = getCoreTraits("ko");
const EMOTION_KEYS = getEmotionKeys("ko");
const EMOTION_LEVELS = getEmotionLevels("ko");
const FORMALITY_LEVELS = getFormalityLevels("ko");
const DIRECTNESS_LEVELS = getDirectnessLevels("ko");

// --- 순수 함수 ---

/**
 * 프롬프트 응답을 정규화된 personaConfig 객체로 변환
 */
function buildPersonaConfig(answers) {
  return {
    lang: answers.lang || "ko",
    agent: {
      name: answers.agentName,
      age: parseInt(answers.agentAge, 10) || 30,
      gender: answers.agentGender,
      role: answers.agentRole,
      personalityType: answers.personalityType,
      coreTraits: answers.coreTraits || [],
      values: answers.values || ""
    },
    emotionalSensitivity: answers.emotions || {},
    interactionPatterns: {
      formalityLevel: answers.formalityLevel || "medium",
      directness: answers.directness || 0.7,
      emotionalExpression: answers.emotionalExpression || 0.8,
      patienceLevel: answers.patienceLevel || 0.8
    },
    dialogueStyles: {
      greeting: answers.greeting || "",
      onSuccess: answers.onSuccess || "",
      onError: answers.onError || "",
      banned: answers.banned || ""
    },
    user: {
      name: answers.userName,
      title: answers.userTitle,
      characteristics: answers.userCharacteristics || ""
    }
  };
}

/**
 * personaConfig를 CLAUDE.md용 마크다운 문자열로 변환 (마커 포함)
 */
function generateClaudeMd(config, lang) {
  const l = lang || config.lang || "ko";
  const t = L[l] || L.ko;
  const a = config.agent;
  const e = config.emotionalSensitivity;
  const ip = config.interactionPatterns;
  const ds = config.dialogueStyles;
  const u = config.user;

  const typeLabel = getPersonalityTypes(l).find(pt => pt.value === a.personalityType)?.name || a.personalityType;
  const formalLabel = getFormalityLevels(l).find(f => f.value === ip.formalityLevel)?.name || ip.formalityLevel;
  const genderLabel = t.gender[a.gender] || a.gender;

  const lines = [
    PERSONA_BEGIN_MARKER,
    `# ⚠️ ${t.protocol_title}`,
    ``,
    ...t.protocol_steps.map((step, i) => `${i + 1}. ${step}`),
    ``,
    `### ${a.name} ${t.persona}`,
    ``,
    `**${t.basic_info}:**`,
    `- **${t.name}:** ${a.name} — "Claude Code"${l === "ko" ? "가 아님" : " is not the name"}`,
    `- **${t.age}:** ${a.age}${t.years_old} ${genderLabel}`,
    `- **${t.role}:** ${a.role}`,
    ``,
    `**${t.personality} (personality):**`,
    `- **${t.type}:** ${typeLabel}`,
    `- **${t.core_traits_label}:** ${a.coreTraits.join(", ")}`,
    `- **${t.values}:** ${a.values}`,
    ``
  ];

  // 감정 민감도
  lines.push(`**${t.emotional_sensitivity} (emotionalSensitivity):**`);
  const emotionKeys = getEmotionKeys(l);
  for (const ek of emotionKeys) {
    const val = e[ek.key];
    if (val !== undefined) {
      lines.push(`- ${ek.key}: ${val}`);
    }
  }
  lines.push(``);

  // 상호작용 패턴
  lines.push(`**${t.interaction_patterns} (interactionPatterns):**`);
  lines.push(`- formalityLevel: ${formalLabel}`);
  lines.push(`- directness: ${ip.directness}`);
  lines.push(`- emotionalExpression: ${ip.emotionalExpression}`);
  lines.push(`- patienceLevel: ${ip.patienceLevel}`);
  lines.push(``);

  // 대화 스타일
  if (ds.greeting || ds.onSuccess || ds.onError || ds.banned) {
    lines.push(`**${t.dialogue_styles} (dialogueStyles):**`);
    if (ds.greeting) lines.push(`- ${t.greeting}: "${ds.greeting}"`);
    if (ds.onSuccess) lines.push(`- ${t.on_success}: "${ds.onSuccess}"`);
    if (ds.onError) lines.push(`- ${t.on_error}: "${ds.onError}"`);
    if (ds.banned) lines.push(`- ${t.banned}: ${ds.banned}`);
    lines.push(``);
  }

  // 사용자 정보
  if (u.name) {
    lines.push(`**${t.user_info}:**`);
    lines.push(`- **${t.name}:** ${u.name}`);
    if (u.title) lines.push(`- **${t.title}:** ${u.title}`);
    if (u.characteristics) lines.push(`- **${t.characteristics}:** ${u.characteristics}`);
    lines.push(``);
  }

  lines.push(PERSONA_END_MARKER);
  return lines.join("\n");
}

/**
 * personaConfig를 Brain 저장용 마크다운 문서로 변환
 */
function generateBrainDoc(config, lang) {
  const l = lang || config.lang || "ko";
  const t = L[l] || L.ko;
  const a = config.agent;
  const e = config.emotionalSensitivity;
  const ip = config.interactionPatterns;
  const u = config.user;

  const genderLabel = t.gender[a.gender] || a.gender;

  const lines = [
    `# ${a.name} ${t.persona_settings}`,
    ``,
    `## ${t.basic_info}`,
    `- **${t.name}:** ${a.name}`,
    `- **${t.age}:** ${a.age}${t.years_old} ${genderLabel}`,
    `- **${t.role}:** ${a.role}`,
    `- **${t.personality_type}:** ${a.personalityType}`,
    `- **${t.core_traits_label}:** ${a.coreTraits.join(", ")}`,
    `- **${t.values}:** ${a.values}`,
    ``
  ];

  lines.push(`## ${t.emotional_sensitivity}`);
  const emotionKeys = getEmotionKeys(l);
  for (const ek of emotionKeys) {
    const val = e[ek.key];
    if (val !== undefined) {
      lines.push(`- ${ek.label}: ${val}`);
    }
  }
  lines.push(``);

  lines.push(`## ${t.interaction_patterns}`);
  lines.push(`- formalityLevel: ${ip.formalityLevel}`);
  lines.push(`- directness: ${ip.directness}`);
  lines.push(`- emotionalExpression: ${ip.emotionalExpression}`);
  lines.push(`- patienceLevel: ${ip.patienceLevel}`);
  lines.push(``);

  if (u.name) {
    lines.push(`## ${t.user_info}`);
    lines.push(`- **${t.name}:** ${u.name}`);
    if (u.title) lines.push(`- **${t.title}:** ${u.title}`);
    if (u.characteristics) lines.push(`- **${t.characteristics}:** ${u.characteristics}`);
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * CLAUDE.md 파일에서 페르소나 섹션을 교체(또는 삽입)
 * @returns {{ updated: boolean, mode: "replace"|"insert" }}
 */
function updateClaudeMd(filePath, newSection) {
  let content = "";
  let mode = "insert";

  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf-8");
  }

  const beginIdx = content.indexOf(PERSONA_BEGIN_MARKER);
  const endIdx = content.indexOf(PERSONA_END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1) {
    const before = content.substring(0, beginIdx);
    const after = content.substring(endIdx + PERSONA_END_MARKER.length);
    content = before + newSection + after;
    mode = "replace";
  } else {
    content = newSection + "\n\n" + content;
    mode = "insert";
  }

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + ".bak");
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, content, "utf-8");
  return { updated: true, mode };
}

module.exports = {
  PERSONA_BEGIN_MARKER,
  PERSONA_END_MARKER,
  // 하위호환 상수 (ko 기본값)
  PERSONALITY_TYPES,
  CORE_TRAITS,
  EMOTION_KEYS,
  EMOTION_LEVELS,
  FORMALITY_LEVELS,
  DIRECTNESS_LEVELS,
  // i18n getter 함수
  getPersonalityTypes,
  getCoreTraits,
  getEmotionKeys,
  getEmotionLevels,
  getFormalityLevels,
  getDirectnessLevels,
  // 순수 함수
  buildPersonaConfig,
  generateClaudeMd,
  generateBrainDoc,
  updateClaudeMd,
  // i18n 라벨 (테스트/외부 참조용)
  L
};
