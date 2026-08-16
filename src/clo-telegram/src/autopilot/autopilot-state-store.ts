import fs from "node:fs";
import path from "node:path";
import type { AutopilotIntent } from "./types.js";

export interface PendingAutopilotAction {
  pendingActionId: string;
  chatId: number;
  sourceMessageId?: number;
  userId?: number;
  intent: AutopilotIntent;
  text: string;
  entities: Record<string, string>;
  status: "pending" | "applied" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
}

export interface ChatMemoryPolicy {
  chatId: number;
  allowPersonalMemory: boolean;
  updatedBy?: number;
  updatedAt: string;
}

interface AutopilotState {
  pendingActions: PendingAutopilotAction[];
  chatMemoryPolicies: ChatMemoryPolicy[];
}

export class AutopilotStateStore {
  constructor(private readonly filePath: string) {}

  createPendingAction(input: {
    chatId: number;
    sourceMessageId?: number;
    userId?: number;
    intent: AutopilotIntent;
    text: string;
    entities: Record<string, string>;
    ttlMs?: number;
  }): PendingAutopilotAction {
    const now = Date.now();
    const state = this.load();
    const pendingAction: PendingAutopilotAction = {
      pendingActionId: `auto_${now}_${Math.random().toString(36).slice(2, 8)}`,
      chatId: input.chatId,
      ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      intent: input.intent,
      text: input.text,
      entities: input.entities,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.ttlMs ?? 10 * 60_000)).toISOString(),
    };
    state.pendingActions = [
      pendingAction,
      ...state.pendingActions.filter((item) => item.status === "pending" && new Date(item.expiresAt).getTime() > now),
    ].slice(0, 20);
    this.save(state);
    return pendingAction;
  }

  listPending(chatId: number): PendingAutopilotAction[] {
    const now = Date.now();
    return this.load().pendingActions.filter(
      (item) => item.chatId === chatId && item.status === "pending" && new Date(item.expiresAt).getTime() > now,
    );
  }

  getPendingAction(pendingActionId: string): PendingAutopilotAction | undefined {
    return this.load().pendingActions.find((item) => item.pendingActionId === pendingActionId);
  }

  markPendingAction(
    pendingActionId: string,
    status: PendingAutopilotAction["status"],
  ): PendingAutopilotAction | undefined {
    const state = this.load();
    const index = state.pendingActions.findIndex((item) => item.pendingActionId === pendingActionId);
    if (index < 0) return undefined;
    const updated: PendingAutopilotAction = {
      ...state.pendingActions[index],
      status,
    };
    state.pendingActions[index] = updated;
    this.save(state);
    return updated;
  }

  setChatMemoryPolicy(input: { chatId: number; allowPersonalMemory: boolean; updatedBy?: number }): ChatMemoryPolicy {
    const state = this.load();
    const policy: ChatMemoryPolicy = {
      chatId: input.chatId,
      allowPersonalMemory: input.allowPersonalMemory,
      ...(input.updatedBy !== undefined ? { updatedBy: input.updatedBy } : {}),
      updatedAt: new Date().toISOString(),
    };
    state.chatMemoryPolicies = [
      policy,
      ...state.chatMemoryPolicies.filter((item) => item.chatId !== input.chatId),
    ];
    this.save(state);
    return policy;
  }

  getChatMemoryPolicy(chatId: number): ChatMemoryPolicy | undefined {
    return this.load().chatMemoryPolicies.find((item) => item.chatId === chatId);
  }

  private load(): AutopilotState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<AutopilotState>;
      return {
        pendingActions: Array.isArray(parsed.pendingActions) ? parsed.pendingActions.filter(isPendingAction) : [],
        chatMemoryPolicies: Array.isArray(parsed.chatMemoryPolicies) ? parsed.chatMemoryPolicies.filter(isChatMemoryPolicy) : [],
      };
    } catch {
      return { pendingActions: [], chatMemoryPolicies: [] };
    }
  }

  private save(state: AutopilotState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.filePath);
  }
}

function isPendingAction(value: unknown): value is PendingAutopilotAction {
  const item = value as Partial<PendingAutopilotAction>;
  return typeof item.pendingActionId === "string"
    && typeof item.chatId === "number"
    && typeof item.intent === "string"
    && typeof item.text === "string"
    && typeof item.entities === "object"
    && typeof item.status === "string"
    && typeof item.createdAt === "string"
    && typeof item.expiresAt === "string";
}

function isChatMemoryPolicy(value: unknown): value is ChatMemoryPolicy {
  const item = value as Partial<ChatMemoryPolicy>;
  return typeof item.chatId === "number"
    && typeof item.allowPersonalMemory === "boolean"
    && typeof item.updatedAt === "string";
}
