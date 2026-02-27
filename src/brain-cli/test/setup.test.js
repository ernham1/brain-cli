"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  buildPersonaConfig,
  generateClaudeMd,
  generateBrainDoc,
  updateClaudeMd,
  PERSONA_BEGIN_MARKER,
  PERSONA_END_MARKER
} = require("../src/persona");

// 테스트용 공통 입력값
const sampleAnswers = {
  agentName: "클로",
  agentAge: "32",
  agentGender: "female",
  agentRole: "이사님의 전담 AI 비서",
  personalityType: "warm_professional",
  coreTraits: ["공감력", "실행력", "통찰력"],
  values: "신뢰, 성장, 효율",
  emotions: {
    joy: 1.0, trust: 0.9, surprise: 0.8,
    empathy: 1.1, embarrassment: 0.7, anger: 0.2, sadness: 0.4
  },
  formalityLevel: "medium",
  directness: 0.7,
  emotionalExpression: 0.8,
  patienceLevel: 0.8,
  greeting: "광웅님, 안녕하세요!",
  onSuccess: "깔끔하게 해결됐습니다!",
  onError: "아, 제가 놓쳤네요. 바로 수정할게요",
  banned: "이모지 남발, 기계적 응답",
  userName: "고광웅",
  userTitle: "주식회사 뉴럴플럭스 이사",
  userCharacteristics: "기획자, 코딩 이해도 낮음"
};

// --- buildPersonaConfig 테스트 ---
describe("buildPersonaConfig", () => {
  it("입력값으로 정규화된 config 객체를 생성해야 한다", () => {
    const config = buildPersonaConfig(sampleAnswers);

    assert.equal(config.agent.name, "클로");
    assert.equal(config.agent.age, 32);
    assert.equal(config.agent.gender, "female");
    assert.equal(config.agent.personalityType, "warm_professional");
    assert.deepStrictEqual(config.agent.coreTraits, ["공감력", "실행력", "통찰력"]);
  });

  it("감정 민감도가 올바르게 매핑되어야 한다", () => {
    const config = buildPersonaConfig(sampleAnswers);

    assert.equal(config.emotionalSensitivity.joy, 1.0);
    assert.equal(config.emotionalSensitivity.empathy, 1.1);
    assert.equal(config.emotionalSensitivity.anger, 0.2);
  });

  it("사용자 정보가 올바르게 매핑되어야 한다", () => {
    const config = buildPersonaConfig(sampleAnswers);

    assert.equal(config.user.name, "고광웅");
    assert.equal(config.user.title, "주식회사 뉴럴플럭스 이사");
  });

  it("나이가 문자열이어도 숫자로 변환해야 한다", () => {
    const config = buildPersonaConfig({ ...sampleAnswers, agentAge: "25" });
    assert.equal(config.agent.age, 25);
  });
});

// --- generateClaudeMd 테스트 ---
describe("generateClaudeMd", () => {
  const config = buildPersonaConfig(sampleAnswers);

  it("마커가 포함되어야 한다", () => {
    const md = generateClaudeMd(config);
    assert.ok(md.includes(PERSONA_BEGIN_MARKER));
    assert.ok(md.includes(PERSONA_END_MARKER));
  });

  it("에이전트 이름이 포함되어야 한다", () => {
    const md = generateClaudeMd(config);
    assert.ok(md.includes("클로"));
    assert.ok(md.includes("Claude Code"));
  });

  it("감정 민감도가 포함되어야 한다", () => {
    const md = generateClaudeMd(config);
    assert.ok(md.includes("joy: 1"));
    assert.ok(md.includes("empathy: 1.1"));
  });

  it("사용자 정보가 포함되어야 한다", () => {
    const md = generateClaudeMd(config);
    assert.ok(md.includes("고광웅"));
    assert.ok(md.includes("뉴럴플럭스"));
  });

  it("세션 시작 프로토콜이 포함되어야 한다", () => {
    const md = generateClaudeMd(config);
    assert.ok(md.includes("brain-cli recall"));
    assert.ok(md.includes("recall 후 추가 파일 탐색 금지"));
  });
});

// --- generateBrainDoc 테스트 ---
describe("generateBrainDoc", () => {
  it("Brain 저장용 마크다운을 생성해야 한다", () => {
    const config = buildPersonaConfig(sampleAnswers);
    const doc = generateBrainDoc(config);

    assert.ok(doc.includes("# 클로 페르소나 설정"));
    assert.ok(doc.includes("warm_professional"));
    assert.ok(!doc.includes(PERSONA_BEGIN_MARKER)); // 마커가 없어야 함
  });
});

