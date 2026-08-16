import fs from "node:fs";
import path from "node:path";
import type { CreateTaskParams, TaskResult } from "../bridge.js";
import { formatDecisionBrief, shouldSendDecisionBrief } from "./decision-brief.js";
import { DecisionJournal, type JournalAppendInput, type JournalVerdict } from "./decision-journal.js";
import { EvaluationRunner, type EvaluationDecision, type EvaluationRunResult } from "./evaluation-runner.js";
import { EvaluatorRouter, type EvaluatorRouteResult } from "./evaluator-router.js";
import { ReworkIssuer } from "./rework-issuer.js";
import { OrchestratorStore } from "./store.js";
import { TwinDecider, scanIrreversible, type IrreversibleScan, type TwinDecision, type TwinVerdict } from "./twin-decider.js";
import type {
  ArtifactRef,
  ClaimLevel,
  EvaluationPlan,
  EvaluationProfile,
  EvidenceRequirement,
  GateKind,
  GateSpec,
  OwnerDirectives,
  OrchestratorStatus,
  OrchestratorTask,
  RiskLevel,
  ScopeSpec,
  TargetAgent,
  TaskType,
} from "./types.js";
import { runCoreGates, type GateResult } from "./gates.js";

const CORE_GATE_KINDS: GateKind[] = ["risk", "contract", "evidence"];

export interface BridgeTaskCreator {
  createTask(params: CreateTaskParams): string;
}

export interface TrackBridgeDispatchInput {
  sourceChatId: number;
  sourceMessageId: number;
  targetCwd: string;
  instruction: string;
  targetAgent?: TargetAgent;
  projectHint?: string;
  telecloDecision?: TeleCloOrchestrationDecision;
  bridgeTaskInitialStatus?: "pending" | "launched";
}

export interface TeleCloOrchestrationDecision {
  objective?: string;
  taskType?: TaskType;
  riskLevel?: RiskLevel;
  evaluationProfile?: EvaluationProfile;
  claimLevel?: ClaimLevel;
  successCriteria?: string[];
  hardConstraints?: string[];
  exclusions?: string[];
  priorityHints?: OwnerDirectives["priorityHints"];
  gates?: GateSpec[];
  requiredEvidence?: EvidenceRequirement[];
  notes?: string;
}

interface RuntimePlan {
  ownerDirectives: OwnerDirectives;
  objective: string;
  scope: ScopeSpec;
  taskType: TaskType;
  riskLevel: RiskLevel;
  evaluationProfile: EvaluationProfile;
  claimLevel: ClaimLevel;
  evaluationPlan: EvaluationPlan;
  decisionSource: "teleclo" | "runtime-default";
  notes?: string;
}

export interface TrackBridgeDispatchResult {
  orchestratorTaskId: string;
  bridgeTaskId?: string;
  dispatched: boolean;
  message: string;
}

export interface BridgeResultEvaluation {
  orchestratorTaskId: string;
  evaluation: EvaluationRunResult;
  message: string | null;
  /** 자율 승인 시 내부 로그 (Telegram 전송 대상 아님, 일일 요약용) */
  autoApprovalLog?: string;
  /** 트윈 판정 결과 (ASK/REVIEW_NEEDED 또는 비가역 신호에서만 존재) */
  twinVerdict?: TwinVerdict;
  /** 결정 저널 행 ID (dj-...) · 기록 실패 시 없음 */
  journalId?: string;
}

export interface ReversalOutcome {
  journalId: string;
  status: "reissued" | "failed";
  orchestratorTaskId?: string;
  bridgeTaskId?: string;
  error?: string;
}

export interface DesktopSessionEndInput {
  sourceChatId: number;
  projectPath: string;
  projectName: string;
  reason: string;
  endedAt: string;
  currentTask?: string;
  recentFiles?: string[];
  summary?: string;
  remainingTasks?: string[];
}

export interface DesktopSessionEndHandling {
  action: "continued" | "completed" | "review_needed" | "ignored";
  orchestratorTaskId?: string;
  bridgeTaskId?: string;
  message: string | null;
}

export class OrchestratorBridgeRuntime {
  constructor(
    private readonly options: {
      store?: OrchestratorStore;
      runner?: EvaluationRunner;
      evaluatorRouter?: EvaluatorRouter;
      reworkIssuer?: ReworkIssuer;
      bridgeTaskCreator?: BridgeTaskCreator;
      twinDecider?: TwinDecider;
      decisionJournal?: DecisionJournal;
      /** 감사 GUI가 쓰는 뒤집기 요청 큐 디렉토리 */
      reversalsDir?: string;
    } = {},
  ) {}

