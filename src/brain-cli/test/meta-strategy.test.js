"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { RECORD_TYPES, validateRecord } = require("../src/schemas");
const { writeJsonl } = require("../src/utils");
const {
  loadMetaStrategies,
  getSeedStrategies,
  getMetaStrategySourceRef,
  getMetaStrategyContentPath,
  updateEffectivenessScore,
  META_STRATEGY_SCOPE_TYPE,
  META_STRATEGY_SCOPE_ID,
  SEED_STRATEGIES
} = require("../src/meta-strategy");

let testRoot;

function createTestBrain(opts = {}) {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-meta-strategy-test-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.mkdirSync(path.join(testRoot, "30_topics", "meta_strategies"), { recursive: true });

  // tags.json (동의어 맵 — search에 필요)
  fs.writeFileSync(
    path.join(testRoot, "90_index", "tags.json"),
    JSON.stringify({ domain: { synonyms: {} }, intent: { synonyms: {} } }),
    "utf-8"
  );

  const digestLines = ["# Brain records_digest.txt"];
  const records = [];

  if (opts.withDesignStrategy) {
    digestLines.push(
      "rec_topic_meta_strategies_20260301_0001 | design 전략 | 디자인 관련 전략 | domain/memory,intent/retrieval | active | meta_strategy | candidate | 2026-03-01T00:00:00"
    );
    records.push({
      recordId: "rec_topic_meta_strategies_20260301_0001",
      scopeType: "topic",
      scopeId: "meta_strategies",
      type: "meta_strategy",
      title: "design 전략",
      summary: "디자인 관련 전략",
      tags: ["domain/memory", "intent/retrieval"],
      sourceType: "candidate",
      sourceRef: "30_topics/meta_strategies/design.json",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00",
      contentHash: "sha256:aaa111"
    });

    // content JSON 파일 생성
    const designContent = {
      name: "design",
      trigger_pattern: ["디자인", "UI", "CSS"],
      recall_sequence: [
        { step: 1, query_template: "이사님 디자인 선호", type_filter: "note" },
        { step: 2, query_template: "{task_keywords}", type_filter: null }
      ],
      priority_fields: ["sourceType=user_confirmed"],
      effectiveness_score: 0.0
    };
    fs.writeFileSync(
      path.join(testRoot, "30_topics", "meta_strategies", "design.json"),
      JSON.stringify(designContent),
      "utf-8"
    );
  }

  if (opts.withBugfixStrategy) {
    digestLines.push(
      "rec_topic_meta_strategies_20260301_0002 | bugfix 전략 | 버그수정 관련 전략 | domain/memory,intent/retrieval | active | meta_strategy | candidate | 2026-03-01T00:00:00"
    );
    records.push({
      recordId: "rec_topic_meta_strategies_20260301_0002",
      scopeType: "topic",
      scopeId: "meta_strategies",
      type: "meta_strategy",
      title: "bugfix 전략",
      summary: "버그수정 관련 전략",
      tags: ["domain/memory", "intent/retrieval"],
      sourceType: "candidate",
      sourceRef: "30_topics/meta_strategies/bugfix.json",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00",
      contentHash: "sha256:bbb222"
    });
  }

  if (opts.withMissingContent) {
    digestLines.push(
      "rec_topic_meta_strategies_20260301_0003 | missing 전략 | 파일 없는 전략 | domain/memory | active | meta_strategy | candidate | 2026-03-01T00:00:00"
    );
    records.push({
      recordId: "rec_topic_meta_strategies_20260301_0003",
      scopeType: "topic",
      scopeId: "meta_strategies",
      type: "meta_strategy",
      title: "missing 전략",
      summary: "파일 없는 전략",
      tags: ["domain/memory"],
      sourceType: "candidate",
      sourceRef: "30_topics/meta_strategies/missing.json",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00",
      contentHash: "sha256:ccc333"
    });
    // content 파일은 의도적으로 생성하지 않음
  }

  if (opts.withInvalidJson) {
    digestLines.push(
      "rec_topic_meta_strategies_20260301_0004 | invalid 전략 | JSON 깨진 전략 | domain/memory | active | meta_strategy | candidate | 2026-03-01T00:00:00"
    );
    records.push({
      recordId: "rec_topic_meta_strategies_20260301_0004",
      scopeType: "topic",
      scopeId: "meta_strategies",
      type: "meta_strategy",
      title: "invalid 전략",
      summary: "JSON 깨진 전략",
      tags: ["domain/memory"],
      sourceType: "candidate",
      sourceRef: "30_topics/meta_strategies/invalid.json",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00",
      contentHash: "sha256:ddd444"
    });
    // 잘못된 JSON 파일 생성
    fs.writeFileSync(
      path.join(testRoot, "30_topics", "meta_strategies", "invalid.json"),
      "{ not valid json !!!",
      "utf-8"
    );
  }

  fs.writeFileSync(
    path.join(testRoot, "90_index", "records_digest.txt"),
    digestLines.join("\n") + "\n",
    "utf-8"
  );
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), records);

  return testRoot;
}

