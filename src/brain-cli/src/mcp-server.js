#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { BWTEngine } = require("./bwt");
const { search } = require("./search");
const { getDefaultBrainRoot } = require("./utils");
const { createMemoryBrief } = require("./context-assembler");
const { guardDraft } = require("./answer-guard");
const { checkAccess } = require("./access-policy");
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
  createGrowthPromotionProposal,
  createGrowthRegressionCase,
  listAgentForgePromotionExports,
  listProjectPromotionExports,
  listGrowthCandidates,
  reviewGrowthCandidate,
  reviewGrowthPromotionProposal,
  runGrowthRegressionCase
} = require("./growth-signal");
const { consumeProjectPromotionExport } = require("./project-promotion-consumer");
const { generateCodexImage, getCodexSubscriptionStatus } = require("./codex-image");

const SERVER_INFO = {
  name: "brain-memory-kernel",
  version: "0.2.0"
};

function rootExists(root) {
  return !!root && fs.existsSync(path.join(root, "90_index", "manifest.json"));
}

function resolveMcpBrainRoot() {
  if (process.env.BRAIN_ROOT && rootExists(path.resolve(process.env.BRAIN_ROOT))) {
    return path.resolve(process.env.BRAIN_ROOT);
  }
  const neuralfluxRoot = path.join(os.homedir(), "NeuralfluxBrain");
  if (rootExists(neuralfluxRoot)) return neuralfluxRoot;
  const defaultRoot = getDefaultBrainRoot();
  if (rootExists(defaultRoot)) return defaultRoot;
  throw new Error("Brain root를 찾을 수 없습니다. BRAIN_ROOT 환경변수를 확인하세요.");
}

function getPeerRoots(primaryRoot) {
  return [
    path.join(os.homedir(), "Brain"),
    path.join(os.homedir(), "NeuralfluxBrain")
  ].filter(root => rootExists(root) && path.resolve(root).toLowerCase() !== path.resolve(primaryRoot).toLowerCase());
}

function textContent(text) {
  return {
    content: [
      {
        type: "text",
        text: typeof text === "string" ? text : JSON.stringify(text, null, 2)
      }
    ]
  };
}

function formatRecall(candidates) {
  const relevant = (candidates || []).filter(candidate => (candidate.score || 0) > 0);
  if (relevant.length === 0) return "관련 기억 없음";
  return relevant.map(candidate => {
    const source = candidate._source ? ` [${candidate._source}]` : "";
    const score = typeof candidate.score === "number" ? candidate.score.toFixed(1) : "?";
    const line = `[${score}] [${candidate.recordId}]${source} ${candidate.title} — ${candidate.summary}`;
    return candidate.originalChunkPreview
      ? `${line}\n  원본: ${candidate.originalChunkPreview}`
      : line;
  }).join("\n");
}

function mergeCandidates(items, topK) {
  const byId = new Map();
  for (const item of items) {
    const existing = byId.get(item.recordId);
    if (!existing || (item.score || 0) > (existing.score || 0)) byId.set(item.recordId, item);
  }
  return Array.from(byId.values())
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, topK);
}

function brainRecall(args = {}) {
  const goal = Array.isArray(args.keywords)
    ? args.keywords.join(" ")
    : (args.goal || args.query || args.keyword);
  if (!goal) throw new Error("goal 또는 query 필드가 필요합니다.");
  const brainRoot = resolveMcpBrainRoot();
  const peerRoots = getPeerRoots(brainRoot);
  const topK = Number(args.topK || args.top_k || 5);
  const query = {
    currentGoal: goal,
    goal,
    scopeType: args.scopeType,
    scopeId: args.scopeId,
    type: args.type,
    topK
  };
  const candidates = [];
  for (const root of [brainRoot, ...peerRoots]) {
    try {
      const result = search(root, query);
      candidates.push(...(result.candidates || []).map(candidate => ({
        ...candidate,
        _source: path.basename(root)
      })));
    } catch { /* peer 검색 실패는 MCP 전체 실패로 만들지 않는다 */ }
  }
  return formatRecall(mergeCandidates(candidates, topK));
}

