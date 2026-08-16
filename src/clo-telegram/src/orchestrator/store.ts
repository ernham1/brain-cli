import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ArtifactRef,
  AttemptRef,
  CreateOrchestratorTaskInput,
  OrchestratorEvent,
  OrchestratorStatus,
  OrchestratorTask,
  WorkerRef,
} from "./types.js";

const ALLOWED_TRANSITIONS: Record<OrchestratorStatus, OrchestratorStatus[]> = {
  created: ["planned", "failed"],
  planned: ["blocked", "dispatched", "failed"],
  blocked: ["dispatched", "ask", "failed"],
  dispatched: ["running", "failed"],
  running: ["result_received", "failed"],
  result_received: ["verifying", "failed"],
  verifying: ["passed", "rework", "ask", "failed"],
  passed: ["reported"],
  rework: ["dispatched", "ask", "failed"],
  ask: ["reported"],
  failed: ["reported"],
  reported: [],
};

export class OrchestratorStore {
  private readonly tasksDir: string;
  private readonly eventsFile: string;

  constructor(private readonly rootDir = path.join(process.cwd(), "data", "orchestrator")) {
    this.tasksDir = path.join(rootDir, "tasks");
    this.eventsFile = path.join(rootDir, "events.jsonl");
    fs.mkdirSync(this.tasksDir, { recursive: true });
  }

  create(input: CreateOrchestratorTaskInput): OrchestratorTask {
    validateCreateInput(input);

    const now = new Date().toISOString();
    const task: OrchestratorTask = {
      orchestratorTaskId: input.orchestratorTaskId ?? makeId("orch"),
      ...(input.bridgeTaskId !== undefined ? { bridgeTaskId: input.bridgeTaskId } : {}),
      sourceChatId: input.sourceChatId,
      sourceMessageId: input.sourceMessageId,
      targetCwd: input.targetCwd,
      targetAgent: input.targetAgent,
      taskType: input.taskType,
      ownerDirectives: input.ownerDirectives,
      objective: input.objective,
      scope: input.scope,
      instruction: input.instruction,
      status: "created",
      riskLevel: input.riskLevel,
      evaluationProfile: input.evaluationProfile,
      claimLevel: input.claimLevel,
      evaluationPlan: input.evaluationPlan,
      ...(input.workerRef !== undefined ? { workerRef: input.workerRef } : {}),
      artifacts: input.artifacts ?? [],
      attempts: input.attempts ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.writeTask(task);
    this.appendEvent({
      eventId: makeId("event"),
      orchestratorTaskId: task.orchestratorTaskId,
      type: "created",
      status: task.status,
      at: now,
      details: { targetAgent: task.targetAgent, taskType: task.taskType },
    });
    return task;
  }

  get(orchestratorTaskId: string): OrchestratorTask | undefined {
    const filePath = this.taskFilePath(orchestratorTaskId);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as OrchestratorTask;
    } catch {
      return undefined;
    }
  }