function teardownBrain() {
  if (testRoot && fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
  testRoot = null;
}

// --- REQ-100: RECORD_TYPES에 "meta_strategy" 추가 ---

describe("REQ-100: RECORD_TYPES에 meta_strategy 추가", () => {
  it("RECORD_TYPES에 meta_strategy가 포함되어야 한다", () => {
    assert.ok(RECORD_TYPES.includes("meta_strategy"));
  });

  it("기존 9개 타입이 모두 포함되어야 한다", () => {
    const expected = ["rule", "decision", "profile", "log", "ref", "note", "candidate", "reminder", "project_state"];
    for (const t of expected) {
      assert.ok(RECORD_TYPES.includes(t), `${t}가 RECORD_TYPES에 없음`);
    }
  });

  it("RECORD_TYPES 길이가 10이어야 한다", () => {
    assert.equal(RECORD_TYPES.length, 10);
  });
});

// --- REQ-101: meta_strategy 레코드 14필드 스키마 준수 ---

describe("REQ-101: meta_strategy 레코드 스키마 검증", () => {
  it("validateRecord()가 meta_strategy 타입 레코드를 유효한 것으로 판정해야 한다", () => {
    const record = {
      recordId: "rec_topic_meta_strategies_20260301_0001",
      scopeType: "topic",
      scopeId: "meta_strategies",
      type: "meta_strategy",
      title: "design 전략",
      summary: "디자인 관련 전략",
      tags: ["domain/memory", "intent/retrieval"],
      sourceType: "candidate",
      sourceRef: "30_topics/meta_strategies/design.json",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00",
      contentHash: "sha256:aaa111"
    };
    const result = validateRecord(record);
    assert.ok(result.valid, `검증 실패: ${result.errors.join(", ")}`);
  });
});

// --- REQ-102: content JSON 구조 ---

describe("REQ-102: content JSON 구조", () => {
  it("유효한 content JSON이 필수 필드를 포함해야 한다", () => {
    const content = {
      name: "design",
      trigger_pattern: ["디자인", "UI"],
      recall_sequence: [
        { step: 1, query_template: "{task_keywords}", type_filter: null }
      ],
      effectiveness_score: 0.0
    };
    assert.ok(typeof content.name === "string");
    assert.ok(Array.isArray(content.trigger_pattern));
    assert.ok(Array.isArray(content.recall_sequence));
    assert.equal(typeof content.effectiveness_score, "number");
  });

  it("recall_sequence step이 step/query_template/type_filter를 포함해야 한다", () => {
    const step = { step: 1, query_template: "{task_keywords}", type_filter: null };
    assert.ok("step" in step);
    assert.ok("query_template" in step);
    assert.ok("type_filter" in step);
  });
});

// --- REQ-103: loadMetaStrategies ---

describe("REQ-103: loadMetaStrategies", () => {
  after(() => teardownBrain());

  it("meta_strategy 레코드를 검색하고 content를 로드해야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const result = loadMetaStrategies(testRoot);

    assert.equal(result.strategies.length, 1);
    assert.equal(result.strategies[0].content.name, "design");
    assert.ok(result.strategies[0].record.recordId.includes("meta_strategies"));
    assert.deepEqual(result.warnings, []);
    teardownBrain();
  });

  it("meta_strategy 레코드가 없으면 빈 배열을 반환해야 한다", () => {
    createTestBrain({});
    const result = loadMetaStrategies(testRoot);

    assert.equal(result.strategies.length, 0);
    assert.deepEqual(result.warnings, []);
    teardownBrain();
  });
});

// --- REQ-104: content 파일 오류 시 skip + warning ---

describe("REQ-104: content 파일 오류 시 skip + warning", () => {
  after(() => teardownBrain());

  it("sourceRef 파일이 없으면 skip하고 warning을 추가해야 한다", () => {
    createTestBrain({ withMissingContent: true });
    const result = loadMetaStrategies(testRoot);

    assert.equal(result.strategies.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes("[SKIP]"));
    teardownBrain();
  });

  it("JSON 파싱 실패 시 skip하고 warning을 추가해야 한다", () => {
    createTestBrain({ withInvalidJson: true });
    const result = loadMetaStrategies(testRoot);

    assert.equal(result.strategies.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes("[SKIP]"));
    teardownBrain();
  });

  it("유효 1개 + 오류 1개 혼재 시 유효한 전략만 반환해야 한다", () => {
    createTestBrain({ withDesignStrategy: true, withMissingContent: true });
    const result = loadMetaStrategies(testRoot);

    assert.equal(result.strategies.length, 1);
    assert.equal(result.strategies[0].content.name, "design");
    assert.equal(result.warnings.length, 1);
    teardownBrain();
  });
});

// --- REQ-105: loadMetaStrategies 반환 구조 ---