function parseIntent(intentInput) {
  if (typeof intentInput === "object" && intentInput !== null) return intentInput;
  if (typeof intentInput !== "string" || intentInput.trim() === "") {
    throw new Error("intent 필드가 필요합니다. JSON 문자열 또는 객체를 전달하세요.");
  }
  const raw = intentInput.trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  return JSON.parse(raw);
}

function brainWrite(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  const intent = parseIntent(args.intent);
  const engine = new BWTEngine(brainRoot);
  const result = engine.execute(intent);
  if (!result.success) {
    throw new Error(JSON.stringify(result.report, null, 2));
  }
  return {
    ok: true,
    recordId: result.recordId,
    report: result.report
  };
}

async function generateImage(args = {}) {
  return generateCodexImage({
    prompt: args.prompt,
    size: args.size || "1536x1024",
    referenceImages: args.referenceImages
  });
}

async function imageGenerationStatus() {
  return getCodexSubscriptionStatus();
}

function brainBrief(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  const project = args.project || args.scopeId;
  if (!project) throw new Error("project 또는 scopeId 필드가 필요합니다.");
  const brief = createMemoryBrief(brainRoot, {
    project,
    goal: args.goal || "",
    userId: args.userId || args.user || "ernham",
    channel: args.channel || "mcp",
    channelMode: args.channelMode || "desktop_claude",
    conversationId: args.conversationId,
    topK: Number(args.topK || 5),
    depth: args.depth || "auto",
    peerRoots: getPeerRoots(brainRoot)
  });
  return brief;
}

function brainGuard(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  if (!args.brief && !args.briefId) throw new Error("brief 또는 briefId 필드가 필요합니다.");
  if (!args.draftText && !args.draftPath) throw new Error("draftText 또는 draftPath 필드가 필요합니다.");
  return guardDraft(brainRoot, {
    brief: args.brief || args.briefId,
    draftText: args.draftText,
    draftPath: args.draftPath
  });
}

function brainPolicyCheck(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  if (!args.channelMode || !args.visibility) throw new Error("channelMode, visibility 필드가 필요합니다.");
  return checkAccess(brainRoot, {
    channelMode: args.channelMode,
    visibility: args.visibility,
    conversationId: args.conversationId,
    content: args.content || "",
    ref: args.ref || null
  });
}

function brainSmartMemoryProposals(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  const proposals = listSmartMemoryProposals(brainRoot, {
    scopeId: args.scope || args.scopeId,
    status: args.status
  });
  return {
    proposals,
    total: proposals.length
  };
}

function brainSmartMemoryReviewProposal(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return reviewSmartMemoryProposal(brainRoot, {
    proposalId: args.proposalId || args.proposal,
    decision: args.decision,
    reviewer: args.reviewer || "mcp",
    reason: args.reason || ""
  });
}

function brainSmartMemoryApplyProposal(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return applyApprovedSmartMemoryProposal(brainRoot, {
    proposalId: args.proposalId || args.proposal,
    appliedBy: args.appliedBy || args.applied_by || "mcp",
    reason: args.reason || ""
  });
}

function brainSmartMemoryPolicy(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  const scopeId = args.scope || args.scopeId;
  return {
    policy: scopeId
      ? getSmartMemoryPolicyForScope(brainRoot, scopeId)
      : readSmartMemoryPolicy(brainRoot)
  };
}

function brainSmartMemoryEvaluationCases(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  const scopeId = args.scope || args.scopeId;
  const seeded = args.seedDefaults || args.seed_defaults
    ? seedDefaultSmartMemoryEvaluationCases(brainRoot, { scopeId })
    : null;
  const cases = listSmartMemoryEvaluationCases(brainRoot, { scopeId });
  return {
    cases,
    total: cases.length,
    seeded
  };
}

function brainSmartMemoryEvaluate(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return runSmartMemoryEvaluationSuite(brainRoot, {
    scopeId: args.scope || args.scopeId,
    seedDefaults: Boolean(args.seedDefaults || args.seed_defaults),
    userId: args.userId || args.user
  });
}

