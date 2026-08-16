"use strict";

const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { Worker } = require("node:worker_threads");

// .env 파일 자동 로딩 (dotenv 없이)
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      if (process.env[key] === undefined) process.env[key] = match[2].trim();
    }
  }
}

// brain-cli 모듈 직접 참조 (subprocess 없이)
const BRAIN_CLI_SRC = path.join(__dirname, "../brain-cli/src");
const { BWTEngine } = require(path.join(BRAIN_CLI_SRC, "bwt"));
const { search } = require(path.join(BRAIN_CLI_SRC, "search"));
const { embedText, getDb, isDbAvailable, isVectorAvailable } = require(path.join(BRAIN_CLI_SRC, "db"));
const { teamInit, teamAddMember, teamActivity, teamDecisions } = require(path.join(BRAIN_CLI_SRC, "team"));
const { createMemoryBrief } = require(path.join(BRAIN_CLI_SRC, "context-assembler"));
const { guardDraft } = require(path.join(BRAIN_CLI_SRC, "answer-guard"));
const { checkAccess } = require(path.join(BRAIN_CLI_SRC, "access-policy"));
const {
  applyApprovedSmartMemoryProposal,
  listSmartMemoryProposals,
  reviewSmartMemoryProposal
} = require(path.join(BRAIN_CLI_SRC, "smart-memory-learning"));
const {
  listSmartMemoryEvaluationCases,
  runSmartMemoryEvaluationSuite,
  seedDefaultSmartMemoryEvaluationCases
} = require(path.join(BRAIN_CLI_SRC, "smart-memory-evaluation"));
const {
  getSmartMemoryPolicyForScope,
  readSmartMemoryPolicy
} = require(path.join(BRAIN_CLI_SRC, "smart-memory-policy"));
const {
  applyApprovedGrowthPromotionProposal,
  createGrowthPromotionProposal,
  createGrowthRegressionCase,
  listAgentForgePromotionExports,
  listProjectPromotionExports,
  listGrowthCandidates,
  reviewGrowthCandidate,
  reviewGrowthPromotionProposal,
  runGrowthRegressionCase
} = require(path.join(BRAIN_CLI_SRC, "growth-signal"));
const { consumeProjectPromotionExport } = require(path.join(BRAIN_CLI_SRC, "project-promotion-consumer"));
const { readLatestIntegrityEvent } = require(path.join(BRAIN_CLI_SRC, "integrity-monitor"));

// --- 설정 ---
const PORT = process.env.PORT || 3847;
const API_KEY = process.env.BRAIN_API_KEY || null; // null = 인증 없음 (테스트용)
const BRAIN_ROOT = (() => {
  if (process.env.BRAIN_ROOT) return path.resolve(process.env.BRAIN_ROOT);
  const homeRoot = path.join(os.homedir(), "NeuralfluxBrain");
  if (fs.existsSync(path.join(homeRoot, "90_index"))) return homeRoot;
  const fallback = path.join(os.homedir(), "Brain");
  return fallback;
})();

function envFlag(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

function parsePeerRoots(value) {
  if (value === undefined) return [];
  return String(value)
    .split(/[;,]/)
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => path.resolve(v));
}

// 멀티 루트: 기본 peer는 개인 서버용 기본값이며, 조직 서버는 env로 차단한다.
const DEFAULT_PEER_ROOTS = [
  path.join(os.homedir(), "Brain"),
  path.join(os.homedir(), "NeuralfluxBrain"),
];
const DEFAULT_PEERS_DISABLED = envFlag("BRAIN_DISABLE_DEFAULT_PEERS");
const CONFIGURED_PEER_ROOTS = parsePeerRoots(process.env.BRAIN_PEER_ROOTS);
const PEER_ROOTS = [
  ...CONFIGURED_PEER_ROOTS,
  ...(DEFAULT_PEERS_DISABLED ? [] : DEFAULT_PEER_ROOTS),
]
  .map(r => path.resolve(r))
  .filter((r, index, roots) => (
    fs.existsSync(path.join(r, "90_index")) &&
    r !== BRAIN_ROOT &&
    roots.indexOf(r) === index
  ));

