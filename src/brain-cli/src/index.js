#!/usr/bin/env node
/* global AbortSignal, fetch, setImmediate, URLSearchParams */
"use strict";

const { Command } = require("commander");
const path = require("path");
const { BWTEngine } = require("./bwt");
const { validate, generateDistributionReport, reconcileManifest } = require("./validate");
const { getDefaultBrainRoot, resolveBrainRoot, detectProjectName } = require("./utils");
const { init } = require("./init");
const { teamInit, teamAddMember, teamActivity, teamDecisions } = require("./team");
const { boot } = require("./boot");
const { search } = require("./search");
const { evaluateSearchQuality, formatSearchEvaluationReport } = require("./search-evaluation");
const { loadActiveState, validateActiveState } = require("./active-state");
const { createMemoryBrief } = require("./context-assembler");
const { guardDraft } = require("./answer-guard");
const {
  applyApprovedSmartMemoryProposal,
  listSmartMemoryProposals,
  reviewSmartMemoryProposal
} = require("./smart-memory-learning");
const {
  listSmartMemoryEvaluationCases,
  runSmartMemoryEvaluationSuite,
  seedDefaultSmartMemoryEvaluationCases
} = require("./smart-memory-evaluation");
const { getSmartMemoryPolicyForScope, readSmartMemoryPolicy } = require("./smart-memory-policy");
const {
  applyApprovedGrowthPromotionProposal,
  createGrowthRegressionCase,
  createGrowthPromotionProposal,
  listAgentForgePromotionExports,
  listProjectPromotionExports,
  listGrowthSignals,
  listGrowthCandidates,
  runGrowthRegressionCase,
  reviewGrowthCandidate,
  reviewGrowthPromotionProposal
} = require("./growth-signal");
const { consumeProjectPromotionExport } = require("./project-promotion-consumer");
const { getAllowedUserContext } = require("./user-ontology");
const { listFacts, upsertFact } = require("./fact-ledger");
const { compileMemory } = require("./memory-compiler");
const { compileWorkerMemoryProfile } = require("./worker-memory-compiler");
const { indexObsidian, readSources } = require("./obsidian-connector");
const { applyFrontmatter } = require("./obsidian-frontmatter");
const {
  applyApprovedRelationCandidate,
  generateRelationCandidates,
  listRelationCandidates,
  reviewRelationCandidate
} = require("./obsidian-relation-candidates");
const { indexDepthForSource, retrieveDepth } = require("./depth-retriever");
const {
  buildMemoryGraphBrief,
  evaluateMemoryGraph,
  readActivationLog,
  readEdges,
  readNodes,
  seedGraphFromSources
} = require("./memory-graph");
const { checkAccess, upsertOverride } = require("./access-policy");

const { version } = require("../package.json");
const program = new Command();

program
  .name("brain-cli")
  .description("Brain 장기기억 저장소 CLI")
  .version(version);
function formatCandidateBriefLine(candidate) {
  const preview = candidate.originalChunkPreview ? ` | 원본: ${candidate.originalChunkPreview}` : "";
  return `[${candidate.score}] ${candidate.title} — ${candidate.summary}${preview}`;
}

function printCandidateOriginalPreview(candidate, indent = "    ") {
  if (candidate.originalChunkPreview) {
    console.log(`${indent}원본: ${candidate.originalChunkPreview}`);
  }
}

// --- write 명령 (BWT 실행) ---
program
  .command("write")
  .description("BWT(Brain Write Transaction) 실행 — Intent JSON을 받아 Brain에 기록")
  .argument("<intent-json>", "Intent JSON 문자열 또는 파일 경로")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--project <name>", "팀 프로젝트 이름 (팀 Brain 사용 시)")
  .option("--shared", "팀 공용 공간에 저장 (미지정 시 개인 공간)")
  .option("--server <url>", "Brain Server URL (팀 공유 모드, 예: http://192.168.1.10:3847)")
  .option("--server-key <key>", "Brain Server API Key (선택)")
  .action(async (intentArg, options) => {
    try {
      // Intent 파싱: 파일 경로 또는 JSON 문자열
      let intent;
      const fs = require("fs");
      if (fs.existsSync(intentArg)) {
        intent = JSON.parse(fs.readFileSync(intentArg, "utf-8"));
      } else {
        intent = JSON.parse(intentArg);
      }

      // --- 서버 모드 (경로 미지정 시 로컬 Brain Server 자동 사용) ---
      const implicitLocalServer = !options.server && !options.root && !options.brain;
      const writeServerUrl = options.server
        || (implicitLocalServer ? (process.env.BRAIN_SERVER_URL || "http://127.0.0.1:3849") : null);

      if (writeServerUrl) {
        const baseUrl = writeServerUrl.replace(/\/$/, "");
        const headers = { "Content-Type": "application/json" };
        if (options.serverKey) headers["x-api-key"] = options.serverKey;

        // 명시적 원격 팀 서버에서만 프로젝트 자동 등록을 수행한다.
        if (options.server) {
          const projectName = options.project || detectProjectName(process.cwd());
          const configRes = await fetch(`${baseUrl}/api/team/config`, {
            headers,
            signal: AbortSignal.timeout(5000)
          });
          if (!configRes.ok) throw new Error(`팀 설정 조회 실패: HTTP ${configRes.status}`);
          const configData = await configRes.json();
          const existingProjects = configData.config?.projects || {};

          if (!existingProjects[projectName]) {
            const initRes = await fetch(`${baseUrl}/api/team/init`, {
              method: "POST",
              headers,
              body: JSON.stringify({ project: projectName }),
              signal: AbortSignal.timeout(5000)
            });
            if (!initRes.ok) throw new Error(`팀 프로젝트 등록 실패: HTTP ${initRes.status}`);
            console.log(`[팀 Brain] 프로젝트 자동 등록: ${projectName}`);
          }
        }

        let res;
        try {
          res = await fetch(`${baseUrl}/api/write`, {
            method: "POST",
            headers,
            body: JSON.stringify(intent),
            signal: AbortSignal.timeout(30000)
          });
        } catch (err) {
          const connectionRefused = implicitLocalServer && err.cause?.code === "ECONNREFUSED";
          if (!connectionRefused) throw err;
          console.warn(`[Brain] 로컬 서버가 실행 중이 아니어서 파일 저장으로 전환: ${err.message}`);
        }

        if (res) {
          const data = await res.json();
          if (res.ok && data.success) {
            console.log("SUCCESS:", JSON.stringify(data.report, null, 2));
          } else {
            console.error("FAILED:", JSON.stringify(data.report || data.error, null, 2));
            process.exitCode = 1;
          }
          return;
        }
      }

      // --- 로컬 모드 ---
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 또는 --server 옵션을 사용하세요.");
        process.exitCode = 1;
        return;
      }

      // F4: 팀 Brain 전처리 (--brain + --project 지정 시)
      if (options.brain && options.project) {
        const { readConfig } = require("./team");
        let config;
        try {
          config = readConfig(brainRoot);
        } catch {
          config = null;
        }

        // author 태깅
        if (config && config.defaultMember) {
          const authorTag = `team/author:${config.defaultMember}`;
          if (!intent.record) intent.record = {};
          if (!Array.isArray(intent.record.tags)) intent.record.tags = [];
          if (!intent.record.tags.includes(authorTag)) {
            intent.record.tags.push(authorTag);
          }
        }

        // sourceRef 경로 분기
        if (intent.sourceRef && !intent.sourceRef.startsWith("projects/")) {
          const base = options.shared
            ? `projects/${options.project}/shared`
            : `projects/${options.project}/${config && config.defaultMember ? config.defaultMember : "shared"}`;
          intent.sourceRef = `${base}/${intent.sourceRef}`;
        }
      }

      const engine = new BWTEngine(brainRoot);
      const result = engine.execute(intent);

      if (result.success) {
        console.log("SUCCESS:", JSON.stringify(result.report, null, 2));
      } else {
        console.error("FAILED:", JSON.stringify(result.report, null, 2));
        process.exitCode = 1;
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exitCode = 1;
    }
  });