function brainGrowthCandidates(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  const candidates = listGrowthCandidates(brainRoot, args.scope || args.scopeId);
  return {
    candidates,
    total: candidates.length
  };
}

function brainGrowthReviewCandidate(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return reviewGrowthCandidate(brainRoot, {
    signalId: args.signalId || args.signal,
    decision: args.decision,
    reviewer: args.reviewer || "mcp",
    reason: args.reason || ""
  });
}

function brainGrowthCreateRegressionCase(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return createGrowthRegressionCase(brainRoot, {
    signalId: args.signalId || args.signal,
    createdBy: args.createdBy || args.created_by || "mcp",
    reason: args.reason || ""
  });
}

function brainGrowthRunRegressionCase(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return runGrowthRegressionCase(brainRoot, {
    caseId: args.caseId || args.case,
    runner: args.runner || "mcp",
    reason: args.reason || ""
  });
}

function brainGrowthCreatePromotionProposal(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return createGrowthPromotionProposal(brainRoot, {
    caseId: args.caseId || args.case,
    createdBy: args.createdBy || args.created_by || "mcp",
    reason: args.reason || ""
  });
}

function brainGrowthReviewPromotionProposal(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return reviewGrowthPromotionProposal(brainRoot, {
    proposalId: args.proposalId || args.proposal,
    decision: args.decision,
    reviewer: args.reviewer || "mcp",
    reason: args.reason || ""
  });
}

function brainGrowthApplyPromotionProposal(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return applyApprovedGrowthPromotionProposal(brainRoot, {
    proposalId: args.proposalId || args.proposal,
    appliedBy: args.appliedBy || args.applied_by || "mcp",
    reason: args.reason || ""
  });
}

function brainGrowthAgentForgePromotionExports(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return listAgentForgePromotionExports(brainRoot, {
    scopeId: args.scope || args.scopeId || "agentforge",
    candidateType: args.candidateType || args.candidate_type
  });
}

function brainGrowthProjectPromotionExports(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return listProjectPromotionExports(brainRoot, {
    scopeId: args.scope || args.scopeId,
    candidateType: args.candidateType || args.candidate_type
  });
}

function brainGrowthConsumeProjectPromotionExport(args = {}) {
  const brainRoot = resolveMcpBrainRoot();
  return consumeProjectPromotionExport(brainRoot, {
    scopeId: args.scope || args.scopeId,
    projectRoot: args.projectRoot || args.project_root,
    mode: args.mode || "dry_run",
    promotionId: args.promotionId || args.promotion,
    candidateType: args.candidateType || args.candidate_type,
    approvalId: args.approvalId || args.approval_id,
        adapterRegistryPath: args.adapterRegistryPath || args.adapter_registry_path,
        adapterRegistry: args.adapterRegistry || args.adapter_registry,
        verificationPath: args.verificationPath || args.verification_path,
        verification: args.verification,
        pipelinePolicy: args.pipelinePolicy || args.pipeline_policy,
        requireVerification: args.requireVerification || args.require_verification,
        runVerification: args.runVerification || args.run_verification,
        verificationTimeoutMs: args.verificationTimeoutMs || args.verification_timeout_ms,
        requestedBy: args.requestedBy || args.requested_by || "mcp",
    reason: args.reason || ""
  });
}

