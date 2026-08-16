import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SharedBandingAiRoutingState {
  forced: boolean;
  updatedAt: string;
  updatedBy?: number | string;
  updatedFrom?: "teleclo" | "desktopclo" | "codex" | string;
}

const DEFAULT_STATE: SharedBandingAiRoutingState = {
  forced: false,
  updatedAt: "",
};

export function getSharedBandingAiRoutingStatePath(): string {
  const brainRoot = process.env.BRAIN_ROOT || path.join(os.homedir(), "Brain");
  return path.join(brainRoot, "41_active", "bandingai-routing.json");
}

export function readSharedBandingAiRoutingState(): SharedBandingAiRoutingState {
  const filePath = getSharedBandingAiRoutingStatePath();
  try {
    if (!fs.existsSync(filePath)) return DEFAULT_STATE;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<SharedBandingAiRoutingState>;
    return {
      forced: parsed.forced === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      ...(parsed.updatedBy !== undefined ? { updatedBy: parsed.updatedBy } : {}),
      ...(typeof parsed.updatedFrom === "string" ? { updatedFrom: parsed.updatedFrom } : {}),
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export function writeSharedBandingAiRoutingState(
  forced: boolean,
  updatedBy?: number | string,
  updatedFrom: SharedBandingAiRoutingState["updatedFrom"] = "teleclo",
): SharedBandingAiRoutingState {
  const state: SharedBandingAiRoutingState = {
    forced,
    updatedAt: new Date().toISOString(),
    ...(updatedBy !== undefined ? { updatedBy } : {}),
    ...(updatedFrom ? { updatedFrom } : {}),
  };
  const filePath = getSharedBandingAiRoutingStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
  return state;
}
