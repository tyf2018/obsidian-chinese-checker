/*
Source file for Obsidian 中文纠错插件.
Implements dual local engines:
1) JS rule engine (default, lightweight)
2) Python local HTTP engine (optional enhancement)
*/

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  MarkdownView,
  ItemView,
  TFile,
  editorViewField
} = require("obsidian");

const { EditorView, Decoration, hoverTooltip } = require("@codemirror/view");
const { StateField, StateEffect, RangeSetBuilder } = require("@codemirror/state");

const FRONTMATTER_KEY = "language-tool-ignore";
const RESULT_VIEW_TYPE = "csc-typo-result-view";
const FALLBACK_REASON_LABELS = {
  python_unreachable: "Python 服务未响应（请检查服务是否启动）",
  python_booting: "Python 服务启动中，稍后自动复检",
  python_not_started: "Python 服务未启动（请手动启动或开启自动启动）",
  python_disabled: "Python 引擎已禁用",
  python_service_incompatible: "Python 服务版本不兼容"
};
const PY_DETAIL_LABELS = {
  missing_kenlm: "缺少 kenlm 依赖（Windows 通常需要预编译包或本机构建链）",
  model_download_blocked: "pycorrector 语言模型下载被拦截（请改为本地模型文件）",
  missing_torch: "缺少 torch 依赖（请在插件 venv 安装 torch）",
  pycorrector_api_unavailable: "pycorrector API 不可用",
  corrector_has_no_correct: "pycorrector Corrector.correct 不可用",
  startup_timeout: "启动超时",
  python_check_timeout: "Python 检测请求超时",
  python_health_timeout: "Python 健康检查超时",
  signal_is_aborted_without_reason: "请求被中止（无详细原因）",
  bind_address_in_use: "端口已被占用",
  bind_permission_denied: "端口绑定被系统拒绝"
};
const ENGINE_MODES = {
  JS: "js",
  PYTHON: "python",
  HYBRID: "hybrid"
};
const PY_STARTUP_GATE_WAIT_MS = 18000;
const PY_STARTUP_GATE_RETRY_COOLDOWN_MS = 15000;
const PY_STARTUP_GATE_REARM_COOLDOWN_MS = 45000;
const PY_STARTUP_GATE_MAX_ATTEMPTS = 3;
const PY_HEALTH_PING_TIMEOUT_MS = 1600;
const PY_STARTUP_GATE_PENDING_STALE_MS = 22000;
const PY_FETCH_HARD_TIMEOUT_BUFFER_MS = 1200;
const DEFAULT_WINDOWS_VENV_DIR = "S:\\obsidian-chinese-checker\\.venv";
const DEFAULT_CEDICT_INDEX_FILENAME = "cedict_index.json";
const CEDICT_DEFAULT_FALLBACK_SOURCE = ".obsidian\\plugins\\various-complements\\cedict_ts.u8";
const CJK_TOKEN_REGEX = /[\u4e00-\u9fff]{2,6}/g;
const SHARED_TYPO_RULES_FILENAME = path.join("rules", "common_typos_zh.json");

function isWindowsPlatform() {
  return process.platform === "win32";
}

function normalizeVenvDir(input, fallback = "") {
  const raw = String(input || "").trim().replace(/^"(.*)"$/, "$1");
  const cleaned = raw.replace(/[\\/]+$/, "");
  if (cleaned) return path.normalize(cleaned);
  const fallbackRaw = String(fallback || "").trim();
  if (!fallbackRaw) return "";
  return path.normalize(fallbackRaw.replace(/[\\/]+$/, ""));
}

function buildPythonExecutableFromVenvDir(venvDir) {
  const normalized = normalizeVenvDir(venvDir);
  if (!normalized) return "python";
  if (isWindowsPlatform()) return path.join(normalized, "Scripts", "python.exe");
  return path.join(normalized, "bin", "python3");
}

function buildInstallScriptCommand(scriptPath, venvDir) {
  const normalizedScript = String(scriptPath || "").trim();
  const normalizedVenv = normalizeVenvDir(venvDir);
  if (!normalizedScript) return "";
  if (isWindowsPlatform()) {
    return `cmd /c "\\"${normalizedScript}\\" \\"${normalizedVenv}\\""`;
  }
  return `"${normalizedScript}" "${normalizedVenv}"`;
}

const DEFAULT_SETTINGS = {
  liveCheck: true,
  autoCheckDelayMs: 550,
  confidenceThreshold: 0.55,
  maxSuggestions: 300,
  engineMode: ENGINE_MODES.HYBRID,
  frontmatterKey: FRONTMATTER_KEY,
  pythonEngineEnabled: true,
  pythonAutoStart: true,
  pythonManualTriggerOnly: true,
  pythonExecutable: "python",
  pythonVenvDir: DEFAULT_WINDOWS_VENV_DIR,
  pythonScriptPath: "python_engine_service.py",
  pythonHost: "127.0.0.1",
  pythonPort: 27123,
  pythonTimeoutMs: 12000,
  pythonStartupTimeoutMs: 12000,
  jsCedictEnhanced: true,
  jsCedictSourcePath: "",
  jsCedictIndexPath: DEFAULT_CEDICT_INDEX_FILENAME,
  userDictionary: [],
  pythonSetupHintDismissed: false
};

const COMMON_PHRASE_RULES = [
  { wrong: "因该", correct: "应该", confidence: 0.95 },
  { wrong: "己经", correct: "已经", confidence: 0.95 },
  { wrong: "必需", correct: "必须", confidence: 0.92 },
  { wrong: "在接再厉", correct: "再接再厉", confidence: 0.9 },
  { wrong: "再接再励", correct: "再接再厉", confidence: 0.97 },
  { wrong: "一股作气", correct: "一鼓作气", confidence: 0.93 },
  { wrong: "按步就班", correct: "按部就班", confidence: 0.9 },
  { wrong: "迫不急待", correct: "迫不及待", confidence: 0.94 },
  { wrong: "出奇不意", correct: "出其不意", confidence: 0.9 },
  { wrong: "不径而走", correct: "不胫而走", confidence: 0.9 },
  { wrong: "相形见拙", correct: "相形见绌", confidence: 0.88 },
  { wrong: "谈笑风声", correct: "谈笑风生", confidence: 0.88 },
  { wrong: "配眼睛", correct: "配眼镜", confidence: 0.96 }
];

const DUPLICATE_TOKEN_REGEX = /(的的|了了|是是|地地|得得|在在|和和)/g;
const CONFUSION_CHAR_MAP = {
  齐: ["气", "其", "期"],
  再: ["在"],
  像: ["相"],
  在: ["再"],
  做: ["作"],
  神: ["什"]
};
const WORD_HINTS = ["在干什么", "什么", "天气", "再接再厉", "相形见绌"];

const SET_MATCHES_EFFECT = StateEffect.define();
const CLEAR_MATCHES_EFFECT = StateEffect.define();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWithHardTimeout(executor, timeoutMs, timeoutCode = "operation_timeout") {
  const safeTimeout = Math.max(300, Number(timeoutMs) || 0);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutCode));
    }, safeTimeout);
    Promise.resolve()
      .then(() => executor())
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeReasonValue(input) {
  return String(input || "")
    .replace(/\s+/g, "_")
    .replace(/[^\w.:/+()\\-]/g, "")
    .slice(0, 120);
}

function isTransientFetchReason(reason) {
  const normalized = normalizeReasonValue(reason || "");
  if (!normalized) return false;
  return (
    normalized === "python_fetch_failed" ||
    normalized === "python_check_timeout" ||
    normalized === "python_health_timeout" ||
    normalized === "python_unreachable" ||
    normalized === "Failed_to_fetch" ||
    normalized === "The_user_aborted_a_request." ||
    normalized === "AbortError" ||
    normalized === "signal_is_aborted_without_reason" ||
    normalized.includes("aborted")
  );
}

function buildRequestId(source, sequence) {
  const safeSource = normalizeReasonValue(source || "manual") || "manual";
  const safeSeq = Number(sequence) > 0 ? Number(sequence) : 0;
  return `${Date.now()}-${safeSource}-${safeSeq}`;
}

function buildStageDurations(stageDurations = {}, totalMs = 0) {
  const toNonNegativeInt = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return 0;
    return Math.round(num);
  };
  return {
    readMs: toNonNegativeInt(stageDurations.readMs),
    gateMs: toNonNegativeInt(stageDurations.gateMs),
    detectMs: toNonNegativeInt(stageDurations.detectMs),
    filterMs: toNonNegativeInt(stageDurations.filterMs),
    totalMs: toNonNegativeInt(totalMs)
  };
}

function formatStageDurations(stageDurations) {
  if (!isPlainObject(stageDurations)) return "";
  const segments = [];
  if (Number.isFinite(stageDurations.readMs)) segments.push(`read=${stageDurations.readMs}ms`);
  if (Number.isFinite(stageDurations.gateMs)) segments.push(`gate=${stageDurations.gateMs}ms`);
  if (Number.isFinite(stageDurations.detectMs)) segments.push(`detect=${stageDurations.detectMs}ms`);
  if (Number.isFinite(stageDurations.filterMs)) segments.push(`filter=${stageDurations.filterMs}ms`);
  if (Number.isFinite(stageDurations.totalMs)) segments.push(`total=${stageDurations.totalMs}ms`);
  return segments.join(" | ");
}

function shouldShowQualityDowngrade(engineSource, fallbackReason) {
  const fallback = String(fallbackReason || "").trim();
  if (!fallback) return false;
  const normalizedEngine = String(engineSource || "").toLowerCase();
  if (!normalizedEngine) return true;
  return normalizedEngine === "js" || normalizedEngine.includes(":fallback");
}

function toPrettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value || "");
  }
}

function isPlainObject(input) {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function parseFallbackReason(reason) {
  const normalized = String(reason || "").trim();
  if (!normalized) return { key: "", detail: "" };
  const separator = normalized.indexOf(":");
  if (separator < 0) return { key: normalized, detail: "" };
  return {
    key: normalized.slice(0, separator),
    detail: normalized.slice(separator + 1)
  };
}

function formatFallbackReason(reason) {
  const parsed = parseFallbackReason(reason);
  const baseLabel = FALLBACK_REASON_LABELS[parsed.key] || parsed.key || "unknown";
  const detailLabel = PY_DETAIL_LABELS[parsed.detail] || parsed.detail;
  if (!parsed.detail) return baseLabel;
  if (parsed.key === "python_unavailable") {
    return `Python 能力不可用（${detailLabel}）`;
  }
  if (parsed.key === "python_error") {
    return `Python 引擎异常（${detailLabel}）`;
  }
  if (parsed.key === "python_empty") {
    return `Python 返回空结果（${detailLabel}）`;
  }
  return `${baseLabel}（${detailLabel}）`;
}

function isRetryableGateFallbackReason(reason) {
  const parsed = parseFallbackReason(reason);
  if (!parsed.key) return false;
  if (parsed.key === "python_booting" || parsed.key === "python_unreachable") return true;
  if (parsed.key === "python_unavailable") {
    const retryableDetails = new Set([
      "",
      "unknown",
      "startup_timeout",
      "python_unreachable",
      "python_check_timeout",
      "python_health_timeout"
    ]);
    return retryableDetails.has(parsed.detail || "");
  }
  return false;
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeMatchKey(match) {
  const first = (match.replacements && match.replacements[0] && match.replacements[0].value) || "";
  return `${match.from}:${match.to}:${first}`;
}

function isBooleanTrue(value) {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function normalizeEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.from <= last.to) {
      last.to = Math.max(last.to, current.to);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function invertRanges(totalLength, blocked) {
  if (totalLength <= 0) return [];
  if (!blocked.length) return [{ from: 0, to: totalLength }];
  const ranges = [];
  let cursor = 0;
  for (const item of blocked) {
    if (item.from > cursor) ranges.push({ from: cursor, to: item.from });
    cursor = Math.max(cursor, item.to);
  }
  if (cursor < totalLength) ranges.push({ from: cursor, to: totalLength });
  return ranges.filter((item) => item.to > item.from);
}

function collectRegexRanges(text, regex, into) {
  let match = regex.exec(text);
  while (match) {
    const from = match.index;
    const to = match.index + match[0].length;
    if (to > from) into.push({ from, to });
    match = regex.exec(text);
  }
}

function collectBlockedRanges(text) {
  const blocked = [];
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (frontmatter) blocked.push({ from: 0, to: frontmatter[0].length });
  collectRegexRanges(text, /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, blocked);
  collectRegexRanges(text, /`[^`\n]+`/g, blocked);
  collectRegexRanges(text, /\$\$[\s\S]*?\$\$/g, blocked);
  collectRegexRanges(text, /\$[^$\n]+\$/g, blocked);
  collectRegexRanges(text, /https?:\/\/[^\s)\]]+/g, blocked);
  collectRegexRanges(text, /\]\([^)\n]+\)/g, blocked);
  return mergeRanges(blocked);
}

function extractDetectableRanges(text) {
  const safeText = String(text || "");
  return invertRanges(safeText.length, collectBlockedRanges(safeText));
}

function readFrontmatterBoolean(content, key) {
  const block = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!block) return null;
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*(true|false)\\s*(?:#.*)?$`, "im");
  const lineMatch = block[0].match(re);
  if (!lineMatch) return null;
  return lineMatch[1].toLowerCase() === "true";
}

function toggleFrontmatterFlag(content, key) {
  const eol = normalizeEol(content);
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!fmMatch) {
    const prefix = `---${eol}${key}: true${eol}---${eol}`;
    return { enabled: true, content: `${prefix}${content}` };
  }

  const full = fmMatch[0];
  const suffix = content.slice(full.length);
  const body = full.replace(/^---\r?\n/, "").replace(/\r?\n---$/, "");
  const lines = body ? body.split(/\r?\n/) : [];
  const keyRe = new RegExp(`^(\\s*${escapeRegExp(key)}\\s*:\\s*)([^#]*?)(\\s*(#.*)?)$`, "i");

  let enabled = true;
  let updated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(keyRe);
    if (!match) continue;
    const currentRaw = match[2].trim().toLowerCase();
    const currentValue = currentRaw === "true";
    enabled = !currentValue;
    lines[index] = `${match[1]}${enabled ? "true" : "false"}${match[3] || ""}`;
    updated = true;
    break;
  }

  if (!updated) {
    enabled = true;
    lines.push(`${key}: true`);
  }

  const rebuilt = `---${eol}${lines.join(eol)}${eol}---`;
  return { enabled, content: `${rebuilt}${suffix}` };
}

function buildMatchesDecoration(matches) {
  const builder = new RangeSetBuilder();
  for (const match of matches) {
    const category = match.category || "MINOR";
    const cls =
      category === "TYPOS"
        ? "csc-underline csc-major"
        : category === "STYLE"
          ? "csc-underline csc-style"
          : "csc-underline csc-minor";
    builder.add(
      match.from,
      match.to,
      Decoration.mark({
        class: cls,
        matchData: match
      })
    );
  }
  return builder.finish();
}

const MATCHES_FIELD = StateField.define({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(CLEAR_MATCHES_EFFECT)) {
        next = Decoration.none;
      }
      if (effect.is(SET_MATCHES_EFFECT)) {
        next = buildMatchesDecoration(effect.value.matches || []);
      }
    }
    return next;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  }
});

function getMarkdownViewFromState(state) {
  try {
    return state.field(editorViewField);
  } catch (error) {
    return null;
  }
}

function isMarkdownContext(value) {
  return Boolean(value && value.file && value.editor);
}

function resolveEditorView(markdownContext) {
  if (!markdownContext) return null;
  if (markdownContext.editor && markdownContext.editor.cm) return markdownContext.editor.cm;
  if (
    markdownContext.currentMode &&
    markdownContext.currentMode.editor &&
    markdownContext.currentMode.editor.cm
  ) {
    return markdownContext.currentMode.editor.cm;
  }
  return null;
}