console.log(`Brain Root: ${BRAIN_ROOT}`);
if (PEER_ROOTS.length > 0) {
  console.log(`Peer Roots: ${PEER_ROOTS.join(", ")} (recall 시 합산 검색)`);
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- 미들웨어: API Key 인증 (선택) ---
app.use((req, res, next) => {
  if (!API_KEY) return next(); // API_KEY 미설정 시 인증 없음
  const key = req.headers["x-api-key"] || req.query.apiKey;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "API key가 올바르지 않습니다." });
  }
  next();
});

// --- GET /api/health — 서버 상태 확인 ---
app.get("/api/health", (req, res) => {
  const brainExists = fs.existsSync(path.join(BRAIN_ROOT, "90_index"));
  const latestIntegrityEvent = readLatestIntegrityEvent(BRAIN_ROOT);
  const integrity = latestIntegrityEvent ? {
    status: latestIntegrityEvent.status,
    generatedAt: latestIntegrityEvent.generatedAt,
    summary: latestIntegrityEvent.summary,
    byType: latestIntegrityEvent.byType,
  } : {
    status: "unknown",
    generatedAt: null,
    summary: null,
    byType: {},
  };
  res.json({
    status: "ok",
    brainRoot: BRAIN_ROOT,
    peerRoots: PEER_ROOTS,
    defaultPeersDisabled: DEFAULT_PEERS_DISABLED,
    brainReady: brainExists,
    integrity,
    version: "0.1.0"
  });
});

function shouldEmbedWriteIntent(intent) {
  return intent && (intent.action === "create" || intent.action === "update");
}

let writeEmbeddingWorker = null;

function getWriteEmbeddingWorker() {
  if (writeEmbeddingWorker) return writeEmbeddingWorker;

  const worker = new Worker(path.join(__dirname, "write-embedding-worker.js"), {
    workerData: { brainRoot: BRAIN_ROOT }
  });
  writeEmbeddingWorker = worker;

  worker.on("message", message => {
    if (!message.ok) {
      console.warn(`[Brain Server] ${message.recordId} 임베딩 생성 실패: ${message.error}`);
    }
  });
  worker.on("error", error => {
    console.warn(`[Brain Server] write embedding worker 오류: ${error.message}`);
  });
  worker.on("exit", code => {
    if (writeEmbeddingWorker === worker) writeEmbeddingWorker = null;
    if (code !== 0) console.warn(`[Brain Server] write embedding worker 종료: code=${code}`);
  });

  return worker;
}

