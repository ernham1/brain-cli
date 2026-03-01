"use strict";

const fs = require("fs");
const path = require("path");
const { search, getRecordDetail } = require("./search");

// REQ-109: meta_strategy 저장 경로 규칙
const META_STRATEGY_SCOPE_TYPE = "topic";
const META_STRATEGY_SCOPE_ID = "meta_strategies";

// REQ-106: 5개 seed 전략 상수 정의
const SEED_STRATEGIES = [
  {
    name: "design",
    trigger_pattern: [
      "디자인", "UI", "CSS", "레이아웃", "스타일", "로고", "design", "layout", "화면", "색상",
      "폰트", "간격", "마진", "패딩", "반응형", "모바일", "테마", "아이콘"
    ],
    recall_sequence: [
      { step: 1, query_template: "디자인 UI 선호 스타일 {task_keywords}", type_filter: "note" },
      { step: 2, query_template: "{task_keywords}", type_filter: null },
      { step: 3, query_template: "디자인 레이아웃 결정 {task_keywords}", type_filter: "decision" }
    ],
    priority_fields: ["sourceType=user_confirmed"],
    effectiveness_score: 0.0
  },
  {
    name: "bugfix",
    trigger_pattern: [
      "버그", "오류", "에러", "error", "fix", "bug", "고치", "수정", "깨짐", "안됨",
      "안돼", "문제", "이상", "작동", "안되", "실패", "crash", "장애", "결함"
    ],
    recall_sequence: [
      { step: 1, query_template: "버그 오류 해결 사례 {task_keywords}", type_filter: "note" },
      { step: 2, query_template: "{task_keywords}", type_filter: null },
      { step: 3, query_template: "실수 방지 규칙 레슨 {task_keywords}", type_filter: "rule" }
    ],
    priority_fields: [],
    effectiveness_score: 0.0
  },
  {
    name: "decision",
    trigger_pattern: [
      "어떻게", "선택", "결정", "vs", "비교", "뭐가", "나을까", "판단", "choose",
      "할까", "해야", "좋을까", "방향", "어떤", "추천", "의견"
    ],
    recall_sequence: [
      { step: 1, query_template: "선택 결정 비교 이력 {task_keywords}", type_filter: "decision" },
      { step: 2, query_template: "선호 방향 성향 {task_keywords}", type_filter: "note" },
      { step: 3, query_template: "{task_keywords}", type_filter: null }
    ],
    priority_fields: ["sourceType=user_confirmed"],
    effectiveness_score: 0.0
  },
  {
    name: "new_feature",
    trigger_pattern: [
      "추가", "구현", "만들어", "개발", "새로", "기능", "feature", "create", "build",
      "넣어", "붙여", "연동", "통합", "API", "모듈", "컴포넌트"
    ],
    recall_sequence: [
      { step: 1, query_template: "아키텍처 설계 구조 {task_keywords}", type_filter: "decision" },
      { step: 2, query_template: "코딩 컨벤션 규칙 패턴 {task_keywords}", type_filter: "rule" },
      { step: 3, query_template: "{task_keywords}", type_filter: null }
    ],
    priority_fields: [],
    effectiveness_score: 0.0
  },
  {
    name: "review",
    trigger_pattern: [
      "기획", "검토", "리뷰", "review", "봐줘", "확인", "피드백", "검수", "feedback",
      "점검", "체크", "살펴", "분석", "진단", "평가"
    ],
    recall_sequence: [
      { step: 1, query_template: "프로젝트 목표 방향 기획 {task_keywords}", type_filter: "note" },
      { step: 2, query_template: "피드백 검토 의견 {task_keywords}", type_filter: "note" },
      { step: 3, query_template: "{task_keywords}", type_filter: null }
    ],
    priority_fields: [],
    effectiveness_score: 0.0
  }
];

/**
 * REQ-109: sourceRef 경로 생성
 * @param {string} name - 전략 이름
 * @returns {string} "30_topics/meta_strategies/{name}.json"
 */
function getMetaStrategySourceRef(name) {
  return `30_topics/meta_strategies/${name}.json`;
}

/**
 * REQ-109: content 파일 절대 경로 생성
 * @param {string} brainRoot - Brain 루트 경로
 * @param {string} name - 전략 이름
 * @returns {string}
 */
function getMetaStrategyContentPath(brainRoot, name) {
  return path.join(brainRoot, getMetaStrategySourceRef(name));
}

