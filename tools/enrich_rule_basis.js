"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const COMMON_PATH = path.join(ROOT, "rules", "common_typos_zh.json");
const VARIANT_PATH = path.join(ROOT, "rules", "variant_forms_zh.json");
const RULE_BASIS_OVERRIDES = Object.freeze({
  "交待->交代": "“交代”是现代汉语的规范用词，适用于绝大多数场合。“交待”是一个已经或正在被淘汰的词。",
  "帐号->账号": "在古代“贝”曾作为货币，因此“账”字本义就与金钱、财物记载有关。根据《现代汉语词典》及教育部、国家语言文字工作委员会发布的《第一批异形词整理表》，“账”是“帐”的分化字。为了区分，“账”专门用于与货币、货物出入记载、债务等相关的词语，如“账本”“报账”“银行账号”。"
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildRuleBasis(wrong, correct, mode = "common") {
  const normalizedWrong = String(wrong || "").trim();
  const normalizedCorrect = String(correct || "").trim();
  if (!normalizedWrong || !normalizedCorrect || normalizedWrong === normalizedCorrect) return "";
  const override = RULE_BASIS_OVERRIDES[`${normalizedWrong}->${normalizedCorrect}`];
  if (override) return override;
  if (mode === "variant") {
    return `“${normalizedCorrect}”是现代汉语的规范用词，适用于绝大多数场合。“${normalizedWrong}”是一个已经或正在被淘汰的词。`;
  }
  if (/^[\u4e00-\u9fff]{4}$/.test(normalizedWrong) && /^[\u4e00-\u9fff]{4}$/.test(normalizedCorrect)) {
    return `成语固定写法为“${normalizedCorrect}”，“${normalizedWrong}”属于常见误写。`;
  }
  return `“${normalizedCorrect}”是现代汉语的规范用词，适用于绝大多数场合。“${normalizedWrong}”属于常见误写或异形写法。`;
}

function normalizeRules(rules, mode) {
  const list = Array.isArray(rules) ? rules : [];
  const normalized = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const wrong = String(item.wrong || "").trim();
    const correct = String(item.correct || "").trim();
    if (!wrong || !correct || wrong === correct) continue;
    const confidenceRaw = Number(item.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0.9;
    const basis = String(item.basis || "").trim() || buildRuleBasis(wrong, correct, mode);
    normalized.push({ wrong, correct, confidence, basis });
  }
  return normalized;
}

function stringifyRulePayload(payload) {
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  const topKeys = Object.keys(payload).filter((key) => key !== "rules" && typeof payload[key] !== "undefined");
  const lines = ["{"];
  for (const key of topKeys) {
    lines.push(`  "${key}": ${JSON.stringify(payload[key])},`);
  }
  lines.push('  "rules": [');
  for (let index = 0; index < rules.length; index += 1) {
    const item = rules[index];
    const suffix = index === rules.length - 1 ? "" : ",";
    lines.push(
      `    {"wrong": ${JSON.stringify(item.wrong)}, "correct": ${JSON.stringify(item.correct)}, "confidence": ${item.confidence}, "basis": ${JSON.stringify(item.basis)}}${suffix}`
    );
  }
  lines.push("  ]");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function rewriteRules(filePath, mode) {
  const payload = readJson(filePath);
  const rules = normalizeRules(payload.rules, mode);
  const output = { ...payload, rules };
  if (Object.prototype.hasOwnProperty.call(output, "rule_count")) {
    output.rule_count = rules.length;
  }
  fs.writeFileSync(filePath, stringifyRulePayload(output), "utf8");
  return rules.length;
}

function main() {
  const commonCount = rewriteRules(COMMON_PATH, "common");
  const variantCount = rewriteRules(VARIANT_PATH, "variant");
  console.log(JSON.stringify({ common_count: commonCount, variant_count: variantCount }, null, 2));
}

main();