  get store(): OrchestratorStore {
    return this.options.store ??= new OrchestratorStore();
  }

  private get twinDecider(): TwinDecider {
    return this.options.twinDecider ??= new TwinDecider();
  }

  private get decisionJournal(): DecisionJournal {
    return this.options.decisionJournal ??= new DecisionJournal();
  }

  private get reversalsDir(): string {
    return this.options.reversalsDir ?? path.join(process.cwd(), "data", "orchestrator", "reversals");
  }

  trackBridgeDispatch(input: TrackBridgeDispatchInput): TrackBridgeDispatchResult {
    const planned = buildRuntimePlan(input);
    const task = this.store.create({
      sourceChatId: input.sourceChatId,
      sourceMessageId: input.sourceMessageId,
      targetCwd: input.targetCwd,
      targetAgent: input.targetAgent ?? "desktop-clo",
      taskType: planned.taskType,
      ownerDirectives: planned.ownerDirectives,
      objective: planned.objective,
      scope: planned.scope,
      instruction: input.instruction,
      riskLevel: planned.riskLevel,
      evaluationProfile: planned.evaluationProfile,
      claimLevel: planned.claimLevel,
      evaluationPlan: planned.evaluationPlan,
    });
    this.store.transition(task.orchestratorTaskId, "planned", {
      profile: planned.evaluationProfile,
      decisionSource: planned.decisionSource,
      ...(planned.notes ? { notes: planned.notes } : {}),
    });

    if (!this.options.bridgeTaskCreator) {
      throw new Error("bridgeTaskCreator is required to dispatch bridge task");
    }

    const bridgeTaskId = this.options.bridgeTaskCreator.createTask({
      sourceChatId: input.sourceChatId,
      sourceMessageId: input.sourceMessageId,
      targetCwd: input.targetCwd,
      instruction: input.instruction,
      ...(input.bridgeTaskInitialStatus ? { initialStatus: input.bridgeTaskInitialStatus } : {}),
    });
    this.store.linkWorker(task.orchestratorTaskId, { type: "bridge", taskId: bridgeTaskId });
    this.store.addAttempt(task.orchestratorTaskId, {
      attemptId: attemptIdForBridgeTask(bridgeTaskId),
      attemptNumber: 1,
      status: "dispatched",
      workerTaskId: bridgeTaskId,
      startedAt: new Date().toISOString(),
    });
    this.store.transition(task.orchestratorTaskId, "dispatched", { bridgeTaskId });

    return {
      orchestratorTaskId: task.orchestratorTaskId,
      bridgeTaskId,
      dispatched: true,
      message: `검증 루프 ID: ${task.orchestratorTaskId}`,
    };
  }