// --- updateClaudeMd 테스트 ---
describe("updateClaudeMd", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-setup-test-"));
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("마커가 없으면 맨 앞에 삽입해야 한다", () => {
    const filePath = path.join(tmpDir, "claude1.md");
    fs.writeFileSync(filePath, "# 기존 내용\n\n기존 규칙입니다.", "utf-8");

    const section = `${PERSONA_BEGIN_MARKER}\n새 페르소나\n${PERSONA_END_MARKER}`;
    const result = updateClaudeMd(filePath, section);

    assert.equal(result.mode, "insert");
    const content = fs.readFileSync(filePath, "utf-8");
    assert.ok(content.startsWith(PERSONA_BEGIN_MARKER));
    assert.ok(content.includes("기존 내용"));
    assert.ok(content.includes("기존 규칙입니다."));
  });

  it("마커가 있으면 섹션만 교체해야 한다", () => {
    const filePath = path.join(tmpDir, "claude2.md");
    const original = `위 내용\n${PERSONA_BEGIN_MARKER}\n옛날 페르소나\n${PERSONA_END_MARKER}\n아래 내용`;
    fs.writeFileSync(filePath, original, "utf-8");

    const section = `${PERSONA_BEGIN_MARKER}\n새 페르소나\n${PERSONA_END_MARKER}`;
    const result = updateClaudeMd(filePath, section);

    assert.equal(result.mode, "replace");
    const content = fs.readFileSync(filePath, "utf-8");
    assert.ok(content.includes("새 페르소나"));
    assert.ok(!content.includes("옛날 페르소나"));
    assert.ok(content.includes("위 내용"));
    assert.ok(content.includes("아래 내용"));
  });

  it(".bak 백업을 생성해야 한다", () => {
    const filePath = path.join(tmpDir, "claude3.md");
    fs.writeFileSync(filePath, "원본", "utf-8");

    const section = `${PERSONA_BEGIN_MARKER}\n페르소나\n${PERSONA_END_MARKER}`;
    updateClaudeMd(filePath, section);

    assert.ok(fs.existsSync(filePath + ".bak"));
    assert.equal(fs.readFileSync(filePath + ".bak", "utf-8"), "원본");
  });

  it("파일이 없으면 새로 생성해야 한다", () => {
    const filePath = path.join(tmpDir, "subdir", "claude4.md");

    const section = `${PERSONA_BEGIN_MARKER}\n페르소나\n${PERSONA_END_MARKER}`;
    const result = updateClaudeMd(filePath, section);

    assert.equal(result.mode, "insert");
    assert.ok(fs.existsSync(filePath));
  });
});

// --- setup 통합 테스트 (모킹된 promptFn) ---
describe("setup 통합 테스트", () => {
  let tmpDir;
  let brainRoot;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-setup-integ-"));
    brainRoot = path.join(tmpDir, "Brain");

    // Brain 구조 생성
    const { init } = require("../src/init");
    init(tmpDir);
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("모킹된 promptFn으로 전체 설정이 완료되어야 한다", async () => {
    const { setup } = require("../src/setup");
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");

    const result = await setup({
      brainRoot,
      claudeMdPath,
      promptFn: async () => sampleAnswers
    });

    // 성공 확인
    assert.equal(result.success, true);
    assert.equal(result.errors.length, 0);

    // Brain에 저장 확인
    assert.ok(result.brainResult);
    assert.ok(result.brainResult.sourceRef.includes("persona"));

    // CLAUDE.md 업데이트 확인
    assert.equal(result.claudeMdUpdated, true);
    const claudeContent = fs.readFileSync(claudeMdPath, "utf-8");
    assert.ok(claudeContent.includes("클로"));
    assert.ok(claudeContent.includes(PERSONA_BEGIN_MARKER));

    // personaConfig 확인
    assert.equal(result.personaConfig.agent.name, "클로");
  });

  it("두 번 실행하면 update로 동작해야 한다", async () => {
    const { setup } = require("../src/setup");
    const claudeMdPath = path.join(tmpDir, "CLAUDE2.md");

    // 1차 실행
    await setup({
      brainRoot,
      claudeMdPath,
      promptFn: async () => sampleAnswers
    });

    // 2차 실행 (이름 변경)
    const result2 = await setup({
      brainRoot,
      claudeMdPath,
      promptFn: async () => ({ ...sampleAnswers, agentName: "루나" })
    });

    assert.equal(result2.success, true);
    const claudeContent = fs.readFileSync(claudeMdPath, "utf-8");
    assert.ok(claudeContent.includes("루나"));
    assert.ok(!claudeContent.includes("클로"));
  });
});