function scheduleWriteRecordEmbedding(recordId) {
  try {
    getWriteEmbeddingWorker().postMessage({ recordId });
  } catch (error) {
    console.warn(`[Brain Server] ${recordId} 임베딩 예약 실패: ${error.message}`);
  }
}
// --- POST /api/write — BWT 실행 ---
app.post("/api/write", async (req, res) => {
  try {
    const intent = req.body;
    if (!intent || !intent.action) {
      return res.status(400).json({ error: "Intent JSON이 필요합니다." });
    }

    const engine = new BWTEngine(BRAIN_ROOT);
    const result = engine.execute(intent);

    if (result.success) {
      const response = { success: true, report: result.report, recordId: result.recordId };
      if (shouldEmbedWriteIntent(intent) && result.recordId) {
        scheduleWriteRecordEmbedding(result.recordId);
      }
      res.json(response);
    } else {
      res.status(422).json({ success: false, report: result.report });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function buildQueryEmbeddingBestEffort(goal) {
  if (!goal || !isDbAvailable(BRAIN_ROOT)) return null;

  let db = null;
  try {
    db = getDb(BRAIN_ROOT);
    if (!isVectorAvailable(db)) return null;
    const count = db.prepare("SELECT COUNT(*) as cnt FROM record_vectors").get().cnt;
    if (count <= 0) return null;
    return await embedText(goal, "query");
  } catch {
    return null;
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
// --- POST /api/recall — 검색 (멀티 루트 합산) ---
app.post("/api/recall", async (req, res) => {
  try {
    const { goal, scopeType, scopeId, type, topK = 10 } = req.body;
    if (!goal) {
      return res.status(400).json({ error: "goal 필드가 필요합니다." });
    }

    const queryEmbedding = await buildQueryEmbeddingBestEffort(goal);
    const queryOpts = {
      goal,
      currentGoal: goal,
      scopeType,
      scopeId,
      type,
      topK: parseInt(topK),
      ...(queryEmbedding ? { queryEmbedding } : {})
    };

    // 자기 저장소 검색
    const results = search(BRAIN_ROOT, queryOpts);

    // Peer 저장소 검색 후 합산
    for (const peerRoot of PEER_ROOTS) {
      try {
        const peerResults = search(peerRoot, queryOpts);
        if (peerResults.candidates) {
          // peer 출처 태깅
          for (const c of peerResults.candidates) {
            c._source = path.basename(peerRoot);
          }
          results.candidates = results.candidates || [];
          results.candidates.push(...peerResults.candidates);
          results.total = (results.total || 0) + (peerResults.total || 0);
        }
      } catch (_) {
        // peer 검색 실패는 무시 — 자기 결과만 반환
      }
    }

    // 합산 후 score 내림차순 정렬 + topK 재적용
    if (results.candidates) {
      results.candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
      results.candidates = results.candidates.slice(0, parseInt(topK));
      results.total = results.candidates.length;
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /api/brief — 채널 공통 Memory Brief 생성 ---
app.post("/api/brief", (req, res) => {
  try {
    const { project, scopeId, goal, userId, channel, channelMode, conversationId, topK, depth } = req.body;
    if (!project && !scopeId) {
      return res.status(400).json({ error: "project 또는 scopeId 필드가 필요합니다." });
    }
    const brief = createMemoryBrief(BRAIN_ROOT, {
      project: project || scopeId,
      goal: goal || "",
      userId,
      channel,
      channelMode,
      conversationId,
      topK,
      depth,
      peerRoots: PEER_ROOTS
    });
    res.json({ success: true, brief });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /api/guard — 채널 공통 Answer Guard ---
app.post("/api/guard", (req, res) => {
  try {
    const { brief, briefId, draftText } = req.body;
    if (!brief && !briefId) {
      return res.status(400).json({ error: "brief 또는 briefId 필드가 필요합니다." });
    }
    if (!draftText) {
      return res.status(400).json({ error: "draftText 필드가 필요합니다." });
    }
    const result = guardDraft(BRAIN_ROOT, { brief: brief || briefId, draftText });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /api/policy/check — 기억 접근 정책 확인 ---
app.post("/api/policy/check", (req, res) => {
  try {
    const { channelMode, visibility, conversationId, content, ref } = req.body;
    if (!channelMode || !visibility) {
      return res.status(400).json({ error: "channelMode, visibility 필드가 필요합니다." });
    }
    const result = checkAccess(BRAIN_ROOT, { channelMode, visibility, conversationId, content, ref });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /api/smart-memory/proposals — Smart Memory Learning Proposal 조회 ---
app.get("/api/smart-memory/proposals", (req, res) => {
  try {
    const proposals = listSmartMemoryProposals(BRAIN_ROOT, {
      scopeId: req.query.scope || req.query.scopeId,
      status: req.query.status
    });
    res.json({ success: true, proposals, total: proposals.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- POST /api/smart-memory/proposals/:proposalId/review — Smart Memory proposal 수동 review ---
app.post("/api/smart-memory/proposals/:proposalId/review", (req, res) => {
  try {
    const result = reviewSmartMemoryProposal(BRAIN_ROOT, {
      proposalId: req.params.proposalId,
      decision: req.body.decision,
      reviewer: req.body.reviewer || "http",
      reason: req.body.reason || ""
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /찾을 수 없습니다|이미 review|decision|proposalId/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- POST /api/smart-memory/proposals/:proposalId/apply — approved Smart Memory proposal 적용 ---
app.post("/api/smart-memory/proposals/:proposalId/apply", (req, res) => {
  try {
    const result = applyApprovedSmartMemoryProposal(BRAIN_ROOT, {
      proposalId: req.params.proposalId,
      appliedBy: req.body.appliedBy || req.body.applied_by || "http",
      reason: req.body.reason || ""
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /찾을 수 없습니다|approved Smart Memory proposal|proposalId/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- GET /api/smart-memory/policy — Smart Memory policy store 조회 ---
app.get("/api/smart-memory/policy", (req, res) => {
  try {
    const scopeId = req.query.scope || req.query.scopeId;
    const policy = scopeId
      ? getSmartMemoryPolicyForScope(BRAIN_ROOT, scopeId)
      : readSmartMemoryPolicy(BRAIN_ROOT);
    res.json({ success: true, policy });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- GET /api/smart-memory/evaluation-cases — Smart Memory evaluation case 조회 ---
app.get("/api/smart-memory/evaluation-cases", (req, res) => {
  try {
    const scopeId = req.query.scope || req.query.scopeId;
    const seeded = req.query.seedDefaults === "true" || req.query.seed_defaults === "true"
      ? seedDefaultSmartMemoryEvaluationCases(BRAIN_ROOT, { scopeId })
      : null;
    const cases = listSmartMemoryEvaluationCases(BRAIN_ROOT, { scopeId });
    res.json({ success: true, cases, total: cases.length, seeded });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- POST /api/smart-memory/evaluate — Smart Memory evaluation suite 실행 ---
app.post("/api/smart-memory/evaluate", (req, res) => {
  try {
    const result = runSmartMemoryEvaluationSuite(BRAIN_ROOT, {
      scopeId: req.body.scope || req.body.scopeId,
      seedDefaults: Boolean(req.body.seedDefaults || req.body.seed_defaults),
      userId: req.body.userId || req.body.user
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- GET /api/growth/candidates — Growth Candidate 검토 목록 ---
app.get("/api/growth/candidates", (req, res) => {
  try {
    const candidates = listGrowthCandidates(BRAIN_ROOT, req.query.scope || req.query.scopeId);
    res.json({ success: true, candidates, total: candidates.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /api/growth/promotion-exports — scope별 applied promotion 소비 패킷 ---
app.get("/api/growth/promotion-exports", (req, res) => {
  try {
    const result = listProjectPromotionExports(BRAIN_ROOT, {
      scopeId: req.query.scope || req.query.scopeId,
      candidateType: req.query.candidateType || req.query.candidate_type
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /scopeId/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- POST /api/growth/promotion-exports/consume — Project Promotion Export 소비 ---
app.post("/api/growth/promotion-exports/consume", (req, res) => {
  try {
    const result = consumeProjectPromotionExport(BRAIN_ROOT, {
      scopeId: req.body.scope || req.body.scopeId,
      projectRoot: req.body.projectRoot || req.body.project_root,
      mode: req.body.mode || "dry_run",
      promotionId: req.body.promotionId || req.body.promotion,
      candidateType: req.body.candidateType || req.body.candidate_type,
      approvalId: req.body.approvalId || req.body.approval_id,
      adapterRegistryPath: req.body.adapterRegistryPath || req.body.adapter_registry_path,
      adapterRegistry: req.body.adapterRegistry || req.body.adapter_registry,
      verificationPath: req.body.verificationPath || req.body.verification_path,
      verification: req.body.verification,
      pipelinePolicy: req.body.pipelinePolicy || req.body.pipeline_policy,
      requireVerification: req.body.requireVerification || req.body.require_verification,
      runVerification: req.body.runVerification || req.body.run_verification,
      verificationTimeoutMs: req.body.verificationTimeoutMs || req.body.verification_timeout_ms,
      requestedBy: req.body.requestedBy || req.body.requested_by || "http",
      reason: req.body.reason || ""
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /scopeId|projectRoot|mode|approvalId|projectRoot 밖|찾을 수 없습니다|outside/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- GET /api/growth/agentforge/promotion-exports — 호환용 alias ---
app.get("/api/growth/agentforge/promotion-exports", (req, res) => {
  try {
    const result = listAgentForgePromotionExports(BRAIN_ROOT, {
      scopeId: req.query.scope || req.query.scopeId || "agentforge",
      candidateType: req.query.candidateType || req.query.candidate_type
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- POST /api/growth/candidates/:signalId/review — Growth Candidate 수동 review ---
app.post("/api/growth/candidates/:signalId/review", (req, res) => {
  try {
    const result = reviewGrowthCandidate(BRAIN_ROOT, {
      signalId: req.params.signalId,
      decision: req.body.decision,
      reviewer: req.body.reviewer || "http",
      reason: req.body.reason || ""
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /찾을 수 없습니다|없는 signal|이미 review|decision/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- POST /api/growth/candidates/:signalId/regression-case — approved 후보 회귀 케이스 생성 ---
app.post("/api/growth/candidates/:signalId/regression-case", (req, res) => {
  try {
    const result = createGrowthRegressionCase(BRAIN_ROOT, {
      signalId: req.params.signalId,
      createdBy: req.body.createdBy || req.body.created_by || "http",
      reason: req.body.reason || ""
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /찾을 수 없습니다|approved candidate|promotionCandidate|signalId/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- POST /api/growth/regression-cases/:caseId/run — 회귀 케이스 실행 ---
app.post("/api/growth/regression-cases/:caseId/run", (req, res) => {
  try {
    const result = runGrowthRegressionCase(BRAIN_ROOT, {
      caseId: req.params.caseId,
      runner: req.body.runner || "http",
      reason: req.body.reason || ""
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /찾을 수 없습니다|caseId/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- POST /api/growth/regression-cases/:caseId/promotion-proposal — promotion proposal 생성 ---
app.post("/api/growth/regression-cases/:caseId/promotion-proposal", (req, res) => {
  try {
    const result = createGrowthPromotionProposal(BRAIN_ROOT, {
      caseId: req.params.caseId,
      createdBy: req.body.createdBy || req.body.created_by || "http",
      reason: req.body.reason || ""
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /찾을 수 없습니다|passed regression case|caseId/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- POST /api/growth/promotion-proposals/:proposalId/review — promotion proposal 수동 review ---
app.post("/api/growth/promotion-proposals/:proposalId/review", (req, res) => {
  try {
    const result = reviewGrowthPromotionProposal(BRAIN_ROOT, {
      proposalId: req.params.proposalId,
      decision: req.body.decision,
      reviewer: req.body.reviewer || "http",
      reason: req.body.reason || ""
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /찾을 수 없습니다|이미 review|decision|proposalId/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- POST /api/growth/promotion-proposals/:proposalId/apply — approved proposal 적용 ---
app.post("/api/growth/promotion-proposals/:proposalId/apply", (req, res) => {
  try {
    const result = applyApprovedGrowthPromotionProposal(BRAIN_ROOT, {
      proposalId: req.params.proposalId,
      appliedBy: req.body.appliedBy || req.body.applied_by || "http",
      reason: req.body.reason || ""
    });
    res.json({ success: true, result });
  } catch (err) {
    const status = /찾을 수 없습니다|approved proposal|proposalId/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// --- POST /api/team/init — 팀 Brain 프로젝트 초기화 ---
app.post("/api/team/init", (req, res) => {
  try {
    const { project } = req.body;
    if (!project) {
      return res.status(400).json({ error: "project 필드가 필요합니다." });
    }

    const result = teamInit(BRAIN_ROOT, project);
    res.json({ success: true, project, created: result.created, skipped: result.skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /api/team/add-member — 팀원 등록 ---
app.post("/api/team/add-member", (req, res) => {
  try {
    const { project, member } = req.body;
    if (!project || !member) {
      return res.status(400).json({ error: "project, member 필드가 필요합니다." });
    }

    const result = teamAddMember(BRAIN_ROOT, project, member);
    res.json({ success: true, project, member, isNew: result.isNew, created: result.created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /api/team/config — 팀 설정 조회 ---
app.get("/api/team/config", (req, res) => {
  try {
    const cfgPath = path.join(BRAIN_ROOT, "team-config.json");
    if (!fs.existsSync(cfgPath)) {
      return res.json({ projects: {} });
    }
    const config = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /api/admin/activity — 최근 팀 활동 조회 ---
app.get("/api/admin/activity", (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const project = req.query.project || null;
    const author = req.query.author || null;
    const topK = parseInt(req.query.topK) || 20;
    const result = teamActivity(BRAIN_ROOT, { days, project, author, topK });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /api/admin/decisions — 의사결정 로그 조회 ---
app.get("/api/admin/decisions", (req, res) => {
  try {
    const project = req.query.project || null;
    const topK = parseInt(req.query.topK) || 20;
    const result = teamDecisions(BRAIN_ROOT, { project, topK });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 에러 핸들러 ---
app.use((err, req, res, next) => {
  console.error("서버 오류:", err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════╗
║         Brain Server v0.1.0             ║
╠══════════════════════════════════════════╣
║  포트:       ${String(PORT).padEnd(28)}║
║  Brain Root: ${String(BRAIN_ROOT).slice(0, 28).padEnd(28)}║
║  인증:       ${(API_KEY ? "API Key 활성화" : "없음 (테스트 모드)").padEnd(28)}║
╚══════════════════════════════════════════╝

팀원 접속: http://[이 PC의 IP]:${PORT}
엔드포인트:
  GET  /api/health
  POST /api/write
  POST /api/recall
  POST /api/team/init
  POST /api/team/add-member
  GET  /api/team/config
  GET  /api/admin/activity    ?days=7&project=&author=
  GET  /api/admin/decisions   ?project=&topK=20
`);
});


