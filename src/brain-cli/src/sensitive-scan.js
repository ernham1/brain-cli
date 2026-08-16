"use strict";

const DEFAULT_PATTERNS = [
  { id: "token", pattern: "\\b(token|api[_-]?key|secret|password|passwd)\\b\\s*[:=]", flags: "i" },
  { id: "credential-ko", pattern: "(계정|비밀번호|인증키|개인정보)", flags: "i" },
  { id: "email", pattern: "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", flags: "i" },
  { id: "korean-phone", pattern: "01[016789]-?\\d{3,4}-?\\d{4}", flags: "" }
];

function detectSensitive(text, patterns = DEFAULT_PATTERNS) {
  const value = String(text || "");
  const matches = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.pattern, pattern.flags || "");
    if (re.test(value)) matches.push(pattern.id);
  }
  return { sensitive: matches.length > 0, matches };
}

function redactSensitive(text, patterns = DEFAULT_PATTERNS) {
  let result = String(text || "");
  for (const pattern of patterns) {
    const re = new RegExp(pattern.pattern, pattern.flags || "g");
    result = result.replace(re, "[REDACTED]");
  }
  return result;
}

module.exports = {
  DEFAULT_PATTERNS,
  detectSensitive,
  redactSensitive
};
