"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("external credential rotation helper keeps secrets out of output and supports rollback", () => {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/rotate-external-credential.ps1"), "utf8");

  assert.match(source, /Read-Host[\s\S]*-AsSecureString/);
  assert.match(source, /ZeroFreeBSTR/);
  assert.match(source, /Normalize-CredentialValue/);
  assert.match(source, /while \(\$true\)/);
  assert.match(source, /다시 입력/);
  assert.match(source, /Get-Clipboard -Raw/);
  assert.doesNotMatch(source, /Write-(?:Host|Output|Error)[^\n]*\$clipboardValue/i);
  assert.match(source, /WriteAllText\(\$environmentFile, \$originalText/);
  assert.doesNotMatch(source, /Write-(?:Host|Output|Error)[^\n]*\$plainValue/i);
  assert.doesNotMatch(source, /pm2[^\n]*\$plainValue/i);
  assert.match(source, /pm2 delete clo-telegram/);
  assert.match(source, /pm2 start \$ecosystemFile --only clo-telegram/);
  assert.doesNotMatch(source, /pm2 restart clo-telegram/);
  assert.doesNotMatch(source, /ConvertFrom-SecureString/);
});