  handleDesktopSessionEnd(input: DesktopSessionEndInput): DesktopSessionEndHandling {
    const remainingTasks = nonEmptyStrings(input.remainingTasks);
    const summary = normalizeOptionalText(input.summary);
    const currentTask = normalizeOptionalText(input.currentTask);

    if (remainingTasks.length > 0) {
      if (!this.options.bridgeTaskCreator) {
        return {
          action: "review_needed",
          message: formatSessionEndReviewNeededBrief(input, remainingTasks),
        };
      }

      const instruction = buildDesktopContinuationInstruction(input, remainingTasks, summary, currentTask);
      const dispatch = this.trackBridgeDispatch({
        sourceChatId: input.sourceChatId,
        sourceMessageId: 0,
        targetCwd: input.projectPath,
        instruction,
        targetAgent: "desktop-clo",
        projectHint: input.projectName,
        telecloDecision: {
          objective: `${input.projectName} 남은 작업 계속 진행`,
          taskType: "general",
          riskLevel: "yellow",
          evaluationProfile: "standard",
          claimLevel: "review_needed",
          successCriteria: remainingTasks,
          hardConstraints: [
            "이전 세션 요약을 사실 주장으로 확정하지 말고 현재 파일 상태를 직접 확인",
            "완료 전 변경 파일과 검증 증거를 결과에 포함",
          ],
          priorityHints: ["verify"],
          notes: "desktop session end remaining tasks continuation",
        },
      });

      return {
        action: "continued",
        orchestratorTaskId: dispatch.orchestratorTaskId,
        ...(dispatch.bridgeTaskId ? { bridgeTaskId: dispatch.bridgeTaskId } : {}),
        message: null,
      };
    }

    if (summary || currentTask || (input.recentFiles?.length ?? 0) > 0) {
      return {
        action: "completed",
        message: null,
      };
    }

    return { action: "ignored", message: null };
  }
  async handleBridgeTaskResult(result: TaskResult): Promise<BridgeResultEvaluation | null> {
    const task = this.store.findByBridgeTaskId(result.taskId);
    if (!task) return null;

    // 멱등 가드: 이 브릿지 task의 attempt가 이미 종결됐으면 중복 결과다
    // (봇 재시작 후 stale 결과 파일 재처리 등). 저널/전이/푸시를 반복하지 않는다.
    const priorAttempt = task.attempts.find(
      (attempt) => attempt.attemptId === attemptIdForBridgeTask(result.taskId),
    );
    if (priorAttempt && (priorAttempt.status === "completed" || priorAttempt.status === "failed")) {
      console.log(`[Orchestrator] 중복 결과 무시 (이미 종결된 attempt): ${result.taskId}`);
      return null;
    }

    let current = this.advanceResultStatus(task, result);
    current = this.addResultArtifacts(current, result);
    current = this.safeTransition(current, "verifying", { bridgeTaskId: result.taskId });

    const gateResults = [
      ...runCoreGates(current),
      ...this.runExternalGateStubs(current),
    ];
    if (result.status === "failed") {
      gateResults.push(makeFailedGate("contract", true, `worker_failed: ${result.result}`));
    }
    if (result.status === "completed" && isBookkeepingOnlyResult(result.result)) {
      gateResults.push(makeFailedGate(
        "evidence",
        true,
        "non_actionable_worker_result: 작업 결과 대신 세션/Brain 기록만 반환됨. 실제 산출물, 검증 결과, 남은 이슈를 결과에 포함해야 함",
      ));
    }

    const runner = this.options.runner ??= new EvaluationRunner();
    const evaluation = runner.run(current, { gateResults });
    const reworkIssuer = this.options.reworkIssuer ??= new ReworkIssuer();
    const issue = reworkIssuer.create(current, evaluation);

    // --- 결정 파이프라인 v2: 비가역 가드 → 트윈 1차 결정 → 결정 저널 ---
    // ASK/REVIEW_NEEDED는 이사님 푸시 전에 트윈이 1차 결정하고,
    // 비가역 신호는 평가 결과(PASS 포함)와 무관하게 인간 전결로 에스컬레이션한다.
    const irreversibleScan = scanIrreversible(current);
    const briefNeeded = shouldSendDecisionBrief(evaluation);

    let message: string | null = null;
    let autoApprovalLog: string | undefined;
    let twinDecision: TwinDecision | null = null;
    let journalId: string | undefined;
    let twinAction: "approve" | "rework" | "none" = "none";

    if (irreversibleScan || briefNeeded) {
      try {
        twinDecision = await this.twinDecider.decideWithLlm(current, evaluation);
      } catch (err) {
        console.error("[Orchestrator] 트윈 판정 오류 · 에스컬레이션 폴백:", err);
        twinDecision = null;
      }

      try {
        journalId = this.decisionJournal.append(
          buildTwinJournalInput(current, evaluation, twinDecision, irreversibleScan),
        );
      } catch (err) {
        // 저널 없이는 자율 결정 금지: 기록 실패 시 무조건 인간 에스컬레이션
        console.error("[Orchestrator] 결정 저널 기록 실패 · 자율 결정 중단, 에스컬레이션:", err);
        journalId = undefined;
      }

      const canActAutonomously = journalId !== undefined && twinDecision !== null;
      if (canActAutonomously && twinDecision!.verdict === "approve") {
        twinAction = "approve";
        autoApprovalLog = `[트윈 승인] ${current.objective} · ${twinDecision!.rationale}`;
      } else if (
        canActAutonomously
        && twinDecision!.verdict === "reject"
        && twinDecision!.reworkInstruction
        && this.options.bridgeTaskCreator
      ) {
        twinAction = "rework";
      } else {
        message = formatDecisionBrief(current, evaluation);
        if (irreversibleScan) {
          message = `${message}\n비고: 비가역 신호("${irreversibleScan.matchedText}") 감지 · 트윈이 대신 결정하지 않습니다.`;
        }
      }
    } else {
      // PASS / REWORK / DRAFT 자율 흐름의 결정도 전부 저널에 남긴다 (감사 대상)
      try {
        journalId = this.decisionJournal.append(buildAutonomousJournalInput(current, evaluation));
      } catch (err) {
        console.error("[Orchestrator] 결정 저널 기록 실패 (자율 흐름은 계속):", err);
      }
    }

    // 자율 승인 로그: Telegram에 보내지 않고 반환 객체에만 기록 (일일 요약용)
    if (!autoApprovalLog && evaluation.decision === "PASS" && !message) {
      autoApprovalLog = `[자율 승인] ${current.objective} · ${evaluation.summary}`;
    }

    const journalDetails = journalId ? { journalId } : {};
    const doRework =
      twinAction === "rework"
      || (!message && evaluation.decision === "REWORK" && issue.mode === "rework" && Boolean(this.options.bridgeTaskCreator));

    if (doRework) {
      const reworkInstruction = twinAction === "rework" ? twinDecision!.reworkInstruction! : issue.instruction;
      this.store.updateAttempt(current.orchestratorTaskId, attemptIdForBridgeTask(result.taskId), {
        status: "failed",
        completedAt: result.completedAt,
        summary: twinAction === "rework" ? `twin-reject: ${evaluation.summary}` : evaluation.summary,
      });
      current = this.safeTransition(current, "rework", {
        reason: evaluation.summary,
        ...(twinAction === "rework" ? { twinVerdict: "reject", dpRefs: twinDecision!.dpRefs } : {}),
        ...journalDetails,
      });
      const bridgeTaskId = this.options.bridgeTaskCreator!.createTask({
        sourceChatId: current.sourceChatId,
        sourceMessageId: current.sourceMessageId,
        targetCwd: current.targetCwd,
        instruction: reworkInstruction,
      });
      this.store.linkWorker(current.orchestratorTaskId, { type: "bridge", taskId: bridgeTaskId });
      this.store.addAttempt(current.orchestratorTaskId, {
        attemptId: attemptIdForBridgeTask(bridgeTaskId),
        attemptNumber: current.attempts.length + 1,
        status: "dispatched",
        workerTaskId: bridgeTaskId,
        startedAt: new Date().toISOString(),
      });
      this.store.transition(current.orchestratorTaskId, "dispatched", {
        bridgeTaskId,
        rework: true,
        ...(twinAction === "rework" ? { twin: true } : {}),
      });
    } else if (twinAction === "approve") {
      this.store.updateAttempt(current.orchestratorTaskId, attemptIdForBridgeTask(result.taskId), {
        status: result.status === "completed" ? "completed" : "failed",
        completedAt: result.completedAt,
        summary: `twin-approve: ${evaluation.summary}`,
      });
      current = this.safeTransition(current, "passed", {
        decision: evaluation.decision,
        twinVerdict: "approve",
        dpRefs: twinDecision!.dpRefs,
        ...journalDetails,
      });
      this.safeTransition(current, "reported", { decision: evaluation.decision, twinVerdict: "approve" });
    } else {
      // 비가역/에스컬레이션 상태에서 평가가 PASS/REWORK/DRAFT여도 자율 확정하지 않는다
      const nextStatus = message && !briefNeeded ? "ask" : evaluation.nextStatus;
      this.store.updateAttempt(current.orchestratorTaskId, attemptIdForBridgeTask(result.taskId), {
        status: result.status === "completed" ? "completed" : "failed",
        completedAt: result.completedAt,
        summary: evaluation.summary,
      });
      current = this.safeTransition(current, nextStatus, {
        decision: evaluation.decision,
        ...(twinDecision ? { twinVerdict: twinDecision.verdict } : {}),
        ...journalDetails,
      });
      if (current.status === "passed" || current.status === "ask" || current.status === "failed") {
        this.safeTransition(current, "reported", { decision: evaluation.decision });
      }
    }

    return {
      orchestratorTaskId: current.orchestratorTaskId,
      evaluation,
      message,
      autoApprovalLog,
      ...(twinDecision ? { twinVerdict: twinDecision.verdict } : {}),
      ...(journalId ? { journalId } : {}),
    };
  }