describe("REQ-105: loadMetaStrategies 반환 구조", () => {
  after(() => teardownBrain());

  it("반환 객체가 strategies, warnings 키를 가져야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const result = loadMetaStrategies(testRoot);

    assert.ok("strategies" in result);
    assert.ok("warnings" in result);
    assert.ok(Array.isArray(result.strategies));
    assert.ok(Array.isArray(result.warnings));
    teardownBrain();
  });

  it("strategies 각 원소가 record, content 키를 가져야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const result = loadMetaStrategies(testRoot);

    for (const s of result.strategies) {
      assert.ok("record" in s);
      assert.ok("content" in s);
    }
    teardownBrain();
  });

  it("warnings가 문자열 배열이어야 한다", () => {
    createTestBrain({ withMissingContent: true });
    const result = loadMetaStrategies(testRoot);

    for (const w of result.warnings) {
      assert.equal(typeof w, "string");
    }
    teardownBrain();
  });
});

// --- REQ-106: 5개 seed 전략 상수 ---

describe("REQ-106: SEED_STRATEGIES 상수", () => {
  it("SEED_STRATEGIES 배열의 길이가 5여야 한다", () => {
    assert.equal(SEED_STRATEGIES.length, 5);
  });

  it("각 전략이 필수 필드를 가져야 한다", () => {
    const requiredFields = ["name", "trigger_pattern", "recall_sequence", "effectiveness_score"];
    for (const s of SEED_STRATEGIES) {
      for (const field of requiredFields) {
        assert.ok(field in s, `${s.name}에 ${field} 필드 없음`);
      }
    }
  });

  it("5개 전략 이름이 올바라야 한다", () => {
    const names = SEED_STRATEGIES.map(s => s.name);
    assert.deepEqual(names, ["design", "bugfix", "decision", "new_feature", "review"]);
  });

  it("각 전략의 trigger_pattern이 비어있지 않아야 한다", () => {
    for (const s of SEED_STRATEGIES) {
      assert.ok(s.trigger_pattern.length > 0, `${s.name}의 trigger_pattern이 비어있음`);
    }
  });

  it("각 전략의 recall_sequence가 비어있지 않아야 한다", () => {
    for (const s of SEED_STRATEGIES) {
      assert.ok(s.recall_sequence.length > 0, `${s.name}의 recall_sequence가 비어있음`);
    }
  });
});

// --- REQ-107: {task_keywords} step 포함 의무 ---

describe("REQ-107: {task_keywords} step 포함 의무", () => {
  it("모든 seed 전략에 {task_keywords} step이 1개 이상 있어야 한다", () => {
    for (const s of SEED_STRATEGIES) {
      const hasTaskKeywords = s.recall_sequence.some(
        step => step.query_template === "{task_keywords}"
      );
      assert.ok(hasTaskKeywords, `${s.name}에 {task_keywords} step이 없음`);
    }
  });
});

// --- REQ-108: getSeedStrategies ---

describe("REQ-108: getSeedStrategies", () => {
  it("반환 배열의 길이가 5여야 한다", () => {
    const seeds = getSeedStrategies();
    assert.equal(seeds.length, 5);
  });

  it("반환 배열이 원본과 별개 참조여야 한다 (깊은 복사)", () => {
    const seeds = getSeedStrategies();
    assert.notEqual(seeds, SEED_STRATEGIES);
    assert.notEqual(seeds[0], SEED_STRATEGIES[0]);
    assert.notEqual(seeds[0].trigger_pattern, SEED_STRATEGIES[0].trigger_pattern);
    assert.notEqual(seeds[0].recall_sequence, SEED_STRATEGIES[0].recall_sequence);
    assert.notEqual(seeds[0].recall_sequence[0], SEED_STRATEGIES[0].recall_sequence[0]);
  });

  it("반환 배열 수정 시 원본이 변하지 않아야 한다", () => {
    const seeds = getSeedStrategies();
    seeds[0].name = "modified";
    seeds[0].trigger_pattern.push("new_trigger");
    seeds[0].recall_sequence.push({ step: 99, query_template: "test", type_filter: null });

    assert.equal(SEED_STRATEGIES[0].name, "design");
    assert.ok(!SEED_STRATEGIES[0].trigger_pattern.includes("new_trigger"));
    assert.ok(!SEED_STRATEGIES[0].recall_sequence.some(s => s.step === 99));
  });
});

// --- REQ-109: 저장 경로 규칙 ---

describe("REQ-109: 저장 경로 규칙", () => {
  it("META_STRATEGY_SCOPE_TYPE이 topic이어야 한다", () => {
    assert.equal(META_STRATEGY_SCOPE_TYPE, "topic");
  });

  it("META_STRATEGY_SCOPE_ID가 meta_strategies여야 한다", () => {
    assert.equal(META_STRATEGY_SCOPE_ID, "meta_strategies");
  });

  it("getMetaStrategySourceRef가 올바른 경로를 반환해야 한다", () => {
    assert.equal(
      getMetaStrategySourceRef("design"),
      "30_topics/meta_strategies/design.json"
    );
    assert.equal(
      getMetaStrategySourceRef("bugfix"),
      "30_topics/meta_strategies/bugfix.json"
    );
  });

  it("getMetaStrategyContentPath가 절대 경로를 반환해야 한다", () => {
    const result = getMetaStrategyContentPath("/fake/brain", "design");
    assert.ok(result.includes("30_topics"));
    assert.ok(result.includes("meta_strategies"));
    assert.ok(result.includes("design.json"));
  });
});