/**
 * REQ-103~105: active meta_strategy 레코드를 로드하고 content JSON을 파싱한다.
 * @param {string} brainRoot - Brain 루트 경로
 * @returns {{ strategies: Array<{record: Object, content: Object}>, warnings: string[] }}
 */
function loadMetaStrategies(brainRoot) {
  const warnings = [];
  const strategies = [];

  // 1. active meta_strategy 레코드 목록 조회
  const searchResult = search(brainRoot, { type: "meta_strategy" });
  const candidates = searchResult.candidates || [];

  // 2. 각 후보의 상세 레코드 조회 후 content JSON 로드
  for (const candidate of candidates) {
    const record = getRecordDetail(brainRoot, candidate.recordId);
    if (!record || !record.sourceRef) {
      warnings.push(`[SKIP] ${candidate.recordId}: sourceRef 없음`);
      continue;
    }

    const contentPath = path.join(brainRoot, record.sourceRef);
    try {
      const raw = fs.readFileSync(contentPath, "utf8");
      const content = JSON.parse(raw);
      strategies.push({ record, content });
    } catch (err) {
      // REQ-104: 실패 시 skip + warning, 전체 중단 금지
      warnings.push(`[SKIP] ${record.sourceRef}: ${err.message}`);
    }
  }

  return { strategies, warnings };
}

/**
 * REQ-108: seed 전략 배열의 깊은 복사본을 반환한다.
 * @returns {Array} SEED_STRATEGIES 복사본
 */
function getSeedStrategies() {
  return SEED_STRATEGIES.map(s => ({
    ...s,
    trigger_pattern: [...s.trigger_pattern],
    recall_sequence: s.recall_sequence.map(step => ({ ...step })),
    priority_fields: [...(s.priority_fields || [])]
  }));
}

/**
 * REQ-135: 전략의 effectiveness_score를 갱신한다.
 * REQ-137: score를 -1.0 ~ 1.0으로 클램핑한다.
 * REQ-138: score > 0.8 → 승격 알림
 * REQ-139: score < -0.5 → 강등 경고
 * REQ-140: 반환 구조 { success, newScore, message }
 *
 * @param {string} brainRoot - Brain 루트 디렉토리 경로
 * @param {string} strategyName - 전략 이름 (예: "bugfix", "design")
 * @param {number} delta - 점수 변화량 (+0.1 또는 -0.2)
 * @returns {{ success: boolean, newScore: number|null, message: string|null }}
 */
function updateEffectivenessScore(brainRoot, strategyName, delta) {
  const contentPath = getMetaStrategyContentPath(brainRoot, strategyName);

  // content JSON 읽기
  let content;
  try {
    const raw = fs.readFileSync(contentPath, "utf8");
    content = JSON.parse(raw);
  } catch (err) {
    return {
      success: false,
      newScore: null,
      message: `전략 '${strategyName}' 파일을 읽을 수 없습니다: ${err.message}`
    };
  }

  // effectiveness_score 갱신 (현재 값이 없으면 0.0으로 초기화)
  const currentScore = typeof content.effectiveness_score === "number"
    ? content.effectiveness_score
    : 0.0;
  const rawNewScore = currentScore + delta;

  // REQ-137: 클램핑 -1.0 ~ 1.0
  const newScore = Math.max(-1.0, Math.min(1.0, rawNewScore));
  content.effectiveness_score = newScore;

  // 변경된 JSON 저장
  try {
    fs.writeFileSync(contentPath, JSON.stringify(content, null, 2), "utf8");
  } catch (err) {
    return {
      success: false,
      newScore: null,
      message: `전략 '${strategyName}' 파일 저장 실패: ${err.message}`
    };
  }

  // REQ-138, REQ-139: 승격/강등 알림 생성
  let message = null;
  if (newScore > 0.8) {
    message = `전략 '${strategyName}' 검증 완료 (confirmed)`;
  } else if (newScore < -0.5) {
    message = `전략 '${strategyName}' 재검토 필요`;
  }

  return { success: true, newScore, message };
}

module.exports = {
  loadMetaStrategies,
  getSeedStrategies,
  getMetaStrategySourceRef,
  getMetaStrategyContentPath,
  updateEffectivenessScore,
  META_STRATEGY_SCOPE_TYPE,
  META_STRATEGY_SCOPE_ID,
  SEED_STRATEGIES
};