  /**
   * 감사 GUI가 남긴 뒤집기 요청(reversals/*.json)을 처리해 재작업을 발행한다.
   * 처리한 요청은 done/으로 이동하고 결과를 함께 마킹한다 (실패도 마킹, DP-012).
   */
  processReversalRequests(): ReversalOutcome[] {
    const dir = this.reversalsDir;
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
    } catch {
      return [];
    }

    const outcomes: ReversalOutcome[] = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      const outcome = this.processOneReversal(filePath);
      outcomes.push(outcome);
      try {
        const doneDir = path.join(dir, "done");
        fs.mkdirSync(doneDir, { recursive: true });
        let original: Record<string, unknown> = {};
        try {
          original = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
        } catch {
          original = { unparseable: true };
        }
        fs.writeFileSync(
          path.join(doneDir, file),
          JSON.stringify({ ...original, outcome, processedAt: new Date().toISOString() }, null, 2),
          "utf-8",
        );
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`[Orchestrator] 뒤집기 요청 파일 정리 실패 (${file}):`, err);
        try { fs.renameSync(filePath, `${filePath}.failed`); } catch { /* 다음 tick 재시도 방지 불가 시 무시 */ }
      }
    }
    return outcomes;
  }

  private processOneReversal(filePath: string): ReversalOutcome {
    let request: { journalId?: unknown; note?: unknown };
    try {
      request = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { journalId?: unknown; note?: unknown };
    } catch (err) {
      return { journalId: "unknown", status: "failed", error: `request parse failed: ${String(err)}` };
    }

    const journalId = typeof request.journalId === "string" ? request.journalId.trim() : "";
    if (!journalId) return { journalId: "unknown", status: "failed", error: "journalId missing" };

    const event = this.store.listEvents().find((item) => item.details?.journalId === journalId);
    if (!event) return { journalId, status: "failed", error: "journalId not found in orchestrator events" };

    const task = this.store.get(event.orchestratorTaskId);
    if (!task) return { journalId, status: "failed", error: `task not found: ${event.orchestratorTaskId}` };
    if (!this.options.bridgeTaskCreator) return { journalId, status: "failed", error: "bridgeTaskCreator missing" };

    const note = typeof request.note === "string" && request.note.trim() ? request.note.trim() : "사유 미기재";
    const instruction = [
      "[ORCHESTRATOR_REWORK]",
      "(결정 뒤집기: 이사님이 결정 히스토리 감사에서 트윈 결정을 뒤집어 재작업이 발행됨.)",
      `뒤집기 사유: ${note}`,
      `원 지시: ${task.ownerDirectives.rawInstruction}`,
      `재작업 목표: ${task.objective}`,
      "직접 성공 조건(잠금):",
      ...task.evaluationPlan.lockedCriteria.map((criterion) => `- ${criterion}`),
      "주의: 직접 성공 조건을 낮추지 말고, 완료 보고 전 필요한 증거를 남길 것.",
      "[/ORCHESTRATOR_REWORK]",
    ].join("\n");

    try {
      const dispatch = this.trackBridgeDispatch({
        sourceChatId: task.sourceChatId,
        sourceMessageId: task.sourceMessageId,
        targetCwd: task.targetCwd,
        instruction,
        targetAgent: task.targetAgent,
        telecloDecision: {
          objective: `[뒤집기 재작업] ${task.objective}`,
          taskType: task.taskType,
          riskLevel: task.riskLevel,
          evaluationProfile: task.evaluationProfile === "light" ? "standard" : task.evaluationProfile,
          claimLevel: "review_needed",
          successCriteria: task.evaluationPlan.lockedCriteria,
          notes: `twin-reversal:${journalId}`,
        },
      });
      return {
        journalId,
        status: "reissued",
        orchestratorTaskId: dispatch.orchestratorTaskId,
        ...(dispatch.bridgeTaskId ? { bridgeTaskId: dispatch.bridgeTaskId } : {}),
      };
    } catch (err) {
      return { journalId, status: "failed", error: `rework dispatch failed: ${String(err)}` };
    }
  }

  private advanceResultStatus(task: OrchestratorTask, result: TaskResult): OrchestratorTask {
    let current = task;
    if (current.status === "dispatched") current = this.safeTransition(current, "running", { bridgeTaskId: result.taskId });
    if (current.status === "running") current = this.safeTransition(current, "result_received", { bridgeTaskId: result.taskId });
    return current;
  }

  private addResultArtifacts(task: OrchestratorTask, result: TaskResult): OrchestratorTask {
    const createdAt = result.completedAt;
    let current = this.store.addArtifact(task.orchestratorTaskId, makeResultArtifact(result, "log", createdAt));
    current = this.store.addArtifact(task.orchestratorTaskId, makeResultArtifact(result, "note", createdAt));
    return current;
  }

  private runExternalGateStubs(task: OrchestratorTask): GateResult[] {
    const router = this.options.evaluatorRouter ??= new EvaluatorRouter();
    return task.evaluationPlan.gates
      .filter((gate) => !CORE_GATE_KINDS.includes(gate.kind))
      .map((gate) => routeToGateResult(gate, router.routeGate(gate)));
  }

  private safeTransition(
    task: OrchestratorTask,
    status: OrchestratorStatus,
    details: Record<string, unknown> = {},
  ): OrchestratorTask {
    if (task.status === status) return task;
    try {
      return this.store.transition(task.orchestratorTaskId, status, details);
    } catch {
      return this.store.get(task.orchestratorTaskId) ?? task;
    }
  }
}