// ====================================================================
// B08 EffectivenessTracking Tests (REQ-135 ~ REQ-140)
// ====================================================================

// --- REQ-135: updateEffectivenessScore 기본 동작 ---

describe("REQ-135: updateEffectivenessScore 기본 동작", () => {
  after(() => teardownBrain());

  it("content JSON의 effectiveness_score에 delta를 더해야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const result = updateEffectivenessScore(testRoot, "design", 0.1);

    assert.equal(result.success, true);
    assert.equal(result.newScore, 0.1);

    // 파일에도 반영 확인
    const raw = fs.readFileSync(
      path.join(testRoot, "30_topics", "meta_strategies", "design.json"), "utf8"
    );
    const content = JSON.parse(raw);
    assert.equal(content.effectiveness_score, 0.1);
    teardownBrain();
  });

  it("음수 delta(-0.2)를 적용해야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const result = updateEffectivenessScore(testRoot, "design", -0.2);

    assert.equal(result.success, true);
    assert.equal(result.newScore, -0.2);
    teardownBrain();
  });

  it("연속 갱신이 누적되어야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    updateEffectivenessScore(testRoot, "design", 0.1);
    updateEffectivenessScore(testRoot, "design", 0.1);
    const result = updateEffectivenessScore(testRoot, "design", 0.1);

    assert.ok(Math.abs(result.newScore - 0.3) < 0.0001);
    teardownBrain();
  });

  it("effectiveness_score 필드가 없으면 0.0에서 시작해야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    // effectiveness_score 필드 제거
    const contentPath = path.join(testRoot, "30_topics", "meta_strategies", "design.json");
    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
    delete content.effectiveness_score;
    fs.writeFileSync(contentPath, JSON.stringify(content), "utf8");

    const result = updateEffectivenessScore(testRoot, "design", 0.1);
    assert.equal(result.success, true);
    assert.equal(result.newScore, 0.1);
    teardownBrain();
  });
});

// --- REQ-136: delta 상수 (positive: +0.1, negative: -0.2) ---

describe("REQ-136: delta 상수", () => {
  after(() => teardownBrain());

  it("positive delta +0.1 적용 시 0.0 → 0.1", () => {
    createTestBrain({ withDesignStrategy: true });
    const result = updateEffectivenessScore(testRoot, "design", 0.1);
    assert.equal(result.newScore, 0.1);
    teardownBrain();
  });

  it("negative delta -0.2 적용 시 0.0 → -0.2", () => {
    createTestBrain({ withDesignStrategy: true });
    const result = updateEffectivenessScore(testRoot, "design", -0.2);
    assert.equal(result.newScore, -0.2);
    teardownBrain();
  });
});

// --- REQ-137: 클램핑 -1.0 ~ 1.0 ---

describe("REQ-137: score 클램핑 -1.0 ~ 1.0", () => {
  after(() => teardownBrain());

  it("score가 1.0을 초과하면 1.0으로 클램핑해야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    // 초기값을 0.95로 설정
    const contentPath = path.join(testRoot, "30_topics", "meta_strategies", "design.json");
    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
    content.effectiveness_score = 0.95;
    fs.writeFileSync(contentPath, JSON.stringify(content), "utf8");

    const result = updateEffectivenessScore(testRoot, "design", 0.1);
    assert.equal(result.newScore, 1.0);
    teardownBrain();
  });

  it("score가 -1.0 미만이면 -1.0으로 클램핑해야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const contentPath = path.join(testRoot, "30_topics", "meta_strategies", "design.json");
    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
    content.effectiveness_score = -0.9;
    fs.writeFileSync(contentPath, JSON.stringify(content), "utf8");

    const result = updateEffectivenessScore(testRoot, "design", -0.2);
    assert.equal(result.newScore, -1.0);
    teardownBrain();
  });

  it("정확히 1.0인 상태에서 +0.1을 더해도 1.0이어야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const contentPath = path.join(testRoot, "30_topics", "meta_strategies", "design.json");
    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
    content.effectiveness_score = 1.0;
    fs.writeFileSync(contentPath, JSON.stringify(content), "utf8");

    const result = updateEffectivenessScore(testRoot, "design", 0.1);
    assert.equal(result.newScore, 1.0);
    teardownBrain();
  });
});

// --- REQ-138: score > 0.8 → 승격 알림 ---

describe("REQ-138: score > 0.8 → 승격 알림", () => {
  after(() => teardownBrain());

  it("score가 0.8 초과이면 승격 메시지를 반환해야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const contentPath = path.join(testRoot, "30_topics", "meta_strategies", "design.json");
    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
    content.effectiveness_score = 0.75;
    fs.writeFileSync(contentPath, JSON.stringify(content), "utf8");

    const result = updateEffectivenessScore(testRoot, "design", 0.1);
    assert.ok(Math.abs(result.newScore - 0.85) < 0.0001);
    assert.ok(result.message !== null);
    assert.ok(result.message.includes("검증 완료"));
    teardownBrain();
  });

  it("score가 정확히 0.8이면 승격 메시지가 없어야 한다 (> 0.8 조건)", () => {
    createTestBrain({ withDesignStrategy: true });
    const contentPath = path.join(testRoot, "30_topics", "meta_strategies", "design.json");
    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
    content.effectiveness_score = 0.7;
    fs.writeFileSync(contentPath, JSON.stringify(content), "utf8");

    const result = updateEffectivenessScore(testRoot, "design", 0.1);
    assert.ok(Math.abs(result.newScore - 0.8) < 0.0001);
    assert.equal(result.message, null);
    teardownBrain();
  });
});

