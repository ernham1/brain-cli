#!/usr/bin/env node
"use strict";

const { Command } = require("commander");
const path = require("path");
const { BWTEngine } = require("./bwt");
const { validate } = require("./validate");
const { getDefaultBrainRoot } = require("./utils");
const { init } = require("./init");
const { boot } = require("./boot");
const { search, getRecordDetail } = require("./search");

const program = new Command();

program
  .name("brain-cli")
  .description("Brain 장기기억 저장소 CLI")
  .version("1.3.0");

// --- write 명령 (BWT 실행) ---
program
  .command("write")
  .description("BWT(Brain Write Transaction) 실행 — Intent JSON을 받아 Brain에 기록")
  .argument("<intent-json>", "Intent JSON 문자열 또는 파일 경로")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .action((intentArg, options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      // Intent 파싱: 파일 경로 또는 JSON 문자열
      let intent;
      const fs = require("fs");
      if (fs.existsSync(intentArg)) {
        intent = JSON.parse(fs.readFileSync(intentArg, "utf-8"));
      } else {
        intent = JSON.parse(intentArg);
      }

      const engine = new BWTEngine(brainRoot);
      const result = engine.execute(intent);

      if (result.success) {
        console.log("SUCCESS:", JSON.stringify(result.report, null, 2));
      } else {
        console.error("FAILED:", JSON.stringify(result.report, null, 2));
        process.exit(1);
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- validate 명령 ---
program
  .command("validate")
  .description("Brain 인덱스 정합성 검증")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--full", "확장 검증 모드 (B08)")
  .action((options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      const result = validate(brainRoot, { full: options.full || false });

      console.log("=== Brain Validate ===");
      console.log(`결과: ${result.passed ? "PASS" : "FAIL"}`);

      if (result.errors.length > 0) {
        console.log("\nErrors:");
        result.errors.forEach(e => console.log(`  - ${e}`));
      }
      if (result.warnings.length > 0) {
        console.log("\nWarnings:");
        result.warnings.forEach(w => console.log(`  - ${w}`));
      }

      if (!result.passed) process.exit(1);
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- init 명령 ---
program
  .command("init")
  .description("Brain 디렉토리 초기화 (멱등)")
  .option("-d, --dir <path>", "Brain/ 생성 위치 (기본: 현재 디렉토리)", process.cwd())
  .action((options) => {
    try {
      const result = init(options.dir);
      console.log("=== Brain Init ===");
      console.log(`Brain 경로: ${result.brainRoot}`);
      if (result.created.length > 0) {
        console.log(`\n생성됨 (${result.created.length}):`);
        result.created.forEach(f => console.log(`  + ${f}`));
      }
      if (result.skipped.length > 0) {
        console.log(`\n스킵됨 (${result.skipped.length}):`);
        result.skipped.forEach(f => console.log(`  - ${f}`));
      }
      console.log("\n초기화 완료.");
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- boot 명령 ---
program
  .command("boot")
  .description("Brain 부트 시퀀스 실행")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--scope-type <type>", "스코프 타입")
  .option("--scope-id <id>", "스코프 ID")
  .action((options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다.");
        process.exit(1);
      }

      const result = boot(brainRoot, {
        scopeType: options.scopeType,
        scopeId: options.scopeId
      });

      console.log("=== Brain Boot ===");
      console.log(`결과: ${result.success ? "SUCCESS" : "FAIL"}`);

      if (result.mismatches && result.mismatches.length > 0) {
        console.log(`\n수동 변경 감지 (${result.mismatches.length}건):`);
        result.mismatches.forEach(m => console.log(`  - ${m.path}: ${m.reason}`));
        console.log("\n인덱스 동기화가 필요합니다.");
      }

      if (!result.success) {
        console.error(result.error);
        process.exit(1);
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- search 명령 ---
program
  .command("search")
  .description("Brain 인덱스 검색")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--scope-type <type>", "스코프 타입")
  .option("--scope-id <id>", "스코프 ID")
  .option("-g, --goal <text>", "검색 목표 텍스트")
  .option("-k, --top-k <number>", "상위 N건", "10")
  .action((options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다.");
        process.exit(1);
      }

      const result = search(brainRoot, {
        scopeType: options.scopeType,
        scopeId: options.scopeId,
        currentGoal: options.goal,
        topK: parseInt(options.topK, 10)
      });

      console.log(`=== Brain Search (${result.total}건 중 ${result.candidates.length}건) ===\n`);
      for (const c of result.candidates) {
        console.log(`  ${c.recordId}`);
        console.log(`    제목: ${c.title}`);
        console.log(`    요약: ${c.summary}`);
        console.log(`    태그: ${c.tags.join(", ")}`);
        console.log(`    점수: ${c.score}`);
        console.log();
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- recall 명령 (boot + search 통합) ---
program
  .command("recall")
  .description("Brain 부트 + 검색을 한 번에 실행 (세션 시작용)")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("-g, --goal <text>", "검색 목표 텍스트")
  .option("--scope-type <type>", "스코프 타입")
  .option("--scope-id <id>", "스코프 ID")
  .option("-k, --top-k <number>", "상위 N건", "10")
  .option("-b, --brief", "간결 출력 (점수 상위만, 한 줄씩)")
  .action((options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      // 1. Boot (간결 출력)
      const bootResult = boot(brainRoot, {
        scopeType: options.scopeType,
        scopeId: options.scopeId
      });

      if (!bootResult.success) {
        console.error("Boot FAIL:", bootResult.error);
        process.exit(1);
      }

      // 2. Search
      const searchResult = search(brainRoot, {
        scopeType: options.scopeType,
        scopeId: options.scopeId,
        currentGoal: options.goal,
        topK: parseInt(options.topK, 10)
      });

      // 3. 출력
      if (options.brief) {
        // --brief: 점수 > 0인 것만, 한 줄씩 간결 출력
        const relevant = searchResult.candidates.filter(c => c.score > 0);
        if (relevant.length === 0) {
          console.log("recall: 관련 기억 없음");
        } else {
          for (const c of relevant) {
            console.log(`[${c.score}] ${c.title} — ${c.summary}`);
          }
        }
      } else {
        // 기본: 상세 출력
        console.log(`=== Brain Recall (${searchResult.total}건 중 ${searchResult.candidates.length}건) ===\n`);
        if (searchResult.candidates.length === 0) {
          console.log("  저장된 기억이 없습니다.\n");
        } else {
          for (const c of searchResult.candidates) {
            console.log(`  [${c.recordId}]`);
            console.log(`  ${c.title} — ${c.summary}`);
            console.log(`  태그: ${c.tags.join(", ")}  점수: ${c.score}`);
            console.log();
          }
        }
      }

      if (bootResult.mismatches && bootResult.mismatches.length > 0) {
        console.log(`⚠ 수동 변경 감지 (${bootResult.mismatches.length}건):`);
        bootResult.mismatches.forEach(m => console.log(`  - ${m.path}: ${m.reason}`));
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- setup 명령 (대화형 페르소나 설정) ---
program
  .command("setup")
  .description("대화형 페르소나 설정 (에이전트 캐릭터 + 사용자 정보)")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--claude-md <path>", "글로벌 CLAUDE.md 경로")
  .action(async (options) => {
    try {
      const { setup } = require("./setup");
      const result = await setup({
        brainRoot: options.root || getDefaultBrainRoot(),
        claudeMdPath: options.claudeMd
      });
      if (!result.success) {
        console.error("설정 중 오류:", result.errors.join("; "));
        process.exit(1);
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

program.parse();
