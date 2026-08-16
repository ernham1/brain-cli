import type { GateKind, GateSpec, OrchestratorTask } from "./types.js";

export type EvaluatorName =
  | "core"
  | "command"
  | "uatkit"
  | "playwright"
  | "prism"
  | "gunsa"
  | "rubric"
  | "unsupported";

export type EvaluatorRouteStatus = "routed" | "environment_missing" | "unsupported";

export interface EvaluatorRouterContext {
  baseUrl?: string;
  sourceContext?: string;
  availableEvaluators?: Partial<Record<EvaluatorName, boolean>>;
}

export interface EvaluatorRouteResult {
  kind: GateKind;
  required: boolean;
  evaluator: EvaluatorName;
  status: EvaluatorRouteStatus;
  reason: string;
}

export class EvaluatorRouter {
  routeGate(gate: GateSpec, context: EvaluatorRouterContext = {}): EvaluatorRouteResult {
    const evaluator = evaluatorForGate(gate.kind);
    if (evaluator === "unsupported") {
      return {
        kind: gate.kind,
        required: gate.required,
        evaluator,
        status: "unsupported",
        reason: `no evaluator route for ${gate.kind}`,
      };
    }

    const missingReason = missingEnvironmentReason(evaluator, context);
    if (missingReason) {
      return {
        kind: gate.kind,
        required: gate.required,
        evaluator,
        status: "environment_missing",
        reason: missingReason,
      };
    }

    return {
      kind: gate.kind,
      required: gate.required,
      evaluator,
      status: "routed",
      reason: `${gate.kind} routed to ${evaluator}`,
    };
  }

  routeTask(task: OrchestratorTask, context: EvaluatorRouterContext = {}): EvaluatorRouteResult[] {
    return task.evaluationPlan.gates.map((gate) => this.routeGate(gate, context));
  }
}

function evaluatorForGate(kind: GateKind): EvaluatorName {
  switch (kind) {
    case "risk":
    case "contract":
    case "evidence":
    case "security":
    case "brain_write":
      return "core";
    case "build":
    case "test":
    case "lint":
      return "command";
    case "uatkit":
      return "uatkit";
    case "playwright":
      return "playwright";
    case "prism":
      return "prism";
    case "gunsa":
      return "gunsa";
    case "rubric":
      return "rubric";
  }
}

function missingEnvironmentReason(evaluator: EvaluatorName, context: EvaluatorRouterContext): string | null {
  const available = context.availableEvaluators?.[evaluator] ?? evaluator === "core";
  if (!available) return `${evaluator} evaluator is not available`;
  if ((evaluator === "uatkit" || evaluator === "playwright") && !context.baseUrl) {
    return `${evaluator} requires baseUrl`;
  }
  if (evaluator === "prism" && !context.sourceContext) {
    return "prism requires sourceContext";
  }
  return null;
}
