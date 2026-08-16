export type TargetAgent = "desktop-clo" | "codex" | "local" | "bandingai";
export type TaskType = "code" | "ui" | "research" | "document" | "orchestration" | "general";
export type RiskLevel = "green" | "yellow" | "red";
export type EvaluationProfile = "light" | "standard" | "strict";
export type ClaimLevel = "draft" | "review_needed" | "pass_eligible";

export type OrchestratorStatus =
  | "created"
  | "planned"
  | "blocked"
  | "dispatched"
  | "running"
  | "result_received"
  | "verifying"
  | "passed"
  | "rework"
  | "ask"
  | "failed"
  | "reported";

export type GateKind =
  | "risk"
  | "contract"
  | "evidence"
  | "build"
  | "test"
  | "lint"
  | "uatkit"
  | "playwright"
  | "prism"
  | "security"
  | "gunsa"
  | "rubric"
  | "brain_write";

export interface ScopeSpec {
  include: string[];
  exclude: string[];
}

export interface OwnerDirectives {
  rawInstruction: string;
  hardConstraints: string[];
  successCriteria: string[];
  exclusions: string[];
  priorityHints: Array<"fast" | "draft" | "verify" | "strict">;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  locked: boolean;
}

export interface EvidenceRequirement {
  kind: "file" | "command" | "log" | "screenshot" | "api_response" | "manual_note";
  description: string;
  required: boolean;
}

export interface GateSpec {
  kind: GateKind;
  required: boolean;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export interface EvaluationPlan {
  acceptanceCriteria: AcceptanceCriterion[];
  requiredEvidence: EvidenceRequirement[];
  lockedCriteria: string[];
  gates: GateSpec[];
  flexibility: {
    userRequestedProfile?: EvaluationProfile;
    skippedGates: Array<{ kind: GateKind; reason: string }>;
    advisoryOnly: GateKind[];
  };
  qualityFloor: {
    explicitDirectivesLocked: true;
    passRequiresProfile: "standard" | "strict";
    neverSkip: Array<"risk" | "contract" | "evidence">;
  };
  reworkPolicy: {
    maxAttempts: number;
    askAfterFailure: boolean;
  };
  reportFormat: "mobile_summary";
}

export interface ArtifactRef {
  artifactId: string;
  kind: "file" | "log" | "screenshot" | "url" | "note";
  path?: string;
  url?: string;
  description: string;
  createdAt: string;
}

export interface AttemptRef {
  attemptId: string;
  attemptNumber: number;
  status: "dispatched" | "completed" | "failed" | "cancelled";
  workerTaskId?: string;
  summary?: string;
  startedAt: string;
  completedAt?: string;
}

export interface WorkerRef {
  type: "bridge" | "delegated";
  taskId: string;
}

export interface OrchestratorTask {
  orchestratorTaskId: string;
  bridgeTaskId?: string;
  sourceChatId: number;
  sourceMessageId: number;
  targetCwd: string;
  targetAgent: TargetAgent;
  taskType: TaskType;
  ownerDirectives: OwnerDirectives;
  objective: string;
  scope: ScopeSpec;
  instruction: string;
  status: OrchestratorStatus;
  riskLevel: RiskLevel;
  evaluationProfile: EvaluationProfile;
  claimLevel: ClaimLevel;
  evaluationPlan: EvaluationPlan;
  workerRef?: WorkerRef;
  artifacts: ArtifactRef[];
  attempts: AttemptRef[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrchestratorTaskInput {
  orchestratorTaskId?: string;
  bridgeTaskId?: string;
  sourceChatId: number;
  sourceMessageId: number;
  targetCwd: string;
  targetAgent: TargetAgent;
  taskType: TaskType;
  ownerDirectives: OwnerDirectives;
  objective: string;
  scope: ScopeSpec;
  instruction: string;
  riskLevel: RiskLevel;
  evaluationProfile: EvaluationProfile;
  claimLevel: ClaimLevel;
  evaluationPlan: EvaluationPlan;
  workerRef?: WorkerRef;
  artifacts?: ArtifactRef[];
  attempts?: AttemptRef[];
}

export interface OrchestratorEvent {
  eventId: string;
  orchestratorTaskId: string;
  type: "created" | "status_changed" | "worker_linked" | "artifact_added" | "attempt_added";
  status: OrchestratorStatus;
  previousStatus?: OrchestratorStatus;
  at: string;
  details: Record<string, unknown>;
}