// --- validate 명령 ---
program
  .command("validate")
  .description("Brain 인덱스 정합성 검증")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--full", "확장 검증 모드 (B08)")
  .option("--fix", "manifest 해시 불일치 자동 수정 (reconcile)")
  .option("--report", "레코드 분포 리포트 출력")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      if (options.fix) {
        const { fixed, removed } = reconcileManifest(brainRoot);
        console.log("=== Brain Reconcile ===");
        if (fixed.length > 0) console.log(`해시 갱신 (${fixed.length}건):\n` + fixed.map(f => `  - ${f}`).join("\n"));
        if (removed.length > 0) console.log(`항목 제거 (${removed.length}건):\n` + removed.map(f => `  - ${f}`).join("\n"));
        if (fixed.length === 0 && removed.length === 0) console.log("불일치 없음 — 정상 상태입니다.");
        return;
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

      // K4 오염 감지 자동 기록
      if (result.k4Events && result.k4Events.length > 0) {
        const { logK4Event } = require("./kpi");
        const logged = logK4Event(brainRoot, result.k4Events);
        console.log(`\n⚠ K4 오염 감지 ${logged}건 — 90_index/k4_events.jsonl에 기록됨`);
      }

      if (options.report) {
        const { readJsonl } = require("./utils");
        const records = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));
        const report = generateDistributionReport(records);

        console.log("\n=== 레코드 분포 리포트 ===");
        console.log("\n[scopeType별]");
        for (const [type, count] of Object.entries(report.byScopeType)) {
          console.log(`  ${type}: ${count}건`);
        }

        console.log("\n[scopeId별 — 상위 15]");
        for (const { scopeId, count } of report.byScopeId.slice(0, 15)) {
          console.log(`  ${scopeId}: ${count}건`);
        }

        if (report.staleRecords.length > 0) {
          console.log(`\n[30일 이상 미갱신 active 레코드 — ${report.staleRecords.length}건]`);
          for (const r of report.staleRecords.slice(0, 10)) {
            console.log(`  ${r.recordId}: ${r.title} (${r.updatedAt})`);
          }
          if (report.staleRecords.length > 10) {
            console.log(`  ... 외 ${report.staleRecords.length - 10}건`);
          }
        }
      }

      if (!result.passed) process.exit(1);
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- sourceRef repair 명령 ---
program
  .command("repair-source-refs")
  .description("records.jsonl에는 있지만 디스크에 없는 sourceRef 파일을 메타데이터 기준으로 복구")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--dry-run", "실제 수정 없이 복구/정리 대상만 출력")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      const { repairSourceRefs } = require("./source-ref-repair");
      const result = repairSourceRefs(brainRoot, { dryRun: !!options.dryRun });

      console.log(options.dryRun ? "=== Brain SourceRef Repair (dry-run) ===" : "=== Brain SourceRef Repair ===");
      console.log(`Brain root: ${brainRoot}`);
      console.log(`1. 원문 파일 복구 대상: ${result.missingRecordSourceRefs.length}건`);
      for (const item of result.missingRecordSourceRefs) {
        console.log(`  - ${item.recordId}: ${item.sourceRef}`);
      }
      console.log(`2. manifest 찌꺼기 정리 대상: ${result.removedManifestEntries.length}건`);
      for (const ref of result.removedManifestEntries) {
        console.log(`  - ${ref}`);
      }

      if (options.dryRun) {
        console.log("\n--dry-run 없이 실행하면 위 항목을 복구/정리합니다.");
        return;
      }

      console.log(`\n복구 완료: ${result.restored.length}건`);
      if (result.restored.length > 0 || result.removedManifestEntries.length > 0) {
        console.log("\n--- validate 실행 ---");
        const validation = validate(brainRoot);
        console.log(`결과: ${validation.passed ? "PASS" : "FAIL"}`);
        if (validation.errors.length > 0) {
          console.log("Errors:");
          validation.errors.forEach(e => console.log(`  - ${e}`));
        }
        if (validation.warnings.length > 0) {
          console.log("Warnings:");
          validation.warnings.forEach(w => console.log(`  - ${w}`));
        }
        if (!validation.passed) process.exit(1);
      }
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
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--scope-type <type>", "스코프 타입")
  .option("--scope-id <id>", "스코프 ID")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
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
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--scope-type <type>", "스코프 타입")
  .option("--scope-id <id>", "스코프 ID")
  .option("-g, --goal <text>", "검색 목표 텍스트")
  .option("-t, --type <type>", "레코드 타입 필터 (note, rule, decision 등)")
  .option("-k, --top-k <number>", "상위 N건", "10")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
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
        printCandidateOriginalPreview(c);
        console.log(`    태그: ${c.tags.join(", ")}`);
        console.log(`    점수: ${c.score}`);
        console.log();
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- search-quality 명령 ---
const searchQualityCmd = program
  .command("search-quality")
  .description("Brain 검색 품질 평가");