function buildDesktopContinuationInstruction(
  input: DesktopSessionEndInput,
  remainingTasks: string[],
  summary?: string,
  currentTask?: string,
): string {
  const lines = [
    "이전 PC 세션 종료 후 남은 작업을 계속 진행하세요.",
    `프로젝트: ${input.projectName}`,
    `경로: ${input.projectPath}`,
    `종료 사유: ${input.reason}`,
    `종료 시각: ${input.endedAt}`,
    "",
    "이전 세션 요약:",
    summary ?? currentTask ?? "요약 없음",
    "",
    "남은 작업:",
    ...remainingTasks.map((task, index) => `${index + 1}. ${task}`),
  ];

  const recentFiles = nonEmptyStrings(input.recentFiles);
  if (recentFiles.length > 0) {
    lines.push("", "최근 파일:", ...recentFiles.slice(-8).map((file) => `- ${file}`));
  }

  lines.push(
    "",
    "진행 기준:",
    "- 현재 파일 상태를 직접 확인한 뒤 진행하세요.",
    "- 남은 작업이 이미 처리됐으면 중복 수정하지 말고 근거를 결과에 남기세요.",
    "- 완료 후 변경 내용, 검증 결과, 남은 이슈를 결과에 포함하세요.",
  );

  return lines.join("\n");
}