// --- REQ-139: score < -0.5 → 강등 경고 ---

describe("REQ-139: score < -0.5 → 강등 경고", () => {
  after(() => teardownBrain());

  it("score가 -0.5 미만이면 강등 경고를 반환해야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const contentPath = path.join(testRoot, "30_topics", "meta_strategies", "design.json");
    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
    content.effectiveness_score = -0.4;
    fs.writeFileSync(contentPath, JSON.stringify(content), "utf8");

    const result = updateEffectivenessScore(testRoot, "design", -0.2);
    assert.ok(Math.abs(result.newScore - (-0.6)) < 0.0001);
    assert.ok(result.message !== null);
    assert.ok(result.message.includes("재검토 필요"));
    teardownBrain();
  });

  it("score가 정확히 -0.5이면 강등 경고가 없어야 한다 (< -0.5 조건)", () => {
    createTestBrain({ withDesignStrategy: true });
    const contentPath = path.join(testRoot, "30_topics", "meta_strategies", "design.json");
    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
    content.effectiveness_score = -0.3;
    fs.writeFileSync(contentPath, JSON.stringify(content), "utf8");

    const result = updateEffectivenessScore(testRoot, "design", -0.2);
    assert.ok(Math.abs(result.newScore - (-0.5)) < 0.0001);
    assert.equal(result.message, null);
    teardownBrain();
  });
});

// --- REQ-140: 반환 구조 { success, newScore, message } ---

describe("REQ-140: 반환 구조 { success, newScore, message }", () => {
  after(() => teardownBrain());

  it("성공 시 success=true, newScore=숫자, message 반환해야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const result = updateEffectivenessScore(testRoot, "design", 0.1);

    assert.equal(typeof result.success, "boolean");
    assert.equal(result.success, true);
    assert.equal(typeof result.newScore, "number");
    assert.ok("message" in result);
    teardownBrain();
  });

  it("파일 미존재 시 success=false, newScore=null, message=에러 메시지 반환해야 한다", () => {
    createTestBrain({});
    const result = updateEffectivenessScore(testRoot, "nonexistent", 0.1);

    assert.equal(result.success, false);
    assert.equal(result.newScore, null);
    assert.ok(typeof result.message === "string");
    assert.ok(result.message.length > 0);
    teardownBrain();
  });

  it("중간 범위 score에서 message=null이어야 한다", () => {
    createTestBrain({ withDesignStrategy: true });
    const result = updateEffectivenessScore(testRoot, "design", 0.1);

    assert.equal(result.message, null);
    teardownBrain();
  });
});

// ====================================================================
// [B09] Phase2Tests — meta-strategy.test.js
// REQ: REQ-155 ~ REQ-158
// Ref: TEST-UT-META-STRATEGY
// Depends On: B05(MetaStrategySchema), B08(EffectivenessTracking)
// ====================================================================

// --- B09 전용 픽스처 함수 ---

function _b09CreateLoadTestBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-b09-load-"));
  const indexDir = path.join(tmpDir, "90_index");
  const topicsDir = path.join(tmpDir, "30_topics", "meta_strategies");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(topicsDir, { recursive: true });

  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: {} }, intent: { synonyms: {} }
  }));

  const now = new Date().toISOString();
  const bugfixContent = {
    name: "bugfix",
    trigger_pattern: ["버그", "오류", "에러"],
    recall_sequence: [
      { step: 1, query_template: "유사 버그 기록", type_filter: "note" },
      { step: 2, query_template: "{task_keywords}", type_filter: null }
    ],
    effectiveness_score: 0.0
  };
  fs.writeFileSync(path.join(topicsDir, "bugfix.json"), JSON.stringify(bugfixContent, null, 2));

  const digestLines = [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `rec_topic_meta_bugfix | bugfix 전략 | 버그 전략 | domain/memory | active | meta_strategy | candidate | ${now}`
  ].join("\n");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);

  const records = [{
    recordId: "rec_topic_meta_bugfix", scopeType: "topic", scopeId: "meta_strategies",
    type: "meta_strategy", title: "bugfix 전략", summary: "버그 전략", tags: ["domain/memory"],
    status: "active", sourceRef: "30_topics/meta_strategies/bugfix.json",
    sourceType: "candidate", updatedAt: now
  }];
  fs.writeFileSync(
    path.join(indexDir, "records.jsonl"),
    records.map(r => JSON.stringify(r)).join("\n") + "\n"
  );

  return tmpDir;
}