function hasCjkText(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function replaceCharAt(text, index, nextChar) {
  if (!text || index < 0 || index >= text.length) return text;
  return `${text.slice(0, index)}${nextChar}${text.slice(index + 1)}`;
}

function parseCedictIndexFile(rawContent) {
  const parsed = JSON.parse(rawContent);
  if (!isPlainObject(parsed)) throw new Error("cedict_index_invalid");
  const words = Array.isArray(parsed.words) ? parsed.words.filter((item) => typeof item === "string") : [];
  const frequentWords = Array.isArray(parsed.frequent_words)
    ? parsed.frequent_words.filter((item) => typeof item === "string")
    : [];
  const rawConfusions = isPlainObject(parsed.char_confusions) ? parsed.char_confusions : {};
  const charConfusions = new Map();
  for (const [key, values] of Object.entries(rawConfusions)) {
    if (typeof key !== "string" || !Array.isArray(values)) continue;
    const normalizedValues = [...new Set(values.filter((item) => typeof item === "string" && item !== key))];
    if (!normalizedValues.length) continue;
    charConfusions.set(key, normalizedValues);
  }
  return {
    version: typeof parsed.version === "string" ? parsed.version : "",
    sourcePath: typeof parsed.source_path === "string" ? parsed.source_path : "",
    words: new Set(words),
    frequentWords: new Set(frequentWords),
    charConfusions
  };
}

function normalizeCedictPinyinToken(rawToken) {
  return String(rawToken || "")
    .toLowerCase()
    .replace(/[0-9]/g, "")
    .replace(/[^a-züv]/g, "")
    .replace(/v/g, "ü");
}

function parseCedictSourceFile(rawContent) {
  const lines = String(rawContent || "").split(/\r?\n/);
  const wordCount = new Map();
  const charFrequency = new Map();
  const pinyinChars = new Map();

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/.*\/$/);
    if (!match) continue;
    const simplified = match[2];
    if (!hasCjkText(simplified)) continue;
    if (/^[\u4e00-\u9fff]{2,6}$/.test(simplified)) {
      wordCount.set(simplified, (wordCount.get(simplified) || 0) + 1);
    }
    for (const char of simplified) {
      charFrequency.set(char, (charFrequency.get(char) || 0) + 1);
    }
    if (/^[\u4e00-\u9fff]$/.test(simplified)) {
      const pinyinToken = normalizeCedictPinyinToken(String(match[3] || "").split(/\s+/)[0] || "");
      if (!pinyinToken) continue;
      if (!pinyinChars.has(pinyinToken)) pinyinChars.set(pinyinToken, new Set());
      pinyinChars.get(pinyinToken).add(simplified);
    }
  }

  const frequentWords = [...wordCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"))
    .slice(0, 25000)
    .map((item) => item[0]);
  const charConfusions = new Map();
  for (const chars of pinyinChars.values()) {
    const sorted = [...chars].sort((a, b) => (charFrequency.get(b) || 0) - (charFrequency.get(a) || 0));
    if (sorted.length < 2) continue;
    for (const current of sorted) {
      const alternatives = [];
      for (const candidate of sorted) {
        if (candidate === current) continue;
        if (!alternatives.includes(candidate)) alternatives.push(candidate);
        if (alternatives.length >= 12) break;
      }
      if (!alternatives.length) continue;
      charConfusions.set(current, alternatives);
    }
  }
  return {
    version: "source-fallback",
    sourcePath: "",
    words: new Set([...wordCount.keys()]),
    frequentWords: new Set(frequentWords),
    charConfusions
  };
}

function loadSharedTypoRules(rulesPath) {
  try {
    if (!rulesPath || !fs.existsSync(rulesPath)) return [];
    const raw = fs.readFileSync(rulesPath, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rules) ? parsed.rules : [];
    const normalized = [];
    const seen = new Set();
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      const wrong = String(item.wrong || "").trim();
      const correct = String(item.correct || "").trim();
      if (!wrong || !correct || wrong === correct) continue;
      const confidenceRaw = Number(item.confidence);
      const confidence = Number.isFinite(confidenceRaw) ? Math.max(0.5, Math.min(0.99, confidenceRaw)) : 0.9;
      if (seen.has(wrong)) continue;
      seen.add(wrong);
      normalized.push({ wrong, correct, confidence });
    }
    return normalized;
  } catch (error) {
    return [];
  }
}

class JsRuleEngine {
  constructor(plugin) {
    this.plugin = plugin;
    this.name = "js";
    const manifestDir = plugin && plugin.manifest && plugin.manifest.dir ? plugin.manifest.dir : "";
    const sharedRulesPath = manifestDir ? path.join(manifestDir, SHARED_TYPO_RULES_FILENAME) : "";
    this.sharedPhraseRules = loadSharedTypoRules(sharedRulesPath);
  }

  getCedictContext() {
    if (!this.plugin || typeof this.plugin.getJsCedictRuntime !== "function") return null;
    return this.plugin.getJsCedictRuntime();
  }

  collectConfusionAlternatives(token, index, cedictContext) {
    const currentChar = token[index];
    const baseCandidates = CONFUSION_CHAR_MAP[currentChar] || [];
    const cedictCandidates = cedictContext && cedictContext.charConfusions ? cedictContext.charConfusions.get(currentChar) || [] : [];
    const merged = [];
    for (const item of [...baseCandidates, ...cedictCandidates]) {
      if (!item || item === currentChar || merged.includes(item)) continue;
      merged.push(item);
      if (merged.length >= 8) break;
    }
    return merged;
  }

  detectCedictCandidates(text, range, pushMatch, cedictContext) {
    if (!cedictContext || !cedictContext.words || !cedictContext.words.size) return;
    const segment = text.slice(range.from, range.to);
    CJK_TOKEN_REGEX.lastIndex = 0;
    let match = CJK_TOKEN_REGEX.exec(segment);
    while (match) {
      const token = match[0];
      const tokenFrom = range.from + match.index;
      const tokenTo = tokenFrom + token.length;
      if (!cedictContext.words.has(token)) {
        let suggestion = "";
        let sourceConfidence = 0.62;
        for (let i = 0; i < token.length; i += 1) {
          const alternatives = this.collectConfusionAlternatives(token, i, cedictContext);
          for (const alt of alternatives) {
            const candidate = replaceCharAt(token, i, alt);
            if (!cedictContext.words.has(candidate)) continue;
            if (cedictContext.frequentWords.size && !cedictContext.frequentWords.has(candidate)) continue;
            suggestion = candidate;
            sourceConfidence = (CONFUSION_CHAR_MAP[token[i]] || []).includes(alt) ? 0.76 : 0.62;
            break;
          }
          if (suggestion) break;
        }
        if (suggestion && suggestion !== token) {
          pushMatch({
            from: tokenFrom,
            to: tokenTo,
            message: `词典候选建议“${suggestion}”`,
            shortMessage: "词典候选",
            replacements: [{ value: suggestion }],
            ruleId: "CEDICT_OOV_RULE",
            category: "TYPOS",
            confidence: sourceConfidence,
            token,
            engine: this.name
          });
        }
      }
      match = CJK_TOKEN_REGEX.exec(segment);
    }
  }

  getPhraseRules() {
    const merged = [];
    const seen = new Set();
    for (const item of [...COMMON_PHRASE_RULES, ...this.sharedPhraseRules]) {
      if (!item || !item.wrong || !item.correct) continue;
      if (seen.has(item.wrong)) continue;
      seen.add(item.wrong);
      merged.push(item);
    }
    return merged;
  }

  async detect(text, context) {
    const ranges = context.ranges || [{ from: 0, to: text.length }];
    const limit = context.maxSuggestions || 300;
    const matches = [];
    const seen = new Set();
    const cedictContext = this.getCedictContext();
    const phraseRules = this.getPhraseRules();

    const pushMatch = (match) => {
      const key = makeMatchKey(match);
      if (seen.has(key)) return;
      seen.add(key);
      matches.push(match);
    };

    for (const range of ranges) {
      const segment = text.slice(range.from, range.to);
      for (const rule of phraseRules) {
        let cursor = segment.indexOf(rule.wrong);
        while (cursor >= 0) {
          const from = range.from + cursor;
          const to = from + rule.wrong.length;
          pushMatch({
            from,
            to,
            message: `检测到常见错词：建议“${rule.correct}”`,
            shortMessage: "常见错别字",
            replacements: [{ value: rule.correct }],
            ruleId: "COMMON_PHRASE_RULE",
            category: "TYPOS",
            confidence: rule.confidence,
            token: text.slice(from, to),
            engine: this.name
          });
          cursor = segment.indexOf(rule.wrong, cursor + 1);
        }
      }

      DUPLICATE_TOKEN_REGEX.lastIndex = 0;
      let duplicate = DUPLICATE_TOKEN_REGEX.exec(segment);
      while (duplicate) {
        const from = range.from + duplicate.index;
        const to = from + duplicate[0].length;
        const replacement = duplicate[0].slice(0, duplicate[0].length / 2);
        pushMatch({
          from,
          to,
          message: "检测到重复字，建议删除一个。",
          shortMessage: "重复字",
          replacements: [{ value: replacement }],
          ruleId: "DUPLICATE_TOKEN_RULE",
          category: "TYPOS",
          confidence: 0.8,
          token: text.slice(from, to),
          engine: this.name
        });
        duplicate = DUPLICATE_TOKEN_REGEX.exec(segment);
      }

      for (const hint of WORD_HINTS) {
        const hintLen = hint.length;
        if (hintLen <= 1) continue;
        const maxStart = range.to - hintLen;
        for (let start = range.from; start <= maxStart; start += 1) {
          const end = start + hintLen;
          const source = text.slice(start, end);
          if (source === hint) continue;
          if (cedictContext && cedictContext.words.has(source)) continue;
          let diffIndex = -1;
          for (let i = 0; i < hintLen; i += 1) {
            if (source[i] === hint[i]) continue;
            if (diffIndex !== -1) {
              diffIndex = -2;
              break;
            }
            diffIndex = i;
          }
          if (diffIndex < 0) continue;
          const wrongChar = source[diffIndex];
          const rightChar = hint[diffIndex];
          const candidates = CONFUSION_CHAR_MAP[wrongChar] || [];
          if (!candidates.includes(rightChar)) continue;
          pushMatch({
            from: start,
            to: end,
            message: `检测到上下文疑似混淆词，建议“${hint}”`,
            shortMessage: "混淆词提示",
            replacements: [{ value: hint }],
            ruleId: "CONFUSION_HINT_RULE",
            category: "TYPOS",
            confidence: 0.82,
            token: source,
            engine: this.name
          });
        }
      }

      if (cedictContext && cedictContext.enabled) {
        this.detectCedictCandidates(text, range, pushMatch, cedictContext);
      }
    }

    matches.sort((a, b) => a.from - b.from || b.confidence - a.confidence);
    return matches.slice(0, limit);
  }
}

class PythonLocalEngine {
  constructor(plugin) {
    this.plugin = plugin;
    this.name = "python";
    this.process = null;
    this.startPromise = null;
    this.serviceVersion = "";
    this.engineStatus = "init";
    this.pycorrectorAvailable = null;
    this.pycorrectorImpl = "";
    this.pycorrectorLmPath = "";
    this.pycorrectorError = "";
    this.fallbackRuleCount = 0;
    this.lastEngineDetail = "";
    this.lastError = "";
    this.lastStderr = "";
    this.pycorrectorLoading = null;
    this.fetchFailureCount = 0;
    this.circuitOpenUntil = 0;
    this.lastHealthAt = 0;
    this.warnedPythonError = false;
    this.warnedNoPycorrector = false;
    this.pendingReadyProbe = null;
    this.explicitStopping = false;
  }

  getVaultBasePath() {
    const adapter = this.plugin.app && this.plugin.app.vault ? this.plugin.app.vault.adapter : null;
    if (!adapter || typeof adapter.getBasePath !== "function") return "";
    try {
      return adapter.getBasePath();
    } catch (error) {
      return "";
    }
  }

  resolveScriptPath() {
    const configured = (this.plugin.settings.pythonScriptPath || "python_engine_service.py").trim();
    const defaultName = "python_engine_service.py";
    const candidates = [];
    const pushCandidate = (value) => {
      if (!value) return;
      const normalized = path.normalize(value);
      if (!candidates.includes(normalized)) candidates.push(normalized);
    };
    const vaultBase = this.getVaultBasePath();
    const vaultRelativeMatcher = /^[\\/]?\.obsidian[\\/]/i;

    if (configured) {
      if (path.isAbsolute(configured)) {
        pushCandidate(configured);
        if (vaultRelativeMatcher.test(configured) && vaultBase) {
          pushCandidate(path.join(vaultBase, configured.replace(/^[\\/]+/, "")));
        }
      } else {
        pushCandidate(path.join(this.plugin.manifest.dir, configured));
        if (vaultRelativeMatcher.test(configured) && vaultBase) {
          pushCandidate(path.join(vaultBase, configured));
        }
      }
    }
    pushCandidate(path.join(this.plugin.manifest.dir, defaultName));
    if (vaultBase && this.plugin.manifest && this.plugin.manifest.id) {
      pushCandidate(path.join(vaultBase, ".obsidian", "plugins", this.plugin.manifest.id, defaultName));
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0] || path.join(this.plugin.manifest.dir, defaultName);
  }

  resolvePythonExecutable() {
    const configured = (this.plugin.settings.pythonExecutable || "python").trim();
    if (!configured) return "python";
    const vaultBase = this.getVaultBasePath();
    const vaultRelativeMatcher = /^[\\/]?\.obsidian[\\/]/i;

    if (path.isAbsolute(configured)) {
      if (fs.existsSync(configured)) return configured;
      if (vaultRelativeMatcher.test(configured) && vaultBase) {
        const candidate = path.join(vaultBase, configured.replace(/^[\\/]+/, ""));
        if (fs.existsSync(candidate)) return candidate;
      }
      return configured;
    }
    if (vaultRelativeMatcher.test(configured) && vaultBase) {
      const candidate = path.join(vaultBase, configured.replace(/^[\\/]+/, ""));
      if (fs.existsSync(candidate)) return candidate;
    }
    if (/[\\/]/.test(configured)) {
      const candidate = path.join(this.plugin.manifest.dir, configured);
      if (fs.existsSync(candidate)) return candidate;
    }
    return configured;
  }

  getExecutableCheck() {
    const configured = (this.plugin.settings.pythonExecutable || "python").trim() || "python";
    const resolved = this.resolvePythonExecutable();
    const hasPathHint = path.isAbsolute(configured) || /[\\/]/.test(configured);
    const exists = hasPathHint ? fs.existsSync(resolved) : null;
    return {
      configured,
      resolved,
      hasPathHint,
      exists
    };
  }

  resolveEnvCheckScriptPath() {
    const candidates = [
      path.join(this.plugin.manifest.dir, "check_pycorrector_env.py"),
      path.join(path.dirname(this.resolveScriptPath()), "check_pycorrector_env.py")
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0];
  }

  getBaseUrl() {
    const host = this.plugin.settings.pythonHost || "127.0.0.1";
    const port = Number(this.plugin.settings.pythonPort) || 27123;
    return `http://${host}:${port}`;
  }