const TOOLS = [
  {
    name: "brain_recall",
    description: "Brain 장기기억에서 관련 기억을 검색합니다. primary/peer root를 합산하고 recordId 기준으로 중복 제거합니다.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "검색 목표 또는 키워드" },
        query: { type: "string", description: "goal 대신 사용할 검색어 alias" },
        keyword: { type: "string", description: "goal 대신 사용할 단일 키워드 alias" },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "goal 대신 사용할 복수 키워드 alias"
        },
        topK: { type: "number", description: "반환할 최대 결과 수", default: 5 },
        scopeType: { type: "string", description: "project/topic/user 등 선택 필터" },
        scopeId: { type: "string", description: "스코프 ID 선택 필터" },
        type: { type: "string", description: "record type 선택 필터" }
      }
    }
  },
  {
    name: "brain_write",
    description: "Brain 장기기억에 Intent JSON을 BWT로 저장합니다. write는 MCP primary root에 기록됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { description: "Intent JSON 문자열 또는 객체" }
      },
      required: ["intent"]
    }
  },
  {
    name: "generate_image",
    description: "로그인된 Codex ChatGPT 구독 계정의 내장 image_gen 도구로 이미지를 생성하고 PNG 절대경로를 반환합니다. OpenAI API 키나 유료 API 폴백은 사용하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "생성할 이미지의 상세 설명" },
        size: {
          type: "string",
          enum: [
            "1024x1024", "1536x1024", "1024x1536",
            "2048x2048", "2048x1152", "1152x2048", "2048x1536", "1536x2048"
          ],
          default: "1536x1024",
          description: "이미지 크기. 2048 계열은 2K 네이티브(3D 스캔 입력 등 고해상도 용도)"
        },
        referenceImages: {
          type: "array",
          items: { type: "string" },
          maxItems: 4,
          description: "참조 이미지 로컬 절대경로 최대 4장. 같은 대상의 정체성·얼굴·복장·포즈를 유지한 채 재생성하거나 다른 각도를 만들 때 사용"
        }
      },
      required: ["prompt"]
    }
  },
  {
    name: "image_generation_status",
    description: "Codex CLI가 ChatGPT 구독 계정으로 로그인되어 이미지 생성에 사용 가능한지 확인합니다.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "brain_brief",
    description: "Memory Kernel Brief를 생성합니다. Active State, Fact Ledger, Recall, Obsidian Signals, Smart Memory 판단, 정책 필터 결과를 포함합니다.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "프로젝트 scopeId" },
        scopeId: { type: "string", description: "project 대신 사용할 scopeId" },
        goal: { type: "string", description: "현재 요청" },
        channelMode: { type: "string", description: "codex_local, desktop_claude, telegram_1_1, telegram_multi_agent" },
        conversationId: { type: "string", description: "대화/스레드 ID" },
        topK: { type: "number", default: 5 },
        depth: { type: "string", description: "auto, D0, D1, D2, D3, D4", default: "auto" }
      },
      required: ["goal"]
    }
  },
  {
    name: "brain_guard",
    description: "Memory Brief 기준으로 답변 초안을 검문합니다.",
    inputSchema: {
      type: "object",
      properties: {
        brief: { description: "brief 객체" },
        briefId: { type: "string", description: "저장된 briefId" },
        draftText: { type: "string", description: "답변 초안 텍스트" },
        draftPath: { type: "string", description: "답변 초안 파일 경로" }
      }
    }
  },
  {
    name: "brain_policy_check",
    description: "채널 모드와 visibility 기준으로 기억 접근 가능 여부를 확인합니다.",
    inputSchema: {
      type: "object",
      properties: {
        channelMode: { type: "string" },
        visibility: { type: "string" },
        conversationId: { type: "string" },
        content: { type: "string" },
        ref: { type: "string" }
      },
      required: ["channelMode", "visibility"]
    }
  },
  {
    name: "brain_smart_memory_proposals",
    description: "Smart Memory Learning Proposal 목록을 조회합니다. proposal을 자동 적용하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "선택 scopeId 필터" },
        scopeId: { type: "string", description: "scope 대신 사용할 scopeId 필터" },
        status: { type: "string", description: "proposal 등 상태 필터" }
      }
    }
  },
  {
    name: "brain_smart_memory_review_proposal",
    description: "Smart Memory Learning Proposal을 수동 승인, 반려, 수정요청으로 검토합니다. 실제 Memory Graph 적용은 하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "Smart Memory proposalId" },
        proposal: { type: "string", description: "proposalId alias" },
        decision: { type: "string", description: "approved, dismissed, needs_changes" },
        reviewer: { type: "string", description: "검토자" },
        reason: { type: "string", description: "검토 사유" }
      },
      required: ["decision"]
    }
  },
  {
    name: "brain_smart_memory_apply_proposal",
    description: "Approved Smart Memory proposal을 Memory Graph edge weight에 적용합니다. 적용은 proposalId 기준으로 멱등 처리됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "Smart Memory proposalId" },
        proposal: { type: "string", description: "proposalId alias" },
        appliedBy: { type: "string", description: "적용자" },
        applied_by: { type: "string", description: "appliedBy alias" },
        reason: { type: "string", description: "적용 사유" }
      }
    }
  },
  {
    name: "brain_smart_memory_policy",
    description: "Smart Memory policy store를 조회합니다. scope를 지정하면 해당 scope 정책만 반환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "선택 scopeId 필터" },
        scopeId: { type: "string", description: "scope 대신 사용할 scopeId 필터" }
      }
    }
  },
  {
    name: "brain_smart_memory_evaluation_cases",
    description: "Smart Memory evaluation case 목록을 조회합니다. seedDefaults=true면 기본 golden case를 먼저 저장합니다.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "선택 scopeId 필터" },
        scopeId: { type: "string", description: "scope 대신 사용할 scopeId 필터" },
        seedDefaults: { type: "boolean", description: "기본 golden case 저장 여부" },
        seed_defaults: { type: "boolean", description: "seedDefaults alias" }
      }
    }
  },
  {
    name: "brain_smart_memory_evaluate",
    description: "Smart Memory evaluation suite를 실행하여 기억 선택, 억제, 검증 depth 동작을 회귀 검증합니다.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "선택 scopeId 필터" },
        scopeId: { type: "string", description: "scope 대신 사용할 scopeId 필터" },
        seedDefaults: { type: "boolean", description: "기본 golden case 저장 여부" },
        seed_defaults: { type: "boolean", description: "seedDefaults alias" },
        userId: { type: "string", description: "평가 실행 사용자 ID" },
        user: { type: "string", description: "userId alias" }
      }
    }
  },
  {
    name: "brain_growth_candidates",
    description: "Answer Guard가 생성한 Growth promotionCandidate 검토 목록을 조회합니다. 후보를 자동 적용하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "선택 scopeId 필터" },
        scopeId: { type: "string", description: "scope 대신 사용할 scopeId 필터" }
      }
    }
  },
  {
    name: "brain_growth_review_candidate",
    description: "Growth promotionCandidate를 수동 승인 또는 반려합니다. 실제 capability/playbook 적용은 하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        signalId: { type: "string", description: "Growth signalId" },
        signal: { type: "string", description: "signalId alias" },
        decision: { type: "string", description: "approved 또는 dismissed" },
        reviewer: { type: "string", description: "검토자" },
        reason: { type: "string", description: "검토 사유" }
      },
      required: ["decision"]
    }
  },
  {
    name: "brain_growth_create_regression_case",
    description: "Approved Growth Candidate에서 회귀 케이스를 생성합니다. 실제 capability/playbook 적용은 하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        signalId: { type: "string", description: "Growth signalId" },
        signal: { type: "string", description: "signalId alias" },
        createdBy: { type: "string", description: "생성자" },
        reason: { type: "string", description: "생성 사유" }
      }
    }
  },
  {
    name: "brain_growth_run_regression_case",
    description: "Regression case를 실행하고 결과 로그를 남깁니다. 실제 capability/playbook 적용은 하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "Regression caseId" },
        case: { type: "string", description: "caseId alias" },
        runner: { type: "string", description: "실행자" },
        reason: { type: "string", description: "실행 사유" }
      }
    }
  },
  {
    name: "brain_growth_create_promotion_proposal",
    description: "Passed regression case에서 promotion proposal을 생성합니다. 실제 capability/playbook 적용은 하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "Regression caseId" },
        case: { type: "string", description: "caseId alias" },
        createdBy: { type: "string", description: "생성자" },
        reason: { type: "string", description: "생성 사유" }
      }
    }
  },
  {
    name: "brain_growth_review_promotion_proposal",
    description: "Promotion proposal을 수동 승인, 반려, 수정요청으로 검토합니다. 실제 capability/playbook 적용은 하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "Promotion proposalId" },
        proposal: { type: "string", description: "proposalId alias" },
        decision: { type: "string", description: "approved, dismissed, needs_changes" },
        reviewer: { type: "string", description: "검토자" },
        reason: { type: "string", description: "검토 사유" }
      },
      required: ["decision"]
    }
  },
  {
    name: "brain_growth_apply_promotion_proposal",
    description: "Approved promotion proposal을 Brain 내부 Active State와 promotion log에 적용합니다. 외부 프로젝트 자산은 직접 수정하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "Promotion proposalId" },
        proposal: { type: "string", description: "proposalId alias" },
        appliedBy: { type: "string", description: "적용자" },
        reason: { type: "string", description: "적용 사유" }
      }
    }
  },
  {
    name: "brain_growth_project_promotion_exports",
    description: "Applied growth promotion을 scope별 프로젝트 소비 패킷으로 조회합니다. 외부 프로젝트 자산은 직접 수정하지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "조회할 프로젝트 scopeId" },
        scopeId: { type: "string", description: "scope 대신 사용할 scopeId" },
        candidateType: { type: "string", description: "capability_patch, playbook_patch, workflow_patch 등 선택 필터" },
        candidate_type: { type: "string", description: "candidateType alias" }
      },
      required: ["scope"]
    }
  },
  {
    name: "brain_growth_consume_project_promotion_export",
    description: "Project Promotion Export를 프로젝트 workspace에 dry-run 또는 승인 apply로 소비합니다. apply는 approvalId가 필요합니다.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "소비할 프로젝트 scopeId" },
        scopeId: { type: "string", description: "scope 대신 사용할 scopeId" },
        projectRoot: { type: "string", description: "소비 대상 프로젝트 루트" },
        project_root: { type: "string", description: "projectRoot alias" },
        mode: { type: "string", description: "dry_run 또는 apply", default: "dry_run" },
        promotionId: { type: "string", description: "특정 promotionId만 소비" },
        promotion: { type: "string", description: "promotionId alias" },
        candidateType: { type: "string", description: "capability_patch, playbook_patch, workflow_patch 등 선택 필터" },
        candidate_type: { type: "string", description: "candidateType alias" },
        approvalId: { type: "string", description: "apply 모드 승인 근거" },
        approval_id: { type: "string", description: "approvalId alias" },
        adapterRegistryPath: { type: "string", description: "프로젝트별 native adapter registry 경로" },
        adapter_registry_path: { type: "string", description: "adapterRegistryPath alias" },
        adapterRegistry: { type: "object", description: "inline adapter registry 객체" },
        verificationPath: { type: "string", description: "apply pipeline 검증 결과 JSON 경로" },
        verification_path: { type: "string", description: "verificationPath alias" },
        verification: { type: "object", description: "inline apply verification 객체" },
        pipelinePolicy: { type: "object", description: "inline apply pipeline policy 객체" },
        pipeline_policy: { type: "object", description: "pipelinePolicy alias" },
        requireVerification: { type: "boolean", description: "apply 전에 verification을 강제" },
        require_verification: { type: "boolean", description: "requireVerification alias" },
        runVerification: { type: "boolean", description: "apply 전에 runChecks를 직접 실행" },
        run_verification: { type: "boolean", description: "runVerification alias" },
        verificationTimeoutMs: { type: "number", description: "검증 명령 기본 timeout(ms)" },
        verification_timeout_ms: { type: "number", description: "verificationTimeoutMs alias" },
        requestedBy: { type: "string", description: "요청자" },
        reason: { type: "string", description: "실행 사유" }
      },
      required: ["scope", "projectRoot"]
    }
  },
  {
    name: "brain_growth_agentforge_promotion_exports",
    description: "호환용 alias입니다. agentforge scope의 applied growth promotion을 프로젝트 소비 패킷으로 조회합니다.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "선택 scopeId 필터", default: "agentforge" },
        scopeId: { type: "string", description: "scope 대신 사용할 scopeId 필터" },
        candidateType: { type: "string", description: "capability_patch, playbook_patch, workflow_patch 등 선택 필터" },
        candidate_type: { type: "string", description: "candidateType alias" }
      }
    }
  }
];