function _b09CreateBrainWithMissingContent() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-b09-missing-"));
  const indexDir = path.join(tmpDir, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "30_topics", "meta_strategies"), { recursive: true });

  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: {} }, intent: { synonyms: {} }
  }));

  const now = new Date().toISOString();
  const digestLines = [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `rec_topic_meta_missing | missing 전략 | 없는 전략 | domain/memory | active | meta_strategy | candidate | ${now}`
  ].join("\n");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);

  const records = [{
    recordId: "rec_topic_meta_missing", scopeType: "topic", scopeId: "meta_strategies",
    type: "meta_strategy", title: "missing 전략", summary: "없는 전략", tags: ["domain/memory"],
    status: "active", sourceRef: "30_topics/meta_strategies/missing_strategy.json",
    sourceType: "candidate", updatedAt: now
  }];
  fs.writeFileSync(
    path.join(indexDir, "records.jsonl"),
    records.map(r => JSON.stringify(r)).join("\n") + "\n"
  );
  return tmpDir;
}

function _b09CreateBrainWithInvalidJson() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-b09-invalid-"));
  const indexDir = path.join(tmpDir, "90_index");
  const topicsDir = path.join(tmpDir, "30_topics", "meta_strategies");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(topicsDir, { recursive: true });

  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: {} }, intent: { synonyms: {} }
  }));
  fs.writeFileSync(
    path.join(topicsDir, "invalid_json_strategy.json"),
    "{ invalid json content !!!"
  );

  const now = new Date().toISOString();
  const digestLines = [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `rec_topic_meta_invalid | invalid 전략 | 잘못된 JSON | domain/memory | active | meta_strategy | candidate | ${now}`
  ].join("\n");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);

  const records = [{
    recordId: "rec_topic_meta_invalid", scopeType: "topic", scopeId: "meta_strategies",
    type: "meta_strategy", title: "invalid 전략", summary: "잘못된 JSON", tags: ["domain/memory"],
    status: "active", sourceRef: "30_topics/meta_strategies/invalid_json_strategy.json",
    sourceType: "candidate", updatedAt: now
  }];
  fs.writeFileSync(
    path.join(indexDir, "records.jsonl"),
    records.map(r => JSON.stringify(r)).join("\n") + "\n"
  );
  return tmpDir;
}

function _b09CreateMixedBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-b09-mixed-"));
  const indexDir = path.join(tmpDir, "90_index");
  const topicsDir = path.join(tmpDir, "30_topics", "meta_strategies");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(topicsDir, { recursive: true });

  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: {} }, intent: { synonyms: {} }
  }));

  const now = new Date().toISOString();

  // 정상 전략 content 파일
  fs.writeFileSync(path.join(topicsDir, "valid_strategy.json"), JSON.stringify({
    name: "valid_strategy",
    trigger_pattern: ["버그"],
    recall_sequence: [{ step: 1, query_template: "{task_keywords}", type_filter: null }],
    effectiveness_score: 0.0
  }, null, 2));
  // missing_strategy.json은 생성하지 않음 (미존재 전략)

  const digestLines = [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `rec_topic_meta_valid | valid 전략 | 정상 전략 | domain/memory | active | meta_strategy | candidate | ${now}`,
    `rec_topic_meta_missing | missing 전략 | 없는 전략 | domain/memory | active | meta_strategy | candidate | ${now}`
  ].join("\n");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);

  const records = [
    {
      recordId: "rec_topic_meta_valid", scopeType: "topic", scopeId: "meta_strategies",
      type: "meta_strategy", title: "valid 전략", summary: "정상 전략", tags: ["domain/memory"],
      status: "active", sourceRef: "30_topics/meta_strategies/valid_strategy.json",
      sourceType: "candidate", updatedAt: now
    },
    {
      recordId: "rec_topic_meta_missing", scopeType: "topic", scopeId: "meta_strategies",
      type: "meta_strategy", title: "missing 전략", summary: "없는 전략", tags: ["domain/memory"],
      status: "active", sourceRef: "30_topics/meta_strategies/missing_strategy.json",
      sourceType: "candidate", updatedAt: now
    }
  ];
  fs.writeFileSync(
    path.join(indexDir, "records.jsonl"),
    records.map(r => JSON.stringify(r)).join("\n") + "\n"
  );

  return tmpDir;
}

function _b09CreateEffectivenessTestBrain(initialScore = 0.0) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-b09-effectiveness-"));
  const indexDir = path.join(tmpDir, "90_index");
  const topicsDir = path.join(tmpDir, "30_topics", "meta_strategies");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(topicsDir, { recursive: true });

  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: {} }, intent: { synonyms: {} }
  }));

  const content = {
    name: "bugfix",
    trigger_pattern: ["버그"],
    recall_sequence: [{ step: 1, query_template: "{task_keywords}", type_filter: null }],
    effectiveness_score: initialScore
  };
  fs.writeFileSync(path.join(topicsDir, "bugfix.json"), JSON.stringify(content, null, 2));

  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(indexDir, "records_digest.txt"),
    [
      "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
      `rec_topic_meta_bugfix | bugfix | bugfix 전략 | domain/memory | active | meta_strategy | candidate | ${now}`
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(indexDir, "records.jsonl"),
    JSON.stringify({
      recordId: "rec_topic_meta_bugfix", scopeType: "topic", scopeId: "meta_strategies",
      type: "meta_strategy", title: "bugfix", summary: "bugfix 전략", tags: ["domain/memory"],
      status: "active", sourceRef: "30_topics/meta_strategies/bugfix.json",
      sourceType: "candidate", updatedAt: now
    }) + "\n"
  );
  return tmpDir;
}