  updateEngineMeta(data) {
    if (!isPlainObject(data)) return;
    if (typeof data.service_version === "string") this.serviceVersion = data.service_version;
    if (typeof data.pycorrector_status === "string") this.engineStatus = data.pycorrector_status;
    if (typeof data.pycorrector_available === "boolean") {
      this.pycorrectorAvailable = data.pycorrector_available;
    } else if (typeof data.pycorrector_status === "string") {
      if (data.pycorrector_status === "ready") {
        this.pycorrectorAvailable = true;
      } else if (data.pycorrector_status === "unavailable") {
        this.pycorrectorAvailable = false;
      } else {
        this.pycorrectorAvailable = null;
      }
    } else if (typeof data.engine === "string") {
      this.pycorrectorAvailable = data.engine === "pycorrector";
    }
    if (typeof data.pycorrector_loading === "boolean") this.pycorrectorLoading = data.pycorrector_loading;
    if (typeof data.pycorrector_impl === "string") this.pycorrectorImpl = data.pycorrector_impl;
    if (typeof data.pycorrector_lm_path === "string") this.pycorrectorLmPath = data.pycorrector_lm_path;
    if (typeof data.fallback_rule_count === "number" && Number.isFinite(data.fallback_rule_count)) {
      this.fallbackRuleCount = Math.max(0, Math.floor(data.fallback_rule_count));
    }
    if (typeof data.engine_detail === "string") this.lastEngineDetail = data.engine_detail;
    if (typeof data.pycorrector_error === "string") {
      const parsed = normalizeReasonValue(data.pycorrector_error);
      if (parsed) {
        this.pycorrectorError = parsed;
        this.lastError = parsed;
      } else {
        this.pycorrectorError = "";
        if (data.pycorrector_status === "ready" || data.pycorrector_available === true) {
          this.lastError = "";
        }
      }
    }
  }

  resetFailureCircuit() {
    this.fetchFailureCount = 0;
    this.circuitOpenUntil = 0;
  }

  markTransientFailure(reason) {
    this.fetchFailureCount += 1;
    const normalized = normalizeReasonValue(reason || this.lastError || "python_unreachable");
    const keepUnavailableReason =
      this.engineStatus === "unavailable" &&
      this.lastError &&
      this.lastError !== "python_unreachable" &&
      isTransientFetchReason(normalized);
    if (!keepUnavailableReason) {
      this.lastError = normalized;
    }
    const cooldownMs = this.fetchFailureCount >= 4 ? 20000 : this.fetchFailureCount >= 2 ? 8000 : 2500;
    this.circuitOpenUntil = Date.now() + cooldownMs;
  }

  isCircuitOpen() {
    return Date.now() < this.circuitOpenUntil;
  }

  async detect(text, context) {
    if (!this.plugin.settings.pythonEngineEnabled) {
      this.lastEngineDetail = "disabled";
      return [];
    }
    try {
      if (this.isCircuitOpen()) {
        const online = await this.ping({ recordFailure: false });
        if (online) {
          this.resetFailureCircuit();
        } else {
          if (this.engineStatus === "unavailable" || this.pycorrectorAvailable === false) {
            return [];
          }
          if (this.plugin.settings.pythonAutoStart) {
            if (this.plugin.pythonStartupGateDone) {
              if (this.lastError && this.lastError !== "python_booting" && !isTransientFetchReason(this.lastError)) {
                throw new Error(this.lastError);
              }
              this.lastError = "python_unreachable";
              throw new Error("python_unreachable");
            }
            this.ensureStartedInBackground();
            this.lastError = "python_booting";
            throw new Error("python_booting");
          }
          this.lastError = "python_not_started";
          throw new Error("python_not_started");
        }
      }
      if (!this.process && !this.startPromise) {
        const online = await this.ping({ recordFailure: false });
        if (!online) {
          if (
            (this.engineStatus === "unavailable" || this.pycorrectorAvailable === false) &&
            (this.pycorrectorError || this.lastError)
          ) {
            return [];
          }
          if (this.plugin.settings.pythonAutoStart) {
            if (this.plugin.pythonStartupGateDone) {
              if (this.lastError && this.lastError !== "python_booting" && !isTransientFetchReason(this.lastError)) {
                throw new Error(this.lastError);
              }
              this.lastError = "python_unreachable";
              throw new Error("python_unreachable");
            }
            this.ensureStartedInBackground();
            this.lastError = "python_booting";
            throw new Error("python_booting");
          }
          this.lastError = "python_not_started";
          throw new Error("python_not_started");
        }
      }
      const payload = {
        text,
        ranges: context.ranges || [],
        max_suggestions: context.maxSuggestions || 300,
        file_path: context.filePath || "",
        trigger: context.triggerSource || "manual"
      };
      const matches = await this.callCheck(payload);
      if (this.engineStatus === "unavailable" && !this.warnedNoPycorrector) {
        this.warnedNoPycorrector = true;
        const reason = this.pycorrectorError || this.lastError || "unavailable";
        new Notice(`pycorrector 不可用，当前使用 Python 兜底规则（${reason}）。`, 6000);
      }
      this.resetFailureCircuit();
      this.warnedPythonError = false;
      return matches;
    } catch (error) {
      const normalized = normalizeReasonValue(error && error.message ? error.message : error);
      if (this.plugin.settings.pythonAutoStart && isTransientFetchReason(normalized)) {
        if (this.plugin.pythonStartupGateDone) {
          this.lastError = normalized || "python_unreachable";
          throw new Error(this.lastError);
        }
        if (normalized === "python_check_timeout" || normalized === "python_health_timeout") {
          this.lastError = normalized;
          throw new Error(normalized);
        }
        this.lastError = "python_booting";
        throw new Error("python_booting");
      }
      this.lastError = normalized;
      if (this.lastError === "python_unreachable") {
        const online = await this.ping({ recordFailure: false }).catch(() => false);
        if (online && (this.engineStatus === "unavailable" || this.pycorrectorAvailable === false)) {
          return [];
        }
      }
      if (
        this.lastError === "python_booting" ||
        this.lastError === "python_unreachable" ||
        this.lastError === "python_not_started"
      ) {
        throw error;
      }
      if (!this.warnedPythonError) {
        this.warnedPythonError = true;
        const detail = this.lastError || "unknown";
        new Notice(`Python 引擎不可用，已回退 JS（${detail}）`, 7000);
      }
      throw error;
    }
  }

