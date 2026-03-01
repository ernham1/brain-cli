"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { classify } = require("../src/classifier");

// 테스트용 전략 생성 헬퍼
function makeStrategy(name, triggerPattern, recallSteps = 3) {
  const recall_sequence = [];
  for (let i = 1; i <= recallSteps; i++) {
    recall_sequence.push({ step: i, query_template: i === 2 ? "{task_keywords}" : `query_${i}`, type_filter: null });
  }
  return {
    record: { recordId: `test-${name}`, type: "meta_strategy" },
    content: {
      name,
      trigger_pattern: triggerPattern,
      recall_sequence,
      effectiveness_score: 0.0
    }
  };
}

// 빈 synonymMap
const emptySynonymMap = new Map();

// 테스트용 synonymMap
function makeSynonymMap(pairs) {
  const map = new Map();
  for (const [key, values] of pairs) {
    map.set(key, values);
  }
  return map;
}

describe("B06 SituationClassifier", () => {

  // ─── REQ-110: classify() 함수 구현 ───

  describe("REQ-110: classify() 함수 구조", () => {
    it("classify 함수가 export 된다", () => {
      assert.equal(typeof classify, "function");
    });

    it("반환값에 matched, primary, secondary, fallback 키가 있다", () => {
      const result = classify("테스트 메시지", [], emptySynonymMap);
      assert.ok("matched" in result);
      assert.ok("primary" in result);
      assert.ok("secondary" in result);
      assert.ok("fallback" in result);
    });

    it("primary/secondary는 null 또는 {strategy, score} 구조다", () => {
      const strategies = [makeStrategy("design", ["디자인", "UI", "CSS", "레이아웃"])];
      const result = classify("디자인 작업을 해주세요", strategies, emptySynonymMap);
      if (result.primary !== null) {
        assert.ok("strategy" in result.primary);
        assert.ok("score" in result.primary);
        assert.equal(typeof result.primary.score, "number");
      }
    });
  });

  // ─── REQ-111: 메시지 토큰화 ───

  describe("REQ-111: 메시지 토큰화", () => {
    it("공백 기준으로 토큰을 분리한다", () => {
      // "footer 디자인 버그 좀 고쳐줘" → "좀"은 길이 1이 아니므로 포함됨 (2글자)
      // 실제로 "좀"은 1글자이므로 제거됨
      const strategies = [makeStrategy("bugfix", ["버그"])];
      const result = classify("footer 디자인 버그 좀 고쳐줘", strategies, emptySynonymMap);
      // "좀"은 길이 1로 제거, 4개 토큰 ("footer", "디자인", "버그", "고쳐줘")
      // "버그" exact match → score = 1.0/4 = 0.25
      assert.equal(result.matched, false); // 0.25 < 0.4
    });

    it("대소문자를 무시한다 (toLowerCase)", () => {
      const strategies = [makeStrategy("bugfix", ["error", "bug", "fix"])];
      // "Error BUG" → toLowerCase → "error bug"
      // exact match: "error" +1.0, "bug" +1.0 → total 2.0, tokens 2 → normalized 1.0
      const result = classify("Error BUG", strategies, emptySynonymMap);
      assert.equal(result.matched, true);
      assert.notEqual(result.primary, null);
      assert.equal(result.primary.score, 1.0);
    });

    it("길이 1 이하 토큰은 제거한다", () => {
      // "a 버그 b" → tokens: ["버그"] (a, b 제거)
      const strategies = [makeStrategy("bugfix", ["버그"])];
      const result = classify("a 버그 b", strategies, emptySynonymMap);
      // "버그" exact → 1.0 / 1 token = 1.0
      assert.equal(result.matched, true);
      assert.equal(result.primary.score, 1.0);
    });
  });

  // ─── REQ-112: 빈 메시지 즉시 반환 ───

  describe("REQ-112: 빈 메시지 즉시 반환", () => {
    it("빈 문자열 → fallback=true", () => {
      const result = classify("", [], emptySynonymMap);
      assert.equal(result.matched, false);
      assert.equal(result.fallback, true);
      assert.equal(result.primary, null);
      assert.equal(result.secondary, null);
    });

    it("공백만 → fallback=true", () => {
      const result = classify("   ", [], emptySynonymMap);
      assert.equal(result.matched, false);
      assert.equal(result.fallback, true);
    });

    it("길이 1 토큰만 → fallback=true (0 나눗셈 방지)", () => {
      const result = classify("a b c", [], emptySynonymMap);
      assert.equal(result.matched, false);
      assert.equal(result.fallback, true);
    });
  });

  // ─── REQ-113: 매칭 점수 산출 ───

  describe("REQ-113: 매칭 점수 산출", () => {
    it("exact match는 +1.0 점", () => {
      const strategies = [makeStrategy("bugfix", ["버그", "에러"])];
      // "버그 에러 수정" → 3 tokens, exact 2개 → 2.0/3 ≈ 0.667
      const result = classify("버그 에러 수정", strategies, emptySynonymMap);
      assert.equal(result.matched, true);
      assert.ok(Math.abs(result.primary.score - 2.0 / 3) < 0.001);
    });

    it("synonym match는 +0.7 점", () => {
      const synonymMap = makeSynonymMap([["error", ["버그", "오류"]]]);
      const strategies = [makeStrategy("bugfix", ["버그"])];
      // "error 수정" → 2 tokens
      // "error": synonymMap.get("error") = ["버그", "오류"], "버그" match → +0.7
      // "수정": no match
      // score = 0.7/2 = 0.35
      const result = classify("error 수정", strategies, synonymMap);
      assert.equal(result.matched, false); // 0.35 < 0.4
      assert.equal(result.fallback, true);
    });

    it("substring match는 +0.5 점 (pattern이 token을 포함)", () => {
      const strategies = [makeStrategy("bugfix", ["레이아웃"])];
      // "이아웃" → pattern "레이아웃".includes("이아웃") = true → +0.5
      // 하지만 "이아웃"은 "레이아웃"에 포함됨 → substring match
      const result = classify("이아웃 테스트", strategies, emptySynonymMap);
      // score = 0.5/2 = 0.25
      assert.equal(result.matched, false); // 0.25 < 0.4
    });

    it("exact 매칭 시 synonym/substring은 체크하지 않는다", () => {
      const synonymMap = makeSynonymMap([["버그", ["error"]]]);
      const strategies = [makeStrategy("bugfix", ["버그"])];
      // "버그" exact match → +1.0 (synonym 추가 안 됨)
      // 1 valid token ("버그"), score = 1.0
      const result = classify("버그 점검", strategies, synonymMap);
      assert.equal(result.matched, true);
      // score = 1.0 / 2 = 0.5
      assert.equal(result.primary.score, 0.5);
    });
  });

  // ─── REQ-114: normalizedScore ───

  describe("REQ-114: normalizedScore 산출", () => {
    it("matchScore를 tokenCount로 나눈다", () => {
      const strategies = [makeStrategy("design", ["디자인", "UI"])];
      // "디자인 UI 작업 요청" → 4 tokens
      // exact: "디자인" +1.0, "ui" +1.0 → total 2.0
      // normalized = 2.0 / 4 = 0.5
      const result = classify("디자인 UI 작업 요청", strategies, emptySynonymMap);
      assert.equal(result.primary.score, 0.5);
    });
  });

  // ─── REQ-115: 내림차순 정렬 ───

  describe("REQ-115: 내림차순 정렬", () => {
    it("가장 높은 점수의 전략이 primary가 된다", () => {
      const bugfix = makeStrategy("bugfix", ["버그", "에러"]);
      const design = makeStrategy("design", ["디자인", "UI", "CSS"]);
      // "디자인 UI CSS 수정" → 4 tokens
      // bugfix: no match → 0
      // design: "디자인" +1.0, "ui" +1.0, "css" +1.0 → 3.0/4 = 0.75
      const result = classify("디자인 UI CSS 수정", [bugfix, design], emptySynonymMap);
      assert.equal(result.primary.strategy.name, "design");
    });
  });

  // ─── REQ-116: primary 선정 ───

  describe("REQ-116: primary 선정 (score >= 0.4)", () => {
    it("score >= 0.4 → primary 선정", () => {
      const strategies = [makeStrategy("design", ["디자인"])];
      // "디자인 수정" → 2 tokens, exact 1 → 1.0/2 = 0.5
      const result = classify("디자인 수정", strategies, emptySynonymMap);
      assert.equal(result.matched, true);
      assert.notEqual(result.primary, null);
      assert.equal(result.primary.strategy.name, "design");
    });

    it("score = 0.4 (경계값) → primary 선정", () => {
      const strategies = [makeStrategy("design", ["디자인", "UI"])];
      // "디자인 UI 작업 수정 요청" → 5 tokens
      // exact: "디자인" +1.0, "ui" +1.0 → 2.0/5 = 0.4
      const result = classify("디자인 UI 작업 수정 요청", strategies, emptySynonymMap);
      assert.equal(result.matched, true);
      assert.notEqual(result.primary, null);
      assert.equal(result.primary.score, 0.4);
    });

    it("score < 0.4 → primary=null, fallback=true", () => {
      const strategies = [makeStrategy("design", ["디자인"])];
      // "여러 가지 작업을 해주세요" → 4 tokens, no match → 0
      const result = classify("여러 가지 작업을 해주세요", strategies, emptySynonymMap);
      assert.equal(result.matched, false);
      assert.equal(result.primary, null);
      assert.equal(result.fallback, true);
    });
  });

  // ─── REQ-117: secondary 선정 ───

  describe("REQ-117: secondary 선정 (score >= 0.25 + step cap)", () => {
    it("2위 score >= 0.25 + step합계 <= 5 → secondary 선정", () => {
      // recall_sequence 2 steps each → total 4 <= 5
      const design = makeStrategy("design", ["디자인", "UI", "CSS"], 2);
      const bugfix = makeStrategy("bugfix", ["버그", "에러", "수정"], 2);
      // "디자인 버그 수정 요청" → 4 tokens
      // design: "디자인" +1.0 → 1.0/4 = 0.25
      // bugfix: "버그" +1.0, "수정" +1.0 → 2.0/4 = 0.5
      // sorted: bugfix(0.5), design(0.25)
      const result = classify("디자인 버그 수정 요청", [design, bugfix], emptySynonymMap);
      assert.equal(result.matched, true);
      assert.equal(result.primary.strategy.name, "bugfix");
      assert.notEqual(result.secondary, null);
      assert.equal(result.secondary.strategy.name, "design");
    });

    it("2위 score < 0.25 → secondary=null", () => {
      const design = makeStrategy("design", ["디자인", "UI", "CSS"], 2);
      const bugfix = makeStrategy("bugfix", ["버그"], 2);
      // "디자인 UI CSS 작업 수정" → 5 tokens
      // design: "디자인" +1, "ui" +1, "css" +1 → 3.0/5 = 0.6
      // bugfix: no match → 0/5 = 0
      const result = classify("디자인 UI CSS 작업 수정", [design, bugfix], emptySynonymMap);
      assert.equal(result.matched, true);
      assert.equal(result.primary.strategy.name, "design");
      assert.equal(result.secondary, null);
    });

    it("step 합계 경계값 = 5 → secondary 선정", () => {
      const design = makeStrategy("design", ["디자인", "UI"], 3); // 3 steps
      const bugfix = makeStrategy("bugfix", ["버그", "수정"], 2); // 2 steps → total 5
      // "디자인 버그 수정 UI" → 4 tokens (UI lowercase = "ui")
      // design: "디자인" +1, "ui" +1 → 2.0/4 = 0.5
      // bugfix: "버그" +1, "수정" +1 → 2.0/4 = 0.5
      const result = classify("디자인 버그 수정 UI", [design, bugfix], emptySynonymMap);
      assert.equal(result.matched, true);
      assert.notEqual(result.secondary, null); // 3+2=5, 경계값 통과
    });
  });

  // ─── REQ-118: 전체 폴백 ───

  describe("REQ-118: 전체 폴백", () => {
    it("strategies 빈 배열 → fallback=true", () => {
      const result = classify("아무 메시지나", [], emptySynonymMap);
      assert.equal(result.matched, false);
      assert.equal(result.fallback, true);
    });

    it("trigger_pattern과 전혀 매칭 안 됨 → fallback=true", () => {
      const strategies = [makeStrategy("design", ["디자인", "UI"])];
      const result = classify("오늘 날씨가 좋네요", strategies, emptySynonymMap);
      assert.equal(result.matched, false);
      assert.equal(result.fallback, true);
    });
  });

  // ─── REQ-119: step 합계 초과 시 secondary null ───

  describe("REQ-119: step 합계 > 5 → secondary null", () => {
    it("step 합계 6 > 5 → secondary=null, matched=true", () => {
      const design = makeStrategy("design", ["디자인", "UI"], 3); // 3 steps
      const bugfix = makeStrategy("bugfix", ["버그", "수정"], 3); // 3 steps → total 6
      // "디자인 버그 수정 UI" → 4 tokens
      // design: "디자인" +1, "ui" +1 → 2.0/4 = 0.5
      // bugfix: "버그" +1, "수정" +1 → 2.0/4 = 0.5
      const result = classify("디자인 버그 수정 UI", [design, bugfix], emptySynonymMap);
      assert.equal(result.matched, true);
      assert.notEqual(result.primary, null);
      assert.equal(result.secondary, null); // 3+3=6 > 5
      assert.equal(result.fallback, false);
    });

    it("step 합계 7 > 5 → secondary=null", () => {
      const design = makeStrategy("design", ["디자인", "UI"], 4); // 4 steps
      const bugfix = makeStrategy("bugfix", ["버그", "수정"], 3); // 3 steps → total 7
      const result = classify("디자인 버그 수정 UI", [design, bugfix], emptySynonymMap);
      assert.equal(result.matched, true);
      assert.equal(result.secondary, null);
    });
  });

  // ─── 추가 엣지 케이스 ───

  describe("엣지 케이스", () => {
    it("synonymMap이 빈 Map이어도 정상 동작", () => {
      const strategies = [makeStrategy("design", ["디자인"])];
      const result = classify("디자인 작업", strategies, new Map());
      assert.equal(typeof result.matched, "boolean");
    });

    it("trigger_pattern이 빈 배열인 전략은 점수 0", () => {
      const emptyStrategy = makeStrategy("empty", []);
      const result = classify("아무 메시지나 입력", [emptyStrategy], emptySynonymMap);
      assert.equal(result.matched, false);
      assert.equal(result.fallback, true);
    });

    it("여러 전략 중 정확히 1개만 임계치 통과 시 primary만 반환", () => {
      const design = makeStrategy("design", ["디자인", "UI", "CSS"], 3);
      const bugfix = makeStrategy("bugfix", ["버그"], 2);
      const decision = makeStrategy("decision", ["결정"], 2);
      // "디자인 UI CSS" → 3 tokens
      // design: 3.0/3 = 1.0
      // bugfix: 0/3 = 0
      // decision: 0/3 = 0
      const result = classify("디자인 UI CSS", [design, bugfix, decision], emptySynonymMap);
      assert.equal(result.matched, true);
      assert.equal(result.primary.strategy.name, "design");
      assert.equal(result.secondary, null); // 2위 score=0 < 0.25
    });
  });
});

