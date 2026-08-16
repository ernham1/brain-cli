"use strict";

const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");

const brainCliSource = path.join(__dirname, "../brain-cli/src");
const { disposeEmbeddingPipeline, embedRecordById } = require(path.join(brainCliSource, "db"));

let embeddingQueue = Promise.resolve();

parentPort.on("message", ({ recordId }) => {
  embeddingQueue = embeddingQueue.then(async () => {
    try {
      const result = await embedRecordById(workerData.brainRoot, recordId);
      parentPort.postMessage({ ok: true, recordId, result });
    } catch (error) {
      parentPort.postMessage({ ok: false, recordId, error: error.message });
    }
  });
});

parentPort.on("close", async () => {
  await disposeEmbeddingPipeline();
});