  async runEnvironmentCheck() {
    const scriptPath = this.resolveEnvCheckScriptPath();
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`env_check_script_not_found:${scriptPath}`);
    }

    const preferred = this.getExecutableCheck();
    const candidates = [preferred.resolved];
    if (preferred.hasPathHint && preferred.exists === false && preferred.resolved !== "python") {
      candidates.push("python");
    }

    let lastError = "";
    for (const executable of candidates) {
      try {
        const result = await new Promise((resolve, reject) => {
          let stdout = "";
          let stderr = "";
          const child = spawn(executable, [scriptPath], {
            cwd: path.dirname(scriptPath),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
          });

          child.stdout.on("data", (chunk) => {
            stdout = `${stdout}${String(chunk || "")}`.slice(-40000);
          });
          child.stderr.on("data", (chunk) => {
            stderr = `${stderr}${String(chunk || "")}`.slice(-40000);
          });

          child.on("error", (error) => {
            reject(error);
          });
          child.on("close", (code, signal) => {
            const normalizedCode = Number.isFinite(code) ? code : -1;
            const merged = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
            resolve({
              ok: normalizedCode === 0,
              exitCode: normalizedCode,
              signal: signal || "",
              executable,
              scriptPath,
              stdout,
              stderr,
              output: merged
            });
          });
        });
        return result;
      } catch (error) {
        lastError = error && error.message ? String(error.message) : String(error || "");
        const isMissingBinary =
          /ENOENT/i.test(lastError) || /not found/i.test(lastError) || /spawn/i.test(lastError);
        if (!isMissingBinary) break;
      }
    }
    throw new Error(normalizeReasonValue(`env_check_spawn_failed:${lastError || "unknown"}`));
  }

  getCheckTimeoutMs(payload) {
    const configuredTimeoutMs = Number(this.plugin.settings.pythonTimeoutMs) || 12000;
    const trigger = String((payload && payload.trigger) || "").trim();
    const isManualTrigger = trigger === "manual" || trigger === "panel-button";
    const baseTimeoutMs = Math.max(isManualTrigger ? 18000 : 12000, configuredTimeoutMs);
    const textLength = String((payload && payload.text) || "").length;
    const rangeCount = Array.isArray(payload && payload.ranges) ? payload.ranges.length : 0;
    const extraByLengthMs = Math.min(45000, Math.floor(textLength / 1000) * 2200);
    const extraByRangeMs = Math.min(6000, Math.floor(rangeCount / 20) * 400);
    const manualSafetyMarginMs = isManualTrigger ? 5000 : 0;
    return baseTimeoutMs + extraByLengthMs + extraByRangeMs + manualSafetyMarginMs;
  }

  async callCheck(payload) {
    const timeoutMs = this.getCheckTimeoutMs(payload);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestPayload = {
      ...payload,
      timeout_budget_ms: timeoutMs
    };
    try {
      const response = await runWithHardTimeout(
        () =>
          fetch(`${this.getBaseUrl()}/check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload),
            signal: controller.signal
          }),
        timeoutMs + PY_FETCH_HARD_TIMEOUT_BUFFER_MS,
        "python_check_timeout"
      );
      if (!response.ok) throw new Error(`python engine status ${response.status}`);
      const data = await response.json();
      if (!isPlainObject(data)) {
        this.lastError = "python_service_incompatible";
        throw new Error("python_service_incompatible");
      }
      const hasCompatibleShape =
        Array.isArray(data.matches) ||
        typeof data.service_version === "string" ||
        typeof data.pycorrector_status === "string" ||
        typeof data.engine === "string";
      if (!hasCompatibleShape) {
        this.lastError = "python_service_incompatible";
        throw new Error("python_service_incompatible");
      }
      if (!this.serviceVersion && typeof data.service_version !== "string") {
        this.serviceVersion = "unknown";
      }
      this.updateEngineMeta(data);
      if (!Array.isArray(data.matches)) return [];
      this.lastError = "";
      this.lastStderr = "";
      this.resetFailureCircuit();
      return data.matches.map((item) => ({
        ...item,
        engine: this.lastEngineDetail || this.name
      }));
    } catch (error) {
      let reason = normalizeReasonValue(error && error.message ? error.message : error);
      const elapsedMs = Date.now() - startedAt;
      const abortedWithoutDetail =
        reason === "AbortError" || reason === "The_user_aborted_a_request." || reason === "signal_is_aborted_without_reason";
      if (abortedWithoutDetail && elapsedMs >= timeoutMs - 300) {
        reason = "python_check_timeout";
      }
      this.markTransientFailure(reason || "python_fetch_failed");
      if (isTransientFetchReason(reason)) {
        this.ensureStartedInBackground();
      }
      throw new Error(reason || "python_fetch_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  getRuntimeEngineLabel(prefix = "python") {
    if (this.lastEngineDetail) return `${prefix}:${this.lastEngineDetail}`;
    if (this.engineStatus === "loading" || this.pycorrectorLoading) return `${prefix}:loading`;
    if (this.pycorrectorAvailable === true) {
      return this.pycorrectorImpl ? `${prefix}:pycorrector(${this.pycorrectorImpl})` : `${prefix}:pycorrector`;
    }
    if (this.pycorrectorAvailable === false || this.engineStatus === "unavailable") return `${prefix}:fallback`;
    return `${prefix}:unknown`;
  }

  async ping(options = {}) {
    const recordFailure = options.recordFailure !== false;
    const timeoutMs = PY_HEALTH_PING_TIMEOUT_MS;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await runWithHardTimeout(
        () =>
          fetch(`${this.getBaseUrl()}/health`, {
            signal: controller.signal
          }),
        timeoutMs + PY_FETCH_HARD_TIMEOUT_BUFFER_MS,
        "python_health_timeout"
      );
      if (response.ok) {
        const data = await response.json().catch(() => null);
        if (!isPlainObject(data)) {
          this.lastError = "python_service_incompatible";
          return false;
        }
        const hasCompatibleHealth =
          typeof data.service_version === "string" ||
          data.ok === true ||
          data.status === "ok" ||
          typeof data.pycorrector_status === "string";
        if (!hasCompatibleHealth) {
          this.lastError = "python_service_incompatible";
          return false;
        }
        if (!this.serviceVersion && typeof data.service_version !== "string") {
          this.serviceVersion = "unknown";
        }
        this.updateEngineMeta(data);
        this.lastHealthAt = Date.now();
      }
      return response.ok;
    } catch (error) {
      let reason = normalizeReasonValue(error && error.message ? error.message : error);
      const elapsedMs = Date.now() - startedAt;
      const abortedWithoutDetail =
        reason === "AbortError" || reason === "The_user_aborted_a_request." || reason === "signal_is_aborted_without_reason";
      if (abortedWithoutDetail && elapsedMs >= timeoutMs - 150) {
        reason = "python_health_timeout";
      }
      if (recordFailure) this.markTransientFailure(reason || "python_unreachable");
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureStarted() {
    if (await this.ping({ recordFailure: false })) return;
    await this.startEngine();
  }

  ensureStartedInBackground() {
    this.ensureStarted().catch((error) => {
      const reason = normalizeReasonValue(error && error.message ? error.message : error);
      if (reason && reason !== "python_booting") {
        this.lastError = reason;
        if (!isTransientFetchReason(reason)) {
          this.engineStatus = "unavailable";
          this.pycorrectorAvailable = false;
        }
        console.error("[obsidian-chinese-checker] Python 后台启动失败:", reason);
      }
    });
  }

  async startEngine() {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    const promise = this.start()
      .then(() => {
        this.lastError = "";
        this.resetFailureCircuit();
        this.warnedPythonError = false;
        if (this.plugin && typeof this.plugin.onPythonEngineReady === "function") {
          this.plugin.onPythonEngineReady().catch(() => {});
        }
      })
      .catch((error) => {
        const reason = normalizeReasonValue(error && error.message ? error.message : error);
        if (reason === "python_booting") {
          this.probeReadyInBackground();
        }
        throw error;
      });
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) {
        this.startPromise = null;
      }
    }
  }

  async start() {
    const scriptPath = this.resolveScriptPath();
    if (!fs.existsSync(scriptPath)) {
      this.lastError = normalizeReasonValue(`script_not_found:${scriptPath}`);
      throw new Error(`script_not_found:${scriptPath}`);
    }
    const executable = this.resolvePythonExecutable();
    if (/[\\/]/.test(executable) && !fs.existsSync(executable)) {
      this.lastError = normalizeReasonValue(`python_not_found:${executable}`);
      throw new Error(`python_not_found:${executable}`);
    }
    this.lastStderr = "";
    this.explicitStopping = false;
    this.engineStatus = "loading";
    this.pycorrectorLoading = true;
    const port = String(Number(this.plugin.settings.pythonPort) || 27123);
    this.process = spawn(executable, [scriptPath, "--port", port], {
      cwd: path.dirname(scriptPath),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.process.on("exit", (code, signal) => {
      if (this.explicitStopping) {
        this.explicitStopping = false;
        this.engineStatus = "init";
        this.pycorrectorAvailable = null;
        this.process = null;
        return;
      }
      const stderrReason = normalizeReasonValue(this.lastStderr || "");
      if (stderrReason.includes("bind_address_in_use")) {
        this.lastError = "bind_address_in_use";
      } else if (stderrReason.includes("bind_permission_denied")) {
        this.lastError = "bind_permission_denied";
      } else {
        const detail = this.lastStderr ? `:${this.lastStderr}` : "";
        this.lastError = normalizeReasonValue(`process_exit:${code == null ? "null" : code}:${signal || "none"}${detail}`);
      }
      this.engineStatus = "unavailable";
      this.pycorrectorAvailable = false;
      console.error("[obsidian-chinese-checker] Python 进程退出:", this.lastError);
      this.process = null;
    });
    this.process.on("error", (error) => {
      this.lastError = normalizeReasonValue(`spawn_error:${error && error.message ? error.message : error}`);
      this.engineStatus = "unavailable";
      this.pycorrectorAvailable = false;
      console.error("[obsidian-chinese-checker] Python 进程拉起失败:", this.lastError);
    });
    this.process.stderr.on("data", (chunk) => {
      const text = String(chunk || "").trim();
      if (!text) return;
      this.lastStderr = text.slice(-180);
    });

    const startupTimeoutMs = Math.max(3000, Number(this.plugin.settings.pythonStartupTimeoutMs) || 12000);
    const attempts = Math.max(1, Math.ceil(startupTimeoutMs / 250));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.ping({ recordFailure: false })) return;
      if (!this.process) {
        if (await this.ping({ recordFailure: false })) return;
        throw new Error(this.lastError || "python_process_exit");
      }
      await sleep(250);
    }
    if (this.process) {
      this.lastError = "python_booting";
      throw new Error("python_booting");
    }
    this.lastError = normalizeReasonValue("startup_timeout");
    throw new Error("Python local engine startup timeout");
  }

  probeReadyInBackground() {
    if (this.pendingReadyProbe) return;
    this.pendingReadyProbe = (async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const online = await this.ping({ recordFailure: false }).catch(() => false);
        if (online) {
          this.lastError = "";
          this.resetFailureCircuit();
          this.warnedPythonError = false;
          if (this.plugin && typeof this.plugin.onPythonEngineReady === "function") {
            this.plugin.onPythonEngineReady().catch(() => {});
          }
          return;
        }
        if (!this.process) return;
        await sleep(500);
      }
    })().finally(() => {
      this.pendingReadyProbe = null;
    });
  }

  stop() {
    if (!this.process) return;
    this.explicitStopping = true;
    this.process.kill();
    this.process = null;
    this.engineStatus = "init";
    this.pycorrectorAvailable = null;
    this.resetFailureCircuit();
    this.pycorrectorLoading = null;
    this.pendingReadyProbe = null;
  }
}

class EngineManager {
  constructor(plugin) {
    this.plugin = plugin;
    this.jsEngine = new JsRuleEngine(plugin);
    this.pythonEngine = new PythonLocalEngine(plugin);
  }

  resolvePythonFallbackReason(cause = "") {
    const normalizedCause = normalizeReasonValue(cause || this.pythonEngine.lastError || "unknown");
    const pyDetail = normalizeReasonValue(this.pythonEngine.pycorrectorError || "");
    if (normalizedCause === "python_booting") {
      if (this.plugin.pythonStartupGateDone) return "python_unreachable";
      return "python_booting";
    }
    if (normalizedCause === "python_not_started") return "python_not_started";
    if (normalizedCause === "bind_address_in_use" || normalizedCause === "bind_permission_denied") {
      return `python_unavailable:${normalizedCause}`;
    }
    if (
      normalizedCause === "python_unreachable" &&
      pyDetail &&
      (this.pythonEngine.engineStatus === "unavailable" || this.pythonEngine.pycorrectorAvailable === false)
    ) {
      return `python_unavailable:${pyDetail}`;
    }
    if (
      normalizedCause === "python_unreachable" &&
      (this.pythonEngine.engineStatus === "unavailable" || this.pythonEngine.pycorrectorAvailable === false)
    ) {
      return `python_unavailable:${this.pythonEngine.lastError || "unknown"}`;
    }
    if (
      normalizedCause === "python_unreachable" &&
      this.pythonEngine.lastError &&
      this.pythonEngine.lastError !== "python_unreachable" &&
      !isTransientFetchReason(this.pythonEngine.lastError)
    ) {
      return `python_unavailable:${this.pythonEngine.lastError}`;
    }
    if (normalizedCause === "python_service_incompatible") {
      return "python_service_incompatible";
    }
    if (
      (normalizedCause === "python_check_timeout" || normalizedCause === "python_health_timeout") &&
      this.plugin.pythonStartupGateDone
    ) {
      return `python_unavailable:${normalizedCause}`;
    }
    if (isTransientFetchReason(normalizedCause)) {
      if (this.plugin.settings.pythonAutoStart && !this.plugin.pythonStartupGateDone) return "python_booting";
      return "python_unreachable";
    }
    if (this.pythonEngine.engineStatus === "unavailable") {
      return `python_unavailable:${this.pythonEngine.lastError || "unknown"}`;
    }
    return `python_error:${normalizedCause || "unknown"}`;
  }

  mergeMatches(groups) {
    const merged = [];
    const map = new Map();
    for (const list of groups) {
      for (const match of list) {
        const key = makeMatchKey(match);
        if (!map.has(key)) {
          map.set(key, {
            ...match,
            replacements: [...(match.replacements || [])]
          });
          continue;
        }
        const existing = map.get(key);
        const replacements = new Map();
        for (const item of existing.replacements || []) {
          replacements.set(item.value, item);
        }
        for (const item of match.replacements || []) {
          replacements.set(item.value, item);
        }
        const confidence = Math.max(existing.confidence || 0, match.confidence || 0);
        map.set(key, {
          ...existing,
          confidence,
          replacements: [...replacements.values()]
        });
      }
    }
    merged.push(...map.values());
    merged.sort((a, b) => a.from - b.from || (b.confidence || 0) - (a.confidence || 0));
    return merged;
  }

  hasOverlap(a, b) {
    return a.from < b.to && b.from < a.to;
  }

  supplementJsMatches(pythonMatches, jsMatches) {
    if (!pythonMatches.length) return jsMatches;
    return jsMatches.filter((candidate) => {
      for (const py of pythonMatches) {
        if (this.hasOverlap(candidate, py)) return false;
      }
      return true;
    });
  }

  async detect(text, context) {
    const mode = this.plugin.settings.engineMode;
    const forceJsOnly = Boolean(context && context.forceJsOnly);
    if (forceJsOnly) {
      return {
        matches: await this.jsEngine.detect(text, context),
        engineUsed: "js",
        fallbackReason: ""
      };
    }
    if ((mode === ENGINE_MODES.PYTHON || mode === ENGINE_MODES.HYBRID) && !this.plugin.settings.pythonEngineEnabled) {
      return {
        matches: await this.jsEngine.detect(text, context),
        engineUsed: "js",
        fallbackReason: "python_disabled"
      };
    }
    if (mode === ENGINE_MODES.JS) {
      return {
        matches: await this.jsEngine.detect(text, context),
        engineUsed: "js",
        fallbackReason: ""
      };
    }
    if (mode === ENGINE_MODES.PYTHON) {
      try {
        const pyMatches = await this.pythonEngine.detect(text, context);
        return {
          matches: Array.isArray(pyMatches) ? pyMatches : [],
          engineUsed: this.pythonEngine.getRuntimeEngineLabel("python"),
          fallbackReason: ""
        };
      } catch (error) {
        return {
          matches: [],
          engineUsed: this.pythonEngine.getRuntimeEngineLabel("python"),
          fallbackReason: this.resolvePythonFallbackReason(
            this.pythonEngine.lastError || (error && error.message ? error.message : "unknown")
          )
        };
      }
    }
    let pythonMatches = [];
    let pythonFallbackReason = "";
    try {
      pythonMatches = await this.pythonEngine.detect(text, context);
    } catch (error) {
      pythonMatches = [];
      pythonFallbackReason = this.resolvePythonFallbackReason(
        this.pythonEngine.lastError || (error && error.message ? error.message : "unknown")
      );
    }
    if (!pythonMatches.length) {
      return {
        matches: await this.jsEngine.detect(text, context),
        engineUsed: "js",
        fallbackReason:
          pythonFallbackReason ||
          (this.pythonEngine.engineStatus === "unavailable"
            ? `python_unavailable:${this.pythonEngine.lastError || "unknown"}`
            : `python_empty:${this.pythonEngine.lastEngineDetail || "unknown"}`)
      };
    }
    const jsMatches = await this.jsEngine.detect(text, context);
    const supplement = this.supplementJsMatches(pythonMatches, jsMatches);
    return {
      matches: this.mergeMatches([pythonMatches, supplement]),
      engineUsed: this.pythonEngine.getRuntimeEngineLabel("混合"),
      fallbackReason: pythonFallbackReason
    };
  }

  async ensurePythonEngineStarted() {
    await this.pythonEngine.ensureStarted();
  }

  stopPythonEngine() {
    this.pythonEngine.stop();
  }

  async waitForPythonReady(maxWaitMs = PY_STARTUP_GATE_WAIT_MS) {
    const mode = this.plugin.settings.engineMode;
    if (mode === ENGINE_MODES.JS) return { state: "skipped", waitedMs: 0 };
    if (!this.plugin.settings.pythonEngineEnabled) return { state: "skipped", waitedMs: 0 };
    if (!this.plugin.settings.pythonAutoStart) return { state: "skipped", waitedMs: 0 };

    const startedAt = Date.now();
    this.pythonEngine.ensureStartedInBackground();
    while (Date.now() - startedAt < maxWaitMs) {
      const online = await this.pythonEngine.ping({ recordFailure: false }).catch(() => false);
      if (online) {
        if (this.pythonEngine.pycorrectorAvailable === true || this.pythonEngine.engineStatus === "ready") {
          return { state: "ready", waitedMs: Date.now() - startedAt };
        }
        if (this.pythonEngine.pycorrectorAvailable === false || this.pythonEngine.engineStatus === "unavailable") {
          return { state: "unavailable", waitedMs: Date.now() - startedAt };
        }
      }
      await sleep(350);
    }
    return { state: "timeout", waitedMs: Date.now() - startedAt };
  }
}

class ScanReportModal extends Modal {
  constructor(app, report) {
    super(app);
    this.report = report;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "中文纠错扫描结果" });
    contentEl.createEl("p", {
      text: `文件总数：${this.report.totalFiles}，跳过：${this.report.skippedFiles}，命中：${this.report.hitFiles}，问题数：${this.report.totalMatches}`
    });

    const list = contentEl.createEl("div", { cls: "csc-scan-list" });
    const preview = this.report.items.slice(0, 80);
    for (const item of preview) {
      list.createEl("div", {
        text: `${item.file}  L${item.line}  ${item.token} -> ${item.suggestion}`,
        cls: "csc-scan-item"
      });
    }
    if (this.report.items.length > preview.length) {
      contentEl.createEl("p", {
        text: `仅显示前 ${preview.length} 条。`
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CscResultPanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.payload = null;
  }

  getViewType() {
    return RESULT_VIEW_TYPE;
  }

  getDisplayText() {
    return "错别字结果";
  }

  getIcon() {
    return "list-checks";
  }

  async onOpen() {
    this.plugin.onResultPanelActivated().catch(() => {});
    this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  setPayload(payload) {
    this.payload = payload;
    this.render();
  }

  async copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      new Notice("已复制");
    } catch (error) {
      new Notice("复制失败，请手动复制。");
    }
  }

  appendDiagnosticsLine(container, text, copyText = "", textClass = "") {
    const row = container.createEl("div", { cls: "csc-result-diagnostics-row" });
    const message = row.createEl("div", { cls: "csc-result-diagnostics", text });
    if (textClass) message.addClass(textClass);
    if (!copyText) return;
    const copyLink = row.createEl("span", { cls: "csc-result-copy-link", text: "复制" });
    copyLink.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.copyText(copyText).catch(() => {});
    };
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("csc-result-panel");
    const header = contentEl.createEl("div", { cls: "csc-result-header" });
    header.createEl("div", { cls: "csc-result-title", text: "中文纠错" });
    const headerRight = header.createEl("div", { cls: "csc-result-header-right" });
    const currentFileName =
      this.payload && this.payload.filePath ? path.basename(String(this.payload.filePath)) : "当前文件";
    headerRight.createEl("div", { cls: "csc-result-current-file", text: currentFileName });
    const checkButton = headerRight.createEl("button", { cls: "csc-result-refresh-btn", text: "检查当前文件" });
    checkButton.onclick = async () => {
      checkButton.disabled = true;
      try {
        const triggered = await this.plugin.triggerDetectionForActiveFileWithRetry("panel-button", 1, 80);
        if (!triggered) new Notice("请先打开一个 Markdown 文件。");
      } finally {
        checkButton.disabled = false;
      }
    };

    if (!this.payload) {
      contentEl.createEl("div", { cls: "csc-result-empty", text: "尚未执行检测。" });
      return;
    }

    if (this.payload.summary) {
      contentEl.createEl("div", { cls: "csc-result-summary", text: this.payload.summary });
    }
    if (this.payload.diagnostics) {
      const d = this.payload.diagnostics;
      const diagText = `触发:${d.trigger || "-"} | 引擎:${d.engine || "-"} | 耗时:${d.durationMs ?? "-"}ms | 时间:${d.timestamp || "-"}`;
      this.appendDiagnosticsLine(contentEl, diagText, diagText);
      if (d.requestId) {
        const requestText = `请求ID: ${d.requestId}`;
        this.appendDiagnosticsLine(contentEl, requestText, d.requestId);
      }
      if (d.engineSource) {
        const engineSourceText = `引擎来源: ${d.engineSource}`;
        this.appendDiagnosticsLine(contentEl, engineSourceText, d.engineSource);
      }
      const stageDurationsText = formatStageDurations(d.stageDurations);
      if (stageDurationsText) {
        this.appendDiagnosticsLine(contentEl, `阶段耗时: ${stageDurationsText}`, stageDurationsText);
      }
      if (d.fallbackReason) {
        const fallbackText = `回退原因: ${formatFallbackReason(d.fallbackReason)}`;
        this.appendDiagnosticsLine(contentEl, fallbackText, d.fallbackReason);
      }
      if (d.qualityHint) {
        this.appendDiagnosticsLine(contentEl, d.qualityHint, d.qualityHint, "csc-result-diagnostics-warning");
      }
      if (d.extraText) {
        this.appendDiagnosticsLine(contentEl, d.extraText, d.extraCopyText || d.extraText);
      }
      if (d.rawText) {
        this.appendDiagnosticsLine(contentEl, "诊断详情：点击复制", d.rawText);
      }
    }

    const items = this.payload.items || [];
    if (!items.length) {
      contentEl.createEl("div", { cls: "csc-result-empty", text: "🏆 当前无错" });
      return;
    }

    const list = contentEl.createEl("div", { cls: "csc-result-list" });
    const isSingleFileResult = this.payload && this.payload.source === "file" && Boolean(this.payload.filePath);
    for (const item of items) {
      const row = list.createEl("div", { cls: "csc-result-item" });
      const title = row.createEl("div", { cls: "csc-result-item-title" });
      title.createEl("span", { cls: "csc-result-item-line", text: `行${item.line}` });
      title.createEl("span", { cls: "csc-result-item-text", text: ` ${item.token}→${item.suggestion || "（无建议）"}` });
      if (!isSingleFileResult) {
        row.createEl("div", { cls: "csc-result-item-meta", text: item.filePath });
      }
      if (item.excerpt) {
        row.createEl("div", { cls: "csc-result-item-excerpt", text: item.excerpt });
      }
      row.onclick = () => {
        this.plugin.jumpToPanelResult(item).catch((error) => {
          new Notice(`跳转失败：${error.message}`);
        });
      };
    }
  }
}

class ChineseTypoSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "中文纠错插件设置" });

    new Setting(containerEl)
      .setName("实时检测")
      .setDesc("输入后自动检测并高亮疑似错别字。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.liveCheck).onChange(async (value) => {
          this.plugin.settings.liveCheck = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("实时检测延迟（毫秒）")
      .setDesc("输入后等待多久触发检测。")
      .addSlider((slider) =>
        slider
          .setLimits(150, 2000, 50)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.autoCheckDelayMs)
          .onChange(async (value) => {
            this.plugin.settings.autoCheckDelayMs = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("置信度阈值")
      .setDesc("低于阈值的建议不会展示。")
      .addSlider((slider) =>
        slider
          .setLimits(0.3, 0.95, 0.05)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.confidenceThreshold)
          .onChange(async (value) => {
            this.plugin.settings.confidenceThreshold = Number(value.toFixed(2));
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("引擎模式")
      .setDesc("Python：仅 Python（严格，不补 JS）；混合：Python 优先，空结果或异常时补/回退 JS；JS：仅本地规则。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption(ENGINE_MODES.JS, "仅 JS 引擎")
          .addOption(ENGINE_MODES.PYTHON, "仅 Python 引擎（严格）")
          .addOption(ENGINE_MODES.HYBRID, "混合（推荐）")
          .setValue(this.plugin.settings.engineMode)
          .onChange(async (value) => {
            this.plugin.settings.engineMode = value;
            await this.plugin.saveSettings();
            if (value !== ENGINE_MODES.JS && !this.plugin.settings.pythonEngineEnabled) {
              new Notice("当前 Python 引擎未启用，实际将回退到 JS。可在下方开启 Python 引擎。", 5000);
            }
          })
      );

    containerEl.createEl("h3", { text: "JS 引擎增强（CEDICT）" });
    const cedictRuntime = this.plugin.getJsCedictRuntime();
    const indexPath = this.plugin.getEffectiveCedictIndexPath();
    const sourcePath = this.plugin.getEffectiveCedictSourcePath();
    const loadedFrom = cedictRuntime.loadedFrom ? ` | 来源：${cedictRuntime.loadedFrom}` : "";
    const cedictStatus = cedictRuntime.ready
      ? `已加载 ${cedictRuntime.words.size} 词${loadedFrom}`
      : `未就绪（${cedictRuntime.error || "index_not_loaded"}）`;
    containerEl.createEl("p", {
      text: `CEDICT 状态：${cedictStatus}`
    });
    containerEl.createEl("p", {
      text: `源文件：${sourcePath} | 索引：${indexPath}`
    });
    new Setting(containerEl)
      .setName("启用 CEDICT 增强")
      .setDesc("增强 JS 的词典候选与误报抑制能力。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.jsCedictEnhanced).onChange(async (value) => {
          this.plugin.settings.jsCedictEnhanced = value;
          await this.plugin.saveSettings();
          await this.plugin.reloadJsCedictIndex({ showNotice: true });
          this.display();
        })
      );
    new Setting(containerEl)
      .setName("CEDICT 源文件路径")
      .setDesc("用于构建索引。默认指向 various-complements 插件中的 cedict_ts.u8。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.jsCedictSourcePath || "")
          .setPlaceholder(this.plugin.getRecommendedCedictSourcePath())
          .onChange(async (value) => {
            this.plugin.settings.jsCedictSourcePath = value.trim();
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("CEDICT 索引路径")
      .setDesc("JS 引擎实际加载的预处理索引 JSON 路径。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.jsCedictIndexPath || "")
          .setPlaceholder(DEFAULT_CEDICT_INDEX_FILENAME)
          .onChange(async (value) => {
            this.plugin.settings.jsCedictIndexPath = value.trim() || DEFAULT_CEDICT_INDEX_FILENAME;
            await this.plugin.saveSettings();
          })
      )
      .addButton((button) =>
        button.setButtonText("重载索引").onClick(async () => {
          await this.plugin.reloadJsCedictIndex({ showNotice: true });
          this.display();
        })
      )
      .addButton((button) =>
        button.setCta().setButtonText("复制构建命令").onClick(async () => {
          const command = this.plugin.getCedictBuildCommand();
          const copied = await this.plugin.copyTextToClipboard(command);
          if (copied) {
            new Notice("CEDICT 索引构建命令已复制。", 7000);
            return;
          }
          new Notice(`请手动执行：${command}`, 9000);
        })
      );

    containerEl.createEl("h3", { text: "Python 本地引擎" });
    const recommendedVenvDir = this.plugin.getRecommendedPythonVenvDir();
    const effectiveVenvDir = this.plugin.getEffectivePythonVenvDir();
    const resolvedExecutable = buildPythonExecutableFromVenvDir(effectiveVenvDir);
    const executableExists = fs.existsSync(resolvedExecutable);

    containerEl.createEl("p", {
      text: `首次安装建议：先确认 .venv 目录，再用“依赖安装助手”安装 pycorrector/torch。默认 .venv：${recommendedVenvDir}`
    });
    containerEl.createEl("p", {
      text: `当前 .venv：${effectiveVenvDir} | 推导 Python：${resolvedExecutable} | 存在：${executableExists}`
    });

    let pythonVenvDirInput = null;
    new Setting(containerEl)
      .setName("Python 虚拟环境目录（.venv）")
      .setDesc("可自定义存储位置。默认使用 S:\\obsidian-chinese-checker\\.venv。")
      .addText((text) => {
        pythonVenvDirInput = text;
        return text
          .setPlaceholder(recommendedVenvDir)
          .setValue(this.plugin.settings.pythonVenvDir || "")
          .onChange(async (value) => {
            this.plugin.settings.pythonVenvDir = normalizeVenvDir(value, recommendedVenvDir);
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) =>
        button.setButtonText("默认").onClick(async () => {
          await this.plugin.updatePythonVenvDir(recommendedVenvDir, { syncExecutable: true, showNotice: true });
          if (pythonVenvDirInput) pythonVenvDirInput.setValue(this.plugin.settings.pythonVenvDir);
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("插件目录").onClick(async () => {
          const localVenv = path.join(this.plugin.manifest.dir, ".venv");
          await this.plugin.updatePythonVenvDir(localVenv, { syncExecutable: true, showNotice: true });
          if (pythonVenvDirInput) pythonVenvDirInput.setValue(this.plugin.settings.pythonVenvDir);
          this.display();
        })
      )
      .addButton((button) =>
        button.setCta().setButtonText("应用到 Python 路径").onClick(async () => {
          await this.plugin.applyPythonExecutableFromVenvSetting({ showNotice: true });
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("依赖安装助手")
      .setDesc("根据当前 .venv 路径生成安装命令。建议先执行安装，再点“引擎自检”。")
      .addButton((button) =>
        button.setCta().setButtonText("复制安装命令").onClick(async () => {
          const command = this.plugin.getInstallCommandPreview();
          const copied = await this.plugin.copyTextToClipboard(command);
          if (copied) {
            new Notice("安装命令已复制。请在终端执行后回到插件运行自检。", 7000);
            return;
          }
          new Notice(`无法自动复制，请手动执行：${command}`, 9000);
        })
      )
      .addButton((button) =>
        button.setButtonText("引擎自检").onClick(async () => {
          await this.plugin.runPythonEngineSelfCheck();
        })
      );

    new Setting(containerEl)
      .setName("启用 Python 引擎")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pythonEngineEnabled).onChange(async (value) => {
          this.plugin.settings.pythonEngineEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("自动拉起 Python 服务")
      .setDesc("检测时后台拉起，不阻塞当前检查；启动完成后自动复检。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pythonAutoStart).onChange(async (value) => {
          this.plugin.settings.pythonAutoStart = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("仅手动检查时使用 Python")
      .setDesc("开启后，只有命令“检查当前文件”或面板按钮会调用 pycorrector；实时/切换文件等自动触发仅使用 JS。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pythonManualTriggerOnly).onChange(async (value) => {
          this.plugin.settings.pythonManualTriggerOnly = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Python 可执行文件")
      .setDesc("建议由上方 .venv 路径自动生成；如需自定义可手动修改。")
      .addText((text) =>
        text.setValue(this.plugin.settings.pythonExecutable).onChange(async (value) => {
          this.plugin.settings.pythonExecutable = value.trim() || "python";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Python 服务脚本路径")
      .setDesc("可填写绝对路径，也可填写相对插件目录路径。")
      .addText((text) =>
        text.setValue(this.plugin.settings.pythonScriptPath).onChange(async (value) => {
          this.plugin.settings.pythonScriptPath = value.trim() || "python_engine_service.py";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Python 服务端口")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pythonPort)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed <= 0) return;
          this.plugin.settings.pythonPort = Math.floor(parsed);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Python 启动超时（毫秒）")
      .setDesc("仅控制后台拉起服务，不会阻塞当前检查流程。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pythonStartupTimeoutMs)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 3000) return;
          this.plugin.settings.pythonStartupTimeoutMs = Math.floor(parsed);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Python 检测超时（毫秒）")
      .setDesc("单次 Python 检测请求超时；超时会临时回退 JS。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pythonTimeoutMs)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 3000) return;
          this.plugin.settings.pythonTimeoutMs = Math.floor(parsed);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("词典白名单（逗号分隔）")
      .setDesc("命中这些词时不再提示。")
      .addTextArea((area) =>
        area
          .setValue(this.plugin.settings.userDictionary.join(","))
          .onChange(async (value) => {
            this.plugin.settings.userDictionary = value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("frontmatter 跳过字段")
      .setDesc("固定为 language-tool-ignore；值为 true 时跳过检测。")
      .addText((text) => text.setDisabled(true).setValue(this.plugin.settings.frontmatterKey));
  }
}

function createEditorExtensions(plugin) {
  const tooltip = hoverTooltip((view, pos) => {
    let target = null;
    const marks = view.state.field(MATCHES_FIELD, false);
    if (!marks) return null;
    const right = Math.min(pos + 1, view.state.doc.length);
    const left = Math.max(pos - 1, 0);
    marks.between(left, right, (from, to, value) => {
      if (pos < from || pos > to) return;
      target = {
        from,
        to,
        match: value.spec.matchData
      };
    });
    if (!target || !target.match) return null;

    return {
      pos: target.from,
      end: target.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "csc-tooltip";

        const title = document.createElement("div");
        title.className = "csc-title";
        title.textContent = target.match.shortMessage || "疑似错别字";
        dom.appendChild(title);

        const message = document.createElement("div");
        message.className = "csc-message";
        message.textContent = target.match.message || "";
        dom.appendChild(message);

        const actions = document.createElement("div");
        actions.className = "csc-actions";
        dom.appendChild(actions);
        const suggestions = (target.match.replacements || []).slice(0, 3);
        for (const item of suggestions) {
          const button = document.createElement("button");
          button.className = "csc-btn";
          button.textContent = item.value;
          button.onclick = () => {
            plugin.applyReplacement(view, target, item.value);
          };
          actions.appendChild(button);
        }

        const extra = document.createElement("div");
        extra.className = "csc-extra-actions";
        dom.appendChild(extra);

        const ignoreButton = document.createElement("button");
        ignoreButton.className = "csc-btn csc-btn-secondary";
        ignoreButton.textContent = "忽略本条";
        ignoreButton.onclick = () => plugin.ignoreSuggestion(view, target);
        extra.appendChild(ignoreButton);

        if (target.match.category === "TYPOS") {
          const dictButton = document.createElement("button");
          dictButton.className = "csc-btn csc-btn-secondary";
          dictButton.textContent = "加入词典";
          dictButton.onclick = () => plugin.addTokenToDictionary(target.match.token || "");
          extra.appendChild(dictButton);
        }

        return { dom };
      }
    };
  });

  const listener = EditorView.updateListener.of((update) => {
    if (!update.docChanged || !plugin.settings.liveCheck) return;
    const markdownContext = getMarkdownViewFromState(update.state);
    if (!isMarkdownContext(markdownContext)) return;
    plugin.scheduleDetection(update.view, markdownContext);
  });

  return [MATCHES_FIELD, tooltip, listener];
}

module.exports = class ChineseTypoCheckerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    if (this.settingsNeedSaveAfterLoad) {
      await this.saveSettings();
      this.settingsNeedSaveAfterLoad = false;
    }
    this.engineManager = new EngineManager(this);
    this.debounceTimers = new WeakMap();
    this.sessionIgnored = new Set();
    this.latestPanelPayload = null;
    this.lastMarkdownView = null;
    this.fileDetectionQueue = new Map();
    this.fileDetectionVersion = new Map();
    this.detectionRequestSeq = 0;
    this.pythonStartupGateDone = false;
    this.pythonStartupGateLastAttemptAt = 0;
    this.pythonStartupGatePromise = null;
    this.pythonStartupGatePromiseStartedAt = 0;
    this.pythonStartupGatePromiseToken = 0;
    this.pythonStartupGateAttemptCount = 0;
    this.pythonStartupGateFallbackReason = "";
    this.manualDetectionWindowUntil = 0;
    this.jsCedictRuntime = {
      enabled: Boolean(this.settings.jsCedictEnhanced),
      ready: false,
      loadedFrom: "",
      indexPath: "",
      sourcePath: "",
      version: "",
      words: new Set(),
      frequentWords: new Set(),
      charConfusions: new Map(),
      error: ""
    };
    await this.reloadJsCedictIndex({ showNotice: false });

    this.registerEditorExtension(createEditorExtensions(this));
    this.addSettingTab(new ChineseTypoSettingTab(this.app, this));
    this.registerView(RESULT_VIEW_TYPE, (leaf) => new CscResultPanelView(leaf, this));
    this.app.workspace.onLayoutReady(() => {
      this.ensureResultPanel(false).catch(() => {});
      this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView) || null;
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf || !leaf.view) return;
        if (leaf.view instanceof MarkdownView) {
          this.lastMarkdownView = leaf.view;
          if (this.isResultPanelVisible()) {
            this.triggerDetectionForActiveFileWithRetry("active-leaf-change").catch(() => {});
          }
          return;
        }
        if (typeof leaf.view.getViewType === "function" && leaf.view.getViewType() === RESULT_VIEW_TYPE) {
          this.onResultPanelActivated().catch(() => {});
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!(file instanceof TFile)) return;
        if (!this.isResultPanelVisible()) return;
        this.triggerDetectionForActiveFileWithRetry("file-open").catch(() => {});
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (!this.isResultPanelVisible()) return;
        this.triggerDetectionForActiveFileWithRetry("layout-change", 1, 100).catch(() => {});
      })
    );

    this.addCommand({
      id: "csc-check-current-file",
      name: "中文纠错：检查当前文件",
      editorCallback: async (_editor, markdownView) => {
        await this.runDetectionForView(markdownView, resolveEditorView(markdownView), "manual");
      }
    });

    this.addCommand({
      id: "csc-open-result-panel",
      name: "中文纠错：打开结果面板",
      callback: async () => {
        await this.ensureResultPanel(true);
      }
    });

    this.addCommand({
      id: "csc-scan-vault",
      name: "中文纠错：扫描整个库",
      callback: async () => {
        await this.scanVault();
      }
    });

    this.addCommand({
      id: "csc-clear-highlights",
      name: "中文纠错：清除高亮",
      editorCallback: async (_editor, markdownView) => {
        this.clearHighlights(resolveEditorView(markdownView));
        await this.updateResultPanel({
          source: "file",
          filePath: markdownView.file ? markdownView.file.path : "",
          items: []
        });
      }
    });

    this.addCommand({
      id: "csc-toggle-live-check",
      name: "中文纠错：切换实时检测",
      callback: async () => {
        this.settings.liveCheck = !this.settings.liveCheck;
        await this.saveSettings();
        new Notice(`实时检测已${this.settings.liveCheck ? "开启" : "关闭"}`);
      }
    });

    this.addCommand({
      id: "csc-toggle-current-file-ignore",
      name: "中文纠错：切换当前文件跳过检测（frontmatter）",
      callback: async () => {
        await this.toggleCurrentFileIgnore();
      }
    });

    this.addCommand({
      id: "csc-reload-python-engine",
      name: "中文纠错：重载引擎",
      callback: async () => {
        await this.reloadPythonEngine();
      }
    });

    this.addCommand({
      id: "csc-run-python-self-check",
      name: "中文纠错：引擎自检",
      callback: async () => {
        await this.runPythonEngineSelfCheck();
      }
    });

    this.addCommand({
      id: "csc-copy-python-install-command",
      name: "中文纠错：复制 Python 依赖安装命令",
      callback: async () => {
        const command = this.getInstallCommandPreview();
        const copied = await this.copyTextToClipboard(command);
        if (copied) {
          new Notice("安装命令已复制到剪贴板。");
          return;
        }
        new Notice(`无法自动复制，请手动执行：${command}`, 9000);
      }
    });

    this.addCommand({
      id: "csc-reload-js-cedict-index",
      name: "中文纠错：重载 JS CEDICT 索引",
      callback: async () => {
        await this.reloadJsCedictIndex({ showNotice: true });
      }
    });

    this.addCommand({
      id: "csc-copy-js-cedict-build-command",
      name: "中文纠错：复制 CEDICT 索引构建命令",
      callback: async () => {
        const command = this.getCedictBuildCommand();
        const copied = await this.copyTextToClipboard(command);
        if (copied) {
          new Notice("CEDICT 索引构建命令已复制。");
          return;
        }
        new Notice(`无法自动复制，请手动执行：${command}`, 9000);
      }
    });

    await this.applyPythonPreflightGuard();

    if (this.settings.pythonEngineEnabled && this.settings.pythonAutoStart) {
      setTimeout(() => {
        this.engineManager.ensurePythonEngineStarted().catch(() => {});
      }, 200);
    }

    new Notice("✅ 中文纠错插件已加载");
    this.maybeShowPythonSetupHint().catch(() => {});
  }

  onunload() {
    if (this.engineManager) this.engineManager.stopPythonEngine();
    this.app.workspace.detachLeavesOfType(RESULT_VIEW_TYPE);
  }

  getRecommendedPythonVenvDir() {
    if (isWindowsPlatform()) return normalizeVenvDir(DEFAULT_WINDOWS_VENV_DIR, DEFAULT_WINDOWS_VENV_DIR);
    const localVenv = path.join(this.manifest.dir, ".venv");
    return normalizeVenvDir(localVenv, localVenv);
  }

  getEffectivePythonVenvDir() {
    const recommended = this.getRecommendedPythonVenvDir();
    return normalizeVenvDir(this.settings.pythonVenvDir, recommended);
  }

  getInstallCommandPreview() {
    const installScriptPath = path.join(this.manifest.dir, "install_pycorrector.bat");
    return buildInstallScriptCommand(installScriptPath, this.getEffectivePythonVenvDir());
  }

  getVaultBasePath() {
    const adapter = this.app && this.app.vault ? this.app.vault.adapter : null;
    if (!adapter || typeof adapter.getBasePath !== "function") return "";
    try {
      return adapter.getBasePath();
    } catch (error) {
      return "";
    }
  }

  getRecommendedCedictSourcePath() {
    const vaultBase = this.getVaultBasePath();
    if (!vaultBase) return CEDICT_DEFAULT_FALLBACK_SOURCE;
    return path.join(vaultBase, CEDICT_DEFAULT_FALLBACK_SOURCE);
  }

  resolveCedictPath(inputValue, fallbackValue = "") {
    const raw = String(inputValue || "").trim();
    const fallback = String(fallbackValue || "").trim();
    const candidate = raw || fallback;
    if (!candidate) return "";
    if (path.isAbsolute(candidate)) return path.normalize(candidate);
    const normalizedRelative = candidate.replace(/^[\\/]+/, "");
    const candidates = [];
    const pushCandidate = (value) => {
      if (!value) return;
      const normalized = path.normalize(value);
      if (!candidates.includes(normalized)) candidates.push(normalized);
    };
    pushCandidate(path.join(this.manifest.dir, normalizedRelative));
    const vaultBase = this.getVaultBasePath();
    if (vaultBase && this.manifest && this.manifest.id) {
      pushCandidate(path.join(vaultBase, ".obsidian", "plugins", this.manifest.id, normalizedRelative));
    }
    if (vaultBase) {
      pushCandidate(path.join(vaultBase, normalizedRelative));
    }
    for (const resolved of candidates) {
      if (fs.existsSync(resolved)) return resolved;
    }
    return candidates[0] || path.normalize(candidate);
  }

  getEffectiveCedictSourcePath() {
    return this.resolveCedictPath(this.settings.jsCedictSourcePath, this.getRecommendedCedictSourcePath());
  }

  getEffectiveCedictIndexPath() {
    return this.resolveCedictPath(this.settings.jsCedictIndexPath, path.join(this.manifest.dir, DEFAULT_CEDICT_INDEX_FILENAME));
  }

  getCedictBuildCommand() {
    const builderPath = path.join(this.manifest.dir, "tools", "build_cedict_index.js");
    const sourcePath = this.getEffectiveCedictSourcePath();
    const indexPath = this.getEffectiveCedictIndexPath();
    return `node "${builderPath}" --input "${sourcePath}" --output "${indexPath}"`;
  }

  getJsCedictRuntime() {
    if (!this.jsCedictRuntime) {
      return {
        enabled: false,
        ready: false,
        loadedFrom: "",
        words: new Set(),
        frequentWords: new Set(),
        charConfusions: new Map(),
        error: "uninitialized"
      };
    }
    return this.jsCedictRuntime;
  }

  async reloadJsCedictIndex(options = {}) {
    const showNotice = options.showNotice === true;
    const runtime = {
      enabled: Boolean(this.settings.jsCedictEnhanced),
      ready: false,
      loadedFrom: "",
      indexPath: this.getEffectiveCedictIndexPath(),
      sourcePath: this.getEffectiveCedictSourcePath(),
      version: "",
      words: new Set(),
      frequentWords: new Set(),
      charConfusions: new Map(),
      error: ""
    };
    if (!runtime.enabled) {
      this.jsCedictRuntime = runtime;
      if (showNotice) new Notice("CEDICT 增强已关闭。");
      return runtime;
    }
    try {
      let parsed = null;
      if (runtime.indexPath && fs.existsSync(runtime.indexPath)) {
        const rawIndex = fs.readFileSync(runtime.indexPath, "utf8");
        parsed = parseCedictIndexFile(rawIndex);
        runtime.loadedFrom = "index";
      } else if (runtime.sourcePath && fs.existsSync(runtime.sourcePath)) {
        const rawSource = fs.readFileSync(runtime.sourcePath, "utf8");
        parsed = parseCedictSourceFile(rawSource);
        runtime.loadedFrom = "source";
      } else {
        runtime.error = "cedict_index_not_found";
        this.jsCedictRuntime = runtime;
        if (showNotice) {
          new Notice(
            `未找到 CEDICT 索引与源文件。索引：${runtime.indexPath || "(empty)"}；源文件：${runtime.sourcePath || "(empty)"}`,
            10000
          );
        }
        return runtime;
      }
      runtime.ready = true;
      runtime.version = parsed.version;
      runtime.sourcePath = parsed.sourcePath || runtime.sourcePath;
      runtime.words = parsed.words;
      runtime.frequentWords = parsed.frequentWords;
      runtime.charConfusions = parsed.charConfusions;
      runtime.error = "";
      this.jsCedictRuntime = runtime;
      if (showNotice) {
        const sourceLabel = runtime.loadedFrom === "index" ? "索引" : "源文件";
        new Notice(`CEDICT 已从${sourceLabel}加载：${runtime.words.size} 词。`, 7000);
      }
      return runtime;
    } catch (error) {
      runtime.error = normalizeReasonValue(error && error.message ? error.message : error);
      this.jsCedictRuntime = runtime;
      if (showNotice) {
        new Notice(`加载 CEDICT 索引失败：${runtime.error}`, 9000);
      }
      return runtime;
    }
  }

  async copyTextToClipboard(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    if (typeof navigator === "undefined" || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      return false;
    }
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      return false;
    }
  }

  async updatePythonVenvDir(nextVenvDir, options = {}) {
    const syncExecutable = options.syncExecutable !== false;
    const showNotice = options.showNotice === true;
    const recommended = this.getRecommendedPythonVenvDir();
    const normalizedVenvDir = normalizeVenvDir(nextVenvDir, recommended);
    this.settings.pythonVenvDir = normalizedVenvDir;
    if (syncExecutable) {
      this.settings.pythonExecutable = buildPythonExecutableFromVenvDir(normalizedVenvDir);
    }
    await this.saveSettings();
    if (showNotice) {
      const summary = syncExecutable
        ? `已更新 .venv 目录并同步 Python 路径：${this.settings.pythonExecutable}`
        : `已更新 .venv 目录：${normalizedVenvDir}`;
      new Notice(summary, 6000);
    }
  }

  async applyPythonExecutableFromVenvSetting(options = {}) {
    const showNotice = options.showNotice === true;
    const normalizedVenvDir = this.getEffectivePythonVenvDir();
    this.settings.pythonVenvDir = normalizedVenvDir;
    this.settings.pythonExecutable = buildPythonExecutableFromVenvDir(normalizedVenvDir);
    await this.saveSettings();
    if (showNotice) {
      new Notice(`已应用 Python 可执行文件：${this.settings.pythonExecutable}`, 6000);
    }
    return this.settings.pythonExecutable;
  }

  async maybeShowPythonSetupHint() {
    if (!isWindowsPlatform()) return;
    if (this.settings.pythonSetupHintDismissed) return;
    if (!this.engineManager || !this.engineManager.pythonEngine) return;
    const executable = this.engineManager.pythonEngine.getExecutableCheck();
    if (executable.exists !== false) return;
    const installCommand = this.getInstallCommandPreview();
    new Notice(`未检测到 Python venv。请先安装依赖：${installCommand}`, 10000);
    this.settings.pythonSetupHintDismissed = true;
    await this.saveSettings();
  }

  async loadSettings() {
    const stored = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    let changed = false;

    if (!this.settings.frontmatterKey) {
      this.settings.frontmatterKey = FRONTMATTER_KEY;
      changed = true;
    }

    const hasStoredVenv = Object.prototype.hasOwnProperty.call(stored, "pythonVenvDir");
    if (!hasStoredVenv || !String(this.settings.pythonVenvDir || "").trim()) {
      this.settings.pythonVenvDir = this.getRecommendedPythonVenvDir();
      changed = true;
    } else {
      const normalized = normalizeVenvDir(this.settings.pythonVenvDir, this.getRecommendedPythonVenvDir());
      if (normalized !== this.settings.pythonVenvDir) {
        this.settings.pythonVenvDir = normalized;
        changed = true;
      }
    }

    const hasStoredExecutable = Object.prototype.hasOwnProperty.call(stored, "pythonExecutable");
    if (!hasStoredExecutable || !String(this.settings.pythonExecutable || "").trim()) {
      this.settings.pythonExecutable = buildPythonExecutableFromVenvDir(this.settings.pythonVenvDir);
      changed = true;
    }

    if (!Object.prototype.hasOwnProperty.call(stored, "pythonSetupHintDismissed")) {
      this.settings.pythonSetupHintDismissed = false;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(stored, "pythonManualTriggerOnly")) {
      this.settings.pythonManualTriggerOnly = true;
      changed = true;
    } else if (typeof this.settings.pythonManualTriggerOnly !== "boolean") {
      this.settings.pythonManualTriggerOnly = Boolean(this.settings.pythonManualTriggerOnly);
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(stored, "jsCedictEnhanced")) {
      this.settings.jsCedictEnhanced = true;
      changed = true;
    } else if (typeof this.settings.jsCedictEnhanced !== "boolean") {
      this.settings.jsCedictEnhanced = Boolean(this.settings.jsCedictEnhanced);
      changed = true;
    }
    const defaultSource = this.getRecommendedCedictSourcePath();
    if (!Object.prototype.hasOwnProperty.call(stored, "jsCedictSourcePath") || !String(this.settings.jsCedictSourcePath || "").trim()) {
      this.settings.jsCedictSourcePath = defaultSource;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(stored, "jsCedictIndexPath") || !String(this.settings.jsCedictIndexPath || "").trim()) {
      this.settings.jsCedictIndexPath = DEFAULT_CEDICT_INDEX_FILENAME;
      changed = true;
    }

    const startupTimeoutMs = Number(this.settings.pythonStartupTimeoutMs) || 0;
    if (startupTimeoutMs > 0 && startupTimeoutMs < 18000) {
      this.settings.pythonStartupTimeoutMs = 18000;
      changed = true;
    }

    this.settingsNeedSaveAfterLoad = changed;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async applyPythonStartupHealthGate() {
    if (this.pythonStartupGateDone) {
      const doneFallbackReason = this.pythonStartupGateFallbackReason || "";
      const canRearm =
        doneFallbackReason &&
        isRetryableGateFallbackReason(doneFallbackReason) &&
        Date.now() - (this.pythonStartupGateLastAttemptAt || 0) >= PY_STARTUP_GATE_REARM_COOLDOWN_MS;
      if (canRearm) {
        this.pythonStartupGateDone = false;
        this.pythonStartupGatePromise = null;
        this.pythonStartupGatePromiseStartedAt = 0;
        this.pythonStartupGatePromiseToken += 1;
        this.pythonStartupGateAttemptCount = 0;
        this.pythonStartupGateFallbackReason = "";
      } else {
        return {
          state: "done",
          waitedMs: 0,
          attempts: this.pythonStartupGateAttemptCount || 0,
          fallbackReason: doneFallbackReason
        };
      }
    }
    if (!this.engineManager) return { state: "skipped", waitedMs: 0, attempts: 0, fallbackReason: "" };
    if (this.pythonStartupGatePromise) {
      const pendingMs = Math.max(0, Date.now() - (this.pythonStartupGatePromiseStartedAt || Date.now()));
      if (pendingMs > PY_STARTUP_GATE_PENDING_STALE_MS) {
        this.pythonStartupGatePromise = null;
        this.pythonStartupGatePromiseStartedAt = 0;
        this.pythonStartupGatePromiseToken += 1;
        const attempts = this.pythonStartupGateAttemptCount || 0;
        if (attempts >= PY_STARTUP_GATE_MAX_ATTEMPTS) {
          this.pythonStartupGateDone = true;
          if (!this.pythonStartupGateFallbackReason) {
            this.pythonStartupGateFallbackReason = "python_unavailable:startup_timeout";
          }
          return {
            state: "failed",
            waitedMs: pendingMs,
            attempts,
            fallbackReason: this.pythonStartupGateFallbackReason
          };
        }
        return {
          state: "timeout",
          waitedMs: pendingMs,
          attempts,
          fallbackReason: this.pythonStartupGateFallbackReason || ""
        };
      }
      return {
        state: "pending",
        waitedMs: pendingMs,
        attempts: this.pythonStartupGateAttemptCount || 0,
        fallbackReason: this.pythonStartupGateFallbackReason || ""
      };
    }
    if ((this.pythonStartupGateAttemptCount || 0) >= PY_STARTUP_GATE_MAX_ATTEMPTS) {
      this.pythonStartupGateDone = true;
      if (!this.pythonStartupGateFallbackReason) this.pythonStartupGateFallbackReason = "python_unreachable";
      return {
        state: "failed",
        waitedMs: 0,
        attempts: this.pythonStartupGateAttemptCount || 0,
        fallbackReason: this.pythonStartupGateFallbackReason
      };
    }

    const now = Date.now();
    if (now - this.pythonStartupGateLastAttemptAt < PY_STARTUP_GATE_RETRY_COOLDOWN_MS) {
      return {
        state: "cooldown",
        waitedMs: 0,
        attempts: this.pythonStartupGateAttemptCount || 0,
        fallbackReason: this.pythonStartupGateFallbackReason || ""
      };
    }
    this.pythonStartupGateLastAttemptAt = now;
    this.pythonStartupGateAttemptCount += 1;
    const attempt = this.pythonStartupGateAttemptCount;
    const gateToken = (this.pythonStartupGatePromiseToken || 0) + 1;
    this.pythonStartupGatePromiseToken = gateToken;
    this.pythonStartupGatePromiseStartedAt = now;

    this.pythonStartupGatePromise = this.engineManager
      .waitForPythonReady(PY_STARTUP_GATE_WAIT_MS)
      .then((result) => {
        if (this.pythonStartupGatePromiseToken !== gateToken) {
          return {
            state: "timeout",
            waitedMs: 0,
            attempts: attempt,
            fallbackReason: ""
          };
        }
        const normalized = {
          state: result.state || "timeout",
          waitedMs: Number(result.waitedMs) || 0,
          attempts: attempt,
          fallbackReason: ""
        };
        if (normalized.state === "ready" || normalized.state === "skipped") {
          this.pythonStartupGateDone = true;
          this.pythonStartupGateFallbackReason = "";
        }
        if (normalized.state === "ready") {
          this.onPythonEngineReady().catch(() => {});
        }
        if (normalized.state === "unavailable") {
          const engine = this.engineManager.pythonEngine;
          const candidate = this.engineManager.resolvePythonFallbackReason(
            (engine && (engine.pycorrectorError || engine.lastError)) || "python_unavailable:unknown"
          );
          const reason = candidate === "python_booting" ? "python_unreachable" : candidate;
          this.pythonStartupGateDone = true;
          this.pythonStartupGateFallbackReason = reason || "python_unreachable";
          normalized.fallbackReason = this.pythonStartupGateFallbackReason;
          this.triggerDetectionForActiveFileWithRetry("python-gate-finalize", 1, 80).catch(() => {});
          return normalized;
        }
        if (normalized.state === "timeout" && attempt >= PY_STARTUP_GATE_MAX_ATTEMPTS) {
          this.pythonStartupGateDone = true;
          this.pythonStartupGateFallbackReason = "python_unavailable:startup_timeout";
          normalized.state = "failed";
          normalized.fallbackReason = this.pythonStartupGateFallbackReason;
          this.triggerDetectionForActiveFileWithRetry("python-gate-finalize", 1, 80).catch(() => {});
        }
        return normalized;
      })
      .catch((error) => {
        if (this.pythonStartupGatePromiseToken !== gateToken) {
          return {
            state: "timeout",
            waitedMs: 0,
            attempts: attempt,
            fallbackReason: ""
          };
        }
        const candidate = this.engineManager.resolvePythonFallbackReason(error && error.message ? error.message : error);
        const reason = candidate === "python_booting" ? "python_unreachable" : candidate;
        if (attempt >= PY_STARTUP_GATE_MAX_ATTEMPTS) {
          this.pythonStartupGateDone = true;
          this.pythonStartupGateFallbackReason = reason || "python_unreachable";
          this.triggerDetectionForActiveFileWithRetry("python-gate-finalize", 1, 80).catch(() => {});
          return {
            state: "failed",
            waitedMs: 0,
            attempts: attempt,
            fallbackReason: this.pythonStartupGateFallbackReason
          };
        }
        return {
          state: "timeout",
          waitedMs: 0,
          attempts: attempt,
          fallbackReason: ""
        };
      })
      .finally(() => {
        if (this.pythonStartupGatePromiseToken === gateToken) {
          this.pythonStartupGatePromise = null;
          this.pythonStartupGatePromiseStartedAt = 0;
        }
      });

    return {
      state: "pending",
      waitedMs: 0,
      attempts: attempt,
      fallbackReason: this.pythonStartupGateFallbackReason || ""
    };
  }

  collectPythonDiagnosticsSnapshot(extraText = "") {
    if (!this.engineManager || !this.engineManager.pythonEngine) {
      return extraText ? String(extraText) : "python_engine=uninitialized";
    }
    const pythonEngine = this.engineManager.pythonEngine;
    const executable = pythonEngine.getExecutableCheck();
    const scriptPath = pythonEngine.resolveScriptPath();
    const cedictRuntime = this.getJsCedictRuntime();
    const jsEngine = this.engineManager && this.engineManager.jsEngine ? this.engineManager.jsEngine : null;
    const sharedRuleCount = jsEngine && Array.isArray(jsEngine.sharedPhraseRules) ? jsEngine.sharedPhraseRules.length : 0;
    const lines = [
      `mode=${this.settings.engineMode}`,
      `pythonEngineEnabled=${this.settings.pythonEngineEnabled}`,
      `pythonAutoStart=${this.settings.pythonAutoStart}`,
      `pythonManualTriggerOnly=${this.settings.pythonManualTriggerOnly}`,
      `jsCedictEnhanced=${this.settings.jsCedictEnhanced}`,
      `jsCedictReady=${cedictRuntime.ready}`,
      `jsCedictLoadedFrom=${cedictRuntime.loadedFrom || ""}`,
      `jsCedictError=${cedictRuntime.error || ""}`,
      `jsCedictIndexPath=${cedictRuntime.indexPath || ""}`,
      `jsSharedTypoRuleCount=${sharedRuleCount}`,
      `pythonExecutableConfigured=${executable.configured}`,
      `pythonExecutableResolved=${executable.resolved}`,
      `pythonExecutableExists=${executable.exists === null ? "unknown" : String(executable.exists)}`,
      `pythonScriptPath=${scriptPath}`,
      `pythonScriptExists=${String(fs.existsSync(scriptPath))}`,
      `engineStatus=${pythonEngine.engineStatus || ""}`,
      `pycorrectorAvailable=${String(pythonEngine.pycorrectorAvailable)}`,
      `pycorrectorImpl=${pythonEngine.pycorrectorImpl || ""}`,
      `pycorrectorLmPath=${pythonEngine.pycorrectorLmPath || ""}`,
      `pycorrectorError=${pythonEngine.pycorrectorError || ""}`,
      `pythonFallbackRuleCount=${pythonEngine.fallbackRuleCount || 0}`,
      `serviceVersion=${pythonEngine.serviceVersion || ""}`,
      `lastError=${pythonEngine.lastError || ""}`
    ];
    if (extraText) {
      lines.push("", String(extraText));
    }
    return lines.join("\n");
  }

  async applyPythonPreflightGuard() {
    if (!this.settings.pythonEngineEnabled) return false;
    if (!this.engineManager || !this.engineManager.pythonEngine) return false;

    const executable = this.engineManager.pythonEngine.getExecutableCheck();
    if (executable.exists !== false) return false;

    const oldMode = this.settings.engineMode;
    this.settings.pythonEngineEnabled = false;
    if (this.settings.engineMode === ENGINE_MODES.PYTHON) {
      this.settings.engineMode = ENGINE_MODES.HYBRID;
    }
    await this.saveSettings();

    const changedMode = oldMode !== this.settings.engineMode;
    const summary = changedMode
      ? `Python 可执行文件不存在，已关闭 Python 引擎并切换到 ${this.settings.engineMode} 模式。`
      : "Python 可执行文件不存在，已关闭 Python 引擎。";
    const extra = `缺失路径：${executable.resolved}`;
    const installCommand = this.getInstallCommandPreview();
    const requestId = this.nextDetectionRequestId("preflight");
    const raw = this.collectPythonDiagnosticsSnapshot("reason=python_executable_missing");
    const stageSnapshot = buildStageDurations({}, 0);
    await this.updateResultPanel({
      source: "diagnostic",
      filePath: "",
      items: [],
      diagnostics: {
        trigger: "preflight",
        engine: "js",
        durationMs: 0,
        timestamp: new Date().toLocaleTimeString(),
        requestId,
        engineSource: "js",
        stageDurations: stageSnapshot,
        fallbackReason: "python_unavailable:python_not_found",
        extraText: `${summary} ${extra} 建议先执行安装命令：${installCommand}`,
        extraCopyText: raw,
        rawText: toPrettyJson({
          request_id: requestId,
          trigger: "preflight",
          engine_source: "js",
          fallback_reason: "python_unavailable:python_not_found",
          stage_durations: stageSnapshot,
          diagnostics: raw
        })
      }
    });
    new Notice(`${summary} 请在设置中确认 .venv 路径，并先安装 Python 依赖。`, 9000);
    return true;
  }

  async runPythonEngineSelfCheck() {
    const startedAt = Date.now();
    const timestamp = new Date().toLocaleTimeString();
    const requestId = this.nextDetectionRequestId("self-check");
    if (!this.engineManager || !this.engineManager.pythonEngine) {
      new Notice("Python 引擎尚未初始化。");
      return;
    }

    try {
      const report = await this.engineManager.pythonEngine.runEnvironmentCheck();
      const summary = report.ok
        ? `自检通过（exit=${report.exitCode}，${report.executable}）`
        : `自检失败（exit=${report.exitCode}，${report.executable}）`;
      const raw = this.collectPythonDiagnosticsSnapshot(
        [
          `self_check_script=${report.scriptPath}`,
          `self_check_executable=${report.executable}`,
          `self_check_signal=${report.signal || ""}`,
          `self_check_exit_code=${report.exitCode}`,
          "",
          report.output || "(no output)"
        ].join("\n")
      );
      await this.updateResultPanel({
        source: "diagnostic",
        filePath: "",
        items: [],
        diagnostics: {
          trigger: "self-check",
          engine: "diagnostic",
          durationMs: Date.now() - startedAt,
          timestamp,
          requestId,
          engineSource: "diagnostic",
          stageDurations: buildStageDurations({}, Date.now() - startedAt),
          fallbackReason: report.ok ? "" : "python_error:self_check_failed",
          extraText: summary,
          extraCopyText: raw,
          rawText: raw
        }
      });
      new Notice(report.ok ? "Python 引擎自检通过。" : "Python 引擎自检失败，请查看结果面板。", 7000);
    } catch (error) {
      const reason = normalizeReasonValue(error && error.message ? error.message : error);
      const raw = this.collectPythonDiagnosticsSnapshot(`self_check_error=${reason}`);
      await this.updateResultPanel({
        source: "diagnostic",
        filePath: "",
        items: [],
        diagnostics: {
          trigger: "self-check",
          engine: "diagnostic",
          durationMs: Date.now() - startedAt,
          timestamp,
          requestId,
          engineSource: "diagnostic",
          stageDurations: buildStageDurations({}, Date.now() - startedAt),
          fallbackReason: `python_error:${reason || "self_check_failed"}`,
          extraText: `自检执行失败：${reason || "unknown"}`,
          extraCopyText: raw,
          rawText: raw
        }
      });
      new Notice(`自检执行失败：${reason || "unknown"}`, 7000);
    }
  }

  async reloadPythonEngine() {
    try {
      const blocked = await this.applyPythonPreflightGuard();
      if (blocked) return;
      if (!this.settings.pythonEngineEnabled) {
        new Notice("Python 引擎已禁用，请先在设置中开启。");
        return;
      }
      this.engineManager.stopPythonEngine();
      this.pythonStartupGateDone = false;
      this.pythonStartupGateLastAttemptAt = 0;
      this.pythonStartupGatePromise = null;
      this.pythonStartupGatePromiseStartedAt = 0;
      this.pythonStartupGatePromiseToken += 1;
      this.pythonStartupGateAttemptCount = 0;
      this.pythonStartupGateFallbackReason = "";
      await sleep(120);
      await this.engineManager.ensurePythonEngineStarted();
      new Notice("Python 本地引擎已重载。");
    } catch (error) {
      const reason = normalizeReasonValue(error && error.message ? error.message : error);
      if (reason === "python_booting") {
        new Notice("Python 引擎正在后台启动，请稍后再检查。", 6000);
        return;
      }
      new Notice(`重载失败：${reason || "unknown"}`, 7000);
    }
  }

  isResultPanelVisible() {
    return this.app.workspace.getLeavesOfType(RESULT_VIEW_TYPE).length > 0;
  }

  bumpDetectionVersion(filePath) {
    const current = this.fileDetectionVersion.get(filePath) || 0;
    const next = current + 1;
    this.fileDetectionVersion.set(filePath, next);
    return next;
  }

  isLatestDetectionVersion(filePath, version) {
    return (this.fileDetectionVersion.get(filePath) || 0) === version;
  }

  async enqueueFileDetection(filePath, requestFactory) {
    let entry = this.fileDetectionQueue.get(filePath);
    if (!entry) {
      entry = { running: false, pending: null };
      this.fileDetectionQueue.set(filePath, entry);
    }
    entry.pending = requestFactory;
    if (entry.running) return;

    entry.running = true;
    try {
      while (entry.pending) {
        const factory = entry.pending;
        entry.pending = null;
        await factory();
      }
    } finally {
      entry.running = false;
    }
  }

  getPreferredMarkdownView() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active && active.file) return active;
    if (this.lastMarkdownView && this.lastMarkdownView.file) return this.lastMarkdownView;
    const recentLeaf = this.app.workspace.getMostRecentLeaf();
    if (recentLeaf && recentLeaf.view instanceof MarkdownView && recentLeaf.view.file) {
      return recentLeaf.view;
    }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (leaf.view instanceof MarkdownView && leaf.view.file) {
        return leaf.view;
      }
    }
    return null;
  }

  isManualDetectionTrigger(source = "manual") {
    const normalized = String(source || "manual").trim();
    return normalized === "manual" || normalized === "panel-button";
  }

  shouldUsePythonForTrigger(source = "manual") {
    if (!this.settings.pythonManualTriggerOnly) return true;
    return this.isManualDetectionTrigger(source);
  }

  async triggerDetectionForActiveFile(reason = "manual") {
    const view = this.getPreferredMarkdownView();
    if (!view || !view.file) return false;
    this.lastMarkdownView = view;
    await this.runDetectionForView(view, resolveEditorView(view), reason);
    return true;
  }

  async triggerDetectionForActiveFileWithRetry(reason = "manual", retries = 3, intervalMs = 120) {
    if (this.isManualDetectionTrigger(reason)) {
      this.manualDetectionWindowUntil = Date.now() + 15000;
    }
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const triggered = await this.triggerDetectionForActiveFile(reason);
      if (triggered) return true;
      if (attempt < retries) await sleep(intervalMs);
    }
    return false;
  }

  async onResultPanelActivated() {
    if (this.engineManager && this.engineManager.pythonEngine) {
      await this.engineManager.pythonEngine.ping({ recordFailure: false }).catch(() => {});
    }
    if (this.settings.pythonManualTriggerOnly) return;
    await this.triggerDetectionForActiveFileWithRetry("panel");
  }

  async onPythonEngineReady() {
    this.pythonStartupGateDone = true;
    this.pythonStartupGatePromise = null;
    this.pythonStartupGatePromiseStartedAt = 0;
    this.pythonStartupGatePromiseToken += 1;
    this.pythonStartupGateFallbackReason = "";
    if (this.settings.pythonManualTriggerOnly) return;
    await this.triggerDetectionForActiveFileWithRetry("python-ready", 2, 150);
  }

  getPanelSummary(payload) {
    if (!payload || !Array.isArray(payload.items)) return "";
    if (payload.source === "diagnostic") {
      return "引擎诊断";
    }
    if (payload.source === "vault") {
      return `全库扫描：${payload.items.length} 条`;
    }
    const file = payload.filePath || "当前文件";
    return `${file}：${payload.items.length} 条`;
  }

  nextDetectionRequestId(source = "manual") {
    this.detectionRequestSeq += 1;
    return buildRequestId(source, this.detectionRequestSeq);
  }

  async ensureResultPanel(reveal = false) {
    const leaves = this.app.workspace.getLeavesOfType(RESULT_VIEW_TYPE);
    let leaf = leaves[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false) || this.app.workspace.getLeaf(true);
      await leaf.setViewState({
        type: RESULT_VIEW_TYPE,
        active: false
      });
    }
    if (reveal) {
      this.app.workspace.revealLeaf(leaf);
      await this.onResultPanelActivated();
    }
    const view = leaf.view;
    if (view instanceof CscResultPanelView) {
      view.setPayload(this.latestPanelPayload);
    }
    return view;
  }

  countLineByOffset(text, offset) {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i += 1) {
      if (text[i] === "\n") line += 1;
    }
    return line;
  }

  buildPanelItems(filePath, text, matches) {
    const items = [];
    for (const match of matches) {
      const suggestion = (match.replacements && match.replacements[0] && match.replacements[0].value) || "";
      const line = this.countLineByOffset(text, match.from);
      const excerptStart = Math.max(0, match.from - 12);
      const excerptEnd = Math.min(text.length, match.to + 16);
      const excerpt = text.slice(excerptStart, excerptEnd).replace(/\r?\n/g, " ");
      items.push({
        filePath,
        from: match.from,
        to: match.to,
        token: match.token || text.slice(match.from, match.to),
        suggestion,
        line,
        excerpt
      });
    }
    return items;
  }

  async updateResultPanel(payload) {
    this.latestPanelPayload = {
      ...payload,
      summary: this.getPanelSummary(payload)
    };
    const leaves = this.app.workspace.getLeavesOfType(RESULT_VIEW_TYPE);
    if (!leaves.length) {
      await this.ensureResultPanel(false);
      return;
    }
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof CscResultPanelView) {
        view.setPayload(this.latestPanelPayload);
      }
    }
  }

  async jumpToPanelResult(item) {
    const file = this.app.vault.getAbstractFileByPath(item.filePath);
    if (!(file instanceof TFile)) {
      throw new Error("目标文件不存在");
    }
    const leaf = this.app.workspace.getMostRecentLeaf() || this.app.workspace.getLeaf(true);
    await leaf.openFile(file, { active: true });
    const view = leaf.view instanceof MarkdownView ? leaf.view : this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      throw new Error("未找到可用编辑视图");
    }
    const fromPos = view.editor.offsetToPos(item.from);
    const toPos = view.editor.offsetToPos(item.to);
    view.editor.setSelection(fromPos, toPos);
    view.editor.scrollIntoView({ from: fromPos, to: toPos }, true);
    if (view.editor.cm && view.editor.cm.focus) {
      view.editor.cm.focus();
    }
  }

  scheduleDetection(editorView, markdownView) {
    if (!markdownView || !markdownView.file) return;
    const delay = Number(this.settings.autoCheckDelayMs) || 550;
    const oldTimer = this.debounceTimers.get(editorView);
    if (oldTimer) clearTimeout(oldTimer);
    const timer = setTimeout(() => {
      const preferredText = editorView.state.doc.toString();
      this.runDetectionForFile(markdownView.file, {
        source: "live",
        editorView,
        preferredText,
        showNotice: false
      }).catch(() => {});
    }, delay);
    this.debounceTimers.set(editorView, timer);
  }

  clearHighlights(editorView) {
    if (!editorView) return;
    editorView.dispatch({ effects: [CLEAR_MATCHES_EFFECT.of(null)] });
  }

  fileSkipByFrontmatter(file, content) {
    const key = this.settings.frontmatterKey || FRONTMATTER_KEY;
    if (file) {
      const cache = this.app.metadataCache.getFileCache(file);
      const cachedValue = cache && cache.frontmatter ? cache.frontmatter[key] : null;
      if (isBooleanTrue(cachedValue)) return true;
    }
    if (typeof content === "string") {
      return readFrontmatterBoolean(content, key) === true;
    }
    return false;
  }

  filterMatches(filePath, matches) {
    const threshold = Number(this.settings.confidenceThreshold) || 0.55;
    const dictionary = new Set(this.settings.userDictionary || []);
    return matches.filter((match) => {
      const confidence = Number(match.confidence || 0);
      if (confidence < threshold) return false;
      if (dictionary.has(match.token)) return false;
      const ignoreKey = this.buildIgnoreKey(filePath, match);
      if (this.sessionIgnored.has(ignoreKey)) return false;
      return true;
    });
  }

  buildIgnoreKey(filePath, match) {
    return `${filePath || "unknown"}::${makeMatchKey(match)}::${match.token || ""}`;
  }

  async runDetectionForFile(file, options = {}) {
    if (!(file instanceof TFile)) return;
    const source = options.source || "manual";
    const isManualTrigger = this.isManualDetectionTrigger(source);
    const manualWindowRemainingMs = Math.max(0, (this.manualDetectionWindowUntil || 0) - Date.now());
    if (
      !isManualTrigger &&
      this.settings.pythonManualTriggerOnly &&
      source !== "vault" &&
      manualWindowRemainingMs > 0
    ) {
      return;
    }
    const editorView = options.editorView || null;
    const preferredText = typeof options.preferredText === "string" ? options.preferredText : null;
    const showNotice = Boolean(options.showNotice);

    await this.enqueueFileDetection(file.path, async () => {
      const version = this.bumpDetectionVersion(file.path);
      const startedAt = Date.now();
      const timestamp = new Date().toLocaleTimeString();
      const requestId = this.nextDetectionRequestId(source);
      const stageDurations = {
        readMs: 0,
        gateMs: 0,
        detectMs: 0,
        filterMs: 0
      };

      const useEditorText = Boolean(preferredText !== null && editorView);
      const readStartedAt = Date.now();
      const text = preferredText !== null ? preferredText : await this.app.vault.cachedRead(file);
      stageDurations.readMs = Date.now() - readStartedAt;

      if (this.fileSkipByFrontmatter(file, text)) {
        if (editorView) this.clearHighlights(editorView);
        if (!this.isLatestDetectionVersion(file.path, version)) return;
        const snapshot = buildStageDurations(stageDurations, Date.now() - startedAt);
        await this.updateResultPanel({
          source: "file",
          filePath: file.path,
          items: [],
          diagnostics: {
            trigger: source,
            engine: "skip",
            durationMs: Date.now() - startedAt,
            timestamp,
            requestId,
            engineSource: "skip",
            stageDurations: snapshot,
            fallbackReason: "",
            rawText: toPrettyJson({
              request_id: requestId,
              file_path: file.path,
              trigger: source,
              engine_source: "skip",
              stage_durations: snapshot
            })
          }
        });
        if (showNotice) new Notice("当前文件已配置跳过检测。");
        return;
      }

      const allowPythonForTrigger = this.shouldUsePythonForTrigger(source);
      const gateStartedAt = Date.now();
      const gateResult = allowPythonForTrigger
        ? await this.applyPythonStartupHealthGate()
        : { state: "skipped", waitedMs: 0, attempts: this.pythonStartupGateAttemptCount || 0, fallbackReason: "" };
      stageDurations.gateMs = Date.now() - gateStartedAt;
      const ranges = extractDetectableRanges(text);
      const detectStartedAt = Date.now();
      const detectResult = await this.engineManager.detect(text, {
        ranges,
        maxSuggestions: this.settings.maxSuggestions,
        forceJsOnly: !allowPythonForTrigger,
        filePath: file.path,
        triggerSource: source
      });
      stageDurations.detectMs = Date.now() - detectStartedAt;
      if (!this.isLatestDetectionVersion(file.path, version)) return;

      const mode = this.settings.engineMode;
      const gateApplies = mode !== ENGINE_MODES.JS && this.settings.pythonEngineEnabled && allowPythonForTrigger;
      const pythonEngine = this.engineManager && this.engineManager.pythonEngine ? this.engineManager.pythonEngine : null;
      const pythonReadyNow = Boolean(
        pythonEngine && (pythonEngine.pycorrectorAvailable === true || pythonEngine.engineStatus === "ready")
      );
      const pythonUnavailableNow = Boolean(
        pythonEngine && (pythonEngine.pycorrectorAvailable === false || pythonEngine.engineStatus === "unavailable")
      );
      const gateTransient =
        gateResult.state === "pending" || gateResult.state === "timeout" || gateResult.state === "cooldown";
      const gateStableFallbackReason = gateResult.fallbackReason || "";
      const startupFallbackReason =
        gateApplies &&
        gateTransient &&
        !gateStableFallbackReason &&
        !detectResult.fallbackReason &&
        !pythonReadyNow &&
        !pythonUnavailableNow
          ? "python_booting"
          : "";
      const startupGateText =
        gateApplies && gateTransient && !pythonReadyNow
          ? `启动门控：第 ${gateResult.attempts || 0}/${PY_STARTUP_GATE_MAX_ATTEMPTS} 次，状态 ${gateResult.state}${gateResult.waitedMs ? `，等待 ${gateResult.waitedMs}ms` : ""}`
          : "";
      const triggerHintText =
        !allowPythonForTrigger && mode !== ENGINE_MODES.JS && this.settings.pythonEngineEnabled
          ? "当前为自动触发，按策略仅使用 JS。点击“检查当前文件”调用 pycorrector。"
          : "";
      const fallbackReason = detectResult.fallbackReason || gateStableFallbackReason || startupFallbackReason || "";
      const engineSource = detectResult.engineUsed || "unknown";
      const qualityHint = shouldShowQualityDowngrade(engineSource, fallbackReason)
        ? "当前结果未使用 pycorrector，检测质量可能下降。"
        : "";

      const filterStartedAt = Date.now();
      const rawMatches = detectResult.matches || [];
      const filtered = this.filterMatches(file.path, rawMatches);
      stageDurations.filterMs = Date.now() - filterStartedAt;
      if (editorView && useEditorText) {
        editorView.dispatch({
          effects: [SET_MATCHES_EFFECT.of({ matches: filtered })]
        });
      }

      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const activePath = activeView && activeView.file ? activeView.file.path : "";
      const preferredView = this.getPreferredMarkdownView();
      const preferredPath = preferredView && preferredView.file ? preferredView.file.path : "";
      if (
        (source === "panel" ||
          source === "active-leaf-change" ||
          source === "file-open" ||
          source === "layout-change" ||
          source === "python-ready") &&
        ((activePath && activePath !== file.path) || (preferredPath && preferredPath !== file.path))
      ) {
        return;
      }

      const stageSnapshot = buildStageDurations(stageDurations, Date.now() - startedAt);
      const cedictRuntime = this.getJsCedictRuntime();
      const jsEngine = this.engineManager && this.engineManager.jsEngine ? this.engineManager.jsEngine : null;
      const jsSharedTypoRuleCount = jsEngine && Array.isArray(jsEngine.sharedPhraseRules) ? jsEngine.sharedPhraseRules.length : 0;
      const diagnosticsSnapshot = toPrettyJson({
        request_id: requestId,
        file_path: file.path,
        trigger: source,
        python_allowed_for_trigger: allowPythonForTrigger,
        manual_window_remaining_ms: Math.max(0, (this.manualDetectionWindowUntil || 0) - Date.now()),
        gate_state: gateResult.state || "",
        gate_attempts: gateResult.attempts || 0,
        gate_waited_ms: Number(gateResult.waitedMs) || 0,
        fallback_reason: fallbackReason,
        engine_source: engineSource,
        python_engine_status: pythonEngine ? pythonEngine.engineStatus || "" : "",
        python_pycorrector_available: pythonEngine ? pythonEngine.pycorrectorAvailable : null,
        python_pycorrector_impl: pythonEngine ? pythonEngine.pycorrectorImpl || "" : "",
        python_engine_detail: pythonEngine ? pythonEngine.lastEngineDetail || "" : "",
        python_last_error: pythonEngine ? pythonEngine.lastError || "" : "",
        python_last_stderr: pythonEngine ? pythonEngine.lastStderr || "" : "",
        python_service_version: pythonEngine ? pythonEngine.serviceVersion || "" : "",
        python_fallback_rule_count: pythonEngine ? pythonEngine.fallbackRuleCount || 0 : 0,
        js_cedict_enabled: this.settings.jsCedictEnhanced,
        js_cedict_ready: cedictRuntime.ready,
        js_cedict_loaded_from: cedictRuntime.loadedFrom || "",
        js_cedict_error: cedictRuntime.error || "",
        js_shared_typo_rule_count: jsSharedTypoRuleCount,
        stage_durations: stageSnapshot,
        match_count_raw: rawMatches.length,
        match_count_filtered: filtered.length
      });
      await this.updateResultPanel({
        source: "file",
        filePath: file.path,
        items: this.buildPanelItems(file.path, text, filtered),
        diagnostics: {
          trigger: source,
          engine: engineSource,
          durationMs: Date.now() - startedAt,
          timestamp,
          requestId,
          engineSource,
          stageDurations: stageSnapshot,
          fallbackReason,
          qualityHint,
          extraText: startupGateText || triggerHintText,
          rawText: diagnosticsSnapshot
        }
      });

      if (showNotice) {
        new Notice(`检测完成：发现 ${filtered.length} 条建议。`);
      }
      if (isManualTrigger) {
        this.manualDetectionWindowUntil = Date.now() + 8000;
      }
    });
  }

  async runDetectionForView(markdownView, editorView, reason) {
    if (!markdownView || !markdownView.file) return;
    const resolvedEditorView = editorView || resolveEditorView(markdownView);
    let preferredText = null;
    if (resolvedEditorView) {
      preferredText = resolvedEditorView.state.doc.toString();
    } else if (markdownView.editor && typeof markdownView.editor.getValue === "function") {
      preferredText = markdownView.editor.getValue();
    }
    await this.runDetectionForFile(markdownView.file, {
      source: reason,
      editorView: resolvedEditorView,
      preferredText,
      showNotice: reason === "manual"
    });
  }

  applyReplacement(view, target, replacement) {
    view.dispatch({
      changes: [{ from: target.from, to: target.to, insert: replacement }]
    });
    const markdownView = getMarkdownViewFromState(view.state);
    if (isMarkdownContext(markdownView)) {
      this.scheduleDetection(view, markdownView);
    }
  }

  ignoreSuggestion(view, target) {
    const markdownView = getMarkdownViewFromState(view.state);
    const filePath = markdownView && markdownView.file ? markdownView.file.path : "unknown";
    this.sessionIgnored.add(this.buildIgnoreKey(filePath, target.match));
    if (isMarkdownContext(markdownView)) {
      this.scheduleDetection(view, markdownView);
    }
  }

  async addTokenToDictionary(token) {
    if (!token) return;
    if (!this.settings.userDictionary.includes(token)) {
      this.settings.userDictionary.push(token);
      await this.saveSettings();
    }
    new Notice(`已加入词典：${token}`);
  }

  async toggleCurrentFileIgnore() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      new Notice("请先打开一个 Markdown 文件。");
      return;
    }
    const original = await this.app.vault.read(view.file);
    const result = toggleFrontmatterFlag(original, this.settings.frontmatterKey);
    await this.app.vault.modify(view.file, result.content);
    new Notice(`已将 ${view.file.name} 的跳过检测设置为 ${result.enabled}`);

    const editorView = resolveEditorView(view);
    if (editorView) {
      if (result.enabled) {
        this.clearHighlights(editorView);
        await this.updateResultPanel({
          source: "file",
          filePath: view.file.path,
          items: []
        });
      } else {
        await this.runDetectionForView(view, editorView, "manual");
      }
    }
  }

  async scanVault() {
    const files = this.app.vault.getMarkdownFiles();
    const report = {
      totalFiles: files.length,
      skippedFiles: 0,
      hitFiles: 0,
      totalMatches: 0,
      items: []
    };

    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      if (this.fileSkipByFrontmatter(file, content)) {
        report.skippedFiles += 1;
        continue;
      }
      const ranges = extractDetectableRanges(content);
      const raw = await this.engineManager.detect(content, {
        ranges,
        maxSuggestions: this.settings.maxSuggestions,
        filePath: file.path,
        triggerSource: "vault"
      });
      const filtered = this.filterMatches(file.path, raw.matches || []);
      if (!filtered.length) continue;

      report.hitFiles += 1;
      report.totalMatches += filtered.length;
      for (const match of filtered.slice(0, 12)) {
        const line = this.countLineByOffset(content, match.from);
        const excerpt = content.slice(Math.max(0, match.from - 12), Math.min(content.length, match.to + 16)).replace(/\r?\n/g, " ");
        report.items.push({
          file: file.path,
          from: match.from,
          to: match.to,
          token: match.token || "",
          suggestion: (match.replacements && match.replacements[0] && match.replacements[0].value) || "",
          line,
          excerpt
        });
      }
    }

    await this.updateResultPanel({
      source: "vault",
      filePath: "",
      items: report.items.map((item) => ({
        filePath: item.file,
        from: item.from,
        to: item.to,
        token: item.token,
        suggestion: item.suggestion,
        line: item.line || 1,
        excerpt: item.excerpt || ""
      }))
    });
    new ScanReportModal(this.app, report).open();
  }
};
