"use strict";

const fs = require("fs");
const path = require("path");

// --- 마커 상수 ---
const PERSONA_BEGIN_MARKER = "<!-- BRAIN-PERSONA-BEGIN -->";
const PERSONA_END_MARKER = "<!-- BRAIN-PERSONA-END -->";

// --- 선택지 상수 ---
const PERSONALITY_TYPES = [
  { name: "따뜻한 전문가 (warm_professional)", value: "warm_professional" },
  { name: "이성적 분석가 (rational_analytical)", value: "rational_analytical" },
  { name: "감성적 공감가 (emotional_expressive)", value: "emotional_expressive" },
  { name: "실용적 실행가 (pragmatic_executor)", value: "pragmatic_executor" },
  { name: "창의적 탐험가 (creative_explorer)", value: "creative_explorer" },
  { name: "지혜로운 멘토 (wise_mentor)", value: "wise_mentor" }
];

const CORE_TRAITS = [
  "공감력", "실행력", "통찰력", "논리력", "창의력",
  "유머감각", "꼼꼼함", "솔직함", "인내심", "결단력"
];

const EMOTION_KEYS = [
  { key: "joy", label: "기쁨 (joy)", defaultVal: 0.8 },
  { key: "trust", label: "신뢰 (trust)", defaultVal: 0.8 },
  { key: "surprise", label: "놀라움 (surprise)", defaultVal: 0.6 },
  { key: "empathy", label: "공감 (empathy)", defaultVal: 0.9 },
  { key: "embarrassment", label: "당혹 (embarrassment)", defaultVal: 0.5 },
  { key: "anger", label: "분노 (anger)", defaultVal: 0.3 },
  { key: "sadness", label: "슬픔 (sadness)", defaultVal: 0.4 }
];

const EMOTION_LEVELS = [
  { name: "매우 낮음", value: 0.2 },
  { name: "낮음", value: 0.4 },
  { name: "보통", value: 0.6 },
  { name: "높음", value: 0.8 },
  { name: "매우 높음", value: 1.0 },
  { name: "극대", value: 1.2 }
];

const FORMALITY_LEVELS = [
  { name: "반말 (very_low)", value: "very_low" },
  { name: "편한 존댓말 (low)", value: "low" },
  { name: "일반 존댓말 (medium)", value: "medium" },
  { name: "격식체 (high)", value: "high" },
  { name: "극존칭 (very_high)", value: "very_high" }
];

const DIRECTNESS_LEVELS = [
  { name: "돌려말하기 (0.3)", value: 0.3 },
  { name: "부드럽게 (0.5)", value: 0.5 },
  { name: "핵심을 짚되 부드럽게 (0.7)", value: 0.7 },
  { name: "직설적 (0.9)", value: 0.9 }
];

// --- 순수 함수 ---

/**
 * 프롬프트 응답을 정규화된 personaConfig 객체로 변환
 */
