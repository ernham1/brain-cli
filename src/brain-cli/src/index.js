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
  .version("1.3.1");

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
  .option("-t, --type <type>", "레코드 타입 필터 (note, rule, decision 등)")
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
        topK: parseInt(options.topK, 10),
        type: options.type || undefined
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
  .option("-t, --type <type>", "레코드 타입 필터 (note, rule, decision 등)")
  .option("-k, --top-k <number>", "상위 N건", "10")
  .option("-b, --brief", "간결 출력 (점수 상위만, 한 줄씩)")
  .option("--meta", "메타 recall 오케스트레이터 활성화 (상황 분류 + 다단계 전략 실행)")
  .action((options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      // 1. Boot
      const bootResult = boot(brainRoot, {
        scopeType: options.scopeType,
        scopeId: options.scopeId
      });

      if (!bootResult.success) {
        console.error("Boot FAIL:", bootResult.error);
        process.exit(1);
      }

      // REQ-132: --meta 분기 처리 (하위 호환)
      if (options.meta) {
        // Phase 2: 메타 recall 경로
        const { metaRecall } = require("./meta-recall");
        const result = metaRecall(brainRoot, options.goal || "", {
          topK: parseInt(options.topK, 10) || 10
        });

        if (options.brief) {
          const relevant = result.candidates.filter(c => c.score > 0);
          if (relevant.length === 0) {
            console.log("recall: 관련 기억 없음");
          } else {
            if (result.strategies_used.length > 0) {
              const names = result.strategies_used.map(s => s.name).join(", ");
              console.log(`[meta: ${names}]`);
            }
            for (const c of relevant) {
              console.log(`[${c.score}] ${c.title} — ${c.summary}`);
            }
          }
        } else {
          console.log(`=== Brain Meta Recall (${result.candidates.length}건) ===`);
          if (result.fallback) {
            console.log("  모드: fallback (전략 미매칭)\n");
          } else {
            console.log(`  전략: ${result.strategies_used.map(s => `${s.name}(${s.role})`).join(", ")}`);
            console.log(`  실행 steps: ${result.totalSteps}\n`);
          }
          if (result.candidates.length === 0) {
            console.log("  검색 결과 없음\n");
          } else {
            for (const c of result.candidates) {
              console.log(`  [${c.recordId}]`);
              console.log(`  ${c.title} — ${c.summary}`);
              console.log(`  태그: ${c.tags.join(", ")}  점수: ${c.score}`);
              console.log();
            }
          }
        }
      } else {
        // Phase 1: 기존 search() 경로 (변경 없음)
        const searchResult = search(brainRoot, {
          scopeType: options.scopeType,
          scopeId: options.scopeId,
          currentGoal: options.goal,
          topK: parseInt(options.topK, 10),
          type: options.type || undefined
        });

        if (options.brief) {
          const relevant = searchResult.candidates.filter(c => c.score > 0);
          if (relevant.length === 0) {
            console.log("recall: 관련 기억 없음");
          } else {
            for (const c of relevant) {
              console.log(`[${c.score}] ${c.title} — ${c.summary}`);
            }
          }
        } else {
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

// --- meta-seed 명령 (REQ-133) ---
program
  .command("meta-seed")
  .description("5개 기본 메타 전략을 Brain에 등록합니다 (멱등)")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--force", "기존 전략을 최신 seed로 갱신합니다")
  .action((options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      boot(brainRoot);

      const { getSeedStrategies, loadMetaStrategies, getMetaStrategySourceRef,
              META_STRATEGY_SCOPE_TYPE, META_STRATEGY_SCOPE_ID } = require("./meta-strategy");

      // 현재 active 전략 이름 목록 조회
      const { strategies: existing } = loadMetaStrategies(brainRoot);
      const existingNames = new Set(existing.map(s => s.content.name));

      const seeds = getSeedStrategies();
      let registered = 0;
      let updated = 0;
      let skipped = 0;

      for (const seed of seeds) {
        if (existingNames.has(seed.name)) {
          if (options.force) {
            // --force: content JSON을 최신 seed로 갱신 (BWT update)
            const engine = new BWTEngine(brainRoot);
            const existingStrategy = existing.find(s => s.content.name === seed.name);
            const intent = {
              action: "update",
              recordId: existingStrategy.record.recordId,
              sourceRef: getMetaStrategySourceRef(seed.name),
              content: JSON.stringify(seed, null, 2),
              record: {
                summary: `메타 전략: ${seed.name} (trigger ${seed.trigger_pattern.length}개, step ${seed.recall_sequence.length}개)`
              }
            };
            const result = engine.execute(intent);
            if (result.success) {
              console.log(`  갱신: ${seed.name} (trigger ${seed.trigger_pattern.length}개)`);
              updated++;
            } else {
              console.error(`  갱신 실패: ${seed.name} — ${JSON.stringify(result.report)}`);
            }
          } else {
            console.log(`  skip: ${seed.name} (이미 등록됨)`);
            skipped++;
          }
          continue;
        }

        // BWT write로 레코드 + content JSON 생성
        const engine = new BWTEngine(brainRoot);
        const intent = {
          action: "create",
          sourceRef: getMetaStrategySourceRef(seed.name),
          content: JSON.stringify(seed, null, 2),
          record: {
            scopeType: META_STRATEGY_SCOPE_TYPE,
            scopeId: META_STRATEGY_SCOPE_ID,
            type: "meta_strategy",
            title: seed.name,
            summary: `메타 전략: ${seed.name} (trigger ${seed.trigger_pattern.length}개, step ${seed.recall_sequence.length}개)`,
            tags: ["domain/memory", "intent/retrieval"],
            sourceType: "candidate"
          }
        };
        const result = engine.execute(intent);
        if (result.success) {
          console.log(`  등록: ${seed.name}`);
          registered++;
        } else {
          console.error(`  실패: ${seed.name} — ${JSON.stringify(result.report)}`);
        }
      }

      console.log(`\n완료: ${registered}개 등록, ${updated}개 갱신, ${skipped}개 skip`);
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- meta-list 명령 (REQ-134) ---
program
  .command("meta-list")
  .description("등록된 메타 전략 목록을 출력합니다")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .action((options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      boot(brainRoot);

      const { loadMetaStrategies } = require("./meta-strategy");
      const { strategies, warnings } = loadMetaStrategies(brainRoot);

      if (strategies.length === 0) {
        console.log("등록된 메타 전략이 없습니다. brain-cli meta-seed를 실행하세요.");
        return;
      }

      console.log("이름           | trigger 수 | step 수 | effectiveness_score");
      console.log("---------------|-----------|---------|--------------------");

      for (const { content } of strategies) {
        const name = (content.name || "unknown").padEnd(14);
        const triggerCount = String((content.trigger_pattern || []).length).padEnd(9);
        const stepCount = String((content.recall_sequence || []).length).padEnd(7);
        const score = (content.effectiveness_score || 0).toFixed(2).padEnd(20);
        console.log(`${name} | ${triggerCount} | ${stepCount} | ${score}`);
      }

      if (warnings.length > 0) {
        console.warn(`\n경고: ${warnings.length}개 전략 로드 실패`);
        warnings.forEach(w => console.warn(`  - ${w}`));
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- meta-feedback 명령 (REQ-141, REQ-143, REQ-144) ---
program
  .command("meta-feedback <type>")
  .description("최근 사용된 메타 전략에 피드백 (positive: +0.1, negative: -0.2)")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .action((type, options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      // REQ-143: type 유효성 검사
      if (type !== "positive" && type !== "negative") {
        console.error("ERROR: type은 'positive' 또는 'negative'만 허용됩니다.");
        process.exit(1);
      }

      // REQ-141: .meta_last_strategy에서 최근 전략 이름 읽기
      const fs = require("fs");
      const lastStrategyPath = path.join(brainRoot, "90_index", ".meta_last_strategy");
      let strategyName;
      try {
        const raw = fs.readFileSync(lastStrategyPath, "utf8");
        const lastStrategy = JSON.parse(raw);
        strategyName = lastStrategy.primary && lastStrategy.primary.name;
      } catch (_err) {
        // REQ-144: 파일 없거나 파싱 실패 시
        strategyName = null;
      }

      // 피드백 로그에 기록 (자기개선 루프용 — 전략 유무와 무관하게 항상 기록)
      let lastMessage = "";
      try {
        const { logFeedback } = require("./feedback-log");
        const raw = fs.readFileSync(lastStrategyPath, "utf8");
        const lastStrategy = JSON.parse(raw);
        lastMessage = lastStrategy.message || "";
        logFeedback(brainRoot, {
          strategyName: strategyName || "_fallback",
          feedbackType: type,
          message: lastMessage,
          score: lastStrategy.primary ? lastStrategy.primary.score : 0
        });
      } catch { /* 로깅 실패는 무시 */ }

      if (!strategyName) {
        console.log(`피드백 기록됨 (fallback). 최근 전략이 없어 점수 갱신은 생략합니다.`);
        return;
      }

      // REQ-136: delta 결정
      const delta = type === "positive" ? 0.1 : -0.2;

      const { updateEffectivenessScore } = require("./meta-strategy");
      const result = updateEffectivenessScore(brainRoot, strategyName, delta);

      if (!result.success) {
        console.error("ERROR:", result.message);
        process.exit(1);
      }

      console.log(`전략 '${strategyName}' 점수 갱신: ${result.newScore.toFixed(2)} (${type}: ${delta > 0 ? "+" : ""}${delta})`);

      // REQ-138, REQ-139: 승격/강등 알림
      if (result.message) {
        console.log(result.message);
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- meta-learn 명령 (자기개선 루프) ---
program
  .command("meta-learn")
  .description("피드백 로그를 분석하여 전략 트리거 개선을 제안/적용합니다")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--apply", "제안된 트리거를 자동으로 적용합니다")
  .option("--clear", "적용 후 피드백 로그를 초기화합니다")
  .action((options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      const { analyzeFeedback, applyTriggerSuggestions, clearFeedbackLog, readFeedbackLog } = require("./feedback-log");
      const { loadMetaStrategies } = require("./meta-strategy");

      const logs = readFeedbackLog(brainRoot);
      if (logs.length === 0) {
        console.log("피드백 로그가 비어있습니다. meta-feedback 명령으로 피드백을 먼저 쌓아주세요.");
        return;
      }

      console.log(`피드백 로그: ${logs.length}건 분석 중...\n`);

      const { strategies } = loadMetaStrategies(brainRoot);
      const suggestions = analyzeFeedback(brainRoot, strategies);

      if (suggestions.length === 0) {
        console.log("현재 개선이 필요한 전략이 없습니다.");
        return;
      }

      for (const suggestion of suggestions) {
        console.log(`[${suggestion.strategyName}] negative: ${suggestion.negativeCount}, positive: ${suggestion.positiveCount}`);
        if (suggestion.suggestedTriggers.length > 0) {
          console.log(`  제안 트리거: ${suggestion.suggestedTriggers.join(", ")}`);

          if (options.apply) {
            const result = applyTriggerSuggestions(brainRoot, suggestion.strategyName, suggestion.suggestedTriggers);
            if (result.applied) {
              console.log(`  적용 완료: ${result.addedCount}개 트리거 추가됨`);
            }
          }
        } else {
          console.log("  제안할 신규 트리거 없음 (negative 피드백이 있지만 공통 패턴 미발견)");
        }
      }

      if (options.apply && options.clear) {
        clearFeedbackLog(brainRoot);
        console.log("\n피드백 로그 초기화 완료.");
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- links 명령 (기억 연결 그래프) ---
program
  .command("links [recordId]")
  .description("기억 간 연결 조회/추가/삭제")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--add <toId>", "recordId → toId 링크 추가")
  .option("--remove <toId>", "recordId → toId 링크 삭제")
  .option("--type <linkType>", "링크 타입 (related|replaced_by|depends_on|see_also)", "related")
  .option("--stats", "전체 링크 통계 출력")
  .option("--scan", "기존 기억 전체를 스캔하여 자동 링크 생성")
  .action((recordId, options) => {
    try {
      const brainRoot = options.root || getDefaultBrainRoot();
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      const { addLink, removeLink, getLinksFor, readLinks, autoLink } = require("./links");
      const { _loadDigest } = require("./search");

      // 전체 스캔 — 기존 기억 자동 링크
      if (options.scan) {
        const digestPath = path.join(brainRoot, "90_index", "records_digest.txt");
        const allDigest = _loadDigest(digestPath).filter(d => d.status === "active");
        let totalLinked = 0;
        for (const record of allDigest) {
          const count = autoLink(brainRoot, record, allDigest);
          totalLinked += count;
        }
        console.log(`스캔 완료: ${allDigest.length}건 검사, ${totalLinked}건 새 링크 생성`);
        return;
      }

      // 전체 통계
      if (options.stats) {
        const allLinks = readLinks(brainRoot);
        console.log(`총 링크 수: ${allLinks.length}`);
        const typeCounts = {};
        for (const l of allLinks) {
          typeCounts[l.linkType] = (typeCounts[l.linkType] || 0) + 1;
        }
        for (const [type, count] of Object.entries(typeCounts)) {
          console.log(`  ${type}: ${count}`);
        }
        return;
      }

      if (!recordId) {
        console.error("ERROR: recordId를 지정하세요. 또는 --stats 옵션을 사용하세요.");
        process.exit(1);
      }

      // 링크 추가
      if (options.add) {
        const result = addLink(brainRoot, recordId, options.add, options.type);
        if (result.added) {
          console.log(`링크 추가: ${recordId} → ${options.add} (${options.type})`);
        } else {
          console.log("이미 존재하는 링크이거나 자기 참조입니다.");
        }
        return;
      }

      // 링크 삭제
      if (options.remove) {
        const removed = removeLink(brainRoot, recordId, options.remove);
        if (removed) {
          console.log(`링크 삭제: ${recordId} ↔ ${options.remove}`);
        } else {
          console.log("해당 링크를 찾을 수 없습니다.");
        }
        return;
      }

      // 기본: 연결된 링크 목록 출력
      const links = getLinksFor(brainRoot, recordId);
      if (links.length === 0) {
        console.log(`'${recordId}'에 연결된 기억이 없습니다.`);
        return;
      }

      console.log(`'${recordId}' 연결 (${links.length}건):`);
      for (const link of links) {
        const arrow = link.direction === "outgoing" ? "→" : "←";
        console.log(`  ${arrow} ${link.linkedId} [${link.linkType}] (${link.createdAt.slice(0, 10)})`);
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
