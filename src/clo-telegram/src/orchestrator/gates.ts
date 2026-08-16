import fs from "node:fs";
import type {
  ArtifactRef,
  EvidenceRequirement,
  GateKind,
  GateSpec,
  OrchestratorTask,
} from "./types.js";

export type GateResultStatus = "passed" | "failed" | "skipped";

export interface GateRunContext {
  task: OrchestratorTask;
  now?: Date;
  fileExists?: (filePath: string) => boolean;
}

export interface GateResult {
  kind: GateKind;
  required: boolean;
  status: GateResultStatus;
  summary: string;
  evidence: string[];
  errors: string[];
  at: string;
}

const CORE_GATE_KINDS: GateKind[] = ["risk", "contract", "evidence"];

export class GateCore {
  runGate(spec: GateSpec, context: GateRunContext): GateResult {
    const at = (context.now ?? new Date()).toISOString();
    try {
      if (spec.params.skipped === true) {
        return {
          kind: spec.kind,
          required: spec.required,
          status: spec.required ? "failed" : "skipped",
          summary: String(spec.params.reason ?? "gate skipped"),
          evidence: [],
          errors: spec.required ? ["required gate cannot be skipped"] : [],
          at,
        };
      }

      if (spec.kind === "risk") return runRiskGate(spec, context, at);
      if (spec.kind === "contract") return runContractGate(spec, context, at);
      if (spec.kind === "evidence") return runEvidenceGate(spec, context, at);

      return {
        kind: spec.kind,
        required: spec.required,
        status: spec.required ? "failed" : "skipped",
        summary: `gate ${spec.kind} is not implemented in core gate runner`,
        evidence: [],
        errors: spec.required ? [`required gate ${spec.kind} is not implemented`] : [],
        at,
      };
    } catch (error) {
      return {
        kind: spec.kind,
        required: spec.required,
        status: "failed",
        summary: `gate ${spec.kind} threw an error`,
        evidence: [],
        errors: [error instanceof Error ? error.message : String(error)],
        at,
      };
    }
  }
}

export function runCoreGates(task: OrchestratorTask, context: Omit<GateRunContext, "task"> = {}): GateResult[] {
  const runner = new GateCore();
  return buildCoreGateSpecs(task).map((spec) => runner.runGate(spec, { ...context, task }));
}

function buildCoreGateSpecs(task: OrchestratorTask): GateSpec[] {
  const byKind = new Map<GateKind, GateSpec>();
  for (const spec of task.evaluationPlan.gates) {
    if (CORE_GATE_KINDS.includes(spec.kind)) byKind.set(spec.kind, spec);
  }
  for (const kind of CORE_GATE_KINDS) {
    if (!byKind.has(kind)) byKind.set(kind, { kind, required: true, params: { injectedBy: "qualityFloor" } });
  }
  return CORE_GATE_KINDS.map((kind) => byKind.get(kind)).filter((spec): spec is GateSpec => spec !== undefined);
}

function runRiskGate(spec: GateSpec, context: GateRunContext, at: string): GateResult {
  if (context.task.riskLevel === "red") {
    return {
      kind: "risk",
      required: spec.required,
      status: "failed",
      summary: "RED risk requires owner approval before PASS or automatic dispatch",
      evidence: [`riskLevel=${context.task.riskLevel}`],
      errors: ["red risk approval required"],
      at,
    };
  }
  return {
    kind: "risk",
    required: spec.required,
    status: "passed",
    summary: `risk level ${context.task.riskLevel} is allowed for this gate`,
    evidence: [`riskLevel=${context.task.riskLevel}`],
    errors: [],
    at,
  };
}

function runContractGate(spec: GateSpec, context: GateRunContext, at: string): GateResult {
  const task = context.task;
  const errors: string[] = [];

  if (!task.orchestratorTaskId) errors.push("orchestratorTaskId missing");
  if (!task.ownerDirectives?.rawInstruction) errors.push("ownerDirectives.rawInstruction missing");
  if (!Array.isArray(task.ownerDirectives?.successCriteria) || task.ownerDirectives.successCriteria.length === 0) {
    errors.push("ownerDirectives.successCriteria missing");
  }
  if (!Array.isArray(task.evaluationPlan?.lockedCriteria) || task.evaluationPlan.lockedCriteria.length === 0) {
    errors.push("evaluationPlan.lockedCriteria missing");
  }
  if (task.evaluationPlan?.qualityFloor?.explicitDirectivesLocked !== true) {
    errors.push("qualityFloor.explicitDirectivesLocked missing");
  }
  if (task.evaluationProfile === "light" && task.claimLevel === "pass_eligible") {
    errors.push("LIGHT profile cannot be pass_eligible");
  }
  for (const kind of task.evaluationPlan?.qualityFloor?.neverSkip ?? []) {
    const gate = task.evaluationPlan.gates.find((item) => item.kind === kind);
    if (!gate || !gate.required) errors.push(`neverSkip gate ${kind} missing or not required`);
  }

  return {
    kind: "contract",
    required: spec.required,
    status: errors.length === 0 ? "passed" : "failed",
    summary: errors.length === 0 ? "task contract is complete" : "task contract is incomplete",
    evidence: [
      `lockedCriteria=${task.evaluationPlan?.lockedCriteria?.length ?? 0}`,
      `claimLevel=${task.claimLevel}`,
    ],
    errors,
    at,
  };
}

function runEvidenceGate(spec: GateSpec, context: GateRunContext, at: string): GateResult {
  const fileExists = context.fileExists ?? fs.existsSync;
  const requiredEvidence = context.task.evaluationPlan.requiredEvidence.filter((item) => item.required);
  const errors: string[] = [];
  const evidence: string[] = [];

  for (const requirement of requiredEvidence) {
    const match = context.task.artifacts.find((artifact) => evidenceMatches(requirement, artifact, fileExists));
    if (!match) {
      errors.push(`required evidence missing: ${requirement.kind} — ${requirement.description}`);
      continue;
    }
    evidence.push(match.path ?? match.url ?? `${match.kind}:${match.artifactId}`);
  }

  return {
    kind: "evidence",
    required: spec.required,
    status: errors.length === 0 ? "passed" : "failed",
    summary: errors.length === 0 ? "required evidence is present" : "required evidence is missing",
    evidence,
    errors,
    at,
  };
}

function evidenceMatches(
  requirement: EvidenceRequirement,
  artifact: ArtifactRef,
  fileExists: (filePath: string) => boolean,
): boolean {
  if (requirement.kind === "file" && artifact.kind !== "file") return false;
  if (requirement.kind === "command" && artifact.kind !== "log") return false;
  if (requirement.kind === "log" && artifact.kind !== "log") return false;
  if (requirement.kind === "screenshot" && artifact.kind !== "screenshot") return false;
  if (requirement.kind === "manual_note" && artifact.kind !== "note") return false;
  if (requirement.kind === "api_response" && artifact.kind !== "note" && artifact.kind !== "log" && artifact.kind !== "url") {
    return false;
  }

  if (artifact.path) return fileExists(artifact.path);
  return Boolean(artifact.url || artifact.description);
}