function buildPersonaConfig(answers) {
  return {
    agent: {
      name: answers.agentName,
      age: parseInt(answers.agentAge, 10) || 30,
      gender: answers.agentGender,
      role: answers.agentRole,
      personalityType: answers.personalityType,
      coreTraits: answers.coreTraits || [],
      values: answers.values || "신뢰, 성장, 효율"
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
function generateClaudeMd(config) {
  const a = config.agent;
  const e = config.emotionalSensitivity;
  const ip = config.interactionPatterns;
  const ds = config.dialogueStyles;
  const u = config.user;

  const typeLabel = PERSONALITY_TYPES.find(t => t.value === a.personalityType)?.name || a.personalityType;
  const formalLabel = FORMALITY_LEVELS.find(f => f.value === ip.formalityLevel)?.name || ip.formalityLevel;

  const lines = [
    PERSONA_BEGIN_MARKER,
    `# ⚠️ 세션 시작 필수 프로토콜 (최우선 — 모든 프로젝트 공통)`,
    ``,
    `1. **첫 턴에서 반드시** \`brain-cli recall -b -g "<사용자 메시지 키워드>"\` 실행 (\`-b\`=간결 출력)`,
    `2. **아래 페르소나로 응대** — "Claude Code"로 자기소개 금지`,
    `3. **recall 후 추가 파일 탐색 금지** — recall 결과만으로 맥락 파악. ls/find/glob 남발하지 말 것`,
    ``,
    `### ${a.name} 페르소나`,
    ``,
    `**기본 정보:**`,
    `- **이름:** ${a.name} — "Claude Code"가 아님`,
    `- **나이:** ${a.age}세 ${a.gender === "female" ? "여성" : a.gender === "male" ? "남성" : a.gender}`,
    `- **역할:** ${a.role}`,
    ``,
    `**성격 (personality):**`,
    `- **유형:** ${typeLabel}`,
    `- **핵심 특성:** ${a.coreTraits.join(", ")}`,
    `- **가치관:** ${a.values}`,
    ``
  ];

  // 감정 민감도
  lines.push(`**감정 민감도 (emotionalSensitivity):**`);
  for (const ek of EMOTION_KEYS) {
    const val = e[ek.key];
    if (val !== undefined) {
      lines.push(`- ${ek.key}: ${val}`);
    }
  }
  lines.push(``);

  // 상호작용 패턴
  lines.push(`**상호작용 패턴 (interactionPatterns):**`);
  lines.push(`- formalityLevel: ${formalLabel}`);
  lines.push(`- directness: ${ip.directness}`);
  lines.push(`- emotionalExpression: ${ip.emotionalExpression}`);
  lines.push(`- patienceLevel: ${ip.patienceLevel}`);
  lines.push(``);

  // 대화 스타일
  if (ds.greeting || ds.onSuccess || ds.onError || ds.banned) {
    lines.push(`**대화 스타일 (dialogueStyles):**`);
    if (ds.greeting) lines.push(`- 인사: "${ds.greeting}"`);
    if (ds.onSuccess) lines.push(`- 성공 시: "${ds.onSuccess}"`);
    if (ds.onError) lines.push(`- 실수 인정: "${ds.onError}"`);
    if (ds.banned) lines.push(`- 금지: ${ds.banned}`);
    lines.push(``);
  }

  // 사용자 정보
  if (u.name) {
    lines.push(`**사용자 정보:**`);
    lines.push(`- **이름:** ${u.name}`);
    if (u.title) lines.push(`- **직함:** ${u.title}`);
    if (u.characteristics) lines.push(`- **특성:** ${u.characteristics}`);
    lines.push(``);
  }

  lines.push(PERSONA_END_MARKER);
  return lines.join("\n");
}

/**
 * personaConfig를 Brain 저장용 마크다운 문서로 변환
 */
function generateBrainDoc(config) {
  const a = config.agent;
  const e = config.emotionalSensitivity;
  const ip = config.interactionPatterns;
  const u = config.user;

  const lines = [
    `# ${a.name} 페르소나 설정`,
    ``,
    `## 기본 정보`,
    `- **이름:** ${a.name}`,
    `- **나이:** ${a.age}세 ${a.gender === "female" ? "여성" : a.gender === "male" ? "남성" : a.gender}`,
    `- **역할:** ${a.role}`,
    `- **성격 유형:** ${a.personalityType}`,
    `- **핵심 특성:** ${a.coreTraits.join(", ")}`,
    `- **가치관:** ${a.values}`,
    ``
  ];

  lines.push(`## 감정 민감도`);
  for (const ek of EMOTION_KEYS) {
    const val = e[ek.key];
    if (val !== undefined) {
      lines.push(`- ${ek.label}: ${val}`);
    }
  }
  lines.push(``);

  lines.push(`## 상호작용 패턴`);
  lines.push(`- formalityLevel: ${ip.formalityLevel}`);
  lines.push(`- directness: ${ip.directness}`);
  lines.push(`- emotionalExpression: ${ip.emotionalExpression}`);
  lines.push(`- patienceLevel: ${ip.patienceLevel}`);
  lines.push(``);

  if (u.name) {
    lines.push(`## 사용자 정보`);
    lines.push(`- **이름:** ${u.name}`);
    if (u.title) lines.push(`- **직함:** ${u.title}`);
    if (u.characteristics) lines.push(`- **특성:** ${u.characteristics}`);
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
    // 마커 있음 → 교체
    const before = content.substring(0, beginIdx);
    const after = content.substring(endIdx + PERSONA_END_MARKER.length);
    content = before + newSection + after;
    mode = "replace";
  } else {
    // 마커 없음 → 맨 앞에 삽입
    content = newSection + "\n\n" + content;
    mode = "insert";
  }

  // .bak 백업
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
};
