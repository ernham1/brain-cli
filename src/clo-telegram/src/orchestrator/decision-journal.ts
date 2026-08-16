import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 결정 저널 기록기: 파이프라인의 모든 자율/트윈/에스컬레이션 결정을
 * append-only JSONL(월별 분할)로 남긴다.
 *
 * 행 계약의 정본은 decision-pipeline repo의 schemas/journal-row.schema.json이다.
 * 이 모듈은 그 계약을 벗어나는 행을 만들지 않도록 생성 시점에 자체 검증하고,
 * 실패하면 명시적으로 throw하며 아무것도 쓰지 않는다 (DP-002).
 * 스키마 변경 시 이 파일의 검증도 함께 갱신할 것.
 */

export type JournalVerdict = "approve" | "reject" | "hold" | "escalate";
export type JournalHumanDecision = "approve" | "reject" | "hold";

export interface JournalTwinRecord {
  twinVersion: string;
  knowledgePackHash: string;
  verdict: JournalVerdict;
  rationale?: string;
  dpRefs?: string[];
  confidence?: number;
  latencyMs: number;
}

export interface JournalHumanRecord {
  decision: JournalHumanDecision;
  decidedAt: string;
  note?: string;
}

export interface JournalAppendInput {
  session: string;
  project: string;
  decisionType: string;
  question: string;
  options?: string[];
  irreversible: boolean;
  irreversibleClass:
    | "deploy"
    | "delete"
    | "external-send"
    | "financial"
    | "personnel"
    | "external-commitment"
    | null;
  mode?: "shadow" | "live";
  blind?: boolean;
  twin: JournalTwinRecord | null;
  human?: JournalHumanRecord | null;
}

export interface JournalRow extends Required<Pick<JournalAppendInput, "session" | "project" | "decisionType" | "question" | "irreversible" | "irreversibleClass" | "twin">> {
  id: string;
  ts: string;
  options?: string[];
  mode: "shadow" | "live";
  blind: boolean;
  human: JournalHumanRecord | null;
}

const ID_PATTERN = /^dj-[0-9]{8}-[0-9]{4}-[a-z0-9]{4}$/;
const TS_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const DP_PATTERN = /^DP-[0-9]{3}$/;
const IRREVERSIBLE_CLASSES = new Set([
  "deploy", "delete", "external-send", "financial", "personnel", "external-commitment",
]);

export function defaultJournalDir(): string {
  return path.join(os.homedir(), ".claude", "decision-journal");
}

export class DecisionJournal {
  constructor(private readonly dir = defaultJournalDir()) {}

  /** 결정 1건을 저널에 append하고 결정 ID(dj-...)를 반환한다. */
  append(input: JournalAppendInput): string {
    const now = new Date();
    const row: JournalRow = {
      id: makeJournalId(now),
      ts: toKstIso(now),
      session: input.session,
      project: input.project,
      decisionType: input.decisionType,
      question: input.question,
      ...(input.options && input.options.length > 0 ? { options: input.options } : {}),
      irreversible: input.irreversible,
      irreversibleClass: input.irreversibleClass,
      mode: input.mode ?? "live",
      blind: input.blind ?? false,
      twin: input.twin,
      human: input.human ?? null,
    };

    const errors = validateJournalRow(row);
    if (errors.length > 0) {
      throw new Error(`decision journal row validation failed:\n- ${errors.join("\n- ")}`);
    }

    fs.mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, `${row.ts.slice(0, 7)}.jsonl`);
    fs.appendFileSync(target, `${JSON.stringify(row)}\n`, "utf-8");
    return row.id;
  }
}

export function validateJournalRow(row: JournalRow): string[] {
  const errors: string[] = [];
  if (!ID_PATTERN.test(row.id)) errors.push(`id: pattern mismatch (${row.id})`);
  if (!TS_PATTERN.test(row.ts)) errors.push(`ts: pattern mismatch (${row.ts})`);
  for (const key of ["session", "project", "decisionType", "question"] as const) {
    if (typeof row[key] !== "string" || row[key].length === 0) errors.push(`${key}: non-empty string required`);
  }
  if (typeof row.irreversible !== "boolean") errors.push("irreversible: boolean required");
  if (row.irreversible === true && row.irreversibleClass == null) {
    errors.push("irreversibleClass: required when irreversible=true");
  }
  if (row.irreversible === false && row.irreversibleClass != null) {
    errors.push("irreversibleClass: must be null when irreversible=false");
  }
  if (row.irreversibleClass != null && !IRREVERSIBLE_CLASSES.has(row.irreversibleClass)) {
    errors.push(`irreversibleClass: invalid value (${row.irreversibleClass})`);
  }
  if (row.mode !== "shadow" && row.mode !== "live") errors.push("mode: shadow|live required");
  if (typeof row.blind !== "boolean") errors.push("blind: boolean required");

  if (row.twin !== null) {
    if (!row.twin.twinVersion) errors.push("twin.twinVersion: required");
    if (!row.twin.knowledgePackHash) errors.push("twin.knowledgePackHash: required");
    if (!["approve", "reject", "hold", "escalate"].includes(row.twin.verdict)) {
      errors.push(`twin.verdict: invalid (${row.twin.verdict})`);
    }
    if (typeof row.twin.latencyMs !== "number" || row.twin.latencyMs < 0) {
      errors.push("twin.latencyMs: number >= 0 required");
    }
    if (row.twin.confidence !== undefined && (row.twin.confidence < 0 || row.twin.confidence > 1)) {
      errors.push("twin.confidence: 0..1 required");
    }
    for (const ref of row.twin.dpRefs ?? []) {
      if (!DP_PATTERN.test(ref)) errors.push(`twin.dpRefs: invalid ref (${ref})`);
    }
  }

  if (row.human !== null) {
    if (!["approve", "reject", "hold"].includes(row.human.decision)) {
      errors.push(`human.decision: invalid (${row.human.decision})`);
    }
    if (!TS_PATTERN.test(row.human.decidedAt)) errors.push("human.decidedAt: pattern mismatch");
  }
  return errors;
}

function makeJournalId(now: Date): string {
  const kst = kstParts(now);
  const rand = crypto.randomBytes(3).toString("hex").slice(0, 4);
  return `dj-${kst.date}-${kst.time}-${rand}`;
}

function toKstIso(now: Date): string {
  const kst = kstParts(now);
  return `${kst.date.slice(0, 4)}-${kst.date.slice(4, 6)}-${kst.date.slice(6, 8)}T${kst.time.slice(0, 2)}:${kst.time.slice(2, 4)}:${kst.seconds}+09:00`;
}

function kstParts(now: Date): { date: string; time: string; seconds: string } {
  const kstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const iso = new Date(kstMs).toISOString(); // KST 벽시계를 UTC 표기로 얻는다
  return {
    date: iso.slice(0, 10).replace(/-/g, ""),
    time: iso.slice(11, 16).replace(":", ""),
    seconds: iso.slice(17, 19),
  };
}