function formatSessionEndReviewNeededBrief(input: DesktopSessionEndInput, remainingTasks: string[]): string {
  return [
    "판단: 이사님 결정 필요",
    `프로젝트: ${input.projectName}`,
    "사유: 남은 작업은 감지됐지만 재지시할 브릿지 실행기가 없습니다.",
    `남은 작업: ${remainingTasks.slice(0, 3).join(" / ")}`,
  ].join("\n");
}

function formatSessionEndCompletedBrief(
  input: DesktopSessionEndInput,
  summary?: string,
  currentTask?: string,
): string {
  return [
    "판단: PC 세션 종료 검토",
    `프로젝트: ${input.projectName}`,
    "상태: 종료 요약상 구조화된 남은 작업 없음",
    `요약: ${summary ?? currentTask ?? "요약 없음"}`,
  ].join("\n");
}
function routeToGateResult(gate: GateSpec, route: EvaluatorRouteResult): GateResult {
  const at = new Date().toISOString();
  if (route.status === "routed") {
    return makeFailedGate(
      gate.kind,
      gate.required,
      `environment_missing: ${route.evaluator} evaluator route exists but runtime execution is not connected`,
      at,
    );
  }
  if (route.status === "environment_missing") {
    return {
      kind: gate.kind,
      required: gate.required,
      status: gate.required ? "failed" : "skipped",
      summary: route.reason,
      evidence: [],
      errors: gate.required ? [`environment_missing: ${route.reason}`] : [],
      at,
    };
  }
  return makeFailedGate(gate.kind, gate.required, route.reason, at);
}

function isBookkeepingOnlyResult(resultText: string): boolean {
  const text = resultText.trim();
  if (!text) return true;

  const startsWithBookkeeping = [
    /^세션 기록 완료[:：]/,
    /^Brain에 .*기록/,
    /^브레인에 .*기록/,
    /^핸드오프 기록/,
    /^VS Code 핸드오프/,
  ].some((pattern) => pattern.test(text));
  if (startsWithBookkeeping) return true;

  const hasBrainRecordId = /rec_(topic|proj|user|misc)_[A-Za-z0-9_-]+/.test(text);
  const onlySaysStored = /(Brain|브레인|handoff|핸드오프|세션 기록).*(기록|저장|완료)/.test(text);
  return hasBrainRecordId && onlySaysStored;
}
function makeFailedGate(kind: GateKind, required: boolean, error: string, at = new Date().toISOString()): GateResult {
  return {
    kind,
    required,
    status: required ? "failed" : "skipped",
    summary: error,
    evidence: [],
    errors: required ? [error] : [],
    at,
  };
}