// ====================================================================
// [B09] Phase2Tests — classifier.test.js
// REQ: REQ-145 ~ REQ-150
// Ref: TEST-UT-CLASSIFIER
// Depends On: B06(SituationClassifier)
// ====================================================================

describe("B09 Phase2Tests — classifier", () => {

  // --- REQ-145: classifier exact match 테스트 ---

  describe("classifier exact match (REQ-145)", () => {
    it("trigger_pattern 토큰 exact match — +1.0 점수 부여", () => {
      const strategies = [
        {
          record: { recordId: "rec_topic_bugfix" },
          content: {
            name: "bugfix",
            trigger_pattern: ["버그", "오류", "에러", "error", "fix", "bug"],
            recall_sequence: [
              { step: 1, query_template: "유사 버그 기록", type_filter: "note" },
              { step: 2, query_template: "{task_keywords}", type_filter: null },
              { step: 3, query_template: "프로젝트 레슨", type_filter: "rule" }
            ],
            effectiveness_score: 0.0
          }
        }
      ];
      const synonymMap = new Map();
      const result = classify("버그", strategies, synonymMap);

      assert.equal(result.matched, true, "exact match → matched=true");
      assert.ok(result.primary !== null, "primary 존재");
      assert.equal(result.primary.strategy.name, "bugfix");
      assert.ok(result.primary.score >= 1.0, `score=${result.primary.score} >= 1.0`);
    });

    it("trigger_pattern 2개 토큰 exact match — +2.0 누적, normalizedScore 올바름", () => {
      const strategies = [
        {
          record: { recordId: "rec_topic_bugfix" },
          content: {
            name: "bugfix",
            trigger_pattern: ["버그", "오류", "에러", "error", "fix"],
            recall_sequence: [
              { step: 1, query_template: "{task_keywords}", type_filter: null }
            ],
            effectiveness_score: 0.0
          }
        }
      ];
      const synonymMap = new Map();
      // "버그 오류" → 2 토큰 모두 exact match → matchScore=2.0, normalizedScore=2.0/2=1.0
      const result = classify("버그 오류", strategies, synonymMap);

      assert.equal(result.matched, true);
      assert.ok(result.primary.score >= 1.0, `score=${result.primary.score}`);
      assert.equal(result.primary.strategy.name, "bugfix");
    });
  });

  // --- REQ-146: classifier synonym match 테스트 ---

  describe("classifier synonym match (REQ-146)", () => {
    it("동의어 토큰 — trigger_pattern 동의어 매칭 시 +0.7 부여", () => {
      const strategies = [
        {
          record: { recordId: "rec_topic_design" },
          content: {
            name: "design",
            trigger_pattern: ["디자인", "ui", "css", "레이아웃"],
            recall_sequence: [
              { step: 1, query_template: "디자인 선호", type_filter: "note" },
              { step: 2, query_template: "{task_keywords}", type_filter: null }
            ],
            effectiveness_score: 0.0
          }
        }
      ];
      const synonymMap = new Map([
        ["프론트엔드", ["ui", "frontend", "화면"]],
        ["ui", ["프론트엔드", "frontend", "화면"]]
      ]);

      // "프론트엔드" → synonymMap.get("프론트엔드") includes "ui" → +0.7
      // messageTokenCount=1, normalizedScore=0.7/1=0.7
      const result = classify("프론트엔드", strategies, synonymMap);

      assert.equal(result.matched, true, "synonym match → matched=true (score=0.7 >= 0.4)");
      assert.ok(result.primary !== null, "primary 존재");
      assert.equal(result.primary.strategy.name, "design");
      assert.ok(
        Math.abs(result.primary.score - 0.7) < 0.01,
        `score=${result.primary.score} ≈ 0.7`
      );
    });

    it("synonym match score가 exact match보다 낮음 — 0.7 < 1.0", () => {
      const strategies = [
        {
          record: { recordId: "rec_topic_design" },
          content: {
            name: "design",
            trigger_pattern: ["ui", "css"],
            recall_sequence: [
              { step: 1, query_template: "{task_keywords}", type_filter: null }
            ],
            effectiveness_score: 0.0
          }
        }
      ];
      const synonymMap = new Map([["프론트엔드", ["ui"]]]);

      const resultSynonym = classify("프론트엔드", strategies, synonymMap);
      const resultExact = classify("ui", strategies, new Map());

      assert.ok(
        resultSynonym.primary.score < resultExact.primary.score,
        `synonym(${resultSynonym.primary.score}) < exact(${resultExact.primary.score})`
      );
    });
  });

  // --- REQ-147: classifier normalization 테스트 ---

  describe("classifier normalization (REQ-147)", () => {
    const bugfixStrategy = {
      record: { recordId: "rec_topic_bugfix" },
      content: {
        name: "bugfix",
        trigger_pattern: ["버그", "오류", "에러", "error", "fix", "bug", "고치", "수정"],
        recall_sequence: [
          { step: 1, query_template: "유사 버그 기록", type_filter: "note" },
          { step: 2, query_template: "{task_keywords}", type_filter: null },
          { step: 3, query_template: "레슨", type_filter: "rule" }
        ],
        effectiveness_score: 0.0
      }
    };

    it("4토큰 메시지에서 2개 exact match — normalizedScore=0.5", () => {
      const result = classify("버그 오류 뭔가 이상해", [bugfixStrategy], new Map());

      assert.equal(result.matched, true, "0.5 >= 0.4 → matched");
      assert.ok(
        Math.abs(result.primary.score - 0.5) < 0.01,
        `normalizedScore=${result.primary.score} ≈ 0.5`
      );
    });

    it("5토큰 메시지에서 1개 exact match — normalizedScore=0.2 → fallback", () => {
      const result = classify("버그 아닌 것 같고 뭔지", [bugfixStrategy], new Map());

      assert.equal(result.matched, false, "0.2 < 0.4 → fallback");
      assert.equal(result.fallback, true);
    });

    it("multi-strategy normalization — 모든 normalizedScore < 0.4 → 전체 fallback", () => {
      const designStrategy = {
        record: { recordId: "rec_topic_design" },
        content: {
          name: "design",
          trigger_pattern: ["ui", "css", "레이아웃"],
          recall_sequence: [
            { step: 1, query_template: "{task_keywords}", type_filter: null },
            { step: 2, query_template: "디자인 결정사항", type_filter: "decision" }
          ],
          effectiveness_score: 0.0
        }
      };
      const synonymMap = new Map([["프론트엔드", ["ui"]]]);

      // "버그 프론트엔드 확인" → 3토큰
      // bugfix: "버그" exact(+1.0) → 1.0/3≈0.333
      // design: "프론트엔드" → synonym "ui"(+0.7) → 0.7/3≈0.233
      const result = classify("버그 프론트엔드 확인", [bugfixStrategy, designStrategy], synonymMap);

      assert.equal(result.matched, false, "모든 normalizedScore < 0.4 → fallback");
    });
  });

  // --- REQ-148: classifier threshold 테스트 ---

  describe("classifier threshold (REQ-148)", () => {
    function makeThresholdStrategy(name, triggerPattern, steps = 2) {
      return {
        record: { recordId: `rec_topic_${name}` },
        content: {
          name,
          trigger_pattern: triggerPattern,
          recall_sequence: Array.from({ length: steps }, (_, i) => ({
            step: i + 1,
            query_template: "{task_keywords}",
            type_filter: null
          })),
          effectiveness_score: 0.0
        }
      };
    }

    it("1위 score >= 0.4 → primary 선정", () => {
      const strategy = makeThresholdStrategy("bugfix", ["버그", "오류", "에러"]);
      const result = classify("버그 수정", [strategy], new Map());

      assert.equal(result.matched, true);
      assert.ok(result.primary !== null, "primary 선정");
      assert.equal(result.primary.strategy.name, "bugfix");
      assert.ok(result.primary.score >= 0.4, `score=${result.primary.score} >= 0.4`);
    });

    it("2위 score >= 0.25 + step cap 충족 → secondary 선정", () => {
      const bugfix = makeThresholdStrategy("bugfix", ["버그", "오류", "fix"], 2);
      const design = makeThresholdStrategy("design", ["디자인", "ui", "화면"], 2);

      // "버그 버그 디자인 화면" → 4토큰
      // bugfix: "버그"×2(+2.0), 2.0/4=0.5 → primary
      // design: "디자인"(+1.0)+"화면"(+1.0)=2.0, 2.0/4=0.5 → secondary
      const result = classify("버그 버그 디자인 화면", [bugfix, design], new Map());

      assert.equal(result.matched, true);
      assert.ok(result.primary !== null, "primary 존재");
      assert.ok(result.secondary !== null, "secondary 선정 (step cap 내)");
      assert.ok(result.secondary.score >= 0.25, `secondary score=${result.secondary.score} >= 0.25`);
    });

    it("1위 score < 0.4 → fallback=true, primary=null", () => {
      const strategy = makeThresholdStrategy("bugfix", ["버그", "오류"]);
      const result = classify("무관한 내용입니다", [strategy], new Map());

      assert.equal(result.matched, false);
      assert.equal(result.fallback, true);
      assert.equal(result.primary, null);
      assert.equal(result.secondary, null);
    });

    it("1위 >= 0.4, 2위 < 0.25 → secondary=null", () => {
      const bugfix = makeThresholdStrategy("bugfix", ["버그", "오류", "에러"], 2);
      const design = makeThresholdStrategy("design", ["디자인"], 2);

      // "버그 오류 에러 다른내용 또다른" → 5토큰
      // bugfix: 3개 exact(+3.0), 3.0/5=0.6 → primary
      // design: 0, 0.0 < 0.25 → secondary 미선정
      const result = classify("버그 오류 에러 다른내용 또다른", [bugfix, design], new Map());

      assert.equal(result.matched, true);
      assert.ok(result.primary !== null);
      assert.equal(result.secondary, null, "2위 score < 0.25 → secondary=null");
    });
  });

  // --- REQ-149: classifier step cap 테스트 ---

  describe("classifier step cap (REQ-149)", () => {
    function makeStrategyWithSteps(name, triggerPattern, steps) {
      return {
        record: { recordId: `rec_topic_${name}` },
        content: {
          name,
          trigger_pattern: triggerPattern,
          recall_sequence: Array.from({ length: steps }, (_, i) => ({
            step: i + 1,
            query_template: "{task_keywords}",
            type_filter: null
          })),
          effectiveness_score: 0.0
        }
      };
    }

    it("primary 3 steps + secondary 3 steps = 6 > 5 → secondary=null", () => {
      const bugfix = makeStrategyWithSteps("bugfix", ["버그", "오류", "에러", "fix"], 3);
      const design = makeStrategyWithSteps("design", ["디자인", "ui", "css"], 3);

      // "버그 오류 디자인 ui 수정" → 5토큰
      // bugfix: 2.0/5=0.4 → primary (3 steps)
      // design: 2.0/5=0.4 → secondary 후보 (3 steps) → 합계 6 > 5 → null
      const result = classify("버그 오류 디자인 ui 수정", [bugfix, design], new Map());

      assert.equal(result.matched, true, "primary 매칭됨");
      assert.ok(result.primary !== null, "primary 존재");
      assert.equal(result.secondary, null, "step 합계 6 > 5 → secondary=null");
    });

    it("primary 3 steps + secondary 2 steps = 5 ≤ 5 → secondary 허용", () => {
      const bugfix = makeStrategyWithSteps("bugfix", ["버그", "오류", "에러", "fix"], 3);
      const design = makeStrategyWithSteps("design", ["디자인", "ui", "css"], 2);

      // "버그 오류 디자인 ui 수정" → 5토큰
      // bugfix: 2.0/5=0.4 → primary (3 steps)
      // design: 2.0/5=0.4 → secondary 후보 (2 steps) → 합계 5 ≤ 5 → 허용
      const result = classify("버그 오류 디자인 ui 수정", [bugfix, design], new Map());

      assert.equal(result.matched, true);
      assert.ok(result.primary !== null, "primary 존재");
      assert.ok(result.secondary !== null, "step 합계 5 ≤ 5 → secondary 허용");
    });

    it("primary 4 steps + secondary 2 steps = 6 > 5 → secondary=null", () => {
      const bugfix = makeStrategyWithSteps("bugfix", ["버그", "오류", "에러"], 4);
      const design = makeStrategyWithSteps("design", ["디자인", "ui"], 2);

      // "버그 오류 에러 디자인 ui" → 5토큰
      // bugfix: 3.0/5=0.6 → primary (4 steps)
      // design: 2.0/5=0.4 → secondary 후보 (2 steps) → 합계 6 > 5 → null
      const result = classify("버그 오류 에러 디자인 ui", [bugfix, design], new Map());

      assert.equal(result.matched, true);
      assert.ok(result.primary !== null);
      assert.equal(result.secondary, null, "primary 4 steps + secondary 2 steps = 6 > 5");
    });
  });

  // --- REQ-150: classifier edge case 테스트 ---

  describe("classifier edge cases (REQ-150)", () => {
    it("빈 메시지 — messageTokenCount=0 → 즉시 fallback 반환", () => {
      const strategy = {
        record: { recordId: "rec_topic_bugfix" },
        content: {
          name: "bugfix",
          trigger_pattern: ["버그"],
          recall_sequence: [{ step: 1, query_template: "{task_keywords}", type_filter: null }],
          effectiveness_score: 0.0
        }
      };
      const result = classify("", [strategy], new Map());

      assert.equal(result.matched, false, "빈 메시지 → matched=false");
      assert.equal(result.fallback, true, "빈 메시지 → fallback=true");
      assert.equal(result.primary, null);
      assert.equal(result.secondary, null);
    });

    it("공백만 있는 메시지 — 유효 토큰 없음 → fallback", () => {
      const strategy = {
        record: { recordId: "rec_topic_bugfix" },
        content: {
          name: "bugfix",
          trigger_pattern: ["버그"],
          recall_sequence: [{ step: 1, query_template: "{task_keywords}", type_filter: null }],
          effectiveness_score: 0.0
        }
      };
      const result = classify("   ", [strategy], new Map());

      assert.equal(result.fallback, true, "공백만 → fallback");
    });

    it("1자 토큰만 있는 메시지 — filter 후 빈 배열 → fallback", () => {
      const strategy = {
        record: { recordId: "rec_topic_bugfix" },
        content: {
          name: "bugfix",
          trigger_pattern: ["버그"],
          recall_sequence: [{ step: 1, query_template: "{task_keywords}", type_filter: null }],
          effectiveness_score: 0.0
        }
      };
      const result = classify("a b c", [strategy], new Map());

      assert.equal(result.fallback, true, "1자 토큰만 → fallback");
    });

    it("전략 0개 — strategies=[] → fallback", () => {
      const result = classify("버그 오류 수정해줘", [], new Map());

      assert.equal(result.matched, false, "전략 없음 → matched=false");
      assert.equal(result.fallback, true, "전략 없음 → fallback=true");
      assert.equal(result.primary, null);
      assert.equal(result.secondary, null);
    });

    it("전략 있지만 trigger_pattern 빈 배열 — 매칭 점수 0 → fallback", () => {
      const strategy = {
        record: { recordId: "rec_topic_empty" },
        content: {
          name: "empty_strategy",
          trigger_pattern: [],
          recall_sequence: [{ step: 1, query_template: "{task_keywords}", type_filter: null }],
          effectiveness_score: 0.0
        }
      };
      const result = classify("버그 수정", [strategy], new Map());

      assert.equal(result.matched, false, "빈 trigger → 모든 score=0 → fallback");
      assert.equal(result.fallback, true);
    });
  });
});
