"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function argValue(name) {
  const arg = process.argv.find(item => item.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

function loadRecoveryRecords(files) {
  const byId = new Map();
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const record of report.created || []) {
      if (record.recordId) byId.set(record.recordId, record);
    }
  }
  return [...byId.values()];
}

function main() {
  const brainRoot = path.resolve(argValue("root"));
  const backupDbPath = path.resolve(argValue("backup-db"));
  const peerRoot = argValue("peer-root") ? path.resolve(argValue("peer-root")) : null;
  const recoveryFiles = String(argValue("recovery-reports") || "").split(";").filter(Boolean).map(file => path.resolve(file));
  const outputPath = path.resolve(argValue("output"));

  const db = new Database(path.join(brainRoot, "90_index", "records.db"), { readonly: true, fileMustExist: true });
  const currentRows = db.prepare("SELECT record_id, source_ref, title, status FROM records").all();
  const integrity = db.pragma("integrity_check").map(row => Object.values(row)[0]);
  const areswar = db.prepare(`
    SELECT record_id, source_ref, status, replaced_by
    FROM records
    WHERE record_id IN (
      'rec_proj_areswar_20260716_0001',
      'rec_proj_areswar_20260716_0002',
      'rec_proj_areswar_20260716_0003',
      'rec_proj_areswar_20260716_0004',
      'rec_proj_areswar_20260716_0005'
    )
    ORDER BY record_id
  `).all();
  db.close();

  const backupDb = new Database(backupDbPath, { readonly: true, fileMustExist: true });
  const backupRows = backupDb.prepare("SELECT record_id, source_ref, title, status FROM records").all();
  backupDb.close();
  const currentById = new Map(currentRows.map(row => [row.record_id, row]));
  const missingPreexisting = backupRows.filter(row => !currentById.has(row.record_id));
  const changedIdentity = backupRows.filter(row => {
    const current = currentById.get(row.record_id);
    return current && (current.source_ref !== row.source_ref || current.title !== row.title);
  }).map(row => ({ before: row, after: currentById.get(row.record_id) }));

  const jsonlPath = path.join(brainRoot, "90_index", "records.jsonl");
  const jsonl = fs.readFileSync(jsonlPath, "utf-8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const jsonlIds = new Set(jsonl.map(record => record.recordId));
  const duplicateJsonlIds = [...new Set(jsonl.map(record => record.recordId).filter((id, index, ids) => ids.indexOf(id) !== index))];
  const digest = fs.readFileSync(path.join(brainRoot, "90_index", "records_digest.txt"), "utf-8");
  const recovered = loadRecoveryRecords(recoveryFiles);

  let peerIntegrity = null;
  if (peerRoot) {
    const peerDb = new Database(path.join(peerRoot, "90_index", "records.db"), { readonly: true, fileMustExist: true });
    peerIntegrity = peerDb.pragma("integrity_check").map(row => Object.values(row)[0]);
    peerDb.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mainIntegrity: integrity,
    peerIntegrity,
    currentDbRecords: currentRows.length,
    currentJsonlRecords: jsonl.length,
    duplicateJsonlIds,
    preRecoveryBackupRecords: backupRows.length,
    missingPreexistingCount: missingPreexisting.length,
    changedPreexistingIdentityCount: changedIdentity.length,
    missingPreexisting: missingPreexisting.slice(0, 20),
    changedPreexistingIdentity: changedIdentity.slice(0, 20),
    recoveredUniqueRecords: recovered.length,
    recoveredMissingInDb: recovered.filter(record => !currentById.has(record.recordId)),
    recoveredMissingInJsonl: recovered.filter(record => !jsonlIds.has(record.recordId)),
    recoveredMissingInDigest: recovered.filter(record => !digest.includes(record.recordId)),
    areswar,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  process.stdout.write(JSON.stringify({
    mainIntegrity: report.mainIntegrity,
    peerIntegrity: report.peerIntegrity,
    duplicateJsonlIds: report.duplicateJsonlIds.length,
    missingPreexistingCount: report.missingPreexistingCount,
    changedPreexistingIdentityCount: report.changedPreexistingIdentityCount,
    recoveredUniqueRecords: report.recoveredUniqueRecords,
    recoveredMissingInDb: report.recoveredMissingInDb.length,
    recoveredMissingInJsonl: report.recoveredMissingInJsonl.length,
    recoveredMissingInDigest: report.recoveredMissingInDigest.length,
    areswar: report.areswar,
  }, null, 2) + "\n");
}

if (require.main === module) main();