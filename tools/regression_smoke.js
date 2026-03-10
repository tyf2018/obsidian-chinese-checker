"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const withService = args.has("--with-service");
const pythonExec = process.env.CSC_PYTHON || "python";

function checkJsSyntax(filePath) {
  const full = path.join(ROOT, filePath);
  const code = fs.readFileSync(full, "utf8");
  new vm.Script(code, { filename: full });
}

function loadJson(filePath) {
  const full = path.join(ROOT, filePath);
  const raw = fs.readFileSync(full, "utf8");
  return JSON.parse(raw);
}

function runRangeExtractorCheckInProcess() {
  const modulePath = path.join(ROOT, "tools", "range_extractor_check.js");
  const originalExit = process.exit;
  process.exit = (code = 0) => {
    throw new Error(`range_extractor_check_exit_${Number(code) || 0}`);
  };
  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    require(resolved);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (message.startsWith("range_extractor_check_exit_0")) return;
    throw error;
  } finally {
    process.exit = originalExit;
  }
}

function verifyRules() {
  const common = loadJson(path.join("rules", "common_typos_zh.json"));
  const variant = loadJson(path.join("rules", "variant_forms_zh.json"));
  const domain = loadJson(path.join("rules", "domain_terms_zh.json"));

  const commonList = Array.isArray(common) ? common : Array.isArray(common.rules) ? common.rules : [];
  const variantList = Array.isArray(variant) ? variant : Array.isArray(variant.rules) ? variant.rules : [];
  const domainList = Array.isArray(domain) ? domain : Array.isArray(domain.terms) ? domain.terms : [];

  if (!commonList.length) {
    throw new Error("rules/common_typos_zh.json 无有效规则");
  }
  if (!variantList.length) {
    throw new Error("rules/variant_forms_zh.json 无有效规则");
  }
  if (!domainList.length) {
    throw new Error("rules/domain_terms_zh.json 无有效词条");
  }

  const key = (item) => `${String(item.wrong || "").trim()}->${String(item.correct || "").trim()}`;
  const pairs = new Set(commonList.map(key));
  const requiredPairs = ["按纳->按捺", "保镳->保镖"];
  for (const pair of requiredPairs) {
    if (!pairs.has(pair)) {
      throw new Error(`common_typos 缺少必需映射: ${pair}`);
    }
  }
}

function runContractCheck() {
  const result = spawnSync(pythonExec, [path.join("tools", "contract_check.py"), "--allow-legacy"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false
  });
  if (result.status === 0) return true;
  console.error("[fail] Python 协议契约检查");
  if (result.error) {
    console.error(String(result.error.message || result.error));
  }
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return false;
}

function main() {
  try {
    checkJsSyntax("main.js");
    console.log("[ok] 语法检查 main.js");
  } catch (error) {
    console.error(`[fail] 语法检查 main.js: ${String(error && error.message ? error.message : error)}`);
    return 1;
  }

  try {
    checkJsSyntax("range_extractor.js");
    console.log("[ok] 语法检查 range_extractor.js");
  } catch (error) {
    console.error(`[fail] 语法检查 range_extractor.js: ${String(error && error.message ? error.message : error)}`);
    return 1;
  }

  try {
    runRangeExtractorCheckInProcess();
    console.log("[ok] 范围抽取回归");
  } catch (error) {
    console.error(`[fail] 范围抽取回归: ${String(error && error.message ? error.message : error)}`);
    return 1;
  }

  try {
    verifyRules();
    console.log("[ok] 规则文件完整性");
  } catch (error) {
    console.error(`[fail] 规则文件完整性: ${String(error && error.message ? error.message : error)}`);
    return 1;
  }

  if (withService) {
    if (!runContractCheck()) {
      return 1;
    }
    console.log("[ok] Python 协议契约检查");
  }

  console.log("Smoke checks passed.");
  return 0;
}

process.exit(main());