// --- REQ-155: meta_strategy type 스키마 포함 테스트 ---

describe("B09 meta_strategy 스키마 포함 (REQ-155)", () => {
  it("RECORD_TYPES에 'meta_strategy' 포함", () => {
    assert.ok(
      RECORD_TYPES.includes("meta_strategy"),
      `RECORD_TYPES=${JSON.stringify(RECORD_TYPES)} 에 'meta_strategy' 없음`
    );
  });

  it("RECORD_TYPES가 배열이며 기존 타입도 포함 (하위 호환)", () => {
    assert.ok(Array.isArray(RECORD_TYPES), "배열 타입");
    const existingTypes = ["rule", "decision", "note", "profile", "log", "ref"];
    for (const t of existingTypes) {
      assert.ok(RECORD_TYPES.includes(t), `기존 타입 '${t}' 유지됨`);
    }
  });
});

// --- REQ-156: loadMetaStrategies 정상 로딩 테스트 ---

describe("B09 loadMetaStrategies 정상 로딩 (REQ-156)", () => {
  let b09LoadBrain;

  before(() => {
    b09LoadBrain = _b09CreateLoadTestBrain();
  });

  after(() => {
    fs.rmSync(b09LoadBrain, { recursive: true, force: true });
  });

  it("정상 JSON 파일 → { strategies, warnings } 반환", () => {
    const result = loadMetaStrategies(b09LoadBrain);

    assert.ok("strategies" in result, "strategies 키 존재");
    assert.ok("warnings" in result, "warnings 키 존재");
    assert.ok(Array.isArray(result.strategies), "strategies 배열");
    assert.ok(Array.isArray(result.warnings), "warnings 배열");
  });

  it("전략 객체 구조 검증 — record + content 포함", () => {
    const result = loadMetaStrategies(b09LoadBrain);

    assert.ok(result.strategies.length > 0, "최소 1개 이상 전략 로드");

    const strategy = result.strategies[0];
    assert.ok("record" in strategy, "record 포함");
    assert.ok("content" in strategy, "content 포함");
    assert.ok(typeof strategy.content.name === "string", "content.name 문자열");
    assert.ok(Array.isArray(strategy.content.trigger_pattern), "trigger_pattern 배열");
    assert.ok(Array.isArray(strategy.content.recall_sequence), "recall_sequence 배열");
    assert.ok(typeof strategy.content.effectiveness_score === "number", "effectiveness_score 숫자");
  });

  it("content.recall_sequence 각 step 구조 검증", () => {
    const result = loadMetaStrategies(b09LoadBrain);
    const strategy = result.strategies[0];

    for (const step of strategy.content.recall_sequence) {
      assert.ok(typeof step.step === "number", "step.step 숫자");
      assert.ok(typeof step.query_template === "string", "step.query_template 문자열");
      assert.ok("type_filter" in step, "step.type_filter 키 존재");
    }
  });

  it("정상 로딩 시 warnings 배열이 비어있음", () => {
    const result = loadMetaStrategies(b09LoadBrain);
    assert.equal(result.warnings.length, 0, "정상 로딩 → warnings 없음");
  });
});

// --- REQ-157: loadMetaStrategies 파일 미존재 skip + warning 테스트 ---