async function callTool(name, args) {
  switch (name) {
    case "brain_recall":
      return textContent(brainRecall(args));
    case "brain_write":
      return textContent(brainWrite(args));
    case "generate_image":
      return textContent(await generateImage(args));
    case "image_generation_status":
      return textContent(await imageGenerationStatus());
    case "brain_brief":
      return textContent(brainBrief(args));
    case "brain_guard":
      return textContent(brainGuard(args));
    case "brain_policy_check":
      return textContent(brainPolicyCheck(args));
    case "brain_smart_memory_proposals":
      return textContent(brainSmartMemoryProposals(args));
    case "brain_smart_memory_review_proposal":
      return textContent(brainSmartMemoryReviewProposal(args));
    case "brain_smart_memory_apply_proposal":
      return textContent(brainSmartMemoryApplyProposal(args));
    case "brain_smart_memory_policy":
      return textContent(brainSmartMemoryPolicy(args));
    case "brain_smart_memory_evaluation_cases":
      return textContent(brainSmartMemoryEvaluationCases(args));
    case "brain_smart_memory_evaluate":
      return textContent(brainSmartMemoryEvaluate(args));
    case "brain_growth_candidates":
      return textContent(brainGrowthCandidates(args));
    case "brain_growth_review_candidate":
      return textContent(brainGrowthReviewCandidate(args));
    case "brain_growth_create_regression_case":
      return textContent(brainGrowthCreateRegressionCase(args));
    case "brain_growth_run_regression_case":
      return textContent(brainGrowthRunRegressionCase(args));
    case "brain_growth_create_promotion_proposal":
      return textContent(brainGrowthCreatePromotionProposal(args));
    case "brain_growth_review_promotion_proposal":
      return textContent(brainGrowthReviewPromotionProposal(args));
    case "brain_growth_apply_promotion_proposal":
      return textContent(brainGrowthApplyPromotionProposal(args));
    case "brain_growth_project_promotion_exports":
      return textContent(brainGrowthProjectPromotionExports(args));
    case "brain_growth_consume_project_promotion_export":
      return textContent(brainGrowthConsumeProjectPromotionExport(args));
    case "brain_growth_agentforge_promotion_exports":
      return textContent(brainGrowthAgentForgePromotionExports(args));
    default:
      throw new Error(`알 수 없는 도구: ${name}`);
  }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id, error) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error)
    }
  });
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case "initialize":
        writeResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        });
        break;
      case "ping":
        writeResult(id, {});
        break;
      case "tools/list":
        writeResult(id, { tools: TOOLS });
        break;
      case "tools/call":
        writeResult(id, await callTool(params?.name, params?.arguments || {}));
        break;
      default:
        writeError(id, new Error(`지원하지 않는 MCP method: ${method}`));
    }
  } catch (error) {
    writeError(id, error);
  }
}

function startServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  rl.on("line", line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handleMessage(JSON.parse(trimmed));
    } catch (error) {
      writeError(null, error);
    }
  });
}

if (require.main === module) startServer();

module.exports = {
  TOOLS,
  resolveMcpBrainRoot,
  getPeerRoots,
  brainRecall,
  brainWrite,
  generateImage,
  imageGenerationStatus,
  brainBrief,
  brainGuard,
  brainPolicyCheck,
  brainSmartMemoryProposals,
  brainSmartMemoryReviewProposal,
  brainSmartMemoryApplyProposal,
  brainSmartMemoryPolicy,
  brainSmartMemoryEvaluationCases,
  brainSmartMemoryEvaluate,
  brainGrowthCandidates,
  brainGrowthReviewCandidate,
  brainGrowthCreateRegressionCase,
  brainGrowthRunRegressionCase,
  brainGrowthCreatePromotionProposal,
  brainGrowthReviewPromotionProposal,
  brainGrowthApplyPromotionProposal,
  brainGrowthProjectPromotionExports,
  brainGrowthConsumeProjectPromotionExport,
  brainGrowthAgentForgePromotionExports,
  handleMessage
};