  listAll(): OrchestratorTask[] {
    try {
      return fs.readdirSync(this.tasksDir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(fs.readFileSync(path.join(this.tasksDir, file), "utf-8")) as OrchestratorTask)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  findByBridgeTaskId(bridgeTaskId: string): OrchestratorTask | undefined {
    return this.listAll().find((task) => (
      task.bridgeTaskId === bridgeTaskId ||
      task.workerRef?.taskId === bridgeTaskId ||
      task.attempts.some((attempt) => attempt.workerTaskId === bridgeTaskId)
    ));
  }

  transition(
    orchestratorTaskId: string,
    nextStatus: OrchestratorStatus,
    details: Record<string, unknown> = {},
  ): OrchestratorTask {
    const task = this.requireTask(orchestratorTaskId);
    const allowed = ALLOWED_TRANSITIONS[task.status];
    if (!allowed.includes(nextStatus)) {
      throw new Error(`Invalid orchestrator status transition: ${task.status} -> ${nextStatus}`);
    }

    const previousStatus = task.status;
    const updated = this.updateTask(task, { status: nextStatus });
    this.appendEvent({
      eventId: makeId("event"),
      orchestratorTaskId,
      type: "status_changed",
      status: nextStatus,
      previousStatus,
      at: updated.updatedAt,
      details,
    });
    return updated;
  }

  linkWorker(orchestratorTaskId: string, workerRef: WorkerRef): OrchestratorTask {
    const task = this.requireTask(orchestratorTaskId);
    const updated = this.updateTask(task, {
      workerRef,
      ...(workerRef.type === "bridge" ? { bridgeTaskId: workerRef.taskId } : {}),
    });
    this.appendEvent({
      eventId: makeId("event"),
      orchestratorTaskId,
      type: "worker_linked",
      status: updated.status,
      at: updated.updatedAt,
      details: { workerRef },
    });
    return updated;
  }

  addArtifact(orchestratorTaskId: string, artifact: ArtifactRef): OrchestratorTask {
    const task = this.requireTask(orchestratorTaskId);
    const updated = this.updateTask(task, { artifacts: [...task.artifacts, artifact] });
    this.appendEvent({
      eventId: makeId("event"),
      orchestratorTaskId,
      type: "artifact_added",
      status: updated.status,
      at: updated.updatedAt,
      details: { artifactId: artifact.artifactId, kind: artifact.kind },
    });
    return updated;
  }

  addAttempt(orchestratorTaskId: string, attempt: AttemptRef): OrchestratorTask {
    const task = this.requireTask(orchestratorTaskId);
    const updated = this.updateTask(task, { attempts: [...task.attempts, attempt] });
    this.appendEvent({
      eventId: makeId("event"),
      orchestratorTaskId,
      type: "attempt_added",
      status: updated.status,
      at: updated.updatedAt,
      details: { attemptId: attempt.attemptId, attemptNumber: attempt.attemptNumber },
    });
    return updated;
  }

  updateAttempt(
    orchestratorTaskId: string,
    attemptId: string,
    patch: Partial<Omit<AttemptRef, "attemptId" | "attemptNumber" | "startedAt">>,
  ): OrchestratorTask {
    const task = this.requireTask(orchestratorTaskId);
    const attempt = task.attempts.find((item) => item.attemptId === attemptId);
    if (!attempt) throw new Error(`Orchestrator attempt not found: ${attemptId}`);
    const updatedAttempts = task.attempts.map((item) => (
      item.attemptId === attemptId ? { ...item, ...patch } : item
    ));
    const updated = this.updateTask(task, { attempts: updatedAttempts });
    this.appendEvent({
      eventId: makeId("event"),
      orchestratorTaskId,
      type: "attempt_added",
      status: updated.status,
      at: updated.updatedAt,
      details: { attemptId, updated: true, status: patch.status },
    });
    return updated;
  }

  listEvents(orchestratorTaskId?: string): OrchestratorEvent[] {
    try {
      return fs.readFileSync(this.eventsFile, "utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as OrchestratorEvent)
        .filter((event) => !orchestratorTaskId || event.orchestratorTaskId === orchestratorTaskId);
    } catch {
      return [];
    }
  }

  private requireTask(orchestratorTaskId: string): OrchestratorTask {
    const task = this.get(orchestratorTaskId);
    if (!task) throw new Error(`Orchestrator task not found: ${orchestratorTaskId}`);
    return task;
  }

  private updateTask(task: OrchestratorTask, patch: Partial<OrchestratorTask>): OrchestratorTask {
    const updated: OrchestratorTask = {
      ...task,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.writeTask(updated);
    return updated;
  }

  private writeTask(task: OrchestratorTask): void {
    const filePath = this.taskFilePath(task.orchestratorTaskId);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(task, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  private appendEvent(event: OrchestratorEvent): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`, "utf-8");
  }

  private taskFilePath(orchestratorTaskId: string): string {
    return path.join(this.tasksDir, `${orchestratorTaskId}.json`);
  }
}

function validateCreateInput(input: CreateOrchestratorTaskInput): void {
  if (!input.ownerDirectives || typeof input.ownerDirectives.rawInstruction !== "string") {
    throw new Error("ownerDirectives.rawInstruction is required");
  }
  if (!Array.isArray(input.ownerDirectives.successCriteria)) {
    throw new Error("ownerDirectives.successCriteria is required");
  }
  if (!input.evaluationPlan || !Array.isArray(input.evaluationPlan.lockedCriteria)) {
    throw new Error("evaluationPlan.lockedCriteria is required");
  }
  if (input.evaluationPlan.qualityFloor?.explicitDirectivesLocked !== true) {
    throw new Error("evaluationPlan.qualityFloor.explicitDirectivesLocked is required");
  }
  if (input.evaluationPlan.reportFormat !== "mobile_summary") {
    throw new Error("evaluationPlan.reportFormat mobile_summary is required");
  }
  if (input.claimLevel !== "draft" && input.claimLevel !== "review_needed" && input.claimLevel !== "pass_eligible") {
    throw new Error("claimLevel is required");
  }
}

function makeId(prefix: string): string {
  const datePart = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 15);
  return `${prefix}_${datePart}_${crypto.randomBytes(3).toString("hex")}`;
}