describe("B09 loadMetaStrategies 파일 미존재 skip (REQ-157)", () => {

  it("content 파일 미존재 → 해당 전략 skip, warnings에 추가", () => {
    const brainRoot = _b09CreateBrainWithMissingContent();

    try {
      const result = loadMetaStrategies(brainRoot);

      const missingStrategy = result.strategies.find(
        s => s.content.name === "missing_strategy"
      );
      assert.equal(missingStrategy, undefined, "미존재 파일 전략은 skip됨");

      assert.ok(result.warnings.length > 0, "warnings에 경고 추가됨");
      assert.ok(
        result.warnings.some(w => w.includes("missing_strategy") || w.includes("missing")),
        `warnings에 관련 정보 포함: ${JSON.stringify(result.warnings)}`
      );
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("JSON 파싱 실패 → 해당 전략 skip, 로딩 중단 없음", () => {
    const brainRoot = _b09CreateBrainWithInvalidJson();

    try {
      const result = loadMetaStrategies(brainRoot);

      const invalidStrategy = result.strategies.find(
        s => s.content && s.content.name === "invalid_json_strategy"
      );
      assert.equal(invalidStrategy, undefined, "JSON 파싱 실패 전략 skip됨");

      assert.ok(result.warnings.length > 0, "JSON 파싱 실패 → warnings 추가");
      assert.ok(Array.isArray(result.strategies), "strategies 배열 정상 반환");
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("정상 전략 + 미존재 파일 전략 혼합 → 정상 전략만 로드, 미존재는 skip", () => {
    const brainRoot = _b09CreateMixedBrain();

    try {
      const result = loadMetaStrategies(brainRoot);

      const validStrategy = result.strategies.find(
        s => s.content.name === "valid_strategy"
      );
      assert.ok(validStrategy !== undefined, "정상 전략 로드됨");

      const missingStrategy = result.strategies.find(
        s => s.content && s.content.name === "missing_strategy"
      );
      assert.equal(missingStrategy, undefined, "미존재 전략 skip됨");

      assert.ok(result.warnings.length > 0, "warnings 존재");
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });
});

// --- REQ-158: effectiveness_score 갱신 테스트 ---

describe("B09 effectiveness_score 갱신 (REQ-158)", () => {

  it("positive delta +0.1 → score가 0.1 증가", () => {
    const brainRoot = _b09CreateEffectivenessTestBrain(0.0);
    try {
      const result = updateEffectivenessScore(brainRoot, "bugfix", +0.1);

      assert.equal(result.success, true, "success=true");
      assert.ok(
        Math.abs(result.newScore - 0.1) < 0.001,
        `newScore=${result.newScore} ≈ 0.1`
      );
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("negative delta -0.2 → score가 0.2 감소", () => {
    const brainRoot = _b09CreateEffectivenessTestBrain(0.0);
    try {
      const result = updateEffectivenessScore(brainRoot, "bugfix", -0.2);

      assert.equal(result.success, true);
      assert.ok(
        Math.abs(result.newScore - (-0.2)) < 0.001,
        `newScore=${result.newScore} ≈ -0.2`
      );
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("score 상한 클램핑 — 0.95 + 0.1 → 1.0 (1.05 아님)", () => {
    const brainRoot = _b09CreateEffectivenessTestBrain(0.95);
    try {
      const result = updateEffectivenessScore(brainRoot, "bugfix", +0.1);

      assert.equal(result.success, true);
      assert.ok(result.newScore <= 1.0, `클램핑 적용: newScore=${result.newScore} <= 1.0`);
      assert.ok(Math.abs(result.newScore - 1.0) < 0.001, `newScore=${result.newScore} ≈ 1.0`);
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("score 하한 클램핑 — -0.9 + (-0.2) → -1.0 (-1.1 아님)", () => {
    const brainRoot = _b09CreateEffectivenessTestBrain(-0.9);
    try {
      const result = updateEffectivenessScore(brainRoot, "bugfix", -0.2);

      assert.equal(result.success, true);
      assert.ok(result.newScore >= -1.0, `클램핑 적용: newScore=${result.newScore} >= -1.0`);
      assert.ok(Math.abs(result.newScore - (-1.0)) < 0.001, `newScore=${result.newScore} ≈ -1.0`);
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("score > 0.8 → message에 'confirmed' 포함", () => {
    const brainRoot = _b09CreateEffectivenessTestBrain(0.75);
    try {
      const result = updateEffectivenessScore(brainRoot, "bugfix", +0.1);

      assert.equal(result.success, true);
      assert.ok(result.newScore > 0.8, `newScore=${result.newScore} > 0.8`);
      assert.ok(
        result.message !== null && result.message.includes("confirmed"),
        `message '${result.message}'에 'confirmed' 포함`
      );
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("score < -0.5 → message에 '재검토' 포함", () => {
    const brainRoot = _b09CreateEffectivenessTestBrain(-0.4);
    try {
      const result = updateEffectivenessScore(brainRoot, "bugfix", -0.2);

      assert.equal(result.success, true);
      assert.ok(result.newScore < -0.5, `newScore=${result.newScore} < -0.5`);
      assert.ok(
        result.message !== null && result.message.includes("재검토"),
        `message '${result.message}'에 '재검토' 포함`
      );
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("갱신 후 content JSON 파일에 반영됨 — 파일 재읽기로 검증", () => {
    const brainRoot = _b09CreateEffectivenessTestBrain(0.0);
    try {
      updateEffectivenessScore(brainRoot, "bugfix", +0.1);

      const contentPath = path.join(brainRoot, "30_topics", "meta_strategies", "bugfix.json");
      const content = JSON.parse(fs.readFileSync(contentPath, "utf-8"));
      assert.ok(
        Math.abs(content.effectiveness_score - 0.1) < 0.001,
        `파일의 effectiveness_score=${content.effectiveness_score} ≈ 0.1`
      );
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("반환 구조 검증 — { success, newScore, message }", () => {
    const brainRoot = _b09CreateEffectivenessTestBrain(0.0);
    try {
      const result = updateEffectivenessScore(brainRoot, "bugfix", +0.1);

      assert.ok("success" in result, "success 키 존재");
      assert.ok("newScore" in result, "newScore 키 존재");
      assert.ok("message" in result, "message 키 존재");
      assert.ok(typeof result.success === "boolean", "success boolean");
      assert.ok(typeof result.newScore === "number", "newScore 숫자");
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });
});