function makeResultArtifact(
  result: TaskResult,
  kind: "log" | "note",
  createdAt: string,
): ArtifactRef {
  return {
    artifactId: `${kind}_${result.taskId}`,
    kind,
    description: result.result,
    createdAt,
  };
}

function attemptIdForBridgeTask(bridgeTaskId: string): string {
  return `attempt_${bridgeTaskId}`;
}

/** 결정 저널 decisionType 축: taskType → dev/product/ops (유형별 분리 집계용) */
function decisionTypeForTask(taskType: OrchestratorTask["taskType"]): string {
  if (taskType === "code" || taskType === "ui") return "dev";
  if (taskType === "research" || taskType === "document") return "product";
  return "ops";
}

function journalProjectForTask(task: OrchestratorTask): string {
  const base = path.basename(task.targetCwd ?? "");
  return base || "unknown";
}

function journalQuestion(task: OrchestratorTask, evaluation: EvaluationRunResult): string {
  return `[${evaluation.decision}] ${task.objective} · ${evaluation.summary}`;
}

/** ASK/REVIEW_NEEDED(또는 비가역 가드)에서 트윈 판정을 저널 행으로 변환 */
function buildTwinJournalInput(
  task: OrchestratorTask,
  evaluation: EvaluationRunResult,
  twin: TwinDecision | null,
  irreversibleScan: IrreversibleScan | null,
): JournalAppendInput {
  return {
    session: "teleclo-orchestrator",
    project: journalProjectForTask(task),
    decisionType: decisionTypeForTask(task.taskType),
    question: journalQuestion(task, evaluation),
    irreversible: twin ? twin.irreversible : Boolean(irreversibleScan),
    irreversibleClass: twin ? twin.irreversibleClass : irreversibleScan?.irreversibleClass ?? null,
    mode: "live",
    blind: false,
    // 트윈 실행 불가(지식팩 부재/판정 오류)는 명시적 null로 기록 (DP-012)
    twin: twin
      ? {
        twinVersion: twin.twinVersion,
        knowledgePackHash: twin.knowledgePackHash,
        verdict: twin.verdict,
        rationale: twin.rationale,
        dpRefs: twin.dpRefs,
        confidence: twin.confidence,
        latencyMs: twin.latencyMs,
      }
      : null,
    human: null,
  };
}

/** PASS/REWORK/DRAFT 자율 흐름의 결정을 저널 행으로 변환 (트윈이 아닌 게이트 자동 결정) */
function buildAutonomousJournalInput(
  task: OrchestratorTask,
  evaluation: EvaluationRunResult,
): JournalAppendInput {
  const verdictByDecision: Partial<Record<EvaluationDecision, JournalVerdict>> = {
    PASS: "approve",
    REWORK: "reject",
    DRAFT: "hold",
  };
  const verdict = verdictByDecision[evaluation.decision] ?? "hold";
  const rationaleByDecision: Partial<Record<EvaluationDecision, string>> = {
    PASS: "자율 승인: 필수 게이트 전수 통과 + 워커 보고 존재",
    REWORK: `자동 재작업: ${evaluation.summary}`,
    DRAFT: "light 프로필 초안 접수 · 자동 보류",
  };
  return {
    session: "teleclo-orchestrator",
    project: journalProjectForTask(task),
    decisionType: decisionTypeForTask(task.taskType),
    question: journalQuestion(task, evaluation),
    irreversible: false,
    irreversibleClass: null,
    mode: "live",
    blind: false,
    twin: {
      twinVersion: "gate-auto",
      knowledgePackHash: "n/a",
      verdict,
      rationale: rationaleByDecision[evaluation.decision] ?? evaluation.summary,
      dpRefs: [],
      latencyMs: 0,
    },
    human: null,
  };
}

