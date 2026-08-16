import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function createBrainRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teleclo-brain-search-v32-"));
  for (const dir of ["10_projects", "90_index", "99_policy"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "99_policy", "brainPolicy.md"), "# Brain policy\n", "utf-8");
  fs.writeFileSync(path.join(root, "90_index", "manifest.json"), JSON.stringify({
    version: "1.0",
    files: [],
    updatedAt: new Date().toISOString()
  }, null, 2), "utf-8");
  fs.writeFileSync(path.join(root, "90_index", "tags.json"), JSON.stringify({
    version: "1.0",
    axes: ["domain", "intent"],
    domain: { values: ["memory"], synonyms: {}, banned: [] },
    intent: { values: ["retrieval"], synonyms: {}, banned: [] }
  }, null, 2), "utf-8");
  const record = {
    recordId: "rec_proj_brain_20260629_2001",
    scopeType: "project",
    scopeId: "brain",
    type: "note",
    title: "텔레클로 검색 UAT",
    summary: "텔레클로가 Brain recall preview를 보존한다",
    tags: ["domain/memory", "intent/retrieval"],
    sourceType: "candidate",
    sourceRef: "10_projects/brain/teleclo-search-uat.md",
    status: "active",
    replacedBy: null,
    deprecationReason: null,
    updatedAt: "2026-06-29T00:00:00.000Z",
    contentHash: "sha256:teleclo-uat",
    originalChunk: "teleclo-search-v32-preview-20260629 원문 미리보기는 텔레클로 도구 출력에 남아야 한다."
  };
  fs.writeFileSync(path.join(root, "90_index", "records.jsonl"), JSON.stringify(record) + "\n", "utf-8");
  fs.writeFileSync(path.join(root, "90_index", "records_digest.txt"), [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `${record.recordId} | ${record.title} | ${record.summary} | ${record.tags.join(",")} | active | note | candidate | ${record.updatedAt}`
  ].join("\n") + "\n", "utf-8");
  return root;
}

test("TeleClo brain_recall UAT preserves Brain search preview without Telegram send", async () => {
  const root = createBrainRoot();
  const previousRoot = process.env.BRAIN_ROOT;
  const previousServer = process.env.BRAIN_SERVER_URL;
  process.env.BRAIN_ROOT = root;
  process.env.BRAIN_SERVER_URL = "http://127.0.0.1:9";
  try {
    const { executeRecall } = await import(`../dist/tools.js?uat=${Date.now()}`);
    const output = await executeRecall({ goal: "텔레클로 검색 UAT preview", topK: 3 }, root, 64445716);

    assert.match(output, /rec_proj_brain_20260629_2001/);
    assert.match(output, /원본:/);
    assert.match(output, /teleclo-search-v32-preview-20260629/);
  } finally {
    if (previousRoot === undefined) delete process.env.BRAIN_ROOT;
    else process.env.BRAIN_ROOT = previousRoot;
    if (previousServer === undefined) delete process.env.BRAIN_SERVER_URL;
    else process.env.BRAIN_SERVER_URL = previousServer;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("TeleClo local recall fallback searches without a full Brain boot", async () => {
  const root = createBrainRoot();
  const previousRoot = process.env.BRAIN_ROOT;
  const previousServer = process.env.BRAIN_SERVER_URL;
  process.env.BRAIN_ROOT = root;
  process.env.BRAIN_SERVER_URL = "http://127.0.0.1:9";
  fs.writeFileSync(path.join(root, "90_index", "manifest.json"), "{invalid", "utf-8");
  try {
    const { executeRecall } = await import(`../dist/tools.js?fallback=${Date.now()}`);
    const output = await executeRecall({ goal: "텔레클로 검색 UAT preview", topK: 3 }, root, 64445716);

    assert.match(output, /rec_proj_brain_20260629_2001/);
    assert.doesNotMatch(output, /Brain 부트 실패/);
  } finally {
    if (previousRoot === undefined) delete process.env.BRAIN_ROOT;
    else process.env.BRAIN_ROOT = previousRoot;
    if (previousServer === undefined) delete process.env.BRAIN_SERVER_URL;
    else process.env.BRAIN_SERVER_URL = previousServer;
    fs.rmSync(root, { recursive: true, force: true });
  }
});