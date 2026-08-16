"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { boot } = require("../src/boot");
const { BWTEngine } = require("../src/bwt");
const { validate } = require("../src/validate");

describe("BWT/boot 동시 실행", () => {
  it("boot 조회가 진행 중인 BWT 문서 tmp를 건드리지 않아야 한다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-boot-write-race-"));
    const brainRoot = init(parent).brainRoot;

    try {
      const engine = new BWTEngine(brainRoot);
      const originalUpdateRecordsTmp = engine._updateRecordsTmp.bind(engine);
      let bootInvokedWithLiveDocumentTmp = false;

      engine._updateRecordsTmp = function(parsed) {
        const documentTmpPath = path.join(brainRoot, parsed.sourceRef) + ".tmp";
        assert.equal(fs.existsSync(documentTmpPath), true);

        const bootResult = boot(brainRoot);
        assert.equal(bootResult.success, true);
        bootInvokedWithLiveDocumentTmp = true;

        assert.equal(
          fs.existsSync(documentTmpPath),
          true,
          "읽기 경로인 boot가 BWT의 live tmp를 이동하거나 삭제하면 안 된다"
        );
        return originalUpdateRecordsTmp(parsed);
      };

      const result = engine.execute({
        action: "create",
        sourceRef: "10_projects/race-test/20260721-live-tmp.md",
        content: "# BWT live tmp 경쟁 조건 회귀 테스트",
        record: {
          scopeType: "project",
          scopeId: "race-test",
          type: "log",
          title: "BWT live tmp 경쟁 조건",
          summary: "boot는 write 중인 tmp를 건드리지 않는다",
          tags: ["domain/memory", "intent/debug"],
          sourceType: "candidate"
        }
      });

      assert.equal(bootInvokedWithLiveDocumentTmp, true);
      assert.equal(result.success, true, result.report.message);
      assert.equal(validate(brainRoot).passed, true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