function buildRuntimePlan(input: TrackBridgeDispatchInput): RuntimePlan {
  const decision = input.telecloDecision;
  const instruction = normalizeInstruction(input.instruction);
  const successCriteria = nonEmptyStrings(decision?.successCriteria);
  const lockedCriteria = successCriteria.length > 0 ? successCriteria : ["텔레클로가 위임한 원 지시 수행"];
  const evaluationProfile = decision?.evaluationProfile ?? "standard";
  const gates = normalizeGates(decision?.gates);

  const ownerDirectives: OwnerDirectives = {
    rawInstruction: instruction,
    hardConstraints: nonEmptyStrings(decision?.hardConstraints),
    successCriteria: lockedCriteria,
    exclusions: nonEmptyStrings(decision?.exclusions),
    priorityHints: uniquePriorityHints(decision?.priorityHints),
  };

  return {
    ownerDirectives,
    objective: normalizeOptionalText(decision?.objective) ?? lockedCriteria[0] ?? instruction,
    scope: {
      include: [input.projectHint ?? input.targetCwd],
      exclude: ownerDirectives.exclusions,
    },
    taskType: decision?.taskType ?? "general",
    riskLevel: decision?.riskLevel ?? "yellow",
    evaluationProfile,
    claimLevel: decision?.claimLevel ?? "review_needed",
    evaluationPlan: buildEvaluationPlan({
      lockedCriteria,
      gates,
      evaluationProfile,
      requiredEvidence: decision?.requiredEvidence,
    }),
    decisionSource: decision ? "teleclo" : "runtime-default",
    ...(normalizeOptionalText(decision?.notes) ? { notes: normalizeOptionalText(decision?.notes) } : {}),
  };
}

function buildEvaluationPlan(input: {
  lockedCriteria: string[];
  gates: GateSpec[];
  evaluationProfile: EvaluationProfile;
  requiredEvidence?: EvidenceRequirement[];
}): EvaluationPlan {
  const requiredEvidence = normalizeRequiredEvidence(input.requiredEvidence, input.gates);
  return {
    acceptanceCriteria: input.lockedCriteria.map((criterion, index) => ({
      id: `ac_${index + 1}`,
      text: criterion,
      locked: true,
    })),
    requiredEvidence,
    lockedCriteria: [...input.lockedCriteria],
    gates: input.gates,
    flexibility: {
      userRequestedProfile: input.evaluationProfile,
      skippedGates: input.gates
        .filter((gate) => gate.params.skipped === true)
        .map((gate) => ({ kind: gate.kind, reason: String(gate.params.reason ?? "profile adjustment") })),
      advisoryOnly: input.gates
        .filter((gate) => !gate.required)
        .map((gate) => gate.kind),
    },
    qualityFloor: {
      explicitDirectivesLocked: true,
      passRequiresProfile: "standard",
      neverSkip: ["risk", "contract", "evidence"],
    },
    reworkPolicy: {
      maxAttempts: input.evaluationProfile === "light" ? 0 : 1,
      askAfterFailure: true,
    },
    reportFormat: "mobile_summary",
  };
}

function normalizeGates(gates?: GateSpec[]): GateSpec[] {
  const byKind = new Map<GateKind, GateSpec>();
  for (const kind of CORE_GATE_KINDS) {
    byKind.set(kind, { kind, required: true, params: { source: "runtime-default" } });
  }

  for (const gate of gates ?? []) {
    const existing = byKind.get(gate.kind);
    byKind.set(gate.kind, {
      kind: gate.kind,
      required: CORE_GATE_KINDS.includes(gate.kind) ? true : gate.required,
      params: {
        ...(existing?.params ?? {}),
        ...gate.params,
        ...(CORE_GATE_KINDS.includes(gate.kind) ? { neverSkip: true } : {}),
      },
      ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {}),
    });
  }

  return Array.from(byKind.values());
}

function normalizeRequiredEvidence(evidence: EvidenceRequirement[] | undefined, gates: GateSpec[]): EvidenceRequirement[] {
  const normalized = (evidence ?? [])
    .map((item) => ({
      kind: item.kind,
      description: normalizeOptionalText(item.description) ?? `${item.kind} evidence`,
      required: item.required,
    }))
    .filter((item) => item.description.length > 0);

  if (normalized.length > 0) return normalized;

  return gates
    .filter((gate) => gate.required)
    .map((gate) => ({
      kind: gate.kind === "build" || gate.kind === "test" || gate.kind === "lint" ? "command" : "manual_note",
      description: `${gate.kind} gate result`,
      required: true,
    }));
}

function nonEmptyStrings(items?: string[]): string[] {
  return uniqueStrings((items ?? [])
    .map((item) => normalizeOptionalText(item))
    .filter((item): item is string => Boolean(item)));
}

function uniquePriorityHints(hints?: OwnerDirectives["priorityHints"]): OwnerDirectives["priorityHints"] {
  return Array.from(new Set(hints ?? []));
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items));
}

function normalizeInstruction(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeOptionalText(text?: string): string | undefined {
  const normalized = text?.trim().replace(/\s+/g, " ");
  return normalized ? normalized : undefined;
}