searchQualityCmd
  .command("evaluate")
  .description("질문/정답 케이스로 검색 품질을 평가")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--cases <path>", "평가 케이스 JSON 파일 경로")
  .option("-k, --top-k <number>", "검색 topK", "5")
  .option("--json", "JSON으로 출력")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다.");
        process.exit(1);
      }
      const report = evaluateSearchQuality(brainRoot, {
        casesPath: options.cases,
        topK: parseInt(options.topK, 10)
      });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatSearchEvaluationReport(report));
      if (report.status !== "passed") process.exitCode = 2;
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
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("-g, --goal <text>", "검색 목표 텍스트")
  .option("--scope-type <type>", "스코프 타입")
  .option("--scope-id <id>", "스코프 ID")
  .option("-t, --type <type>", "레코드 타입 필터 (note, rule, decision 등)")
  .option("-k, --top-k <number>", "상위 N건", "10")
  .option("-b, --brief", "간결 출력 (점수 상위만, 한 줄씩)")
  .option("-l, --layer <number>", "강제 레이어 지정 (0=L0만, 1=L0+L1, 2=전체, 기본: 자동)")
  .option("--batch <queries...>", "여러 쿼리를 한 번에 실행 (쿼리별 독립 검색)")
  .option("--meta", "메타 recall 오케스트레이터 활성화 (상황 분류 + 다단계 전략 실행)")
  .option("--server <url>", "Brain Server URL (팀 공유 모드)")
  .option("--server-key <key>", "Brain Server API Key (선택)")
  .action(async (options) => {
    try {
      // --- 서버 모드 (경로 미지정 시 로컬 Brain Server 자동 사용) ---
      const implicitLocalServer = !options.server && !options.root && !options.brain;
      const recallServerUrl = options.server
        || (implicitLocalServer ? (process.env.BRAIN_SERVER_URL || "http://127.0.0.1:3849") : null);
      if (recallServerUrl) {
        try {
          const requestedGoals = options.batch && options.batch.length > 0
            ? options.batch
            : (options.goal ? [options.goal] : []);
          if (requestedGoals.length === 0) {
            throw new Error("--goal 또는 --batch 옵션이 필요합니다.");
          }

          const url = `${recallServerUrl.replace(/\/$/, "")}/api/recall`;
          const headers = { "Content-Type": "application/json" };
          if (options.serverKey) headers["x-api-key"] = options.serverKey;

          const serverResults = [];
          for (const goal of requestedGoals) {
            const body = {
              goal,
              scopeType: options.scopeType,
              scopeId: options.scopeId,
              type: options.type,
              topK: options.topK
            };
            const res = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(5000)
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
              throw new Error(data.error || `HTTP ${res.status}`);
            }
            serverResults.push({
              goal,
              candidates: data.results?.candidates || [],
              consolidationHints: data.results?.consolidationHints || []
            });
          }

          if (options.batch && options.batch.length > 0) {
            const allConsolidationHints = [];
            for (let index = 0; index < serverResults.length; index++) {
              const { goal, candidates, consolidationHints } = serverResults[index];
              console.log(`── 쿼리 ${index + 1}: "${goal}" ──`);

              if (options.brief) {
                const relevant = candidates.filter(candidate => candidate.score > 0);
                if (relevant.length === 0) {
                  console.log("관련 기억 없음");
                } else {
                  for (const candidate of relevant) {
                    console.log(formatCandidateBriefLine(candidate));
                  }
                }
              } else if (candidates.length === 0) {
                console.log("  저장된 기억이 없습니다.");
              } else {
                for (const candidate of candidates) {
                  console.log(`  [${candidate.recordId}]`);
                  console.log(`  ${candidate.title} — ${candidate.summary}`);
                  printCandidateOriginalPreview(candidate, "  ");
                  console.log(`  태그: ${(candidate.tags || []).join(", ")}  점수: ${candidate.score}`);
                  console.log();
                }
              }

              allConsolidationHints.push(...consolidationHints);
              if (index < serverResults.length - 1) {
                console.log();
              }
            }

            if (allConsolidationHints.length > 0) {
              const seen = new Set();
              const uniqueHints = allConsolidationHints.filter(hint => {
                const key = `${hint.scopeId}:${hint.type}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
              console.log(`\n📦 통합 제안 (${uniqueHints.length}건):`);
              for (const hint of uniqueHints) {
                console.log(`  ${hint.message}`);
                console.log(`    대상: ${hint.recordIds.slice(0, 3).join(", ")}${hint.count > 3 ? ` 외 ${hint.count - 3}건` : ""}`);
              }
            }
          } else {
            const candidates = serverResults[0].candidates;
            if (options.brief) {
              if (candidates.length === 0) {
                console.log("recall: 관련 기억 없음");
              } else {
                for (const candidate of candidates) {
                  console.log(formatCandidateBriefLine(candidate));
                }
              }
            } else {
              console.log(`=== Brain Recall (${candidates.length}건) ===\n`);
              for (const candidate of candidates) {
                console.log(`  ${candidate.recordId}`);
                console.log(`    제목: ${candidate.title}`);
                console.log(`    요약: ${candidate.summary}`);
                printCandidateOriginalPreview(candidate);
                console.log(`    태그: ${(candidate.tags || []).join(", ")}`);
                console.log(`    점수: ${candidate.score}`);
                console.log();
              }
            }
          }
          return;
        } catch (err) {
          if (!implicitLocalServer) {
            console.error("FAILED:", err.message);
            process.exit(1);
          }
          console.warn(`[Brain] 로컬 서버 조회 실패, 파일 검색으로 전환: ${err.message}`);
        }
      }
      // --- 로컬 모드 ---
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 또는 --server 옵션을 사용하세요.");
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

      // --- batch 모드: 여러 쿼리를 한 번에 실행 ---
      if (options.batch && options.batch.length > 0) {
        const queries = options.batch;
        const topK = parseInt(options.topK, 10);
        const forceLayer = options.layer !== undefined ? parseInt(options.layer, 10) : null;
        const allConsolidationHints = [];

        for (let i = 0; i < queries.length; i++) {
          const goal = queries[i];

          // 벡터 임베딩 (best-effort)
          let queryEmbedding = null;
          try {
            const { isDbAvailable, getDb, isVectorAvailable, embedText } = require("./db");
            if (isDbAvailable(brainRoot)) {
              const db = getDb(brainRoot);
              const vectorReady = isVectorAvailable(db);
              db.close();
              if (vectorReady) {
                queryEmbedding = await embedText(goal, "query");
              }
            }
          } catch { /* 임베딩 실패 시 FTS 폴백 */ }

          const searchResult = search(brainRoot, {
            scopeType: options.scopeType,
            scopeId: options.scopeId,
            currentGoal: goal,
            topK,
            type: options.type || undefined,
            queryEmbedding,
            forceLayer: forceLayer !== null && !isNaN(forceLayer) ? forceLayer : null
          });

          // 쿼리 헤더 출력
          console.log(`── 쿼리 ${i + 1}: "${goal}" ──`);

          if (options.brief) {
            const relevant = searchResult.candidates.filter(c => c.score > 0);
            if (relevant.length === 0) {
              console.log("관련 기억 없음");
            } else {
              for (const c of relevant) {
                console.log(formatCandidateBriefLine(c));
              }
            }
          } else {
            if (searchResult.candidates.length === 0) {
              console.log("  저장된 기억이 없습니다.");
            } else {
              for (const c of searchResult.candidates) {
                console.log(`  [${c.recordId}]`);
                console.log(`  ${c.title} — ${c.summary}`);
                printCandidateOriginalPreview(c, "  ");
                console.log(`  태그: ${c.tags.join(", ")}  점수: ${c.score}`);
                console.log();
              }
            }
          }

          // 쿼리 간 빈 줄 구분 (마지막 쿼리 제외)
          if (i < queries.length - 1) {
            console.log();
          }

          // 통합 힌트 수집
          if (searchResult.consolidationHints) {
            allConsolidationHints.push(...searchResult.consolidationHints);
          }
        }

        // 중복 제거된 통합 힌트 출력
        if (allConsolidationHints.length > 0) {
          const seen = new Set();
          const unique = allConsolidationHints.filter(h => {
            const key = `${h.scopeId}:${h.type}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          console.log(`\n📦 통합 제안 (${unique.length}건):`);
          for (const h of unique) {
            console.log(`  ${h.message}`);
            console.log(`    대상: ${h.recordIds.slice(0, 3).join(", ")}${h.count > 3 ? ` 외 ${h.count - 3}건` : ""}`);
          }
        }

        // boot 수동 변경 감지
        if (!options.brief && bootResult.mismatches && bootResult.mismatches.length > 0) {
          console.log(`⚠ 수동 변경 감지 (${bootResult.mismatches.length}건):`);
          bootResult.mismatches.forEach(m => console.log(`  - ${m.path}: ${m.reason}`));
        }
        return;
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
              console.log(formatCandidateBriefLine(c));
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
                printCandidateOriginalPreview(c, "  ");
              console.log(`  태그: ${c.tags.join(", ")}  점수: ${c.score}`);
              console.log();
            }
          }
        }
      } else {
        // Phase 1: 기존 search() 경로 + classify best-effort
        try {
          const { classify } = require("./classifier");
          const { loadMetaStrategies } = require("./meta-strategy");
          const { _saveLastStrategy } = require("./meta-recall");
          const { loadSynonyms } = require("./utils");

          const metaData = loadMetaStrategies(brainRoot);
          if (metaData.strategies.length > 0) {
            const synonymMap = loadSynonyms(brainRoot);
            const classification = classify(options.goal, metaData.strategies, synonymMap);
            if (classification.matched) {
              _saveLastStrategy(brainRoot, classification, options.goal);
            }
          }
        } catch { /* classify 실패는 recall 결과에 영향 없음 */ }

        // Phase 2: 벡터 임베딩 사전 생성 (비동기, 실패 시 FTS 폴백)
        let queryEmbedding = null;
        try {
          const { isDbAvailable, getDb, isVectorAvailable, embedText } = require("./db");
          if (isDbAvailable(brainRoot)) {
            const db = getDb(brainRoot);
            const vectorReady = isVectorAvailable(db);
            db.close();
            if (vectorReady) {
              queryEmbedding = await embedText(options.goal, "query");
            }
          }
        } catch { /* 임베딩 실패 시 FTS 폴백 */ }

        const forceLayer = options.layer !== undefined ? parseInt(options.layer, 10) : null;
        const searchResult = search(brainRoot, {
          scopeType: options.scopeType,
          scopeId: options.scopeId,
          currentGoal: options.goal,
          topK: parseInt(options.topK, 10),
          type: options.type || undefined,
          queryEmbedding,
          forceLayer: forceLayer !== null && !isNaN(forceLayer) ? forceLayer : null
        });

        if (options.brief) {
          const relevant = searchResult.candidates.filter(c => c.score > 0);
          if (relevant.length === 0) {
            console.log("recall: 관련 기억 없음");
          } else {
            for (const c of relevant) {
              console.log(formatCandidateBriefLine(c));
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
                printCandidateOriginalPreview(c, "  ");
              console.log(`  태그: ${c.tags.join(", ")}  점수: ${c.score}`);
              console.log();
            }
          }
        }

        // 재귀적 기억 통합 힌트 출력
        if (searchResult.consolidationHints && searchResult.consolidationHints.length > 0) {
          console.log(`\n📦 통합 제안 (${searchResult.consolidationHints.length}건):`);
          for (const h of searchResult.consolidationHints) {
            console.log(`  ${h.message}`);
            console.log(`    대상: ${h.recordIds.slice(0, 3).join(", ")}${h.count > 3 ? ` 외 ${h.count - 3}건` : ""}`);
          }
        }
      }

      if (!options.brief && bootResult.mismatches && bootResult.mismatches.length > 0) {
        console.log(`⚠ 수동 변경 감지 (${bootResult.mismatches.length}건):`);
        bootResult.mismatches.forEach(m => console.log(`  - ${m.path}: ${m.reason}`));
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    } finally {
      try {
        const { disposeEmbeddingPipeline } = require("./db");
        await Promise.race([
          disposeEmbeddingPipeline(),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
      } catch { /* 임베딩 자원 해제 실패가 recall 결과를 덮지 않음 */ }
      await new Promise(resolve => setImmediate(resolve));
    }
  });

// --- meta-seed 명령 (REQ-133) ---
program
  .command("meta-seed")
  .description("5개 기본 메타 전략을 Brain에 등록합니다 (멱등)")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--force", "기존 전략을 최신 seed로 갱신합니다")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
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
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
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
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((type, options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
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
      } catch {
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
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--apply", "제안된 트리거를 자동으로 적용합니다")
  .option("--clear", "적용 후 피드백 로그를 초기화합니다")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
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
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--add <toId>", "recordId → toId 링크 추가")
  .option("--remove <toId>", "recordId → toId 링크 삭제")
  .option("--type <linkType>", "링크 타입 (related|replaced_by|depends_on|see_also)", "related")
  .option("--stats", "전체 링크 통계 출력")
  .option("--scan", "기존 기억 전체를 스캔하여 자동 링크 생성")
  .action((recordId, options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
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
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--claude-md <path>", "글로벌 CLAUDE.md 경로")
  .action(async (options) => {
    try {
      const { setup } = require("./setup");
      const result = await setup({
        brainRoot: resolveBrainRoot(options),
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

// --- team 명령 (팀 Brain 관리) ---
const teamCmd = program
  .command("team")
  .description("팀 Brain 관리 (init, add-member)");

teamCmd
  .command("init")
  .description("팀 Brain 초기화 및 프로젝트 등록")
  .option("--brain <path>", "팀 Brain 경로 (필수)")
  .option("--project <name>", "프로젝트 이름 (필수)")
  .action((options) => {
    try {
      if (!options.brain) {
        console.error("ERROR: --brain 옵션이 필요합니다. 예) brain-cli team init --brain ~/NeuralfluxBrain --project clo-telegram");
        process.exit(1);
      }
      if (!options.project) {
        console.error("ERROR: --project 옵션이 필요합니다. 예) brain-cli team init --brain ~/NeuralfluxBrain --project clo-telegram");
        process.exit(1);
      }
      const teamBrainPath = require("path").resolve(options.brain);
      const { created, skipped } = teamInit(teamBrainPath, options.project);
      console.log(`✅ 팀 Brain 초기화 완료: ${teamBrainPath}`);
      console.log(`   프로젝트: ${options.project}`);
      if (created.length > 0) console.log(`   생성: ${created.join(", ")}`);
      if (skipped.length > 0) console.log(`   스킵 (이미 존재): ${skipped.length}개`);
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

teamCmd
  .command("add-member")
  .description("팀원을 프로젝트에 등록하고 개인 공간 생성")
  .option("--brain <path>", "팀 Brain 경로 (필수)")
  .option("--project <name>", "프로젝트 이름 (필수)")
  .option("--member <name>", "팀원 이름 (필수)")
  .action((options) => {
    try {
      if (!options.brain || !options.project || !options.member) {
        console.error("ERROR: --brain, --project, --member 옵션이 모두 필요합니다.");
        console.error("예) brain-cli team add-member --brain ~/NeuralfluxBrain --project clo-telegram --member 고광웅");
        process.exit(1);
      }
      const teamBrainPath = require("path").resolve(options.brain);
      const { created, skipped, isNew } = teamAddMember(teamBrainPath, options.project, options.member);
      if (isNew) {
        console.log(`✅ 팀원 등록 완료: ${options.member} → ${options.project}`);
      } else {
        console.log(`ℹ️  이미 등록된 팀원입니다: ${options.member} (${options.project})`);
      }
      if (created.length > 0) console.log(`   생성: ${created.join(", ")}`);
      if (skipped.length > 0) console.log(`   스킵 (이미 존재): ${skipped.length}개`);
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- team status 명령 (최근 팀 활동 조회) ---
teamCmd
  .command("status")
  .description("팀 Brain 최근 활동 현황 조회 (관리자 뷰)")
  .option("--brain <path>", "팀 Brain 경로")
  .option("--server <url>", "Brain Server URL")
  .option("--server-key <key>", "Brain Server API Key (선택)")
  .option("--days <n>", "최근 N일 조회 (기본 7)", "7")
  .option("--project <name>", "특정 프로젝트만 조회")
  .option("--author <name>", "특정 팀원만 조회")
  .action(async (options) => {
    try {
      let records = [];
      let total = 0;

      if (options.server) {
        const baseUrl = options.server.replace(/\/$/, "");
        const headers = { "Content-Type": "application/json" };
        if (options.serverKey) headers["x-api-key"] = options.serverKey;

        const params = new URLSearchParams({ days: options.days });
        if (options.project) params.set("project", options.project);
        if (options.author) params.set("author", options.author);

        const res = await fetch(`${baseUrl}/api/admin/activity?${params}`, { headers });
        const data = await res.json();
        if (!data.success) {
          console.error("ERROR:", data.error);
          process.exit(1);
        }
        records = data.records;
        total = data.total;
      } else if (options.brain) {
        const brainRoot = require("path").resolve(options.brain);
        const result = teamActivity(brainRoot, {
          days: parseInt(options.days),
          project: options.project || null,
          author: options.author || null
        });
        records = result.records;
        total = result.total;
      } else {
        console.error("ERROR: --server 또는 --brain 옵션이 필요합니다.");
        process.exit(1);
      }

      console.log(`\n=== 팀 활동 현황 (최근 ${options.days}일) ===\n`);
      if (records.length === 0) {
        console.log("  활동 기록이 없습니다.\n");
        return;
      }

      // 프로젝트별로 그룹화
      const byProject = {};
      for (const r of records) {
        const key = r.scopeId || "unknown";
        if (!byProject[key]) byProject[key] = [];
        byProject[key].push(r);
      }

      for (const [project, items] of Object.entries(byProject)) {
        console.log(`[${project}]`);
        for (const r of items) {
          const date = r.updatedAt ? r.updatedAt.slice(0, 10) : "?";
          const author = r.author ? `  ${r.author}` : "";
          const type = (r.type || "").padEnd(10);
          console.log(`  ${date}${author}  ${type}  ${r.title}`);
          if (r.summary) console.log(`    → ${r.summary}`);
        }
        console.log();
      }

      console.log(`전체 ${total}건 (프로젝트 ${Object.keys(byProject).length}개)\n`);
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- team decisions 명령 (의사결정 로그 조회) ---
teamCmd
  .command("decisions")
  .description("팀 Brain 의사결정 로그 조회")
  .option("--brain <path>", "팀 Brain 경로")
  .option("--server <url>", "Brain Server URL")
  .option("--server-key <key>", "Brain Server API Key (선택)")
  .option("--project <name>", "특정 프로젝트만 조회")
  .action(async (options) => {
    try {
      let records = [];
      let total = 0;

      if (options.server) {
        const baseUrl = options.server.replace(/\/$/, "");
        const headers = { "Content-Type": "application/json" };
        if (options.serverKey) headers["x-api-key"] = options.serverKey;

        const params = new URLSearchParams();
        if (options.project) params.set("project", options.project);

        const res = await fetch(`${baseUrl}/api/admin/decisions?${params}`, { headers });
        const data = await res.json();
        if (!data.success) {
          console.error("ERROR:", data.error);
          process.exit(1);
        }
        records = data.records;
        total = data.total;
      } else if (options.brain) {
        const brainRoot = require("path").resolve(options.brain);
        const result = teamDecisions(brainRoot, { project: options.project || null });
        records = result.records;
        total = result.total;
      } else {
        console.error("ERROR: --server 또는 --brain 옵션이 필요합니다.");
        process.exit(1);
      }

      console.log(`\n=== 의사결정 로그 (${total}건) ===\n`);
      if (records.length === 0) {
        console.log("  저장된 의사결정이 없습니다.\n");
        return;
      }

      for (const r of records) {
        const date = r.updatedAt ? r.updatedAt.slice(0, 10) : "?";
        const project = r.scopeId ? `[${r.scopeId}]` : "";
        const author = r.author ? ` — ${r.author}` : "";
        const confirmed = r.sourceType === "user_confirmed" ? "✓" : "·";
        console.log(`${confirmed} ${date}  ${project}  ${r.title}${author}`);
        if (r.summary) console.log(`    ${r.summary}`);
        console.log();
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- Memory Kernel PoC 명령 ---
const stateCmd = program
  .command("state")
  .description("Active State Ledger 조회");

stateCmd
  .command("status")
  .description("스코프의 Active State를 조회하고 없으면 최소 상태를 생성")
  .requiredOption("--scope <scopeId>", "스코프 ID")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--json", "JSON 출력")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const state = loadActiveState(brainRoot, options.scope);
      const validation = validateActiveState(state);
      if (options.json) {
        console.log(JSON.stringify({ state, validation }, null, 2));
        return;
      }
      console.log(`=== Active State: ${state.scopeId} ===`);
      console.log(`updatedAt: ${state.updatedAt}`);
      console.log(`capabilities: ${state.capabilities.length}`);
      for (const capability of state.capabilities) {
        console.log(`- ${capability.title}: ${capability.summary}`);
      }
      if (!validation.passed) {
        console.log("\n검증 이슈:");
        validation.issues.forEach(issue => console.log(`- ${issue}`));
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

const factCmd = program
  .command("fact")
  .description("Fact Ledger 조회/갱신");

factCmd
  .command("list")
  .description("Fact Ledger 목록 조회")
  .requiredOption("--scope <scopeId>", "스코프 ID")
  .option("--status <status>", "상태 필터")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const facts = listFacts(brainRoot, { scopeId: options.scope, status: options.status });
      console.log(JSON.stringify({ facts, total: facts.length }, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

factCmd
  .command("upsert")
  .description("Fact를 추가하거나 갱신")
  .requiredOption("--scope <scopeId>", "스코프 ID")
  .requiredOption("--subject <text>", "주어")
  .requiredOption("--predicate <text>", "술어")
  .requiredOption("--object <text>", "목적어")
  .option("--source <ref>", "sourceRef")
  .option("--source-record <recordId>", "source recordId")
  .option("--source-type <type>", "sourceType", "candidate")
  .option("--record-type <type>", "record type")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = upsertFact(brainRoot, {
        scopeId: options.scope,
        subject: options.subject,
        predicate: options.predicate,
        object: options.object,
        sourceRefs: options.source ? [options.source] : [],
        sourceRecordIds: options.sourceRecord ? [options.sourceRecord] : [],
        sourceType: options.sourceType,
        recordType: options.recordType
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.fact.status === "disputed") process.exitCode = 2;
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

program
  .command("compile-memory")
  .description("Raw record를 memory class와 fact candidate로 컴파일")
  .option("--record <recordId>", "특정 recordId")
  .option("--scope <scopeId>", "스코프 ID")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      if (!options.record && !options.scope) throw new Error("--record 또는 --scope가 필요합니다.");
      const result = compileMemory(brainRoot, { recordId: options.record, scopeId: options.scope });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

program
  .command("worker-profile")
  .description("작업자 기록 기반 Worker Memory Profile 생성")
  .requiredOption("--worker <workerId>", "작업자 ID")
  .option("--scope <scopeId>", "대상 Brain scopeId")
  .option("--team <teamId>", "팀 ID")
  .option("--from <date>", "대상 기간 시작일")
  .option("--to <date>", "대상 기간 종료일")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const profile = compileWorkerMemoryProfile(brainRoot, {
        workerId: options.worker,
        teamId: options.team || null,
        scopeId: options.scope,
        from: options.from,
        to: options.to
      });
      console.log(JSON.stringify(profile, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

const obsidianCmd = program
  .command("obsidian")
  .description("Obsidian source registry와 depth index 관리");

obsidianCmd
  .command("frontmatter")
  .description("Obsidian markdown frontmatter를 dry-run 또는 backup apply로 보강")
  .requiredOption("--root <path>", "Obsidian AI학습 root")
  .option("--apply", "실제 파일에 적용")
  .option("--backup-dir <path>", "backup 저장 경로")
  .option("--scope <scopeId>", "기본 scopeId")
  .option("--limit <n>", "최대 파일 수")
  .option("--preview-limit <n>", "preview 출력 수", "10")
  .action((options) => {
    try {
      const result = applyFrontmatter(path.resolve(options.root), {
        dryRun: !options.apply,
        backupDir: options.backupDir,
        scopeId: options.scope,
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        previewLimit: parseInt(options.previewLimit, 10)
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

obsidianCmd
  .command("index")
  .description("Obsidian markdown 문서를 source registry에 색인")
  .requiredOption("--root <path>", "Obsidian AI학습 root")
  .requiredOption("--scope <scopeId>", "스코프 힌트")
  .option("--limit <n>", "최대 파일 수", "50")
  .option("--prune", "이번 색인 root에서 더 이상 보이지 않는 source 제거")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = options.brain ? path.resolve(options.brain) : getDefaultBrainRoot();
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = indexObsidian(brainRoot, {
        root: path.resolve(options.root),
        scope: options.scope,
        limit: parseInt(options.limit, 10),
        prune: !!options.prune
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

obsidianCmd
  .command("depth")
  .description("sourceId 기준 D0-D4 depth index 생성")
  .option("--source <sourceId>", "sourceId")
  .option("--all", "현재 source registry 전체 depth index 생성")
  .option("--scope <scopeId>", "전체 생성 시 scope 필터")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      if (options.all) {
        const sources = readSources(brainRoot)
          .filter(source => !options.scope || (source.scopeHints || []).includes(options.scope));
        const results = sources.map(source => indexDepthForSource(brainRoot, source.sourceId));
        console.log(JSON.stringify({
          indexed: results.length,
          totalEntries: results.reduce((sum, result) => sum + result.entries.length, 0),
          sources: results.map(result => ({ sourceId: result.sourceId, entries: result.entries.length }))
        }, null, 2));
        return;
      }
      if (!options.source) throw new Error("--source 또는 --all이 필요합니다.");
      console.log(JSON.stringify(indexDepthForSource(brainRoot, options.source), null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

obsidianCmd
  .command("relation-candidates")
  .description("Obsidian source registry에서 relation 후보를 생성하거나 조회")
  .option("--scope <scopeId>", "scopeId 필터")
  .option("--status <status>", "조회할 후보 상태")
  .option("--list", "기존 후보만 조회")
  .option("--min-score <number>", "후보 최소 점수", "0.35")
  .option("--limit <n>", "최대 후보 수", "50")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      if (options.list || options.status) {
        console.log(JSON.stringify(listRelationCandidates(brainRoot, {
          scope: options.scope,
          status: options.status
        }), null, 2));
        return;
      }
      console.log(JSON.stringify(generateRelationCandidates(brainRoot, {
        scope: options.scope,
        minScore: parseFloat(options.minScore),
        limit: parseInt(options.limit, 10)
      }), null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

obsidianCmd
  .command("relation-review")
  .description("relation 후보를 approved/dismissed/needs_changes로 검토")
  .requiredOption("--candidate <candidateId>", "candidateId")
  .requiredOption("--decision <decision>", "approved, dismissed, needs_changes")
  .option("--reason <text>", "검토 사유", "")
  .option("--reviewer <name>", "검토자", "Codex")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      console.log(JSON.stringify(reviewRelationCandidate(brainRoot, {
        candidateId: options.candidate,
        decision: options.decision,
        reason: options.reason,
        reviewer: options.reviewer
      }), null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

obsidianCmd
  .command("relation-apply")
  .description("approved relation 후보를 md frontmatter memory.relations에 적용")
  .requiredOption("--candidate <candidateId>", "candidateId")
  .option("--backup-dir <path>", "backup 저장 경로")
  .option("--applied-by <name>", "적용자", "Codex")
  .option("--reason <text>", "적용 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      console.log(JSON.stringify(applyApprovedRelationCandidate(brainRoot, {
        candidateId: options.candidate,
        backupDir: options.backupDir,
        appliedBy: options.appliedBy,
        reason: options.reason
      }), null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

program
  .command("retrieve-depth")
  .description("Obsidian D0-D4 progressive retrieval 실행")
  .requiredOption("--goal <text>", "요청")
  .option("--scope <scopeId>", "스코프 ID")
  .option("--depth <depth>", "D0, D1, D2, D3, D4, auto", "auto")
  .option("-k, --top-k <number>", "상위 N건", "5")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = retrieveDepth(brainRoot, {
        goal: options.goal,
        scopeId: options.scope,
        depth: options.depth,
        topK: parseInt(options.topK, 10)
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

const memoryGraphCmd = program
  .command("memory-graph")
  .description("Memory Graph seed, brief, inspect, evaluate");

memoryGraphCmd
  .command("seed")
  .description("scope 기준 Memory Graph node/edge seed")
  .requiredOption("--scope <scopeId>", "scopeId")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      console.log(JSON.stringify(seedGraphFromSources(brainRoot, { scopeId: options.scope }), null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

memoryGraphCmd
  .command("brief")
  .description("Memory Graph activation brief 생성")
  .requiredOption("--scope <scopeId>", "scopeId")
  .requiredOption("--goal <text>", "요청")
  .option("-k, --top-k <number>", "상위 N건", "8")
  .option("--channel-mode <mode>", "dm 또는 group")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      console.log(JSON.stringify(buildMemoryGraphBrief(brainRoot, {
        scopeId: options.scope,
        goal: options.goal,
        topK: parseInt(options.topK, 10),
        channelMode: options.channelMode
      }), null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

memoryGraphCmd
  .command("inspect")
  .description("Memory Graph 저장소 현황 조회")
  .option("--scope <scopeId>", "scopeId 필터")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const nodes = readNodes(brainRoot).filter(node => !options.scope || node.scopeId === options.scope);
      const nodeIds = new Set(nodes.map(node => node.nodeId));
      const edges = readEdges(brainRoot).filter(edge => nodeIds.has(edge.fromNodeId) || nodeIds.has(edge.toNodeId));
      const activations = readActivationLog(brainRoot).filter(item => !options.scope || item.scopeId === options.scope);
      console.log(JSON.stringify({
        scopeId: options.scope || null,
        nodes: nodes.length,
        edges: edges.length,
        activations: activations.length,
        nodeTypes: countBy(nodes, "nodeType"),
        relations: countBy(edges, "relation")
      }, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

memoryGraphCmd
  .command("evaluate")
  .description("Memory Graph 평가 시나리오 실행")
  .requiredOption("--scope <scopeId>", "scopeId")
  .option("--goal <text>", "요청", "신규 오픈소스 분석해줘")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = evaluateMemoryGraph(brainRoot, {
        scopeId: options.scope,
        goal: options.goal
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "passed") process.exitCode = 2;
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

const policyCmd = program
  .command("policy")
  .description("Memory access policy 조회/override");

policyCmd
  .command("check")
  .description("채널/가시성 기준 접근 허용 여부 확인")
  .requiredOption("--channel-mode <mode>", "채널 모드")
  .requiredOption("--visibility <visibility>", "visibility")
  .option("--conversation <id>", "대화 ID")
  .option("--content <text>", "검사할 본문", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = checkAccess(brainRoot, {
        channelMode: options.channelMode,
        visibility: options.visibility,
        conversationId: options.conversation,
        content: options.content
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.allowed) process.exitCode = 2;
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

policyCmd
  .command("override <action>")
  .description("thread/session override 추가")
  .requiredOption("--channel-mode <mode>", "채널 모드")
  .requiredOption("--conversation <id>", "대화 ID")
  .requiredOption("--visibility <visibility>", "visibility")
  .option("--scope <scope>", "thread 또는 session", "thread")
  .option("--days <n>", "유효 일수", "7")
  .option("--reason <text>", "이유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((action, options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      if (action !== "allow" && action !== "deny") throw new Error("action은 allow 또는 deny만 허용됩니다.");
      const result = upsertOverride(brainRoot, {
        action,
        channelMode: options.channelMode,
        conversationId: options.conversation,
        visibility: options.visibility,
        scope: options.scope,
        days: parseInt(options.days, 10),
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

program
  .command("brief")
  .description("Memory Brief 생성")
  .requiredOption("--project <scopeId>", "프로젝트 scopeId")
  .requiredOption("--goal <text>", "현재 요청")
  .option("--user <userId>", "사용자 ID", "ernham")
  .option("--channel <channel>", "채널", "codex_local")
  .option("--channel-mode <mode>", "dm 또는 group")
  .option("-k, --top-k <number>", "Recall 상위 N건", "5")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const brief = createMemoryBrief(brainRoot, {
        project: options.project,
        goal: options.goal,
        userId: options.user,
        channel: options.channel,
        channelMode: options.channelMode,
        topK: parseInt(options.topK, 10)
      });
      console.log(JSON.stringify(brief, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

program
  .command("guard")
  .description("Memory Brief 기준으로 답변 초안을 검문")
  .requiredOption("--brief <briefIdOrPath>", "briefId 또는 brief JSON 경로")
  .requiredOption("--draft <path>", "답변 초안 파일")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = guardDraft(brainRoot, {
        brief: options.brief,
        draftPath: path.resolve(options.draft)
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "pass") process.exitCode = 2;
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

const smartMemoryCmd = program
  .command("smart-memory")
  .description("Smart Memory 판단과 학습 proposal 조회");

smartMemoryCmd
  .command("proposals")
  .description("Smart Memory Learning Proposal 목록 조회")
  .option("--scope <scopeId>", "스코프 ID")
  .option("--status <status>", "proposal 등 상태 필터")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const proposals = listSmartMemoryProposals(brainRoot, {
        scopeId: options.scope,
        status: options.status
      });
      console.log(JSON.stringify({ proposals, total: proposals.length }, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

smartMemoryCmd
  .command("review")
  .description("Smart Memory Learning Proposal을 수동 승인/반려/수정요청")
  .requiredOption("--proposal <proposalId>", "Smart Memory proposalId")
  .requiredOption("--decision <decision>", "approved, dismissed, needs_changes")
  .option("--reviewer <name>", "검토자", "Codex")
  .option("--reason <text>", "검토 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = reviewSmartMemoryProposal(brainRoot, {
        proposalId: options.proposal,
        decision: options.decision,
        reviewer: options.reviewer,
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

smartMemoryCmd
  .command("apply")
  .description("Approved Smart Memory proposal을 Memory Graph에 적용")
  .requiredOption("--proposal <proposalId>", "Smart Memory proposalId")
  .option("--applied-by <name>", "적용자", "Codex")
  .option("--reason <text>", "적용 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = applyApprovedSmartMemoryProposal(brainRoot, {
        proposalId: options.proposal,
        appliedBy: options.appliedBy,
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

smartMemoryCmd
  .command("policy")
  .description("Smart Memory policy store 조회")
  .option("--scope <scopeId>", "스코프 ID")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const policy = options.scope
        ? getSmartMemoryPolicyForScope(brainRoot, options.scope)
        : readSmartMemoryPolicy(brainRoot);
      console.log(JSON.stringify({ policy }, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

smartMemoryCmd
  .command("evaluation-cases")
  .description("Smart Memory evaluation case 목록 조회")
  .option("--scope <scopeId>", "스코프 ID")
  .option("--seed-defaults", "기본 golden case를 저장한 뒤 조회")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const seeded = options.seedDefaults
        ? seedDefaultSmartMemoryEvaluationCases(brainRoot, { scopeId: options.scope })
        : null;
      const cases = listSmartMemoryEvaluationCases(brainRoot, { scopeId: options.scope });
      console.log(JSON.stringify({ cases, total: cases.length, seeded }, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

smartMemoryCmd
  .command("evaluate")
  .description("Smart Memory evaluation suite 실행")
  .option("--scope <scopeId>", "스코프 ID")
  .option("--seed-defaults", "기본 golden case를 저장한 뒤 실행")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = runSmartMemoryEvaluationSuite(brainRoot, {
        scopeId: options.scope,
        seedDefaults: Boolean(options.seedDefaults)
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "passed") process.exitCode = 2;
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

const growthCmd = program
  .command("growth")
  .description("Growth Signal 조회");

growthCmd
  .command("signals")
  .description("저장된 Growth Signal 목록 조회")
  .option("--scope <scopeId>", "스코프 ID")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const signals = listGrowthSignals(brainRoot, options.scope);
      console.log(JSON.stringify({ signals, total: signals.length }, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("candidates")
  .description("검토 대기 중인 Growth Candidate 목록 조회")
  .option("--scope <scopeId>", "스코프 ID")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const candidates = listGrowthCandidates(brainRoot, options.scope);
      console.log(JSON.stringify({ candidates, total: candidates.length }, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("review")
  .description("Growth Candidate를 수동 승인/반려")
  .requiredOption("--signal <signalId>", "Growth signalId")
  .requiredOption("--decision <decision>", "approved 또는 dismissed")
  .option("--reviewer <name>", "검토자", "Codex")
  .option("--reason <text>", "검토 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = reviewGrowthCandidate(brainRoot, {
        signalId: options.signal,
        decision: options.decision,
        reviewer: options.reviewer,
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("regression-case")
  .description("Approved Growth Candidate에서 회귀 케이스 생성")
  .requiredOption("--signal <signalId>", "Growth signalId")
  .option("--created-by <name>", "생성자", "Codex")
  .option("--reason <text>", "생성 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = createGrowthRegressionCase(brainRoot, {
        signalId: options.signal,
        createdBy: options.createdBy,
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("run-regression")
  .description("Regression case를 실행하고 결과 로그를 남김")
  .requiredOption("--case <caseId>", "Regression caseId")
  .option("--runner <name>", "실행자", "Codex")
  .option("--reason <text>", "실행 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = runGrowthRegressionCase(brainRoot, {
        caseId: options.case,
        runner: options.runner,
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.result.status !== "passed") process.exitCode = 2;
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("propose-promotion")
  .description("Passed regression case에서 promotion proposal 생성")
  .requiredOption("--case <caseId>", "Regression caseId")
  .option("--created-by <name>", "생성자", "Codex")
  .option("--reason <text>", "생성 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = createGrowthPromotionProposal(brainRoot, {
        caseId: options.case,
        createdBy: options.createdBy,
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("review-proposal")
  .description("Promotion proposal을 수동 승인/반려/수정요청")
  .requiredOption("--proposal <proposalId>", "Promotion proposalId")
  .requiredOption("--decision <decision>", "approved, dismissed, needs_changes")
  .option("--reviewer <name>", "검토자", "Codex")
  .option("--reason <text>", "검토 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = reviewGrowthPromotionProposal(brainRoot, {
        proposalId: options.proposal,
        decision: options.decision,
        reviewer: options.reviewer,
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("apply-proposal")
  .description("Approved promotion proposal을 Brain Active State와 promotion log에 적용")
  .requiredOption("--proposal <proposalId>", "Promotion proposalId")
  .option("--applied-by <name>", "적용자", "Codex")
  .option("--reason <text>", "적용 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = applyApprovedGrowthPromotionProposal(brainRoot, {
        proposalId: options.proposal,
        appliedBy: options.appliedBy,
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("project-export")
  .description("Applied promotion을 scope별 프로젝트 소비 패킷으로 조회")
  .requiredOption("--scope <scopeId>", "조회할 프로젝트 scopeId")
  .option("--candidate-type <type>", "capability_patch, playbook_patch, workflow_patch 등 선택 필터")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = listProjectPromotionExports(brainRoot, {
        scopeId: options.scope,
        candidateType: options.candidateType
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("consume-project-export")
  .description("Project Promotion Export를 프로젝트 workspace에 dry-run 또는 승인 apply로 소비")
  .requiredOption("--scope <scopeId>", "소비할 프로젝트 scopeId")
  .requiredOption("--project-root <path>", "소비 대상 프로젝트 루트")
  .option("--mode <mode>", "dry_run 또는 apply", "dry_run")
  .option("--promotion <promotionId>", "특정 promotionId만 소비")
  .option("--candidate-type <type>", "capability_patch, playbook_patch, workflow_patch 등 선택 필터")
  .option("--approval-id <id>", "apply 모드 승인 근거")
  .option("--adapter-registry <path>", "프로젝트별 native adapter registry 경로")
  .option("--verification <path>", "apply pipeline 검증 결과 JSON 경로")
  .option("--require-verification", "apply 전에 검증 결과를 강제")
  .option("--run-verification", "apply 전에 registry/request의 runChecks를 직접 실행")
  .option("--verification-timeout-ms <ms>", "검증 명령 기본 timeout(ms)")
  .option("--requested-by <name>", "요청자", "Codex")
  .option("--reason <text>", "실행 사유", "")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = consumeProjectPromotionExport(brainRoot, {
        scopeId: options.scope,
        projectRoot: options.projectRoot,
        mode: options.mode,
        promotionId: options.promotion,
        candidateType: options.candidateType,
        approvalId: options.approvalId,
        adapterRegistryPath: options.adapterRegistry,
        verificationPath: options.verification,
        requireVerification: options.requireVerification,
        runVerification: options.runVerification,
        verificationTimeoutMs: options.verificationTimeoutMs,
        requestedBy: options.requestedBy,
        reason: options.reason
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "blocked") process.exitCode = 2;
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

growthCmd
  .command("agentforge-export")
  .description("호환용 alias: applied promotion을 agentforge scope 프로젝트 소비 패킷으로 조회")
  .option("--scope <scopeId>", "선택 scopeId 필터", "agentforge")
  .option("--candidate-type <type>", "capability_patch, playbook_patch, workflow_patch 등 선택 필터")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const result = listAgentForgePromotionExports(brainRoot, {
        scopeId: options.scope,
        candidateType: options.candidateType
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

const userOntologyCmd = program
  .command("user-ontology")
  .description("User Ontology 조회");

userOntologyCmd
  .command("show")
  .description("채널 정책이 적용된 사용자 온톨로지 조회")
  .requiredOption("--user <userId>", "사용자 ID")
  .option("--channel <channel>", "채널", "codex_local")
  .option("--channel-mode <mode>", "dm 또는 group")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다.");
      const context = getAllowedUserContext(brainRoot, {
        userId: options.user,
        channel: options.channel,
        channelMode: options.channelMode
      });
      console.log(JSON.stringify(context, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- integrity-monitor 명령 ---
program
  .command("integrity-monitor")
  .description("Brain 기준선 대비 신규 정합성 문제 감시 (삭제·자동복구 없음)")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--baseline <path>", "기준선 JSON 경로")
  .option("--init-baseline", "현재 issue를 명시적으로 기준선으로 저장")
  .option("--record-event", "append-only 사건 JSON 기록")
  .option("--json", "JSON 출력")
  .action((options) => {
    const {
      createIntegrityBaseline,
      defaultBaselinePath,
      publicMonitorResult,
      runIntegrityMonitor,
      writeIntegrityEvent,
      compareWithBaseline,
    } = require("./integrity-monitor");
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) throw new Error("Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
      const baselinePath = path.resolve(options.baseline || defaultBaselinePath(brainRoot));
      let result;
      if (options.initBaseline) {
        const created = createIntegrityBaseline(brainRoot, baselinePath);
        result = compareWithBaseline(created.audit, created.baseline);
        result = { ...result, baselinePath, eventPath: null };
        if (options.recordEvent) result.eventPath = writeIntegrityEvent(brainRoot, result).eventPath;
      } else {
        result = runIntegrityMonitor(brainRoot, { baselinePath, recordEvent: Boolean(options.recordEvent) });
      }
      const output = publicMonitorResult(result);
      if (options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`Brain Integrity Monitor: ${output.status}`);
        console.log(`known=${output.knownIssueCount} new=${output.newIssueCount} resolved=${output.resolvedIssueCount}`);
        if (output.eventPath) console.log(`event=${output.eventPath}`);
      }
      if (output.status === "baseline_missing") process.exitCode = 3;
      else if (output.status === "alert") process.exitCode = 2;
    } catch (error) {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    }
  });
// --- cleanup 명령 ---
program
  .command("cleanup")
  .description("Brain 저장소 무결성 진단 (읽기 전용)")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--dry-run", "호환 옵션: cleanup은 항상 읽기 전용")
  .option("--skip-archive", "호환 옵션: Raw 아카이브는 비활성화됨")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      const { cleanup } = require("./cleanup");
      const report = cleanup(brainRoot);

      console.log("=== Brain Cleanup Audit (read-only) ===\n");
      console.log("1. Raw가 없는 active 참조: " + report.brokenRefs + "건");
      console.log("2. 실제 파일이 없는 manifest 항목: " + report.manifestCleaned + "건");
      console.log("3. work-log 아카이브: 비활성화 (Raw 불변)");
      console.log("4. 완료 표시 핸드오프 후보: " + report.handoffDeprecated + "건");
      console.log("\n어떤 파일이나 인덱스도 수정하지 않았습니다.");
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// --- db 명령어 ---
const dbCmd = program
  .command("db")
  .description("SQLite 인덱스 관리");

dbCmd
  .command("migrate")
  .description("records.jsonl → SQLite FTS5 인덱스 마이그레이션")
  .option("-r, --root <path>", "Brain/ 루트 경로")
  .option("--brain <path>", "팀 Brain 경로")
  .action(async (opts) => {
    const { resolveBrainRoot } = require("./utils");
    const { migrateFromJsonl } = require("./db");
    const brainRoot = resolveBrainRoot(opts);
    process.stdout.write(`마이그레이션 시작: ${brainRoot}\n`);
    try {
      const { migrated, skipped } = migrateFromJsonl(brainRoot);
      process.stdout.write(`완료 — 마이그레이션: ${migrated}건, 건너뜀: ${skipped}건\n`);
      process.stdout.write(`인덱스 위치: ${brainRoot}/90_index/records.db\n`);
    } catch (e) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      process.exit(1);
    }
  });

dbCmd
  .command("status")
  .description("SQLite 인덱스 상태 확인")
  .option("-r, --root <path>", "Brain/ 루트 경로")
  .option("--brain <path>", "팀 Brain 경로")
  .action(async (opts) => {
    const { resolveBrainRoot } = require("./utils");
    const { isDbAvailable, getDb } = require("./db");
    const brainRoot = resolveBrainRoot(opts);
    if (!isDbAvailable(brainRoot)) {
      process.stdout.write("SQLite 인덱스 없음 — brain-cli db migrate 실행 필요\n");
      return;
    }
    const db = getDb(brainRoot);
    const total  = db.prepare("SELECT COUNT(*) as cnt FROM records").get().cnt;
    const active = db.prepare("SELECT COUNT(*) as cnt FROM records WHERE status='active'").get().cnt;
    const fts    = db.prepare("SELECT COUNT(*) as cnt FROM records_fts").get().cnt;
    db.close();
    process.stdout.write(`SQLite 인덱스 상태\n`);
    process.stdout.write(`  전체 레코드: ${total}건\n`);
    process.stdout.write(`  활성 레코드: ${active}건\n`);
    process.stdout.write(`  FTS5 인덱스: ${fts}건\n`);
  });

dbCmd
  .command("embed")
  .description("Phase 2: 전체 레코드에 벡터 임베딩 생성 (sqlite-vec + multilingual-e5-small)")
  .option("-r, --root <path>", "Brain/ 루트 경로")
  .option("--brain <path>", "팀 Brain 경로")
  .action(async (opts) => {
    const { resolveBrainRoot } = require("./utils");
    const { isDbAvailable, batchEmbed } = require("./db");
    const brainRoot = resolveBrainRoot(opts);
    if (!isDbAvailable(brainRoot)) {
      process.stderr.write("ERROR: SQLite 인덱스 없음 — brain-cli db migrate 먼저 실행하세요\n");
      process.exit(1);
    }
    process.stdout.write("벡터 임베딩 시작 (첫 실행 시 모델 다운로드 ~120MB)...\n");
    try {
      const { embedded, skipped } = await batchEmbed(brainRoot, ({ done, total, recordId }) => {
        process.stdout.write(`  [${done}/${total}] ${recordId}\n`);
      });
      process.stdout.write(`완료 — 임베딩: ${embedded}건, 건너뜀: ${skipped}건\n`);
    } catch (e) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      process.exit(1);
    }
  });

// --- wiki 명령어 ---
const wikiCmd = program
  .command("wiki")
  .description("Brain Wiki 관리 (카파시 Wiki 레이어)");

wikiCmd
  .command("compile")
  .description("Raw 레코드를 정제하여 40_wiki/ 하위에 Wiki 문서 생성/갱신")
  .option("-r, --root <path>", "Brain/ 루트 경로 (미지정 시 자동 탐색)")
  .option("--brain <path>", "팀 Brain 경로 (미지정 시 개인 Brain 사용)")
  .option("--scope <scopeId>", "특정 scopeId만 컴파일")
  .option("--full", "전체 재컴파일 (변경 감지 없이 모든 scopeId 대상)")
  .option("--dry-run", "실행 없이 대상 scopeId 목록만 출력")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(options);
      if (!brainRoot) {
        console.error("ERROR: Brain/ 디렉토리를 찾을 수 없습니다. --root 옵션을 사용하세요.");
        process.exit(1);
      }

      const { wikiCompile } = require("./wiki-compile");

      if (options.dryRun) {
        console.log("=== Brain Wiki Compile (dry-run) ===\n");
        const result = wikiCompile(brainRoot, {
          scope: options.scope,
          full: !!options.full,
          dryRun: true
        });
        if (result.dryRunTargets.length === 0) {
          console.log("컴파일 대상 없음 (모든 Wiki가 최신 상태입니다).");
        } else {
          console.log(`컴파일 대상 scopeId (${result.dryRunTargets.length}건):`);
          result.dryRunTargets.forEach(s => console.log(`  - ${s}`));
        }
        return;
      }

      console.log("=== Brain Wiki Compile ===\n");
      const result = wikiCompile(brainRoot, {
        scope: options.scope,
        full: !!options.full,
        dryRun: false
      });

      if (result.compiled.length > 0) {
        console.log(`✅ 컴파일 완료 (${result.compiled.length}건):`);
        result.compiled.forEach(s => console.log(`  - ${s}`));
      }
      if (result.skipped.length > 0) {
        console.log(`⏭ 건너뜀 (${result.skipped.length}건): ${result.skipped.join(", ")}`);
      }
      if (result.errors.length > 0) {
        console.log(`\n❌ 오류 (${result.errors.length}건):`);
        result.errors.forEach(e => console.log(`  - ${e}`));
      }

      if (result.compiled.length > 0) {
        console.log(`\n📖 40_wiki/_index.md 갱신됨`);
      }
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

// ─── lint ─────────────────────────────────────────────────────────────────────
program
  .command("lint")
  .description("Brain 저장소 품질 검사 (7가지 규칙)")
  .option("--json", "결과를 JSON으로 출력")
  .option("--fix-titles", "work-log 제목 재생성 + 30일+ 레코드 archived 처리")
  .option("--dry-run", "--fix-titles와 조합 시 수정 없이 대상만 표시")
  .option("--checks <ids>", "실행할 검사 ID 목록 (쉼표 구분, 예: duplicate,staleness)")
  .action((options) => {
    try {
      const brainRoot = resolveBrainRoot(getDefaultBrainRoot());
      const { lint, fixTitles } = require("./lint");

      if (options.fixTitles) {
        const result = fixTitles(brainRoot, { dryRun: !!options.dryRun });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (options.dryRun) {
          console.log(`[dry-run] 제목 재생성 대상: ${result.fixed}건, archived 대상: ${result.archived}건`);
        } else {
          console.log(`✅ 제목 재생성: ${result.fixed}건, archived: ${result.archived}건`);
          if (result.fixed + result.archived > 0) {
            console.log("  백업: 90_index/records.jsonl.bak");
          }
        }
        return;
      }

      const checksArg = options.checks ? options.checks.split(",") : undefined;
      const { issues, summary } = lint(brainRoot, { checks: checksArg });

      if (options.json) {
        console.log(JSON.stringify({ issues, summary }, null, 2));
        return;
      }

      const grouped = { critical: [], warning: [], info: [] };
      for (const issue of issues) {
        grouped[issue.severity].push(issue);
      }

      if (grouped.critical.length > 0) {
        console.log(`\n🚨 Critical (${grouped.critical.length}건):`);
        grouped.critical.forEach(i => console.log(`  [${i.checkId}] ${i.message}`));
      }
      if (grouped.warning.length > 0) {
        console.log(`\n⚠️  Warning (${grouped.warning.length}건):`);
        grouped.warning.forEach(i => console.log(`  [${i.checkId}] ${i.message}`));
      }
      if (grouped.info.length > 0) {
        console.log(`\nℹ️  Info (${grouped.info.length}건):`);
        grouped.info.forEach(i => console.log(`  [${i.checkId}] ${i.message}`));
      }

      if (issues.length === 0) {
        console.log("✅ 이슈 없음");
      }

      console.log(`\n검사 ${summary.checksRun}개 / 레코드 ${summary.recordsChecked}건 — critical: ${summary.critical}, warning: ${summary.warning}, info: ${summary.info}`);

    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });

program.parse();

