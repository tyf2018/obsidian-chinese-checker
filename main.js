/*
Source file for Obsidian 中文纠错插件.
Implements dual local engines:
1) JS rule engine (default, lightweight)
2) Python local HTTP engine (optional enhancement)
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Menu,
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
  python_not_verified: "Python 环境尚未通过自检",
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
  bind_permission_denied: "端口绑定被系统拒绝",
  python_not_found: "未找到 Python 可执行文件",
  python_version_unsupported: "当前仅支持 Python 3.11.x",
  python_script_missing: "Python 服务脚本缺失",
  pycorrector_model_missing: "pycorrector 模型文件缺失"
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
const MAX_TRACKED_FILE_STATES = 600;
const MAX_SESSION_IGNORES = 5000;
const MAX_FRONT_DETECTION_CACHE_ITEMS = 16;
const MAX_FRONT_DETECTION_CACHE_TEXT_LENGTH = 12000;
const MAX_FRONT_DETECTION_CACHE_MATCHES = 80;
const MAX_PANEL_FILE_ITEMS = 200;
const MAX_PANEL_VAULT_ITEMS = 120;
const MAX_SCAN_REPORT_ITEMS = 120;
const MAX_PANEL_EXCERPT_LENGTH = 40;
const MAX_DIAGNOSTICS_RAW_TEXT_LENGTH = 6000;
const MAX_FILTER_DIAGNOSTIC_ITEMS = 40;
const CEDICT_IDLE_RELEASE_MS = 5 * 60 * 1000;
const PYTHON_IDLE_SHUTDOWN_MS = 8 * 60 * 1000;
const MEMORY_RECLAIM_INTERVAL_MS = 60 * 1000;
const DEFAULT_WINDOWS_VENV_DIR = "S:\\obsidian-chinese-checker\\.venv";
const DEFAULT_WINDOWS_PYCORRECTOR_DATA_DIR = "S:\\obsidian-chinese-checker\\.pycorrector\\datasets";
const DEFAULT_PYCORRECTOR_LM_FILENAME = "people_chars_lm.klm";
const SUPPORTED_PYTHON_MAJOR = 3;
const SUPPORTED_PYTHON_MINOR = 11;
const SUPPORTED_PYTHON_LABEL = `Python ${SUPPORTED_PYTHON_MAJOR}.${SUPPORTED_PYTHON_MINOR}.x`;
const DEFAULT_CEDICT_INDEX_FILENAME = "cedict_index.json";
const CEDICT_DEFAULT_FALLBACK_SOURCE = ".obsidian\\plugins\\various-complements\\cedict_ts.u8";
const CJK_TOKEN_REGEX = /[\u4e00-\u9fff]{2,6}/g;
const SHARED_TYPO_RULES_FILENAME = path.join("rules", "common_typos_zh.json");
const VARIANT_FORMS_FILENAME = path.join("rules", "variant_forms_zh.json");
const DOMAIN_TERMS_FILENAME = path.join("rules", "domain_terms_zh.json");
const IDIOM_DICTIONARY_FILENAME = path.join("rules", "chengyu_daquan.txt");
const JS_RULE_RELOAD_INTERVAL_MS = 2000;
const MATCH_RULE_PRIORITY = Object.freeze({
  PYCORRECTOR_RULE: 500,
  PYCORRECTOR_DIFF_RULE: 420,
  COMMON_PHRASE_RULE: 360,
  FALLBACK_COMMON_PHRASE_RULE: 350,
  VARIANT_FORM_RULE: 260,
  DUPLICATE_TOKEN_RULE: 340,
  FALLBACK_DUPLICATE_RULE: 340,
  CONFUSION_HINT_RULE: 220,
  CEDICT_OOV_RULE: 120
});
const MATCH_MIN_CONFIDENCE_BY_RULE = Object.freeze({
  PYCORRECTOR_RULE: 0.55,
  PYCORRECTOR_DIFF_RULE: 0.72,
  COMMON_PHRASE_RULE: 0.8,
  FALLBACK_COMMON_PHRASE_RULE: 0.88,
  VARIANT_FORM_RULE: 0.66,
  DUPLICATE_TOKEN_RULE: 0.8,
  FALLBACK_DUPLICATE_RULE: 0.8,
  CONFUSION_HINT_RULE: 0.86,
  CEDICT_OOV_RULE: 0.92
});
const MATCH_MIN_CONFIDENCE_BY_SOURCE = Object.freeze({
  pycorrector: 0.55,
  "Python 规则引擎": 0.88,
  "规范词形建议": 0.66,
  "混淆集上下文": 0.86,
  "词典候选": 0.92
});
const RULE_MAX_CONFIDENCE_HINTS = Object.freeze({
  CONFUSION_HINT_RULE: 0.82,
  CEDICT_OOV_RULE: 0.76
});
const RULE_BASIS_OVERRIDES = Object.freeze({
  "交待->交代": "“交代”是现代汉语的规范用词，适用于绝大多数场合。“交待”是一个已经或正在被淘汰的词。",
  "帐号->账号": "在古代“贝”曾作为货币，因此“账”字本义就与金钱、财物记载有关。根据《现代汉语词典》及教育部、国家语言文字工作委员会发布的《第一批异形词整理表》，“账”是“帐”的分化字。为了区分，“账”专门用于与货币、货物出入记载、债务等相关的词语，如“账本”“报账”“银行账号”。"
});
const TERM_LENGTH_BUCKET_CACHE = new WeakMap();
const HIGH_PRECISION_PHRASE_RULE_IDS = new Set(["COMMON_PHRASE_RULE", "FALLBACK_COMMON_PHRASE_RULE"]);
const OVERLAP_FRAGMENT_RULE_IDS = new Set(["CONFUSION_HINT_RULE", "PYCORRECTOR_RULE", "PYCORRECTOR_DIFF_RULE"]);
const HIGH_AMBIGUITY_FRAGMENT_CHARS = new Set(["己", "已", "几", "的", "地", "得", "在", "再"]);
const RESULT_SORT_MODES = Object.freeze({
  CONFIDENCE_DESC: "confidence_desc",
  LINE_DESC: "line_desc"
});
const RESULT_SORT_LABELS = Object.freeze({
  [RESULT_SORT_MODES.CONFIDENCE_DESC]: "按正确率🠋",
  [RESULT_SORT_MODES.LINE_DESC]: "按行号🠋"
});
const RESULT_CONFIDENCE_GROUPS = Object.freeze({
  HIGH: "high",
  REVIEW: "review"
});
const RESULT_CONFIDENCE_GROUP_LABELS = Object.freeze({
  [RESULT_CONFIDENCE_GROUPS.HIGH]: "高置信",
  [RESULT_CONFIDENCE_GROUPS.REVIEW]: "需复核"
});
const PYTHON_SETUP_STATES = Object.freeze({
  UNCONFIGURED: "unconfigured",
  CONFIGURED_UNVERIFIED: "configured_unverified",
  READY: "ready",
  ERROR: "error"
});
const PYTHON_SETUP_STATE_LABELS = Object.freeze({
  [PYTHON_SETUP_STATES.UNCONFIGURED]: "未配置",
  [PYTHON_SETUP_STATES.CONFIGURED_UNVERIFIED]: "已配置未验证",
  [PYTHON_SETUP_STATES.READY]: "可用",
  [PYTHON_SETUP_STATES.ERROR]: "异常"
});
const BUILTIN_DOMAIN_PROTECTED_TOKENS = new Set([
  "样例",
  "测试样例",
  "本页",
  "所圈",
  "最右列",
  "全文列",
  "二字",
  "当前文件",
  "设置页",
  "面板标题"
]);
const DOCUMENT_PROTECTED_TERM_MAX_LENGTH = 12;
const DOCUMENT_PROTECTED_RUN_MAX_LENGTH = 24;
const DOCUMENT_PHRASE_ANCHORS = Object.freeze([
  "工作站",
  "海智计划",
  "科创委",
  "创委",
  "委员会",
  "有限责任公司",
  "有限公司",
  "服务平台",
  "平台",
  "项目",
  "课题",
  "胶装",
  "骑缝章",
  "封面",
  "附件",
  "公章",
  "YAML"
]);
const DOCUMENT_COMMON_SURNAMES = new Set(
  "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林钟徐丘骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉钮龚程嵇邢裴陆荣翁荀羊於惠甄曲封储靳焦牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠乔胥苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习艾鱼容向古易慎戈廖庾终暨居衡步都耿满匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷辛阚那简饶空曾关蒯相查红游竺权盖益桓公"
    .split("")
    .filter(Boolean)
);
const DOCUMENT_COMPOUND_SURNAMES = Object.freeze([
  "欧阳",
  "司马",
  "上官",
  "诸葛",
  "东方",
  "夏侯",
  "皇甫",
  "尉迟",
  "公孙",
  "慕容",
  "令狐",
  "宇文",
  "长孙",
  "南宫"
]);
const DOCUMENT_DIALOGUE_MARKERS = Object.freeze([
  "说道",
  "问道",
  "答道",
  "笑道",
  "怒道",
  "喝道",
  "喊道",
  "叹道",
  "低喝",
  "沉声",
  "轻声",
  "冷笑",
  "厉喝",
  "失声",
  "喝问",
  "开口",
  "开口道",
  "出声",
  "一怔",
  "一笑"
]);
const DOCUMENT_LITERARY_PROPER_NOUN_SUFFIXES = Object.freeze([
  "域",
  "山",
  "泉",
  "宫",
  "门",
  "宗",
  "城",
  "殿",
  "阁",
  "峰",
  "谷",
  "洲",
  "岛",
  "塔",
  "府",
  "院",
  "族",
  "堂",
  "派",
  "盟",
  "关",
  "狱",
  "鼎",
  "剑"
]);

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

function buildPycorrectorLmPath(dataDir) {
  const normalized = normalizeVenvDir(dataDir);
  if (!normalized) return DEFAULT_PYCORRECTOR_LM_FILENAME;
  return path.join(normalized, DEFAULT_PYCORRECTOR_LM_FILENAME);
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

function getNearestExistingDirectory(targetPath) {
  let current = normalizeVenvDir(targetPath);
  while (current) {
    try {
      if (fs.existsSync(current) && fs.statSync(current).isDirectory()) return current;
    } catch (error) {
      return "";
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return "";
}

function inspectDirectoryWriteAccess(targetPath) {
  const normalizedTarget = normalizeVenvDir(targetPath);
  if (!normalizedTarget) {
    return {
      targetPath: "",
      checkPath: "",
      exists: false,
      writable: null,
      viaParent: false
    };
  }
  const exists = fs.existsSync(normalizedTarget);
  const checkPath = exists ? normalizedTarget : getNearestExistingDirectory(normalizedTarget);
  if (!checkPath) {
    return {
      targetPath: normalizedTarget,
      checkPath: "",
      exists,
      writable: null,
      viaParent: !exists
    };
  }
  try {
    fs.accessSync(checkPath, fs.constants.W_OK);
    return {
      targetPath: normalizedTarget,
      checkPath,
      exists,
      writable: true,
      viaParent: checkPath !== normalizedTarget
    };
  } catch (error) {
    return {
      targetPath: normalizedTarget,
      checkPath,
      exists,
      writable: false,
      viaParent: checkPath !== normalizedTarget
    };
  }
}

function formatDirectoryWriteStatus(label, check) {
  if (!check || !check.targetPath) return `${label}：未配置`;
  if (check.writable === true) {
    return check.viaParent
      ? `${label}：父目录可写，可创建`
      : `${label}：可写`;
  }
  if (check.writable === false) {
    return check.viaParent
      ? `${label}：父目录不可写`
      : `${label}：不可写`;
  }
  return `${label}：写入权限未知`;
}

function getResultHighConfidenceThreshold(baseThreshold = 0.55) {
  const normalized = Number.isFinite(Number(baseThreshold)) ? Number(baseThreshold) : 0.55;
  return Math.min(0.96, Math.max(0.9, normalized + 0.08));
}

function formatConfidencePercent(confidence) {
  const normalized = Math.max(0, Math.min(0.99, Number(confidence || 0)));
  return `${Math.round(normalized * 100)}%`;
}

function truncateText(value, maxLength = 0) {
  const text = String(value || "");
  const limit = Math.max(0, Number(maxLength) || 0);
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function getResultConfidenceGroup(confidence, baseThreshold = 0.55) {
  return Number(confidence || 0) >= getResultHighConfidenceThreshold(baseThreshold)
    ? RESULT_CONFIDENCE_GROUPS.HIGH
    : RESULT_CONFIDENCE_GROUPS.REVIEW;
}

function splitPanelItemsByConfidence(items, baseThreshold = 0.55) {
  const groups = {
    [RESULT_CONFIDENCE_GROUPS.HIGH]: [],
    [RESULT_CONFIDENCE_GROUPS.REVIEW]: []
  };
  for (const item of Array.isArray(items) ? items : []) {
    groups[getResultConfidenceGroup(item && item.confidence, baseThreshold)].push(item);
  }
  return groups;
}

const DEFAULT_SETTINGS = {
  liveCheck: false,
  autoCheckDelayMs: 550,
  confidenceThreshold: 0.55,
  pycorrectorConfidenceThreshold: 0.925,
  maxSuggestions: 300,
  engineMode: ENGINE_MODES.JS,
  frontmatterKey: FRONTMATTER_KEY,
  pythonEngineEnabled: false,
  pythonAutoStart: false,
  pythonManualTriggerOnly: true,
  pythonExecutable: "python",
  pythonVenvDir: DEFAULT_WINDOWS_VENV_DIR,
  pythonPycorrectorDataDir: DEFAULT_WINDOWS_PYCORRECTOR_DATA_DIR,
  pythonScriptPath: "python_engine_service.py",
  pythonHost: "127.0.0.1",
  pythonPort: 27123,
  pythonTimeoutMs: 12000,
  pythonStartupTimeoutMs: 12000,
  jsCedictEnhanced: true,
  jsCedictSourcePath: "",
  jsCedictIndexPath: DEFAULT_CEDICT_INDEX_FILENAME,
  userDictionary: [],
  pythonSetupHintDismissed: false,
  pythonLastSelfCheckOk: false,
  pythonLastSelfCheckAt: 0,
  pythonLastSelfCheckExecutable: "",
  pythonLastSelfCheckVersion: "",
  pythonLastSelfCheckDataDir: "",
  pythonLastSelfCheckLmPath: ""
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

function clampProgressPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Math.round(num);
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

function hashText(value) {
  return crypto.createHash("sha1").update(String(value || ""), "utf8").digest("hex");
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

function buildQualityHint(engineSource, fallbackReason, isPartial = false) {
  const hints = [];
  if (isPartial) {
    hints.push("pycorrector 因超时，纠错结果不完整（已展示已完成部分）。");
  }
  if (shouldShowQualityDowngrade(engineSource, fallbackReason)) {
    hints.push("当前结果未使用 pycorrector，检测质量可能下降。");
  }
  return hints.join(" ");
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

const ENGINE_TOKEN_LABELS = {
  js: "JS",
  python: "Python",
  hybrid: "混合",
  pycorrector: "pycorrector",
  hint: "Python",
  fallback: "Python",
  none: "无命中",
  unknown: "未知引擎"
};

const ENGINE_TOKEN_HINTS = {
  js: "JS：仅使用插件内的本地规则与词典候选，不调用 Python 服务，速度最快但纠错能力最弱。",
  python: "Python：由本地 Python 服务执行规则检测，属于规则判断，不等同于 pycorrector 上下文模型。",
  hybrid: "混合：同时展示多个检测层的结果，界面口径统一为 pycorrector、Python、JS。",
  pycorrector: "pycorrector：基于上下文模型判断整句是否存在错字，能力最强，但在技术文本中更容易误判。",
  hint: "Python：来自 Python 侧的混淆/提示类规则结果，不是 pycorrector 模型判断。",
  fallback: "Python：来自 Python 侧兜底规则库的结果，适合命中固定错词与重复字，不理解上下文。",
  none: "该检测层未产生命中结果。",
  unknown: "未识别的引擎标识。"
};

function canonicalEngineToken(token) {
  const raw = String(token || "").trim();
  const normalized = normalizeEngineToken(raw);
  if (
    raw === "Python 规则引擎" ||
    raw === "混淆集上下文" ||
    raw === "Python兜底规则" ||
    normalized === "hint" ||
    normalized === "fallback" ||
    normalized === "python"
  ) {
    return "python";
  }
  if (normalized === "js") return "js";
  if (normalized === "pycorrector") return "pycorrector";
  if (normalized === "hybrid") return "hybrid";
  if (normalized === "none") return "none";
  if (normalized === "unknown") return "unknown";
  return normalized;
}

function normalizeEngineToken(token) {
  return String(token || "").trim().toLowerCase();
}

function formatEngineToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return ENGINE_TOKEN_LABELS.unknown;
  const normalized = canonicalEngineToken(raw);
  return ENGINE_TOKEN_LABELS[normalized] || raw;
}

function describeEngineToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return ENGINE_TOKEN_HINTS.unknown;
  const normalized = canonicalEngineToken(raw);
  return ENGINE_TOKEN_HINTS[normalized] || ENGINE_TOKEN_HINTS.unknown;
}

function parseEngineName(engineName) {
  const raw = String(engineName || "").trim();
  if (!raw) return { prefix: "", details: [] };
  const normalizedRaw = raw.replace(/^混合:/, "hybrid:");
  const colonIndex = normalizedRaw.indexOf(":");
  if (colonIndex >= 0) {
    const prefix = normalizedRaw.slice(0, colonIndex).trim();
    const detailRaw = normalizedRaw.slice(colonIndex + 1).trim();
    const details = detailRaw ? detailRaw.split("+").map((item) => item.trim()).filter(Boolean) : [];
    return { prefix, details };
  }
  return {
    prefix: "",
    details: normalizedRaw
      .split("+")
      .map((item) => item.trim())
      .filter(Boolean)
  };
}

function getDisplayEngineParts(tokens) {
  const normalized = [];
  const seen = new Set();
  for (const token of tokens) {
    const canonical = canonicalEngineToken(token);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized;
}

function formatEngineDisplayName(engineName) {
  const parsed = parseEngineName(engineName);
  if (!parsed.prefix && !parsed.details.length) return ENGINE_TOKEN_LABELS.unknown;
  const detailParts = getDisplayEngineParts(parsed.details);
  if (parsed.prefix) {
    const prefixLabel = formatEngineToken(parsed.prefix);
    const detailLabel = detailParts.map((part) => formatEngineToken(part)).join("+");
    return detailLabel ? `${prefixLabel}:${detailLabel}` : prefixLabel;
  }
  return detailParts.map((part) => formatEngineToken(part)).join("+");
}

function buildEngineTooltip(engineName) {
  const display = formatEngineDisplayName(engineName);
  const parsed = parseEngineName(engineName);
  const lines = [`引擎：${display}`];
  const seen = new Set();
  const appendTokenLine = (token) => {
    const normalized = normalizeEngineToken(token) || token;
    if (!token || seen.has(normalized)) return;
    seen.add(normalized);
    lines.push(`${formatEngineToken(token)}：${describeEngineToken(token)}`);
  };
  appendTokenLine(parsed.prefix);
  for (const token of parsed.details) appendTokenLine(token);
  if (lines.length === 1) {
    lines.push(`未知引擎：${ENGINE_TOKEN_HINTS.unknown}`);
  }
  return lines.join("\n");
}

function getResultSortLabel(mode) {
  return RESULT_SORT_LABELS[mode] || RESULT_SORT_LABELS[RESULT_SORT_MODES.CONFIDENCE_DESC];
}

function getResultItemKey(item) {
  if (!item) return "";
  return `${item.filePath || ""}::${item.from || 0}:${item.to || 0}:${item.suggestion || ""}`;
}

function computeMatchSortScore(match) {
  const priority = getMatchRulePriority(match);
  const confidence = Math.max(0, Math.min(0.999, Number((match && match.confidence) || 0)));
  const spanLength = getMatchSpanLength(match);
  const replacementLength = getPrimaryReplacementValue(match).length;
  return (
    priority * 10000 +
    Math.round(confidence * 1000) * 10 +
    Math.min(80, spanLength * 6 + replacementLength * 3)
  );
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

function getPrimaryReplacementValue(match) {
  const replacements = Array.isArray(match && match.replacements) ? match.replacements : [];
  for (const item of replacements) {
    const value = item && typeof item.value === "string" ? item.value : "";
    if (value) return value;
  }
  return "";
}

function getMatchSpanLength(match) {
  return Math.max(0, Number(match.to || 0) - Number(match.from || 0));
}

function matchContains(container, inner) {
  return container.from <= inner.from && container.to >= inner.to && (container.from !== inner.from || container.to !== inner.to);
}

function spansOverlap(left, right) {
  return left.from < right.to && right.from < left.to;
}

function getOverlapLength(left, right) {
  return Math.max(0, Math.min(left.to, right.to) - Math.max(left.from, right.from));
}

function mergeReplacementLists(...lists) {
  const merged = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const value = item && typeof item.value === "string" ? item.value : "";
      if (!value || merged.has(value)) continue;
      merged.set(value, { value });
    }
  }
  return [...merged.values()];
}

function getMatchRulePriority(match) {
  const ruleId = String((match && match.ruleId) || "");
  if (Object.prototype.hasOwnProperty.call(MATCH_RULE_PRIORITY, ruleId)) {
    return MATCH_RULE_PRIORITY[ruleId];
  }
  const shortMessage = String((match && match.shortMessage) || "");
  if (shortMessage.includes("pycorrector")) return MATCH_RULE_PRIORITY.PYCORRECTOR_RULE;
  return 200;
}

function isVariantFormMatch(match) {
  return String((match && match.ruleId) || "") === "VARIANT_FORM_RULE";
}

function hasSameSpan(left, right) {
  return Boolean(left && right) && left.from === right.from && left.to === right.to;
}

function isPreferredMatch(candidate, existing) {
  const priorityDelta = getMatchRulePriority(candidate) - getMatchRulePriority(existing);
  if (priorityDelta !== 0) return priorityDelta > 0;

  const spanDelta = getMatchSpanLength(candidate) - getMatchSpanLength(existing);
  if (spanDelta !== 0) return spanDelta > 0;

  const confidenceDelta = Number(candidate.confidence || 0) - Number(existing.confidence || 0);
  if (confidenceDelta !== 0) return confidenceDelta > 0;

  const replacementDelta = getPrimaryReplacementValue(candidate).length - getPrimaryReplacementValue(existing).length;
  if (replacementDelta !== 0) return replacementDelta > 0;

  return makeMatchKey(candidate) < makeMatchKey(existing);
}

function collapseContainedMatches(matches) {
  const ordered = [...matches].sort((a, b) =>
    a.from - b.from ||
    b.to - a.to ||
    getMatchRulePriority(b) - getMatchRulePriority(a) ||
    (Number(b.confidence || 0) - Number(a.confidence || 0))
  );
  const suppressed = new Set();
  for (let index = 0; index < ordered.length; index += 1) {
    if (suppressed.has(index)) continue;
    const current = ordered[index];
    for (let otherIndex = index + 1; otherIndex < ordered.length; otherIndex += 1) {
      if (suppressed.has(otherIndex)) continue;
      const other = ordered[otherIndex];
      if (!matchContains(current, other) && !matchContains(other, current)) continue;
      if (isPreferredMatch(other, current)) {
        suppressed.add(index);
        break;
      }
      suppressed.add(otherIndex);
    }
  }
  return ordered.filter((_, index) => !suppressed.has(index));
}

function isPycorrectorMatch(match) {
  const ruleId = String((match && match.ruleId) || "");
  if (ruleId === "PYCORRECTOR_RULE" || ruleId === "PYCORRECTOR_DIFF_RULE") return true;
  const shortMessage = String((match && match.shortMessage) || "").toLowerCase();
  return shortMessage.includes("pycorrector");
}

function isHighPrecisionPhraseMatch(match) {
  const ruleId = String((match && match.ruleId) || "");
  return HIGH_PRECISION_PHRASE_RULE_IDS.has(ruleId);
}

function hasHighAmbiguityFragmentChars(match) {
  const token = String((match && match.token) || "");
  const replacement = getPrimaryReplacementValue(match);
  const combined = `${token}${replacement}`;
  for (const char of combined) {
    if (HIGH_AMBIGUITY_FRAGMENT_CHARS.has(char)) return true;
  }
  return false;
}

function shouldSuppressOverlappingFragment(candidate, preferred) {
  if (!spansOverlap(candidate, preferred)) return false;
  if (!isHighPrecisionPhraseMatch(preferred) || isHighPrecisionPhraseMatch(candidate)) return false;
  const candidateRuleId = String((candidate && candidate.ruleId) || "");
  if (!OVERLAP_FRAGMENT_RULE_IDS.has(candidateRuleId)) return false;
  if (!hasHighAmbiguityFragmentChars(candidate)) return false;

  const candidateSpanLength = getMatchSpanLength(candidate);
  const preferredSpanLength = getMatchSpanLength(preferred);
  const overlapLength = getOverlapLength(candidate, preferred);
  const candidateReplacementLength = getPrimaryReplacementValue(candidate).length;
  const preferredReplacementLength = getPrimaryReplacementValue(preferred).length;
  if (candidateSpanLength > 2 && candidateReplacementLength > 2) return false;

  return (
    (candidateSpanLength <= preferredSpanLength && overlapLength >= Math.max(1, candidateSpanLength - 1)) ||
    (candidateSpanLength <= 2 && preferredReplacementLength >= 2)
  );
}

function suppressLowValueOverlaps(matches) {
  return suppressLowValueOverlapsDetailed(matches).filtered;
}

function suppressLowValueOverlapsDetailed(matches) {
  const preferred = [...matches]
    .filter((match) => isHighPrecisionPhraseMatch(match))
    .sort((left, right) =>
      right.confidence - left.confidence ||
      getMatchSpanLength(right) - getMatchSpanLength(left) ||
      left.from - right.from
    );
  if (!preferred.length) return { filtered: matches, suppressed: [] };
  const filtered = [];
  const suppressed = [];
  for (const match of matches) {
    let dropped = false;
    for (const target of preferred) {
      if (match === target) {
        break;
      }
      if (shouldSuppressOverlappingFragment(match, target)) {
        suppressed.push({
          match,
          reason: "overlap_fragment_suppressed",
          preferred: target
        });
        dropped = true;
        break;
      }
    }
    if (dropped) continue;
    filtered.push(match);
  }
  return { filtered, suppressed };
}

function getLineTextAroundMatch(text, match) {
  return getLineRangeAroundMatch(text, match).text;
}

function getLineRangeAroundMatch(text, match) {
  const source = String(text || "");
  if (!source) return { from: 0, to: 0, text: "" };
  const from = Math.max(0, Number(match && match.from) || 0);
  const to = Math.max(from, Number(match && match.to) || from);
  const lineStart = Math.max(0, source.lastIndexOf("\n", Math.max(0, from - 1)) + 1);
  const lineEndIndex = source.indexOf("\n", to);
  const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;
  return {
    from: lineStart,
    to: lineEnd,
    text: source.slice(lineStart, lineEnd)
  };
}

function incrementMapCounter(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function isPureCjkToken(value, minLength = 1, maxLength = Number.MAX_SAFE_INTEGER) {
  const token = String(value || "").trim();
  return token.length >= minLength && token.length <= maxLength && /^[\u4e00-\u9fff]+$/.test(token);
}

function looksLikeChinesePersonName(token) {
  const name = String(token || "").trim();
  if (!isPureCjkToken(name, 2, 4)) return false;
  for (const surname of DOCUMENT_COMPOUND_SURNAMES) {
    if (!name.startsWith(surname)) continue;
    const givenNameLength = name.length - surname.length;
    return givenNameLength >= 1 && givenNameLength <= 2;
  }
  return DOCUMENT_COMMON_SURNAMES.has(name[0]) && name.length >= 2 && name.length <= 3;
}

function isLikelyDialogueNarrativeLine(lineText) {
  const line = String(lineText || "").trim();
  if (!line || isLikelyCodeLikeLine(line)) return false;
  if (/[“”「」『』]/.test(line)) return true;
  if (/[:：]\s*[“"'「『]/.test(line)) return true;
  return DOCUMENT_DIALOGUE_MARKERS.some((marker) => line.includes(marker));
}

function looksLikeLiteraryProperNoun(token) {
  const value = String(token || "").trim();
  if (!isPureCjkToken(value, 2, 4)) return false;
  if (looksLikeChinesePersonName(value)) return true;
  if (value.startsWith("老") && value.length >= 3) return true;
  return DOCUMENT_LITERARY_PROPER_NOUN_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

function collectAnchoredTermsFromRun(runText) {
  const run = String(runText || "").trim();
  const candidates = new Set();
  if (!run || !/^[\u4e00-\u9fff]{2,}$/.test(run)) return candidates;
  for (const anchor of DOCUMENT_PHRASE_ANCHORS) {
    let index = run.indexOf(anchor);
    while (index >= 0) {
      const anchorEnd = index + anchor.length;
      const startMin = Math.max(0, anchorEnd - DOCUMENT_PROTECTED_TERM_MAX_LENGTH);
      const endMax = Math.min(run.length, index + DOCUMENT_PROTECTED_TERM_MAX_LENGTH);
      for (let start = startMin; start <= index; start += 1) {
        for (let end = anchorEnd; end <= endMax; end += 1) {
          const candidate = run.slice(start, end);
          if (
            candidate.length >= 2 &&
            candidate.length <= DOCUMENT_PROTECTED_TERM_MAX_LENGTH &&
            candidate.includes(anchor)
          ) {
            candidates.add(candidate);
          }
        }
      }
      index = run.indexOf(anchor, index + 1);
    }
  }
  return candidates;
}

function collectDocumentProtectedTerms(text) {
  const source = String(text || "");
  if (!source || !hasCjkText(source)) return new Set();
  const anchoredTerms = new Map();
  const personTerms = new Map();
  const literaryTerms = new Map();
  const ranges = extractDetectableRanges(source);
  for (const range of ranges) {
    const segment = source.slice(range.from, range.to);
    const lines = segment.split(/\r?\n/);
    for (const line of lines) {
      const lineText = String(line || "").trim();
      if (!lineText || isLikelyCodeLikeLine(lineText)) continue;
      const literaryLine = isLikelyDialogueNarrativeLine(lineText);
      const runs = lineText.match(/[\u4e00-\u9fff]{2,24}/g) || [];
      for (const item of runs) {
        const run = String(item || "").trim();
        if (!run || run.length > DOCUMENT_PROTECTED_RUN_MAX_LENGTH) continue;
        if (looksLikeChinesePersonName(run)) {
          incrementMapCounter(personTerms, run);
          if (literaryLine) incrementMapCounter(personTerms, run);
        } else if (literaryLine && looksLikeLiteraryProperNoun(run)) {
          incrementMapCounter(literaryTerms, run);
        }
        for (const candidate of collectAnchoredTermsFromRun(run)) {
          incrementMapCounter(anchoredTerms, candidate);
        }
      }
    }
  }
  const protectedTerms = new Set();
  for (const [term, count] of anchoredTerms.entries()) {
    if (count >= 1) protectedTerms.add(term);
  }
  for (const [term, count] of personTerms.entries()) {
    if (count >= 2) protectedTerms.add(term);
  }
  for (const [term, count] of literaryTerms.entries()) {
    if (count >= 1) protectedTerms.add(term);
  }
  return protectedTerms;
}

function shouldSuppressReplacementByProtectedPhrase(match, text, protectedTerms) {
  if (!text || !(protectedTerms instanceof Set) || !protectedTerms.size) return false;
  const token = String((match && match.token) || "").trim();
  const suggestion = getPrimaryReplacementValue(match).trim();
  if (!token || !suggestion || token === suggestion) return false;
  const lineRange = getLineRangeAroundMatch(text, match);
  if (!lineRange.text || !lineRange.text.includes(token)) return false;
  for (const term of protectedTerms) {
    if (!term || term.length <= token.length || !term.includes(token) || !lineRange.text.includes(term)) continue;
    let index = lineRange.text.indexOf(term);
    while (index >= 0) {
      const termFrom = lineRange.from + index;
      const termTo = termFrom + term.length;
      if (termFrom <= match.from && termTo >= match.to) {
        const relativeFrom = match.from - termFrom;
        const relativeTo = match.to - termFrom;
        const replaced = `${term.slice(0, relativeFrom)}${suggestion}${term.slice(relativeTo)}`;
        if (replaced !== term && !protectedTerms.has(replaced)) {
          return true;
        }
      }
      index = lineRange.text.indexOf(term, index + 1);
    }
  }
  return false;
}

function shouldSuppressReplacementByKnownIdiom(match, text, idiomTerms) {
  if (!text || !(idiomTerms instanceof Set) || !idiomTerms.size) return false;
  const buckets = getTermLengthBuckets(idiomTerms);
  if (!buckets || !buckets.lengths.length) return false;
  const token = String((match && match.token) || "").trim();
  const suggestion = getPrimaryReplacementValue(match).trim();
  if (!token || !suggestion || token === suggestion) return false;
  const lineRange = getLineRangeAroundMatch(text, match);
  const lineText = String(lineRange.text || "");
  if (!lineText || !hasCjkText(lineText) || lineText.length < 2) return false;
  const relativeFrom = Math.max(0, Number(match.from || 0) - lineRange.from);
  const relativeTo = Math.min(lineText.length, Number(match.to || 0) - lineRange.from);
  if (relativeTo <= relativeFrom) return false;
  for (const termLength of buckets.lengths) {
    if (termLength < 2 || termLength > lineText.length) continue;
    const termSet = buckets.map.get(termLength);
    if (!(termSet instanceof Set) || !termSet.size) continue;
    const startMin = Math.max(0, relativeTo - termLength);
    const startMax = Math.min(relativeFrom, lineText.length - termLength);
    if (startMax < startMin) continue;
    for (let start = startMin; start <= startMax; start += 1) {
      const phrase = lineText.slice(start, start + termLength);
      if (phrase.length !== termLength || !termSet.has(phrase)) continue;
      const overlapFrom = Math.max(relativeFrom, start);
      const overlapTo = Math.min(relativeTo, start + termLength);
      if (overlapTo <= overlapFrom) continue;
      const relativeOverlapFrom = overlapFrom - start;
      const relativeOverlapTo = overlapTo - start;
      const replaced = `${phrase.slice(0, relativeOverlapFrom)}${suggestion}${phrase.slice(relativeOverlapTo)}`;
      if (replaced === phrase) continue;
      const replacedSet = buckets.map.get(replaced.length);
      if (!(replacedSet instanceof Set) || !replacedSet.has(replaced)) return true;
    }
  }
  return false;
}

function getTermLengthBuckets(termSet) {
  if (!(termSet instanceof Set) || !termSet.size) return null;
  const cached = TERM_LENGTH_BUCKET_CACHE.get(termSet);
  if (cached) return cached;
  const map = new Map();
  for (const item of termSet) {
    const term = String(item || "").trim();
    if (!term) continue;
    const length = term.length;
    if (length < 2) continue;
    if (!map.has(length)) map.set(length, new Set());
    map.get(length).add(term);
  }
  const buckets = {
    map,
    lengths: [...map.keys()].sort((a, b) => a - b)
  };
  TERM_LENGTH_BUCKET_CACHE.set(termSet, buckets);
  return buckets;
}

function shouldSuppressLiteraryContextReplacement(match, text) {
  if (!text || !isPycorrectorMatch(match)) return false;
  const token = String((match && match.token) || "").trim();
  const suggestion = getPrimaryReplacementValue(match).trim();
  const confidence = Number((match && match.confidence) || 0);
  if (!isPureCjkToken(token, 2, 4) || !isPureCjkToken(suggestion, 2, 4) || token === suggestion) return false;
  const lineText = getLineTextAroundMatch(text, match);
  if (!isLikelyDialogueNarrativeLine(lineText)) return false;
  if ((looksLikeChinesePersonName(token) || looksLikeChinesePersonName(suggestion)) && confidence < 0.995) {
    return true;
  }
  if ((looksLikeLiteraryProperNoun(token) || looksLikeLiteraryProperNoun(suggestion)) && confidence < 0.992) {
    return true;
  }
  return token.length === suggestion.length && token.length === 3 && confidence < 0.985;
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

function getCjkCharCount(text) {
  const matches = String(text || "").match(/[\u4e00-\u9fff]/g);
  return matches ? matches.length : 0;
}

function getAsciiLikeRatio(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return 0;
  const matches = compact.match(/[A-Za-z0-9_./\\:=#()[\]{}"`'@&*+\-|,;%]/g);
  return matches ? matches.length / compact.length : 0;
}

function countCodeLikeMarkers(text) {
  const line = String(text || "");
  const markers = [
    /`/,
    /https?:\/\//i,
    /[A-Za-z]:[\\/]/,
    /(?:^|[\s`])[\w.-]+\.(?:exe|js|ts|json|md|css|html|py|bat|cmd)(?:[\s`.,)]|$)/i,
    /\brgb\s*\(/i,
    /--[a-z0-9-]+/i,
    /::|=>|==|!=|&&|\|\|/,
    /[{}[\]<>]/
  ];
  let count = 0;
  for (const marker of markers) {
    if (marker.test(line)) count += 1;
  }
  return count;
}

function isLikelyCodeLikeLine(text) {
  const line = String(text || "").trim();
  if (!line) return false;
  const cjkCount = getCjkCharCount(line);
  const asciiLikeRatio = getAsciiLikeRatio(line);
  const markerCount = countCodeLikeMarkers(line);
  if (!cjkCount && asciiLikeRatio >= 0.35) return true;
  if (asciiLikeRatio >= 0.6) return true;
  if (/^\s*#{1,6}\s+/.test(line) && asciiLikeRatio >= 0.35 && cjkCount <= 8) return true;
  if (markerCount >= 2 && asciiLikeRatio >= 0.22) return true;
  if (/^\s*[-*+]\s+/.test(line) && markerCount >= 2 && cjkCount <= 18) return true;
  return false;
}

function collectHeuristicBlockedLineRanges(text, into) {
  const source = String(text || "");
  const lineRegex = /[^\r\n]*(?:\r?\n|$)/g;
  let match = lineRegex.exec(source);
  while (match) {
    const lineText = match[0];
    const from = match.index;
    const to = from + lineText.length;
    if (to > from && isLikelyCodeLikeLine(lineText)) {
      into.push({ from, to });
    }
    if (!lineText.length) break;
    match = lineRegex.exec(source);
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
  collectHeuristicBlockedLineRanges(text, blocked);
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

function buildRuleBasisText(wrong, correct, options = {}) {
  const normalizedWrong = String(wrong || "").trim();
  const normalizedCorrect = String(correct || "").trim();
  if (!normalizedWrong || !normalizedCorrect || normalizedWrong === normalizedCorrect) return "";
  const override = RULE_BASIS_OVERRIDES[`${normalizedWrong}->${normalizedCorrect}`];
  if (override) return override;
  const mode = options.mode === "variant" ? "variant" : "common";
  if (mode === "variant") {
    return `“${normalizedCorrect}”是现代汉语的规范用词，适用于绝大多数场合。“${normalizedWrong}”是一个已经或正在被淘汰的词。`;
  }
  if (/^[\u4e00-\u9fff]{4}$/.test(normalizedWrong) && /^[\u4e00-\u9fff]{4}$/.test(normalizedCorrect)) {
    return `成语固定写法为“${normalizedCorrect}”，“${normalizedWrong}”属于常见误写。`;
  }
  return `“${normalizedCorrect}”是现代汉语的规范用词，适用于绝大多数场合。“${normalizedWrong}”属于常见误写或异形写法。`;
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

function loadJsonTypoRules(rulesPath, options = {}) {
  if (!rulesPath || !fs.existsSync(rulesPath)) return [];
  const raw = fs.readFileSync(rulesPath, "utf8");
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rules) ? parsed.rules : [];
  const normalized = [];
  const seen = new Set();
  const defaultConfidence = Number.isFinite(Number(options.defaultConfidence)) ? Number(options.defaultConfidence) : 0.9;
  const minConfidence = Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : 0.5;
  const maxConfidence = Number.isFinite(Number(options.maxConfidence)) ? Number(options.maxConfidence) : 0.99;
  const basisMode = options.basisMode === "variant" ? "variant" : "common";
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const wrong = String(item.wrong || "").trim();
    const correct = String(item.correct || "").trim();
    if (!wrong || !correct || wrong === correct) continue;
    const confidenceRaw = Number(item.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(minConfidence, Math.min(maxConfidence, confidenceRaw))
      : defaultConfidence;
    const basis = String(item.basis || "").trim() || buildRuleBasisText(wrong, correct, { mode: basisMode });
    if (seen.has(wrong)) continue;
    seen.add(wrong);
    normalized.push({ wrong, correct, confidence, basis });
  }
  return normalized;
}

function loadDomainProtectedTerms(termsPath) {
  if (!termsPath || !fs.existsSync(termsPath)) return [];
  const raw = fs.readFileSync(termsPath, "utf8");
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.terms) ? parsed.terms : [];
  const normalized = [];
  const seen = new Set();
  for (const item of list) {
    const term = String(item || "").trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    normalized.push(term);
  }
  return normalized;
}

function loadPlainTextTerms(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = String(raw || "").split(/\r?\n/);
  const normalized = [];
  const seen = new Set();
  const exactLength = Number.isInteger(options.exactLength) ? options.exactLength : 0;
  const minLength = Number.isInteger(options.minLength) ? options.minLength : 0;
  const maxLength = Number.isInteger(options.maxLength) ? options.maxLength : 0;
  const pattern = options.pattern instanceof RegExp ? options.pattern : null;
  for (const line of lines) {
    const term = String(line || "").trim();
    if (!term || seen.has(term)) continue;
    if (exactLength > 0 && term.length !== exactLength) continue;
    if (minLength > 0 && term.length < minLength) continue;
    if (maxLength > 0 && term.length > maxLength) continue;
    if (pattern && !pattern.test(term)) continue;
    seen.add(term);
    normalized.push(term);
  }
  return normalized;
}

function getFileVersionSignature(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    return `${Math.floor(Number(stat.mtimeMs) || 0)}:${Number(stat.size) || 0}`;
  } catch (error) {
    return "";
  }
}

function normalizeExistingDir(dirPath) {
  const value = typeof dirPath === "string" ? dirPath.trim() : "";
  if (!value) return "";
  try {
    if (!fs.existsSync(value)) return "";
    const stat = fs.statSync(value);
    return stat.isDirectory() ? value : "";
  } catch (error) {
    return "";
  }
}

function buildPluginRuntimeDirCandidates(plugin) {
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = normalizeExistingDir(value);
    if (!normalized || candidates.includes(normalized)) return;
    candidates.push(normalized);
  };
  pushCandidate(plugin && plugin.manifest ? plugin.manifest.dir : "");
  pushCandidate(typeof __dirname === "string" ? __dirname : "");
  const manifestId = plugin && plugin.manifest && typeof plugin.manifest.id === "string" ? plugin.manifest.id.trim() : "";
  const vaultBasePath =
    plugin &&
    plugin.app &&
    plugin.app.vault &&
    plugin.app.vault.adapter &&
    typeof plugin.app.vault.adapter.basePath === "string"
      ? plugin.app.vault.adapter.basePath.trim()
      : "";
  const configDir =
    plugin &&
    plugin.app &&
    plugin.app.vault &&
    typeof plugin.app.vault.configDir === "string"
      ? plugin.app.vault.configDir.trim()
      : "";
  if (vaultBasePath && configDir && manifestId) {
    pushCandidate(path.join(vaultBasePath, configDir, "plugins", manifestId));
  }
  if (typeof process !== "undefined" && process && typeof process.cwd === "function") {
    pushCandidate(process.cwd());
  }
  return candidates;
}

function resolvePluginRuntimeDir(plugin) {
  const candidates = buildPluginRuntimeDirCandidates(plugin);
  for (const candidate of candidates) {
    const hasRules =
      fs.existsSync(path.join(candidate, SHARED_TYPO_RULES_FILENAME)) ||
      fs.existsSync(path.join(candidate, VARIANT_FORMS_FILENAME)) ||
      fs.existsSync(path.join(candidate, DOMAIN_TERMS_FILENAME)) ||
      fs.existsSync(path.join(candidate, IDIOM_DICTIONARY_FILENAME));
    if (hasRules) return candidate;
  }
  return candidates[0] || "";
}

class JsRuleEngine {
  constructor(plugin) {
    this.plugin = plugin;
    this.name = "js";
    this.runtimeDirCandidates = buildPluginRuntimeDirCandidates(plugin);
    const runtimeDir = resolvePluginRuntimeDir(plugin);
    this.runtimeDir = runtimeDir;
    this.sharedRulesPath = runtimeDir ? path.join(runtimeDir, SHARED_TYPO_RULES_FILENAME) : "";
    this.variantFormsPath = runtimeDir ? path.join(runtimeDir, VARIANT_FORMS_FILENAME) : "";
    this.domainTermsPath = runtimeDir ? path.join(runtimeDir, DOMAIN_TERMS_FILENAME) : "";
    this.idiomTermsPath = runtimeDir ? path.join(runtimeDir, IDIOM_DICTIONARY_FILENAME) : "";
    this.sharedPhraseRules = [];
    this.variantFormRules = [];
    this.domainProtectedTerms = [];
    this.idiomTerms = new Set();
    this.sharedRulesSignature = "";
    this.variantFormsSignature = "";
    this.domainTermsSignature = "";
    this.idiomTermsSignature = "";
    this.sharedRulesLoadError = "";
    this.variantFormsLoadError = "";
    this.domainTermsLoadError = "";
    this.idiomTermsLoadError = "";
    this.lastRuleRefreshAt = 0;
    this.refreshRuntimeRules({ force: true });
  }

  getCedictContext() {
    if (!this.plugin || typeof this.plugin.getJsCedictRuntime !== "function") return null;
    return this.plugin.getJsCedictRuntime();
  }

  refreshRuntimeRules(options = {}) {
    const force = options.force === true;
    const now = Date.now();
    if (!force && now - this.lastRuleRefreshAt < JS_RULE_RELOAD_INTERVAL_MS) return;
    this.lastRuleRefreshAt = now;

    const sharedSignature = getFileVersionSignature(this.sharedRulesPath);
    if (force || sharedSignature !== this.sharedRulesSignature) {
      try {
        this.sharedPhraseRules = loadJsonTypoRules(this.sharedRulesPath, {
          defaultConfidence: 0.9,
          minConfidence: 0.5,
          maxConfidence: 0.99,
          basisMode: "common"
        });
        this.sharedRulesLoadError = "";
      } catch (error) {
        this.sharedPhraseRules = [];
        this.sharedRulesLoadError = String(error && error.message ? error.message : error || "");
      }
      this.sharedRulesSignature = sharedSignature;
      if (!this.sharedPhraseRules.length && this.sharedRulesPath && !fs.existsSync(this.sharedRulesPath)) {
        this.sharedRulesLoadError = this.sharedRulesLoadError || "file_not_found";
      }
    }

    const variantSignature = getFileVersionSignature(this.variantFormsPath);
    if (force || variantSignature !== this.variantFormsSignature) {
      try {
        this.variantFormRules = loadJsonTypoRules(this.variantFormsPath, {
          defaultConfidence: 0.68,
          minConfidence: 0.6,
          maxConfidence: 0.9,
          basisMode: "variant"
        });
        this.variantFormsLoadError = "";
      } catch (error) {
        this.variantFormRules = [];
        this.variantFormsLoadError = String(error && error.message ? error.message : error || "");
      }
      this.variantFormsSignature = variantSignature;
      if (!this.variantFormRules.length && this.variantFormsPath && !fs.existsSync(this.variantFormsPath)) {
        this.variantFormsLoadError = this.variantFormsLoadError || "file_not_found";
      }
    }

    const domainSignature = getFileVersionSignature(this.domainTermsPath);
    if (force || domainSignature !== this.domainTermsSignature) {
      try {
        this.domainProtectedTerms = loadDomainProtectedTerms(this.domainTermsPath);
        this.domainTermsLoadError = "";
      } catch (error) {
        this.domainProtectedTerms = [];
        this.domainTermsLoadError = String(error && error.message ? error.message : error || "");
      }
      this.domainTermsSignature = domainSignature;
      if (!this.domainProtectedTerms.length && this.domainTermsPath && !fs.existsSync(this.domainTermsPath)) {
        this.domainTermsLoadError = this.domainTermsLoadError || "file_not_found";
      }
    }

    const idiomSignature = getFileVersionSignature(this.idiomTermsPath);
    if (force || idiomSignature !== this.idiomTermsSignature) {
      try {
        this.idiomTerms = new Set(
          loadPlainTextTerms(this.idiomTermsPath, {
            minLength: 2,
            maxLength: 4,
            pattern: /^[\u4e00-\u9fff]{2,4}$/
          })
        );
        this.idiomTermsLoadError = "";
      } catch (error) {
        this.idiomTerms = new Set();
        this.idiomTermsLoadError = String(error && error.message ? error.message : error || "");
      }
      this.idiomTermsSignature = idiomSignature;
      if (!this.idiomTerms.size && this.idiomTermsPath && !fs.existsSync(this.idiomTermsPath)) {
        this.idiomTermsLoadError = this.idiomTermsLoadError || "file_not_found";
      }
    }
  }

  getRuleCacheVersion() {
    this.refreshRuntimeRules();
    return [
      this.sharedRulesSignature || "",
      this.variantFormsSignature || "",
      this.domainTermsSignature || "",
      this.idiomTermsSignature || ""
    ].join("|");
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
    const protectedTerms = this.plugin && typeof this.plugin.getProtectedTermsSet === "function"
      ? this.plugin.getProtectedTermsSet()
      : BUILTIN_DOMAIN_PROTECTED_TOKENS;
    const segment = text.slice(range.from, range.to);
    CJK_TOKEN_REGEX.lastIndex = 0;
    let match = CJK_TOKEN_REGEX.exec(segment);
    while (match) {
      const token = match[0];
      const tokenFrom = range.from + match.index;
      const tokenTo = tokenFrom + token.length;
      const lineText = getLineTextAroundMatch(text, { from: tokenFrom, to: tokenTo });
      if (!cedictContext.words.has(token)) {
        if (protectedTerms.has(token)) {
          match = CJK_TOKEN_REGEX.exec(segment);
          continue;
        }
        if (token.length > 4) {
          match = CJK_TOKEN_REGEX.exec(segment);
          continue;
        }
        if (lineText && (isLikelyCodeLikeLine(lineText) || getAsciiLikeRatio(lineText) >= 0.15)) {
          match = CJK_TOKEN_REGEX.exec(segment);
          continue;
        }
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
        if (
          suggestion &&
          suggestion !== token &&
          sourceConfidence >= 0.74 &&
          !protectedTerms.has(suggestion)
        ) {
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

  getVariantFormRules() {
    return Array.isArray(this.variantFormRules) ? this.variantFormRules : [];
  }

  canEmitRuleWithCurrentThreshold(ruleId, shortMessage, maxConfidence) {
    if (!this.plugin || typeof this.plugin.getMatchConfidenceThreshold !== "function") return true;
    const maxValue = Number(maxConfidence);
    if (!Number.isFinite(maxValue) || maxValue <= 0) return true;
    const threshold = this.plugin.getMatchConfidenceThreshold({
      ruleId,
      shortMessage,
      confidence: maxValue,
      engine: this.name
    });
    return maxValue >= threshold;
  }

  async detect(text, context) {
    this.refreshRuntimeRules();
    const ranges = context.ranges || [{ from: 0, to: text.length }];
    const limit = context.maxSuggestions || 300;
    const matches = [];
    const seen = new Set();
    const cedictContext = this.plugin && typeof this.plugin.ensureJsCedictReady === "function"
      ? await this.plugin.ensureJsCedictReady({ reason: context.triggerSource || "detect" })
      : this.getCedictContext();
    const phraseRules = this.getPhraseRules();
    const variantFormRules = this.getVariantFormRules();
    const hintRuleEnabled = this.canEmitRuleWithCurrentThreshold(
      "CONFUSION_HINT_RULE",
      "混淆词提示",
      RULE_MAX_CONFIDENCE_HINTS.CONFUSION_HINT_RULE
    );
    const cedictOovRuleEnabled = this.canEmitRuleWithCurrentThreshold(
      "CEDICT_OOV_RULE",
      "词典候选",
      RULE_MAX_CONFIDENCE_HINTS.CEDICT_OOV_RULE
    );

    const pushMatch = (match) => {
      if (shouldSuppressReplacementByKnownIdiom(match, text, this.idiomTerms)) {
        return;
      }
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
            basis: String(rule.basis || "").trim() || buildRuleBasisText(rule.wrong, rule.correct, { mode: "common" }),
            token: text.slice(from, to),
            engine: this.name
          });
          cursor = segment.indexOf(rule.wrong, cursor + 1);
        }
      }

      for (const rule of variantFormRules) {
        let cursor = segment.indexOf(rule.wrong);
        while (cursor >= 0) {
          const from = range.from + cursor;
          const to = from + rule.wrong.length;
          pushMatch({
            from,
            to,
            message: `检测到异形词，规范词形建议“${rule.correct}”`,
            shortMessage: "规范词形建议",
            replacements: [{ value: rule.correct }],
            ruleId: "VARIANT_FORM_RULE",
            category: "TYPOS",
            confidence: rule.confidence,
            basis: String(rule.basis || "").trim() || buildRuleBasisText(rule.wrong, rule.correct, { mode: "variant" }),
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

      if (hintRuleEnabled) {
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
              confidence: RULE_MAX_CONFIDENCE_HINTS.CONFUSION_HINT_RULE,
              token: source,
              engine: this.name
            });
          }
        }
      }

      if (cedictOovRuleEnabled && cedictContext && cedictContext.enabled) {
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
    this.runtimeVersion = "";
    this.runtimeVersionSupported = null;
    this.runtimeInspection = null;
    this.runtimeInspectionPromise = null;
    this.lastEnvironmentCheckReport = null;
    this.checkCacheSize = 0;
    this.lastCheckPartial = false;
    this.lastCheckTimedOut = false;
    this.lastCheckTimeoutBudgetMs = 0;
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

  invalidateRuntimeInspection() {
    this.runtimeInspection = null;
    this.runtimeInspectionPromise = null;
    this.runtimeVersion = "";
    this.runtimeVersionSupported = null;
  }

  getModelCheck() {
    const dataDir = this.plugin.getEffectivePycorrectorDataDir();
    const lmPath = this.plugin.getEffectivePycorrectorLmPath();
    return {
      dataDir,
      lmPath,
      exists: fs.existsSync(lmPath)
    };
  }

  async inspectRuntime(options = {}) {
    const force = options.force === true;
    if (!force && this.runtimeInspection) return this.runtimeInspection;
    if (!force && this.runtimeInspectionPromise) return this.runtimeInspectionPromise;

    const executable = this.getExecutableCheck();
    if (executable.exists === false) {
      const missing = {
        ok: false,
        supported: null,
        versionText: "",
        executable: executable.resolved,
        reason: "python_not_found"
      };
      this.runtimeInspection = missing;
      this.runtimeVersion = "";
      this.runtimeVersionSupported = null;
      return missing;
    }

    const script = [
      "import importlib.util,json,sys",
      "has_module=lambda name: importlib.util.find_spec(name) is not None",
      "info={'executable':sys.executable,'version_text':sys.version.split()[0],'major':sys.version_info.major,'minor':sys.version_info.minor,'micro':sys.version_info.micro,'pycorrector_spec':has_module('pycorrector'),'torch_spec':has_module('torch')}",
      "print(json.dumps(info, ensure_ascii=False))"
    ].join(";");

    const inspectionPromise = new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(executable.resolved, ["-c", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      child.stdout.on("data", (chunk) => {
        stdout = `${stdout}${String(chunk || "")}`.slice(-8000);
      });
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk || "")}`.slice(-8000);
      });
      child.on("error", (error) => {
        const message = String(error && error.message ? error.message : error || "");
        const reason = /ENOENT|not found|spawn/i.test(message)
          ? "python_not_found"
          : normalizeReasonValue(`runtime_inspect_failed:${message}`);
        resolve({
          ok: false,
          supported: null,
          versionText: "",
          executable: executable.resolved,
          reason
        });
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const detail = normalizeReasonValue(stderr || stdout || `exit_${code}`);
          resolve({
            ok: false,
            supported: null,
            versionText: "",
            executable: executable.resolved,
            reason: detail || "runtime_inspect_failed"
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim() || "{}");
          const major = Number(parsed.major);
          const minor = Number(parsed.minor);
          const versionText = String(parsed.version_text || "").trim();
          resolve({
            ok: true,
            supported: major === SUPPORTED_PYTHON_MAJOR && minor === SUPPORTED_PYTHON_MINOR,
            versionText,
            executable: String(parsed.executable || executable.resolved || ""),
            dependencies: {
              pycorrector: typeof parsed.pycorrector_spec === "boolean" ? parsed.pycorrector_spec : null,
              torch: typeof parsed.torch_spec === "boolean" ? parsed.torch_spec : null
            },
            reason: major === SUPPORTED_PYTHON_MAJOR && minor === SUPPORTED_PYTHON_MINOR ? "" : "python_version_unsupported"
          });
        } catch (error) {
          resolve({
            ok: false,
            supported: null,
            versionText: "",
            executable: executable.resolved,
            reason: normalizeReasonValue(`runtime_inspect_parse_failed:${error && error.message ? error.message : error}`)
          });
        }
      });
    }).then((report) => {
      this.runtimeInspection = report;
      this.runtimeVersion = report.versionText || "";
      this.runtimeVersionSupported = typeof report.supported === "boolean" ? report.supported : null;
      return report;
    }).finally(() => {
      if (this.runtimeInspectionPromise === inspectionPromise) {
        this.runtimeInspectionPromise = null;
      }
    });

    this.runtimeInspectionPromise = inspectionPromise;
    return inspectionPromise;
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
    if (typeof data.check_cache_size === "number" && Number.isFinite(data.check_cache_size)) {
      this.checkCacheSize = Math.max(0, Math.floor(data.check_cache_size));
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
    this.lastCheckPartial = false;
    this.lastCheckTimedOut = false;
    this.lastCheckTimeoutBudgetMs = 0;
    if (!this.plugin.settings.pythonEngineEnabled) {
      this.lastEngineDetail = "disabled";
      return [];
    }
    if (this.plugin && typeof this.plugin.touchPythonActivity === "function") {
      this.plugin.touchPythonActivity();
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
          if (this.plugin.canAutoStartPython()) {
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
          this.lastError = this.plugin.getPythonUnavailableReason();
          throw new Error(this.lastError);
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
          if (this.plugin.canAutoStartPython()) {
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
          this.lastError = this.plugin.getPythonUnavailableReason();
          throw new Error(this.lastError);
        }
      }
      const payload = {
        text,
        ranges: context.ranges || [],
        max_suggestions: context.maxSuggestions || 300,
        file_path: context.filePath || "",
        text_hash: context.textHash || "",
        trigger: context.triggerSource || "manual"
      };
      const checkResult = await this.callCheck(payload);
      const matches = Array.isArray(checkResult && checkResult.matches) ? checkResult.matches : [];
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
      if (this.plugin.canAutoStartPython() && isTransientFetchReason(normalized)) {
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
    const runtime = await this.inspectRuntime({ force: true });
    if (!runtime.ok) {
      const report = {
        ok: false,
        exitCode: -1,
        signal: "",
        executable: runtime.executable || preferred.resolved,
        scriptPath,
        stdout: "",
        stderr: runtime.reason || "",
        output: `runtime_check=${runtime.reason || "unknown"}`,
        versionText: runtime.versionText || "",
        supported: runtime.supported,
        dependencies: runtime.dependencies || null
      };
      this.lastEnvironmentCheckReport = report;
      return report;
    }
    if (runtime.supported === false) {
      const report = {
        ok: false,
        exitCode: -1,
        signal: "",
        executable: runtime.executable || preferred.resolved,
        scriptPath,
        stdout: "",
        stderr: "python_version_unsupported",
        output: `runtime_check=python_version_unsupported\nruntime_version=${runtime.versionText || ""}\nrequired_version=${SUPPORTED_PYTHON_LABEL}`,
        versionText: runtime.versionText || "",
        supported: false,
        dependencies: runtime.dependencies || null
      };
      this.lastEnvironmentCheckReport = report;
      return report;
    }
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
            env: this.plugin.getPythonProcessEnv(),
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
              output: merged,
              versionText: runtime.versionText || "",
              supported: runtime.supported,
              dependencies: runtime.dependencies || null
            });
          });
        });
        this.lastEnvironmentCheckReport = result;
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
    const timeoutBudgetMs = Math.max(800, timeoutMs - 1200);
    this.lastCheckTimeoutBudgetMs = timeoutBudgetMs;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestPayload = {
      ...payload,
      timeout_budget_ms: timeoutBudgetMs
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
      const partial = Boolean(data.partial);
      this.lastCheckPartial = partial;
      if (!Array.isArray(data.matches)) {
        return { matches: [], partial };
      }
      this.lastError = "";
      this.lastStderr = "";
      this.resetFailureCircuit();
      this.lastCheckTimedOut = false;
      return {
        matches: data.matches.map((item) => ({
          ...item,
          engine: this.lastEngineDetail || this.name
        })),
        partial
      };
    } catch (error) {
      let reason = normalizeReasonValue(error && error.message ? error.message : error);
      const elapsedMs = Date.now() - startedAt;
      const abortedWithoutDetail =
        reason === "AbortError" || reason === "The_user_aborted_a_request." || reason === "signal_is_aborted_without_reason";
      if (abortedWithoutDetail && elapsedMs >= timeoutMs - 300) {
        reason = "python_check_timeout";
      }
      this.lastCheckPartial = false;
      this.lastCheckTimedOut = reason === "python_check_timeout";
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
    if (this.plugin && typeof this.plugin.touchPythonActivity === "function") {
      this.plugin.touchPythonActivity();
    }
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
      this.lastError = "python_script_missing";
      throw new Error("python_script_missing");
    }
    const executable = this.resolvePythonExecutable();
    if (/[\\/]/.test(executable) && !fs.existsSync(executable)) {
      this.lastError = normalizeReasonValue(`python_not_found:${executable}`);
      throw new Error(`python_not_found:${executable}`);
    }
    const runtime = await this.inspectRuntime({ force: true });
    if (!runtime.ok) {
      this.lastError = runtime.reason || "python_runtime_inspect_failed";
      throw new Error(this.lastError);
    }
    if (runtime.supported === false) {
      this.lastError = "python_version_unsupported";
      throw new Error(this.lastError);
    }
    this.lastStderr = "";
    this.explicitStopping = false;
    this.engineStatus = "loading";
    this.pycorrectorLoading = true;
    if (this.plugin && typeof this.plugin.touchPythonActivity === "function") {
      this.plugin.touchPythonActivity();
    }
    const port = String(Number(this.plugin.settings.pythonPort) || 27123);
    this.process = spawn(executable, [scriptPath, "--port", port], {
      cwd: path.dirname(scriptPath),
      env: this.plugin.getPythonProcessEnv(),
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
    if (normalizedCause === "python_not_verified") return "python_not_verified";
    if (normalizedCause === "bind_address_in_use" || normalizedCause === "bind_permission_denied") {
      return `python_unavailable:${normalizedCause}`;
    }
    if (
      normalizedCause === "python_version_unsupported" ||
      normalizedCause === "python_script_missing" ||
      normalizedCause === "pycorrector_model_missing"
    ) {
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
    const map = new Map();
    for (const list of groups) {
      for (const match of list) {
        const spanKey = isVariantFormMatch(match)
          ? `${match.from}:${match.to}:${String(match.ruleId || "")}`
          : `${match.from}:${match.to}`;
        const normalized = {
          ...match,
          replacements: mergeReplacementLists(match.replacements || [])
        };
        if (!map.has(spanKey)) {
          map.set(spanKey, normalized);
          continue;
        }
        const existing = map.get(spanKey);
        const replacements = mergeReplacementLists(existing.replacements || [], normalized.replacements || []);
        map.set(
          spanKey,
          isPreferredMatch(normalized, existing)
            ? { ...existing, ...normalized, replacements }
            : { ...existing, replacements }
        );
      }
    }
    const merged = collapseContainedMatches([...map.values()]);
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
        if (!this.hasOverlap(candidate, py)) continue;
        if (isVariantFormMatch(candidate)) {
          if (hasSameSpan(candidate, py) && getPrimaryReplacementValue(candidate) === getPrimaryReplacementValue(py)) {
            return false;
          }
          continue;
        }
        if (matchContains(py, candidate) || matchContains(candidate, py) || isPreferredMatch(py, candidate)) {
          return false;
        }
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
        fallbackReason: "",
        partial: false
      };
    }
    if ((mode === ENGINE_MODES.PYTHON || mode === ENGINE_MODES.HYBRID) && !this.plugin.settings.pythonEngineEnabled) {
      return {
        matches: await this.jsEngine.detect(text, context),
        engineUsed: "js",
        fallbackReason: "python_disabled",
        partial: false
      };
    }
    if (mode === ENGINE_MODES.JS) {
      return {
        matches: await this.jsEngine.detect(text, context),
        engineUsed: "js",
        fallbackReason: "",
        partial: false
      };
    }
    if (mode === ENGINE_MODES.PYTHON) {
      try {
        const pyMatches = await this.pythonEngine.detect(text, context);
        const pythonPartial = Boolean(this.pythonEngine.lastCheckPartial);
        return {
          matches: Array.isArray(pyMatches) ? pyMatches : [],
          engineUsed: this.pythonEngine.getRuntimeEngineLabel("python"),
          fallbackReason: "",
          partial: pythonPartial
        };
      } catch (error) {
        return {
          matches: [],
          engineUsed: this.pythonEngine.getRuntimeEngineLabel("python"),
          fallbackReason: this.resolvePythonFallbackReason(
            this.pythonEngine.lastError || (error && error.message ? error.message : "unknown")
          ),
          partial: false
        };
      }
    }
    let pythonMatches = [];
    let pythonFallbackReason = "";
    let pythonPartial = false;
    try {
      pythonMatches = await this.pythonEngine.detect(text, context);
      pythonPartial = Boolean(this.pythonEngine.lastCheckPartial);
    } catch (error) {
      pythonMatches = [];
      pythonPartial = false;
      pythonFallbackReason = this.resolvePythonFallbackReason(
        this.pythonEngine.lastError || (error && error.message ? error.message : "unknown")
      );
    }
    const pythonExecutionSucceeded =
      !pythonFallbackReason &&
      (
        this.pythonEngine.engineStatus === "ready" ||
        this.pythonEngine.pycorrectorAvailable === true ||
        Boolean(this.pythonEngine.lastEngineDetail)
      );
    if (!pythonMatches.length) {
      const jsMatches = await this.jsEngine.detect(text, context);
      if (pythonExecutionSucceeded) {
        return {
          matches: jsMatches,
          engineUsed: jsMatches.length
            ? `${this.pythonEngine.getRuntimeEngineLabel("混合")}+js`
            : this.pythonEngine.getRuntimeEngineLabel("混合"),
          fallbackReason: "",
          partial: pythonPartial
        };
      }
      return {
        matches: jsMatches,
        engineUsed: "js",
        fallbackReason:
          pythonFallbackReason ||
          (this.pythonEngine.engineStatus === "unavailable"
            ? `python_unavailable:${this.pythonEngine.lastError || "unknown"}`
            : `python_empty:${this.pythonEngine.lastEngineDetail || "unknown"}`),
        partial: false
      };
    }
    const jsMatches = await this.jsEngine.detect(text, context);
    const supplement = this.supplementJsMatches(pythonMatches, jsMatches);
    return {
      matches: this.mergeMatches([pythonMatches, supplement]),
      engineUsed: this.pythonEngine.getRuntimeEngineLabel("混合"),
      fallbackReason: pythonFallbackReason,
      partial: pythonPartial
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
    if (!this.plugin.canAutoStartPython()) return { state: "skipped", waitedMs: 0 };

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
    if (this.report.itemsTruncated) {
      contentEl.createEl("p", {
        text: `为控制内存占用，仅保留前 ${this.report.items.length} 条预览。`
      });
    }

    const list = contentEl.createEl("div", { cls: "csc-scan-list" });
    const preview = this.report.items.slice(0, 80);
    for (const item of preview) {
      list.createEl("div", {
        text: `${item.filePath}  L${item.line}  ${item.token} -> ${item.suggestion}`,
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

  getEmptyResultText() {
    if (!this.payload || this.payload.source !== "file") return "尚未检测";
    const diagnostics = this.payload.diagnostics || {};
    const fallback = parseFallbackReason(diagnostics.fallbackReason);
    const jsCedictRuntime = this.plugin.getJsCedictRuntime();
    if (diagnostics.pythonPartial) {
      return "pycorrector 因超时，结果不完整（已展示已完成部分），请缩小范围后重试。";
    }
    if (fallback.key === "python_booting" || fallback.key === "python_unreachable") {
      return "Python 服务尚未就绪，本次结果可能不完整，请稍后重新纠错。";
    }
    if (fallback.key === "python_not_verified") {
      return "Python 环境尚未通过自检，本次结果仅基于 JS，请先完成自检后重试。";
    }
    if (fallback.key === "python_unavailable" || fallback.key === "python_error" || diagnostics.qualityHint) {
      return "本次结果未完整使用 pycorrector，可能存在漏检，请稍后重新纠错。";
    }
    if (this.plugin.settings.jsCedictEnhanced && !jsCedictRuntime.ready) {
      return "CEDICT 词典尚未就绪，JS 结果可能不完整，请稍后重新纠错。";
    }
    return "✅✅ 未检出错误 ✅✅";
  }

  renderResultItem(container, item, isSingleFileResult, currentResultKey) {
    const row = container.createEl("div", { cls: "csc-result-item" });
    if (getResultItemKey(item) === currentResultKey) {
      row.addClass("is-selected");
    }
    const title = row.createEl("div", { cls: "csc-result-item-title" });
    title.createEl("span", { cls: "csc-result-item-line", text: `行${item.line}` });
    const engineDisplay = formatEngineDisplayName(item.engine);
    const engineTooltip = buildEngineTooltip(item.engine);
    const engineEl = title.createEl("span", { cls: "csc-result-item-engine", text: ` ${engineDisplay}` });
    engineEl.setAttr("title", engineTooltip);
    engineEl.setAttr("aria-label", engineTooltip);
    title.createEl("span", { cls: "csc-result-item-confidence", text: ` ${formatConfidencePercent(item.confidence)}` });
    const contentEl = title.createEl("span", { cls: "csc-result-item-text", text: ` ${item.token}→${item.suggestion || "（无建议）"}` });
    const basisText = String(item.basis || "").trim();
    if (basisText) {
      const tooltipText = `纠错依据：${basisText}`;
      row.setAttr("title", tooltipText);
    }
    if (!isSingleFileResult) {
      row.createEl("div", { cls: "csc-result-item-meta", text: item.filePath });
    }
    if (item.excerpt) {
      row.createEl("div", { cls: "csc-result-item-excerpt", text: item.excerpt });
    }
    row.onclick = () => {
      this.plugin.jumpToPanelResult(item, { updateSelection: true }).catch((error) => {
        new Notice(`跳转失败：${error.message}`);
      });
    };
  }

  renderResultGroup(container, groupKey, items, isSingleFileResult, currentResultKey, options = {}) {
    if (!items.length) return;
    const isReviewGroup = groupKey === RESULT_CONFIDENCE_GROUPS.REVIEW;
    const defaultOpen = options.defaultOpen === true;
    const highThreshold = formatConfidencePercent(
      getResultHighConfidenceThreshold(this.plugin.settings.confidenceThreshold)
    );
    const groupLabel = RESULT_CONFIDENCE_GROUP_LABELS[groupKey] || groupKey;
    const summaryText = isReviewGroup
      ? `${groupLabel} ${items.length} 条（低于 ${highThreshold}，${defaultOpen ? "默认展开" : "默认折叠"}）`
      : `${groupLabel} ${items.length} 条`;
    const wrapper = isReviewGroup
      ? container.createEl("details", { cls: "csc-result-group csc-result-group-review" })
      : container.createEl("div", { cls: "csc-result-group csc-result-group-high" });
    if (isReviewGroup && defaultOpen) {
      wrapper.setAttr("open", "open");
    }
    const header = isReviewGroup
      ? wrapper.createEl("summary", { cls: "csc-result-group-header", text: summaryText })
      : wrapper.createEl("div", { cls: "csc-result-group-header", text: summaryText });
    if (!isReviewGroup) {
      header.addClass("is-static");
    }
    const list = wrapper.createEl("div", { cls: "csc-result-list" });
    for (const item of items) {
      this.renderResultItem(list, item, isSingleFileResult, currentResultKey);
    }
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("csc-result-panel");
    const header = contentEl.createEl("div", { cls: "csc-result-header" });
    header.createEl("div", { cls: "csc-result-title", text: "纠错" });
    const headerRight = header.createEl("div", { cls: "csc-result-header-right" });
    const currentFileName =
      this.payload && this.payload.filePath ? path.basename(String(this.payload.filePath)) : "当前文件";
    const resultCount =
      this.payload && this.payload.source === "file" && Array.isArray(this.payload.items)
        ? `${Number(this.payload.totalItemCount || this.payload.items.length)} 条`
        : "";
    const currentFileText = resultCount ? `${currentFileName} ${resultCount}` : currentFileName;
    headerRight.createEl("div", { cls: "csc-result-current-file", text: currentFileText });
    const checkButton = headerRight.createEl("button", { cls: "csc-result-refresh-btn", text: "开始纠错" });
    checkButton.onclick = async () => {
      checkButton.disabled = true;
      try {
        const executed = await this.plugin.app.commands.executeCommandById("csc-check-current-file");
        if (!executed) {
          const triggered = await this.plugin.triggerDetectionForActiveFileWithRetry("manual", 1, 80);
          if (!triggered) new Notice("请先打开一个 Markdown 文件。");
        }
      } finally {
        checkButton.disabled = false;
      }
    };
    const sortButton = headerRight.createEl("button", { cls: "csc-result-sort-btn", text: "排序" });
    const sortLabel = this.plugin.getResultSortModeLabel();
    sortButton.setAttr("title", `当前排序：${sortLabel}`);
    sortButton.setAttr("aria-label", `当前排序：${sortLabel}`);
    sortButton.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.plugin.openResultSortMenu(event, sortButton);
    };

    if (!this.payload) {
      contentEl.createEl("div", { cls: "csc-result-empty", text: "尚未检测" });
      return;
    }

    if (this.payload.progress && this.payload.progress.active) {
      const progress = this.payload.progress;
      const progressWrap = contentEl.createEl("div", { cls: "csc-result-progress" });
      const progressText = progress.stage ? `${progress.stage} ${clampProgressPercent(progress.percent)}%` : "正在纠错";
      progressWrap.createEl("div", { cls: "csc-result-progress-text", text: progressText });
      const track = progressWrap.createEl("div", { cls: "csc-result-progress-track" });
      const fill = track.createEl("div", { cls: "csc-result-progress-fill" });
      fill.style.width = `${Math.max(6, clampProgressPercent(progress.percent))}%`;
    }

    if (this.payload.summary) {
      contentEl.createEl("div", { cls: "csc-result-summary", text: this.payload.summary });
    }
    if (this.payload.itemsTruncated) {
      contentEl.createEl("div", {
        cls: "csc-result-summary",
        text: `为控制内存占用，当前仅展示前 ${this.payload.items.length} 条结果。`
      });
    }
    if (this.payload.diagnostics) {
      const d = this.payload.diagnostics;
      const diagText = `触发:${d.trigger || "-"} | 引擎:${d.engine || "-"} | 耗时:${d.durationMs ?? "-"}ms | 时间:${d.timestamp || "-"}`;
      this.appendDiagnosticsLine(contentEl, diagText, diagText);
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
        this.appendDiagnosticsLine(contentEl, "诊断数据", d.rawText);
      }
    }

    const items = this.plugin.getSortedPanelItems(this.payload);
    if (!items.length) {
      contentEl.createEl("div", { cls: "csc-result-empty", text: this.getEmptyResultText() });
      return;
    }

    const isSingleFileResult = this.payload && this.payload.source === "file" && Boolean(this.payload.filePath);
    const currentResultKey = this.plugin.currentPanelResultKey;
    const groupedItems = splitPanelItemsByConfidence(items, this.plugin.settings.confidenceThreshold);
    const hasHighConfidenceItems = groupedItems[RESULT_CONFIDENCE_GROUPS.HIGH].length > 0;
    this.renderResultGroup(
      contentEl,
      RESULT_CONFIDENCE_GROUPS.HIGH,
      groupedItems[RESULT_CONFIDENCE_GROUPS.HIGH],
      isSingleFileResult,
      currentResultKey
    );
    this.renderResultGroup(
      contentEl,
      RESULT_CONFIDENCE_GROUPS.REVIEW,
      groupedItems[RESULT_CONFIDENCE_GROUPS.REVIEW],
      isSingleFileResult,
      currentResultKey,
      { defaultOpen: !hasHighConfidenceItems }
    );
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
      .setDesc("已停用自动触发机制；仅支持手动执行“开始纠错”。")
      .addToggle((toggle) => toggle.setDisabled(true).setValue(false));

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
      .setName("全局置信度阈值")
      .setDesc("所有引擎共用的最低阈值。低于阈值的建议不会展示。")
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
      .setName("pycorrector 置信度阈值")
      .setDesc("仅对 pycorrector 生效。低于该阈值的 pycorrector 建议直接忽略；实际采用“全局阈值”和本阈值中的更严格值。")
      .addSlider((slider) =>
        slider
          .setLimits(0.55, 0.99, 0.01)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.pycorrectorConfidenceThreshold)
          .onChange(async (value) => {
            this.plugin.settings.pycorrectorConfidenceThreshold = Number(value.toFixed(2));
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("引擎模式")
      .setDesc("Python：仅使用 Python 侧能力（含 pycorrector 与 Python规则），不补 JS；混合：优先使用 pycorrector/Python，必要时再补或回退 JS；JS：仅本地规则。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption(ENGINE_MODES.JS, "仅 JS 引擎")
          .addOption(ENGINE_MODES.PYTHON, "仅 Python 引擎（pycorrector+Python）")
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
    const recommendedPycorrectorDataDir = this.plugin.getRecommendedPycorrectorDataDir();
    const effectivePycorrectorDataDir = this.plugin.getEffectivePycorrectorDataDir();
    const effectivePycorrectorLmPath = this.plugin.getEffectivePycorrectorLmPath();
    const pycorrectorLmExists = fs.existsSync(effectivePycorrectorLmPath);
    const setupSnapshot = this.plugin.getPythonSetupSnapshot();

    containerEl.createEl("p", {
      text: "首次安装请按以下顺序操作："
    });
    containerEl.createEl("p", {
      text: `步骤 1：确认 pycorrector 模型目录。默认目录：${recommendedPycorrectorDataDir}`
    });
    containerEl.createEl("p", {
      text: `步骤 2：确认 .venv 目录并应用到 Python 路径。默认 .venv：${recommendedVenvDir}`
    });
    containerEl.createEl("p", {
      text: "步骤 3：复制安装命令完成依赖安装，再执行“引擎自检”。"
    });
    containerEl.createEl("p", {
      text: `版本要求：仅支持 ${SUPPORTED_PYTHON_LABEL}`
    });
    containerEl.createEl("p", {
      text: `当前状态：${setupSnapshot.stateLabel} | ${setupSnapshot.detail} | 下一步：${setupSnapshot.nextAction}`
    });
    if (setupSnapshot.preflightSummary) {
      containerEl.createEl("p", {
        text: `预校验：${setupSnapshot.preflightSummary}`
      });
    }
    containerEl.createEl("p", {
      text: `当前 pycorrector 模型目录：${effectivePycorrectorDataDir} | 模型文件：${effectivePycorrectorLmPath} | 存在：${pycorrectorLmExists}`
    });
    containerEl.createEl("p", {
      text: `当前 .venv：${effectiveVenvDir} | 推导 Python：${resolvedExecutable} | 存在：${executableExists}`
    });

    let pycorrectorDataDirInput = null;
    new Setting(containerEl)
      .setName("pycorrector 模型目录")
      .setDesc("步骤 1。默认使用 S:\\obsidian-chinese-checker\\.pycorrector\\datasets，Python 服务会优先从这里读取 .klm。")
      .addText((text) => {
        pycorrectorDataDirInput = text;
        return text
          .setPlaceholder(recommendedPycorrectorDataDir)
          .setValue(this.plugin.settings.pythonPycorrectorDataDir || "")
          .onChange(async (value) => {
            this.plugin.settings.pythonPycorrectorDataDir = normalizeVenvDir(value, recommendedPycorrectorDataDir);
            this.plugin.resetPythonVerificationFields();
            await this.plugin.saveSettings();
            if (this.plugin.engineManager && this.plugin.engineManager.pythonEngine) {
              this.plugin.engineManager.pythonEngine.invalidateRuntimeInspection();
            }
          });
      })
      .addButton((button) =>
        button.setButtonText("默认").onClick(async () => {
          await this.plugin.updatePycorrectorDataDir(recommendedPycorrectorDataDir, { showNotice: true });
          if (pycorrectorDataDirInput) pycorrectorDataDirInput.setValue(this.plugin.settings.pythonPycorrectorDataDir);
          this.display();
        })
      );

    let pythonVenvDirInput = null;
    new Setting(containerEl)
      .setName("Python 虚拟环境目录（.venv）")
      .setDesc("步骤 2。可自定义存储位置。默认使用 S:\\obsidian-chinese-checker\\.venv。")
      .addText((text) => {
        pythonVenvDirInput = text;
        return text
          .setPlaceholder(recommendedVenvDir)
          .setValue(this.plugin.settings.pythonVenvDir || "")
          .onChange(async (value) => {
            this.plugin.settings.pythonVenvDir = normalizeVenvDir(value, recommendedVenvDir);
            this.plugin.resetPythonVerificationFields();
            await this.plugin.saveSettings();
            if (this.plugin.engineManager && this.plugin.engineManager.pythonEngine) {
              this.plugin.engineManager.pythonEngine.invalidateRuntimeInspection();
            }
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
      .setName("依赖安装与自检")
      .setDesc(`步骤 3。仅支持 ${SUPPORTED_PYTHON_LABEL}。先复制安装命令完成依赖安装，再执行“引擎自检”确认 pycorrector 已就绪。`)
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
      .setDesc("首次安装默认关闭；确认环境可用后再开启。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pythonEngineEnabled).onChange(async (value) => {
          this.plugin.settings.pythonEngineEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("自动拉起 Python 服务")
      .setDesc("仅在环境已通过自检且为 Python 3.11.x 时后台拉起；未验证环境不会自动启动。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pythonAutoStart).onChange(async (value) => {
          this.plugin.settings.pythonAutoStart = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("仅手动检查时使用 Python")
      .setDesc("开启后，只有命令“开始纠错”或面板按钮会调用 pycorrector；实时/切换文件等自动触发仅使用 JS。")
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
          this.plugin.resetPythonVerificationFields();
          await this.plugin.saveSettings();
          if (this.plugin.engineManager && this.plugin.engineManager.pythonEngine) {
            this.plugin.engineManager.pythonEngine.invalidateRuntimeInspection();
          }
        })
      );

    new Setting(containerEl)
      .setName("Python 服务脚本路径")
      .setDesc("可填写绝对路径，也可填写相对插件目录路径。")
      .addText((text) =>
        text.setValue(this.plugin.settings.pythonScriptPath).onChange(async (value) => {
          this.plugin.settings.pythonScriptPath = value.trim() || "python_engine_service.py";
          this.plugin.resetPythonVerificationFields();
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
      class: "csc-tooltip-shell",
      create() {
        const dom = document.createElement("div");
        dom.className = "csc-tooltip";
        requestAnimationFrame(() => {
          const shell = dom.parentElement;
          if (shell && shell.classList && shell.classList.contains("cm-tooltip")) {
            shell.classList.add("csc-tooltip-shell");
          }
        });

        const title = document.createElement("div");
        title.className = "csc-title";
        title.textContent = target.match.shortMessage || "疑似错别字";
        dom.appendChild(title);

        const message = document.createElement("div");
        message.className = "csc-message";
        message.textContent = target.match.message || "";
        dom.appendChild(message);

        const basisText = String((target.match && target.match.basis) || "").trim();
        if (basisText) {
          const basis = document.createElement("div");
          basis.className = "csc-basis";
          basis.textContent = `纠错依据：${basisText}`;
          dom.appendChild(basis);
        }

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
    if (!update.docChanged || !plugin.isAutoDetectionEnabled()) return;
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
    this.fileDetectionSnapshot = new Map();
    this.frontDetectionCache = new Map();
    this.detectionRequestSeq = 0;
    this.pythonStartupGateDone = false;
    this.pythonStartupGateLastAttemptAt = 0;
    this.pythonStartupGatePromise = null;
    this.pythonStartupGatePromiseStartedAt = 0;
    this.pythonStartupGatePromiseToken = 0;
    this.pythonStartupGateAttemptCount = 0;
    this.pythonStartupGateFallbackReason = "";
    this.manualDetectionWindowUntil = 0;
    this.pythonReadyReplayPending = false;
    this.jsCedictLoadPromise = null;
    this.jsCedictLastUsedAt = 0;
    this.pythonLastUsedAt = 0;
    this.resultSortMode = RESULT_SORT_MODES.CONFIDENCE_DESC;
    this.currentPanelResultKey = "";
    this.currentPanelResultIndex = -1;
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
      error: "lazy_not_loaded"
    };

    this.registerEditorExtension(createEditorExtensions(this));
    this.addSettingTab(new ChineseTypoSettingTab(this.app, this));
    this.registerView(RESULT_VIEW_TYPE, (leaf) => new CscResultPanelView(leaf, this));
    this.registerInterval(window.setInterval(() => {
      this.reclaimIdleMemory().catch(() => {});
    }, MEMORY_RECLAIM_INTERVAL_MS));
    this.app.workspace.onLayoutReady(() => {
      this.ensureResultPanel(false).catch(() => {});
      this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView) || null;
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf || !leaf.view) return;
        if (leaf.view instanceof MarkdownView) {
          this.lastMarkdownView = leaf.view;
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
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView && activeView.file && activeView.file.path === file.path) {
          this.lastMarkdownView = activeView;
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {})
    );

    this.addCommand({
      id: "csc-check-current-file",
      name: "中文纠错：开始纠错",
      editorCallback: async (_editor, markdownView) => {
        await this.runDetectionForView(markdownView, resolveEditorView(markdownView), "manual");
      }
    });

    this.addCommand({
      id: "csc-jump-to-prev-result",
      name: "中文纠错：跳转至上一条纠错结果",
      callback: async () => {
        await this.navigatePanelResult(-1);
      }
    });

    this.addCommand({
      id: "csc-jump-to-next-result",
      name: "中文纠错：跳转至下一条纠错结果",
      callback: async () => {
        await this.navigatePanelResult(1);
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
        this.settings.liveCheck = false;
        await this.saveSettings();
        new Notice("自动触发已停用；请手动执行“开始纠错”。");
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

    if (this.canAutoStartPython()) {
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

  getRecommendedPycorrectorDataDir() {
    if (isWindowsPlatform()) {
      return normalizeVenvDir(DEFAULT_WINDOWS_PYCORRECTOR_DATA_DIR, DEFAULT_WINDOWS_PYCORRECTOR_DATA_DIR);
    }
    const localDataDir = path.join(this.manifest.dir, ".pycorrector_data");
    return normalizeVenvDir(localDataDir, localDataDir);
  }

  getEffectivePycorrectorDataDir() {
    const recommended = this.getRecommendedPycorrectorDataDir();
    return normalizeVenvDir(this.settings.pythonPycorrectorDataDir, recommended);
  }

  getEffectivePycorrectorLmPath() {
    return buildPycorrectorLmPath(this.getEffectivePycorrectorDataDir());
  }

  getPythonProcessEnv(extra = {}) {
    const dataDir = this.getEffectivePycorrectorDataDir();
    const lmPath = this.getEffectivePycorrectorLmPath();
    return Object.assign({}, process.env, {
      PYCORRECTOR_DATA_DIR: dataDir,
      PYCORRECTOR_LM_PATH: lmPath
    }, extra);
  }

  resetPythonVerificationFields() {
    this.settings.pythonLastSelfCheckOk = false;
    this.settings.pythonLastSelfCheckAt = 0;
    this.settings.pythonLastSelfCheckExecutable = "";
    this.settings.pythonLastSelfCheckVersion = "";
    this.settings.pythonLastSelfCheckDataDir = "";
    this.settings.pythonLastSelfCheckLmPath = "";
  }

  async invalidatePythonVerification(options = {}) {
    const save = options.save !== false;
    this.resetPythonVerificationFields();
    if (this.engineManager && this.engineManager.pythonEngine) {
      this.engineManager.pythonEngine.invalidateRuntimeInspection();
    }
    if (save) await this.saveSettings();
  }

  async markPythonVerification(report) {
    this.settings.pythonLastSelfCheckOk = Boolean(report && report.ok);
    this.settings.pythonLastSelfCheckAt = Date.now();
    this.settings.pythonLastSelfCheckExecutable = String(report && report.executable ? report.executable : "");
    this.settings.pythonLastSelfCheckVersion = String(report && report.versionText ? report.versionText : "");
    this.settings.pythonLastSelfCheckDataDir = this.getEffectivePycorrectorDataDir();
    this.settings.pythonLastSelfCheckLmPath = this.getEffectivePycorrectorLmPath();
    await this.saveSettings();
  }

  hasCurrentPythonVerification(runtimeVersion = "") {
    if (!this.settings.pythonLastSelfCheckOk) return false;
    if (this.settings.pythonLastSelfCheckExecutable !== this.engineManager.pythonEngine.getExecutableCheck().resolved) {
      return false;
    }
    if (this.settings.pythonLastSelfCheckDataDir !== this.getEffectivePycorrectorDataDir()) return false;
    if (this.settings.pythonLastSelfCheckLmPath !== this.getEffectivePycorrectorLmPath()) return false;
    const version = String(runtimeVersion || this.settings.pythonLastSelfCheckVersion || "").trim();
    if (!version) return false;
    return version === this.settings.pythonLastSelfCheckVersion;
  }

  getPythonSetupSnapshot(runtimeReport = null) {
    const pythonEngine = this.engineManager && this.engineManager.pythonEngine ? this.engineManager.pythonEngine : null;
    const runtime = runtimeReport || (pythonEngine ? pythonEngine.runtimeInspection : null);
    const executable = pythonEngine
      ? pythonEngine.getExecutableCheck()
      : { configured: "", resolved: "", exists: false, hasPathHint: true };
    const scriptPath = pythonEngine ? pythonEngine.resolveScriptPath() : "";
    const scriptExists = Boolean(scriptPath && fs.existsSync(scriptPath));
    const modelPath = this.getEffectivePycorrectorLmPath();
    const modelExists = fs.existsSync(modelPath);
    const venvDirCheck = inspectDirectoryWriteAccess(this.getEffectivePythonVenvDir());
    const pycorrectorDataDirCheck = inspectDirectoryWriteAccess(this.getEffectivePycorrectorDataDir());
    const runtimeVersion = String(
      (runtime && runtime.versionText) ||
      (pythonEngine && pythonEngine.runtimeVersion) ||
      this.settings.pythonLastSelfCheckVersion ||
      ""
    ).trim();
    const runtimeSupported =
      runtime && typeof runtime.supported === "boolean"
        ? runtime.supported
        : runtimeVersion
          ? runtimeVersion.startsWith(`${SUPPORTED_PYTHON_MAJOR}.${SUPPORTED_PYTHON_MINOR}.`)
            || runtimeVersion === `${SUPPORTED_PYTHON_MAJOR}.${SUPPORTED_PYTHON_MINOR}`
          : null;
    const runtimeDependencies = runtime && runtime.dependencies
      ? {
          pycorrector: typeof runtime.dependencies.pycorrector === "boolean" ? runtime.dependencies.pycorrector : null,
          torch: typeof runtime.dependencies.torch === "boolean" ? runtime.dependencies.torch : null
        }
      : { pycorrector: null, torch: null };
    const missingDependencies = [];
    if (runtime && runtime.ok && runtimeDependencies.pycorrector === false) missingDependencies.push("pycorrector");
    if (runtime && runtime.ok && runtimeDependencies.torch === false) missingDependencies.push("torch");
    const preflightIssues = [];
    if (venvDirCheck.writable === false) {
      preflightIssues.push({
        code: "python_venv_dir_not_writable",
        message: `${formatDirectoryWriteStatus(".venv 目录", venvDirCheck)}：${venvDirCheck.checkPath || venvDirCheck.targetPath}`
      });
    }
    if (pycorrectorDataDirCheck.writable === false) {
      preflightIssues.push({
        code: "python_data_dir_not_writable",
        message: `${formatDirectoryWriteStatus("模型目录", pycorrectorDataDirCheck)}：${pycorrectorDataDirCheck.checkPath || pycorrectorDataDirCheck.targetPath}`
      });
    }
    if (runtime && runtime.ok && missingDependencies.length) {
      preflightIssues.push({
        code: "python_dependencies_missing",
        message: `运行时缺少依赖：${missingDependencies.join("、")}`
      });
    }

    let state = PYTHON_SETUP_STATES.CONFIGURED_UNVERIFIED;
    let detail = "请先执行“引擎自检”确认 Python 链路。";
    let nextAction = "运行引擎自检";
    let blockReason = "";

    if (executable.exists === false) {
      state = PYTHON_SETUP_STATES.UNCONFIGURED;
      detail = "未检测到 Python 可执行文件。";
      nextAction = "确认 .venv 目录并应用到 Python 路径";
      blockReason = "python_not_found";
    } else if (!scriptExists) {
      state = PYTHON_SETUP_STATES.ERROR;
      detail = "未检测到 Python 服务脚本。";
      nextAction = "修复 python_engine_service.py 路径";
      blockReason = "python_script_missing";
    } else if (!modelExists) {
      state = PYTHON_SETUP_STATES.UNCONFIGURED;
      detail = "未检测到 pycorrector 模型文件。";
      nextAction = "确认模型目录并放置 .klm 文件";
      blockReason = "pycorrector_model_missing";
    } else if (runtimeSupported === false) {
      state = PYTHON_SETUP_STATES.ERROR;
      detail = `当前 Python 版本为 ${runtimeVersion || "unknown"}，仅支持 ${SUPPORTED_PYTHON_LABEL}。`;
      nextAction = "切换到 Python 3.11 并重新自检";
      blockReason = "python_version_unsupported";
    } else if (missingDependencies.length) {
      state = PYTHON_SETUP_STATES.CONFIGURED_UNVERIFIED;
      detail = `当前 Python 可运行，但缺少 ${missingDependencies.join("、")} 依赖。`;
      nextAction = "执行安装命令补齐依赖后重新自检";
    } else if (this.hasCurrentPythonVerification(runtimeVersion)) {
      state = PYTHON_SETUP_STATES.READY;
      detail = `已通过自检${runtimeVersion ? `，当前版本 ${runtimeVersion}` : ""}。`;
      nextAction = "可直接手动执行“开始纠错”";
    } else {
      state = PYTHON_SETUP_STATES.CONFIGURED_UNVERIFIED;
      detail = runtimeVersion
        ? `当前 Python 版本为 ${runtimeVersion}，但尚未通过自检。`
        : "环境已配置，但尚未完成自检。";
      nextAction = "执行引擎自检";
    }

    return {
      state,
      stateLabel: PYTHON_SETUP_STATE_LABELS[state] || state,
      detail,
      nextAction,
      blockReason,
      preflightIssues,
      preflightSummary: preflightIssues.map((item) => item.message).join("；"),
      executable,
      scriptPath,
      scriptExists,
      modelPath,
      modelExists,
      venvDirCheck,
      pycorrectorDataDirCheck,
      runtimeVersion,
      runtimeSupported,
      runtimeDependencies
    };
  }

  canAutoStartPython() {
    if (!this.settings.pythonEngineEnabled) return false;
    if (!this.settings.pythonAutoStart) return false;
    return this.getPythonSetupSnapshot().state === PYTHON_SETUP_STATES.READY;
  }

  getPythonUnavailableReason(runtimeReport = null) {
    const snapshot = this.getPythonSetupSnapshot(runtimeReport);
    if (snapshot.blockReason) return snapshot.blockReason;
    if (snapshot.state === PYTHON_SETUP_STATES.CONFIGURED_UNVERIFIED) return "python_not_verified";
    return "python_not_started";
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

  touchJsCedictActivity() {
    this.jsCedictLastUsedAt = Date.now();
  }

  touchPythonActivity() {
    this.pythonLastUsedAt = Date.now();
  }

  hasActiveDetectionWork() {
    for (const entry of this.fileDetectionQueue.values()) {
      if (entry && (entry.running || entry.pending)) return true;
    }
    return false;
  }

  resetPythonStartupGateState() {
    this.pythonStartupGateDone = false;
    this.pythonStartupGateLastAttemptAt = 0;
    this.pythonStartupGatePromise = null;
    this.pythonStartupGatePromiseStartedAt = 0;
    this.pythonStartupGatePromiseToken += 1;
    this.pythonStartupGateAttemptCount = 0;
    this.pythonStartupGateFallbackReason = "";
  }

  releaseJsCedictRuntime(reason = "idle_release") {
    const runtime = this.getJsCedictRuntime();
    if (!runtime.ready && !runtime.words.size && !runtime.frequentWords.size && !runtime.charConfusions.size) {
      return;
    }
    this.jsCedictRuntime = {
      enabled: Boolean(this.settings.jsCedictEnhanced),
      ready: false,
      loadedFrom: "",
      indexPath: this.getEffectiveCedictIndexPath(),
      sourcePath: this.getEffectiveCedictSourcePath(),
      version: runtime.version || "",
      words: new Set(),
      frequentWords: new Set(),
      charConfusions: new Map(),
      error: reason
    };
  }

  async ensureJsCedictReady(options = {}) {
    const runtime = this.getJsCedictRuntime();
    if (!this.settings.jsCedictEnhanced) return runtime;
    if (runtime.ready) {
      this.touchJsCedictActivity();
      return runtime;
    }
    if (this.jsCedictLoadPromise) return this.jsCedictLoadPromise;
    this.jsCedictLoadPromise = this.reloadJsCedictIndex({
      showNotice: options.showNotice === true
    }).finally(() => {
      this.jsCedictLoadPromise = null;
    });
    return this.jsCedictLoadPromise;
  }

  async reclaimIdleMemory() {
    if (this.hasActiveDetectionWork()) return;
    const now = Date.now();
    const cedictIdleMs = now - (this.jsCedictLastUsedAt || 0);
    if (
      this.settings.jsCedictEnhanced &&
      this.jsCedictRuntime &&
      this.jsCedictRuntime.ready &&
      this.jsCedictLastUsedAt > 0 &&
      cedictIdleMs >= CEDICT_IDLE_RELEASE_MS
    ) {
      this.releaseJsCedictRuntime("idle_released");
    }
    const pythonEngine = this.engineManager && this.engineManager.pythonEngine ? this.engineManager.pythonEngine : null;
    const pythonIdleMs = now - (this.pythonLastUsedAt || 0);
    if (
      pythonEngine &&
      pythonEngine.process &&
      !pythonEngine.startPromise &&
      !this.pythonStartupGatePromise &&
      this.pythonLastUsedAt > 0 &&
      pythonIdleMs >= PYTHON_IDLE_SHUTDOWN_MS
    ) {
      this.engineManager.stopPythonEngine();
      this.resetPythonStartupGateState();
    }
  }

  getProtectedTermsSet() {
    const merged = new Set(BUILTIN_DOMAIN_PROTECTED_TOKENS);
    if (this.engineManager && this.engineManager.jsEngine && Array.isArray(this.engineManager.jsEngine.domainProtectedTerms)) {
      for (const term of this.engineManager.jsEngine.domainProtectedTerms) {
        const normalized = String(term || "").trim();
        if (normalized) merged.add(normalized);
      }
    }
    for (const term of this.settings.userDictionary || []) {
      const normalized = String(term || "").trim();
      if (normalized) merged.add(normalized);
    }
    return merged;
  }

  getIdiomTermsSet() {
    if (this.engineManager && this.engineManager.jsEngine && this.engineManager.jsEngine.idiomTerms instanceof Set) {
      return this.engineManager.jsEngine.idiomTerms;
    }
    return new Set();
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
      this.touchJsCedictActivity();
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
    this.resetPythonVerificationFields();
    if (this.engineManager && this.engineManager.pythonEngine) {
      this.engineManager.pythonEngine.invalidateRuntimeInspection();
    }
    await this.saveSettings();
    if (showNotice) {
      const summary = syncExecutable
        ? `已更新 .venv 目录并同步 Python 路径：${this.settings.pythonExecutable}`
        : `已更新 .venv 目录：${normalizedVenvDir}`;
      new Notice(summary, 6000);
    }
  }

  async updatePycorrectorDataDir(nextDataDir, options = {}) {
    const showNotice = options.showNotice === true;
    const recommended = this.getRecommendedPycorrectorDataDir();
    const normalizedDataDir = normalizeVenvDir(nextDataDir, recommended);
    this.settings.pythonPycorrectorDataDir = normalizedDataDir;
    this.resetPythonVerificationFields();
    if (this.engineManager && this.engineManager.pythonEngine) {
      this.engineManager.pythonEngine.invalidateRuntimeInspection();
    }
    await this.saveSettings();
    if (showNotice) {
      new Notice(`已更新 pycorrector 模型目录：${normalizedDataDir}`, 6000);
    }
    return normalizedDataDir;
  }

  async applyPythonExecutableFromVenvSetting(options = {}) {
    const showNotice = options.showNotice === true;
    const normalizedVenvDir = this.getEffectivePythonVenvDir();
    this.settings.pythonVenvDir = normalizedVenvDir;
    this.settings.pythonExecutable = buildPythonExecutableFromVenvDir(normalizedVenvDir);
    this.resetPythonVerificationFields();
    if (this.engineManager && this.engineManager.pythonEngine) {
      this.engineManager.pythonEngine.invalidateRuntimeInspection();
    }
    await this.saveSettings();
    if (showNotice) {
      new Notice(`已应用 Python 可执行文件：${this.settings.pythonExecutable}`, 6000);
    }
    return this.settings.pythonExecutable;
  }

  async maybeShowPythonSetupHint() {
    if (!isWindowsPlatform()) return;
    if (!this.settings.pythonEngineEnabled) return;
    if (this.settings.pythonSetupHintDismissed) return;
    const snapshot = this.getPythonSetupSnapshot();
    if (snapshot.state === PYTHON_SETUP_STATES.READY) return;
    const installCommand = this.getInstallCommandPreview();
    new Notice(`Python 环境状态：${snapshot.stateLabel}。${snapshot.detail} 下一步：${snapshot.nextAction}。安装命令：${installCommand}`, 10000);
    this.settings.pythonSetupHintDismissed = true;
    await this.saveSettings();
  }

  async loadSettings() {
    const stored = (await this.loadData()) || {};
    const isFreshInstall = !Object.keys(stored).length;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    let changed = false;

    if (!Object.prototype.hasOwnProperty.call(stored, "engineMode")) {
      this.settings.engineMode = isFreshInstall ? ENGINE_MODES.JS : ENGINE_MODES.HYBRID;
      changed = true;
    } else if (!Object.values(ENGINE_MODES).includes(this.settings.engineMode)) {
      this.settings.engineMode = ENGINE_MODES.JS;
      changed = true;
    }

    if (!Object.prototype.hasOwnProperty.call(stored, "pythonEngineEnabled")) {
      this.settings.pythonEngineEnabled = !isFreshInstall;
      changed = true;
    } else if (typeof this.settings.pythonEngineEnabled !== "boolean") {
      this.settings.pythonEngineEnabled = Boolean(this.settings.pythonEngineEnabled);
      changed = true;
    }

    if (!Object.prototype.hasOwnProperty.call(stored, "pythonAutoStart")) {
      this.settings.pythonAutoStart = !isFreshInstall;
      changed = true;
    } else if (typeof this.settings.pythonAutoStart !== "boolean") {
      this.settings.pythonAutoStart = Boolean(this.settings.pythonAutoStart);
      changed = true;
    }

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

    const hasStoredPycorrectorDataDir = Object.prototype.hasOwnProperty.call(stored, "pythonPycorrectorDataDir");
    if (!hasStoredPycorrectorDataDir || !String(this.settings.pythonPycorrectorDataDir || "").trim()) {
      this.settings.pythonPycorrectorDataDir = this.getRecommendedPycorrectorDataDir();
      changed = true;
    } else {
      const normalized = normalizeVenvDir(
        this.settings.pythonPycorrectorDataDir,
        this.getRecommendedPycorrectorDataDir()
      );
      if (normalized !== this.settings.pythonPycorrectorDataDir) {
        this.settings.pythonPycorrectorDataDir = normalized;
        changed = true;
      }
    }

    if (!Object.prototype.hasOwnProperty.call(stored, "pythonSetupHintDismissed")) {
      this.settings.pythonSetupHintDismissed = isFreshInstall;
      changed = true;
    }
    if (typeof this.settings.pythonLastSelfCheckOk !== "boolean") {
      this.settings.pythonLastSelfCheckOk = false;
      changed = true;
    }
    if (!Number.isFinite(Number(this.settings.pythonLastSelfCheckAt))) {
      this.settings.pythonLastSelfCheckAt = 0;
      changed = true;
    } else {
      this.settings.pythonLastSelfCheckAt = Math.max(0, Number(this.settings.pythonLastSelfCheckAt) || 0);
    }
    for (const key of [
      "pythonLastSelfCheckExecutable",
      "pythonLastSelfCheckVersion",
      "pythonLastSelfCheckDataDir",
      "pythonLastSelfCheckLmPath"
    ]) {
      if (typeof this.settings[key] !== "string") {
        this.settings[key] = "";
        changed = true;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(stored, "pythonManualTriggerOnly")) {
      this.settings.pythonManualTriggerOnly = true;
      changed = true;
    } else if (typeof this.settings.pythonManualTriggerOnly !== "boolean") {
      this.settings.pythonManualTriggerOnly = Boolean(this.settings.pythonManualTriggerOnly);
      changed = true;
    }
    if (this.settings.pythonManualTriggerOnly !== true) {
      this.settings.pythonManualTriggerOnly = true;
      changed = true;
    }
    if (this.settings.liveCheck !== false) {
      this.settings.liveCheck = false;
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
    const setupSnapshot = this.getPythonSetupSnapshot();
    const cedictRuntime = this.getJsCedictRuntime();
    const jsEngine = this.engineManager && this.engineManager.jsEngine ? this.engineManager.jsEngine : null;
    const sharedRuleCount = jsEngine && Array.isArray(jsEngine.sharedPhraseRules) ? jsEngine.sharedPhraseRules.length : 0;
    const variantRuleCount = jsEngine && Array.isArray(jsEngine.variantFormRules) ? jsEngine.variantFormRules.length : 0;
    const panelItemCount = this.latestPanelPayload && Array.isArray(this.latestPanelPayload.items)
      ? this.latestPanelPayload.items.length
      : 0;
    const vaultScanItemCount = this.latestPanelPayload && this.latestPanelPayload.source === "vault" && Array.isArray(this.latestPanelPayload.items)
      ? this.latestPanelPayload.items.length
      : 0;
    const lines = [
      `mode=${this.settings.engineMode}`,
      `pythonEngineEnabled=${this.settings.pythonEngineEnabled}`,
      `pythonAutoStart=${this.settings.pythonAutoStart}`,
      `pythonManualTriggerOnly=${this.settings.pythonManualTriggerOnly}`,
      `jsCedictEnhanced=${this.settings.jsCedictEnhanced}`,
      `jsCedictReady=${cedictRuntime.ready}`,
      `jsCedictLoadedFrom=${cedictRuntime.loadedFrom || ""}`,
      `jsCedictWordCount=${cedictRuntime.words ? cedictRuntime.words.size : 0}`,
      `jsCedictConfusionCount=${cedictRuntime.charConfusions ? cedictRuntime.charConfusions.size : 0}`,
      `jsCedictError=${cedictRuntime.error || ""}`,
      `jsCedictIndexPath=${cedictRuntime.indexPath || ""}`,
      `jsSharedTypoRuleCount=${sharedRuleCount}`,
      `jsVariantFormRuleCount=${variantRuleCount}`,
      `frontCacheSize=${this.frontDetectionCache ? this.frontDetectionCache.size : 0}`,
      `panelItemCount=${panelItemCount}`,
      `vaultScanItemCount=${vaultScanItemCount}`,
      `pythonExecutableConfigured=${executable.configured}`,
      `pythonExecutableResolved=${executable.resolved}`,
      `pythonExecutableExists=${executable.exists === null ? "unknown" : String(executable.exists)}`,
      `pythonPycorrectorDataDir=${this.getEffectivePycorrectorDataDir()}`,
      `pythonPycorrectorLmPathConfigured=${this.getEffectivePycorrectorLmPath()}`,
      `pythonSetupState=${setupSnapshot.state}`,
      `pythonSetupStateLabel=${setupSnapshot.stateLabel}`,
      `pythonSetupDetail=${setupSnapshot.detail}`,
      `pythonSetupNextAction=${setupSnapshot.nextAction}`,
      `pythonSetupPreflight=${setupSnapshot.preflightSummary || ""}`,
      `pythonVenvWriteCheck=${formatDirectoryWriteStatus(".venv 目录", setupSnapshot.venvDirCheck)}`,
      `pythonDataDirWriteCheck=${formatDirectoryWriteStatus("模型目录", setupSnapshot.pycorrectorDataDirCheck)}`,
      `pythonRuntimeVersion=${pythonEngine.runtimeVersion || this.settings.pythonLastSelfCheckVersion || ""}`,
      `pythonRuntimeSupported=${pythonEngine.runtimeVersionSupported === null ? "" : String(pythonEngine.runtimeVersionSupported)}`,
      `pythonRuntimePycorrector=${setupSnapshot.runtimeDependencies.pycorrector === null ? "" : String(setupSnapshot.runtimeDependencies.pycorrector)}`,
      `pythonRuntimeTorch=${setupSnapshot.runtimeDependencies.torch === null ? "" : String(setupSnapshot.runtimeDependencies.torch)}`,
      `pythonScriptPath=${scriptPath}`,
      `pythonScriptExists=${String(fs.existsSync(scriptPath))}`,
      `engineStatus=${pythonEngine.engineStatus || ""}`,
      `pycorrectorAvailable=${String(pythonEngine.pycorrectorAvailable)}`,
      `pycorrectorImpl=${pythonEngine.pycorrectorImpl || ""}`,
      `pycorrectorLmPath=${pythonEngine.pycorrectorLmPath || ""}`,
      `pycorrectorError=${pythonEngine.pycorrectorError || ""}`,
      `pythonFallbackRuleCount=${pythonEngine.fallbackRuleCount || 0}`,
      `pythonCheckCacheSize=${pythonEngine.checkCacheSize || 0}`,
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
    const runtime = await this.engineManager.pythonEngine.inspectRuntime({ force: true }).catch(() => null);
    const snapshot = this.getPythonSetupSnapshot(runtime);
    if (!snapshot.blockReason) return false;

    this.engineManager.pythonEngine.lastError = snapshot.blockReason;
    this.engineManager.pythonEngine.engineStatus = "unavailable";
    this.engineManager.pythonEngine.pycorrectorAvailable = false;
    const installCommand = this.getInstallCommandPreview();
    const requestId = this.nextDetectionRequestId("preflight");
    const raw = this.collectPythonDiagnosticsSnapshot(
      [
        `setup_state=${snapshot.state}`,
        `setup_detail=${snapshot.detail}`,
        `setup_next_action=${snapshot.nextAction}`,
        `preflight_reason=${snapshot.blockReason}`
      ].join("\n")
    );
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
        fallbackReason: `python_unavailable:${snapshot.blockReason}`,
        extraText: `Python 环境预校验未通过：${snapshot.stateLabel}。${snapshot.detail}${snapshot.preflightSummary ? ` 预校验：${snapshot.preflightSummary}。` : " "}下一步：${snapshot.nextAction}。安装命令：${installCommand}`,
        extraCopyText: raw,
        rawText: toPrettyJson({
          request_id: requestId,
          trigger: "preflight",
          engine_source: "js",
          fallback_reason: `python_unavailable:${snapshot.blockReason}`,
          stage_durations: stageSnapshot,
          diagnostics: raw
        })
      }
    });
    new Notice(`Python 环境预校验未通过：${snapshot.stateLabel}。${snapshot.detail}`, 9000);
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
      if (report.ok) {
        await this.markPythonVerification(report);
      } else {
        await this.invalidatePythonVerification();
      }
      const summary = report.ok
        ? `自检通过（exit=${report.exitCode}，${report.executable}）`
        : `自检失败（exit=${report.exitCode}，${report.executable}）`;
      const raw = this.collectPythonDiagnosticsSnapshot(
        [
          `self_check_script=${report.scriptPath}`,
          `self_check_executable=${report.executable}`,
          `self_check_signal=${report.signal || ""}`,
          `self_check_exit_code=${report.exitCode}`,
          `self_check_version=${report.versionText || ""}`,
          `self_check_supported=${typeof report.supported === "boolean" ? String(report.supported) : ""}`,
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
      new Notice(report.ok ? "✅ Python 引擎自检通过" : "❌ Python 引擎自检失败，请查看结果面板", 7000);
    } catch (error) {
      await this.invalidatePythonVerification();
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

  bumpDetectionVersion(filePath, textHash = "") {
    const current = this.fileDetectionVersion.get(filePath) || 0;
    const next = current + 1;
    this.fileDetectionVersion.set(filePath, next);
    this.fileDetectionSnapshot.set(filePath, {
      version: next,
      textHash: String(textHash || "").trim()
    });
    this.trimTrackedStateMaps();
    return next;
  }

  isLatestDetectionVersion(filePath, version, textHash = "") {
    const currentVersion = this.fileDetectionVersion.get(filePath) || 0;
    if (currentVersion !== version) return false;
    const snapshot = this.fileDetectionSnapshot.get(filePath);
    if (!snapshot) return !textHash;
    if (!textHash) return snapshot.version === version;
    return snapshot.version === version && snapshot.textHash === String(textHash || "").trim();
  }

  buildFrontDetectionCacheKey(context = {}) {
    const rangesKey = JSON.stringify(context.ranges || []);
    return [
      context.filePath || "",
      context.textHash || "",
      context.engineMode || "",
      context.allowPython ? "python" : "js",
      String(context.maxSuggestions || 0),
      context.jsRuleVersion || "",
      hashText(rangesKey)
    ].join("|");
  }

  getFrontDetectionCache(cacheKey) {
    if (!cacheKey) return null;
    const cached = this.frontDetectionCache.get(cacheKey) || null;
    if (!cached) return null;
    this.frontDetectionCache.delete(cacheKey);
    this.frontDetectionCache.set(cacheKey, cached);
    return cached;
  }

  clearFrontDetectionCache() {
    if (this.frontDetectionCache) {
      this.frontDetectionCache.clear();
    }
  }

  setFrontDetectionCache(cacheKey, value, meta = {}) {
    if (!cacheKey || !value) return;
    const textLength = Number(meta.textLength || 0);
    const matchCount = Array.isArray(value.matches) ? value.matches.length : 0;
    if (textLength > MAX_FRONT_DETECTION_CACHE_TEXT_LENGTH) return;
    if (matchCount > MAX_FRONT_DETECTION_CACHE_MATCHES) return;
    this.frontDetectionCache.set(cacheKey, value);
    while (this.frontDetectionCache.size > MAX_FRONT_DETECTION_CACHE_ITEMS) {
      const oldestKey = this.frontDetectionCache.keys().next().value;
      if (!oldestKey) break;
      this.frontDetectionCache.delete(oldestKey);
    }
  }

  async enqueueFileDetection(filePath, requestFactory, textHash = "") {
    let entry = this.fileDetectionQueue.get(filePath);
    if (!entry) {
      entry = { running: false, runningTextHash: "", pending: null, pendingTextHash: "" };
      this.fileDetectionQueue.set(filePath, entry);
    }
    const normalizedHash = String(textHash || "").trim();
    if (normalizedHash) {
      if (entry.pending && entry.pendingTextHash === normalizedHash) return;
      if (entry.running && !entry.pending && entry.runningTextHash === normalizedHash) return;
    }
    entry.pending = requestFactory;
    entry.pendingTextHash = normalizedHash;
    if (entry.running) return;

    entry.running = true;
    try {
      while (entry.pending) {
        const factory = entry.pending;
        entry.runningTextHash = entry.pendingTextHash || "";
        entry.pending = null;
        entry.pendingTextHash = "";
        await factory();
        entry.runningTextHash = "";
      }
    } finally {
      entry.running = false;
      entry.runningTextHash = "";
      if (!entry.pending) this.fileDetectionQueue.delete(filePath);
      this.trimTrackedStateMaps();
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
    return normalized === "manual" || (this.isPythonReplayDetectionTrigger(normalized) && this.hasManualDetectionWindow());
  }

  isPythonReplayDetectionTrigger(source = "") {
    const normalized = String(source || "").trim();
    return normalized === "python-ready" || normalized === "python-gate-finalize";
  }

  hasManualDetectionWindow() {
    return Math.max(0, (this.manualDetectionWindowUntil || 0) - Date.now()) > 0;
  }

  isAutoDetectionEnabled() {
    return false;
  }

  trimTrackedStateMaps() {
    while (this.fileDetectionVersion.size > MAX_TRACKED_FILE_STATES) {
      const oldestKey = this.fileDetectionVersion.keys().next().value;
      if (!oldestKey) break;
      this.fileDetectionVersion.delete(oldestKey);
      this.fileDetectionSnapshot.delete(oldestKey);
      this.fileDetectionQueue.delete(oldestKey);
    }
    while (this.frontDetectionCache.size > MAX_FRONT_DETECTION_CACHE_ITEMS) {
      const oldestKey = this.frontDetectionCache.keys().next().value;
      if (!oldestKey) break;
      this.frontDetectionCache.delete(oldestKey);
    }
  }

  trimSessionIgnores() {
    while (this.sessionIgnored.size > MAX_SESSION_IGNORES) {
      const oldestKey = this.sessionIgnored.values().next().value;
      if (!oldestKey) break;
      this.sessionIgnored.delete(oldestKey);
    }
  }

  shouldUsePythonForTrigger(source = "manual") {
    return this.isManualDetectionTrigger(source);
  }

  findMarkdownViewByFilePath(filePath = "") {
    if (!filePath) return null;
    const preferred = this.getPreferredMarkdownView();
    if (preferred && preferred.file && preferred.file.path === filePath) return preferred;
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active && active.file && active.file.path === filePath) return active;
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (leaf.view instanceof MarkdownView && leaf.view.file && leaf.view.file.path === filePath) {
        return leaf.view;
      }
    }
    return null;
  }

  async resolveDetectionSnapshot(file, options = {}) {
    const explicitEditorView = options.editorView || null;
    const preferredText = typeof options.preferredText === "string" ? options.preferredText : null;
    if (preferredText !== null) {
      return {
        text: preferredText,
        textHash: hashText(preferredText),
        editorView: explicitEditorView,
        fromEditor: true,
        readMs: 0
      };
    }

    let resolvedEditorView = explicitEditorView;
    let markdownView = options.markdownView || null;
    if (!markdownView || !markdownView.file || markdownView.file.path !== file.path) {
      markdownView = this.findMarkdownViewByFilePath(file.path);
    }
    if (!resolvedEditorView && markdownView) {
      resolvedEditorView = resolveEditorView(markdownView);
    }
    if (resolvedEditorView && resolvedEditorView.state && resolvedEditorView.state.doc) {
      const text = resolvedEditorView.state.doc.toString();
      return {
        text,
        textHash: hashText(text),
        editorView: resolvedEditorView,
        fromEditor: true,
        readMs: 0
      };
    }
    if (markdownView && markdownView.editor && typeof markdownView.editor.getValue === "function") {
      const text = markdownView.editor.getValue();
      return {
        text,
        textHash: hashText(text),
        editorView: resolvedEditorView,
        fromEditor: true,
        readMs: 0
      };
    }

    const readStartedAt = Date.now();
    const text = await this.app.vault.cachedRead(file);
    return {
      text,
      textHash: hashText(text),
      editorView: resolvedEditorView,
      fromEditor: false,
      readMs: Date.now() - readStartedAt
    };
  }

  async triggerDetectionForActiveFile(reason = "manual") {
    if (!this.isManualDetectionTrigger(reason)) return false;
    const view = this.getPreferredMarkdownView();
    if (!view || !view.file) return false;
    this.lastMarkdownView = view;
    await this.runDetectionForView(view, resolveEditorView(view), reason);
    return true;
  }

  async triggerDetectionForActiveFileWithRetry(reason = "manual", retries = 3, intervalMs = 120) {
    if (String(reason || "manual").trim() === "manual") {
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
  }

  async onPythonEngineReady() {
    this.pythonStartupGateDone = true;
    this.pythonStartupGatePromise = null;
    this.pythonStartupGatePromiseStartedAt = 0;
    this.pythonStartupGatePromiseToken += 1;
    this.pythonStartupGateFallbackReason = "";
    if (this.pythonReadyReplayPending || !this.hasManualDetectionWindow()) return;
    this.pythonReadyReplayPending = true;
    this.triggerDetectionForActiveFileWithRetry("python-ready", 1, 80)
      .catch(() => {})
      .finally(() => {
        this.pythonReadyReplayPending = false;
      });
  }

  getPanelSummary(payload) {
    if (!payload || !Array.isArray(payload.items)) return "";
    const totalItemCount = Number(payload.totalItemCount || payload.items.length || 0);
    if (payload.source === "diagnostic") {
      return "引擎诊断";
    }
    if (payload.source === "vault") {
      return payload.itemsTruncated ? `全库扫描：${totalItemCount} 条（仅展示前 ${payload.items.length} 条）` : `全库扫描：${totalItemCount} 条`;
    }
    if (payload.source === "file") {
      const grouped = splitPanelItemsByConfidence(payload.items, this.settings.confidenceThreshold);
      const highCount = grouped[RESULT_CONFIDENCE_GROUPS.HIGH].length;
      const reviewCount = grouped[RESULT_CONFIDENCE_GROUPS.REVIEW].length;
      return payload.itemsTruncated
        ? `共 ${totalItemCount} 条，仅展示前 ${payload.items.length} 条；当前高置信 ${highCount} 条，需复核 ${reviewCount} 条`
        : `共 ${totalItemCount} 条，高置信 ${highCount} 条，需复核 ${reviewCount} 条`;
    }
    return "";
  }

  getResultSortModeLabel(mode = this.resultSortMode) {
    return getResultSortLabel(mode);
  }

  sortPanelItems(items, mode = this.resultSortMode) {
    const normalizedMode = RESULT_SORT_LABELS[mode] ? mode : RESULT_SORT_MODES.CONFIDENCE_DESC;
    const sorted = [...(Array.isArray(items) ? items : [])];
    if (normalizedMode === RESULT_SORT_MODES.LINE_DESC) {
      sorted.sort((left, right) =>
        (right.line || 0) - (left.line || 0) ||
        (right.from || 0) - (left.from || 0) ||
        (right.sortScore || 0) - (left.sortScore || 0)
      );
      return sorted;
    }
    sorted.sort((left, right) =>
      (right.sortScore || 0) - (left.sortScore || 0) ||
      (left.line || 0) - (right.line || 0) ||
      (left.from || 0) - (right.from || 0)
    );
    return sorted;
  }

  getSortedPanelItems(payload = this.latestPanelPayload, mode = this.resultSortMode) {
    if (!payload || !Array.isArray(payload.items)) return [];
    return this.sortPanelItems(payload.items, mode);
  }

  syncCurrentPanelResultState(payload = this.latestPanelPayload, preferredKey = this.currentPanelResultKey) {
    const items = this.getSortedPanelItems(payload);
    if (!items.length) {
      this.currentPanelResultKey = "";
      this.currentPanelResultIndex = -1;
      return;
    }
    let nextIndex = preferredKey ? items.findIndex((item) => getResultItemKey(item) === preferredKey) : -1;
    if (nextIndex < 0) nextIndex = 0;
    this.currentPanelResultIndex = nextIndex;
    this.currentPanelResultKey = getResultItemKey(items[nextIndex]);
  }

  async refreshResultPanelView() {
    const leaves = this.app.workspace.getLeavesOfType(RESULT_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof CscResultPanelView) {
        view.setPayload(this.latestPanelPayload);
      }
    }
  }

  async setResultSortMode(mode) {
    const normalizedMode = RESULT_SORT_LABELS[mode] ? mode : RESULT_SORT_MODES.CONFIDENCE_DESC;
    if (this.resultSortMode === normalizedMode) return;
    const previousKey = this.currentPanelResultKey;
    this.resultSortMode = normalizedMode;
    this.syncCurrentPanelResultState(this.latestPanelPayload, previousKey);
    await this.refreshResultPanelView();
  }

  decorateResultSortMenuDom() {
    window.requestAnimationFrame(() => {
      const menus = document.querySelectorAll(".menu");
      const menuEl = menus.length ? menus[menus.length - 1] : null;
      if (!(menuEl instanceof HTMLElement)) return;
      menuEl.addClass("csc-result-sort-menu");
      const menuItems = menuEl.querySelectorAll(".menu-item");
      for (const menuItem of menuItems) {
        if (!(menuItem instanceof HTMLElement)) continue;
        menuItem.removeClass("csc-is-selected");
        const titleEl = menuItem.querySelector(".menu-item-title");
        const title = titleEl ? String(titleEl.textContent || "").trim() : "";
        if (title === getResultSortLabel(this.resultSortMode)) {
          menuItem.addClass("csc-is-selected");
        }
      }
    });
  }

  openResultSortMenu(event, anchorEl = null) {
    const menu = new Menu();
    const modes = [RESULT_SORT_MODES.CONFIDENCE_DESC, RESULT_SORT_MODES.LINE_DESC];
    for (const mode of modes) {
      menu.addItem((item) => {
        item.setTitle(getResultSortLabel(mode));
        item.onClick(() => {
          this.setResultSortMode(mode).catch(() => {});
        });
      });
    }
    if (event && typeof menu.showAtMouseEvent === "function") {
      menu.showAtMouseEvent(event);
      this.decorateResultSortMenuDom();
      return;
    }
    if (anchorEl && typeof anchorEl.getBoundingClientRect === "function" && typeof menu.showAtPosition === "function") {
      const rect = anchorEl.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
      this.decorateResultSortMenuDom();
    }
  }

  setCurrentPanelResult(item, payload = this.latestPanelPayload) {
    const items = this.getSortedPanelItems(payload);
    const nextKey = getResultItemKey(item);
    const nextIndex = items.findIndex((candidate) => getResultItemKey(candidate) === nextKey);
    if (nextIndex < 0) return false;
    this.currentPanelResultKey = nextKey;
    this.currentPanelResultIndex = nextIndex;
    return true;
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

  canApplyDetectionSnapshot(editorView, filePath, textHash = "") {
    if (!editorView || !editorView.state || !editorView.state.doc) return false;
    const markdownView = getMarkdownViewFromState(editorView.state);
    if (!markdownView || !markdownView.file || markdownView.file.path !== filePath) return false;
    if (!textHash) return true;
    return hashText(editorView.state.doc.toString()) === textHash;
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
      const excerpt = truncateText(text.slice(excerptStart, excerptEnd).replace(/\r?\n/g, " "), MAX_PANEL_EXCERPT_LENGTH);
      items.push({
        filePath,
        from: match.from,
        to: match.to,
        token: match.token || text.slice(match.from, match.to),
        suggestion,
        engine: String(match.engine || "").trim() || "unknown",
        confidence: Number(match.confidence || 0),
        ruleId: String(match.ruleId || "").trim(),
        basis: String(match.basis || "").trim(),
        sortScore: computeMatchSortScore(match),
        line,
        excerpt
      });
    }
    return items;
  }

  compactPanelPayload(payload) {
    if (!payload || !Array.isArray(payload.items)) return payload;
    const source = String(payload.source || "");
    const itemLimit = source === "vault" ? MAX_PANEL_VAULT_ITEMS : MAX_PANEL_FILE_ITEMS;
    const totalItemCount = Math.max(0, Number(payload.totalItemCount || payload.items.length || 0));
    const compactItems = payload.items.slice(0, itemLimit).map((item) => ({
      ...item,
      excerpt: truncateText(item && item.excerpt, MAX_PANEL_EXCERPT_LENGTH)
    }));
    const diagnostics = payload.diagnostics
      ? {
          ...payload.diagnostics,
          rawText: truncateText(payload.diagnostics.rawText || "", MAX_DIAGNOSTICS_RAW_TEXT_LENGTH),
          extraText: truncateText(payload.diagnostics.extraText || "", 300)
        }
      : payload.diagnostics;
    return {
      ...payload,
      items: compactItems,
      totalItemCount,
      itemsTruncated: totalItemCount > compactItems.length,
      diagnostics
    };
  }

  async updateResultPanel(payload) {
    const previousKey = this.currentPanelResultKey;
    const compactPayload = this.compactPanelPayload(payload);
    this.latestPanelPayload = {
      ...compactPayload,
      summary: this.getPanelSummary(compactPayload)
    };
    this.syncCurrentPanelResultState(this.latestPanelPayload, previousKey);
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

  async setResultPanelProgress(filePath, progress) {
    const current = this.latestPanelPayload;
    const canReuseCurrent = current && current.source === "file" && current.filePath === filePath;
    const basePayload = canReuseCurrent
      ? current
      : {
          source: "file",
          filePath,
          items: []
        };
    await this.updateResultPanel({
      ...basePayload,
      progress
    });
  }

  async jumpToPanelResult(item, options = {}) {
    if (options.updateSelection !== false) {
      this.setCurrentPanelResult(item);
      await this.refreshResultPanelView();
    }
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

  async navigatePanelResult(step) {
    const items = this.getSortedPanelItems();
    if (!items.length) {
      new Notice("当前没有纠错结果。");
      return false;
    }
    if (!Number.isInteger(this.currentPanelResultIndex) || this.currentPanelResultIndex < 0) {
      this.syncCurrentPanelResultState();
    } else {
      const current = items[this.currentPanelResultIndex];
      if (!current || getResultItemKey(current) !== this.currentPanelResultKey) {
        this.syncCurrentPanelResultState();
      }
    }
    if (this.currentPanelResultIndex < 0) {
      new Notice("当前没有可跳转的纠错结果。");
      return false;
    }
    const nextIndex = this.currentPanelResultIndex + step;
    if (nextIndex < 0) {
      new Notice("已到第一条纠错结果。");
      return false;
    }
    if (nextIndex >= items.length) {
      new Notice("已到最后一条纠错结果。");
      return false;
    }
    await this.jumpToPanelResult(items[nextIndex], { updateSelection: true });
    return true;
  }

  scheduleDetection(editorView, markdownView) {
    if (!this.isAutoDetectionEnabled()) return;
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

  getMatchConfidenceThreshold(match) {
    const globalThreshold = Number(this.settings.confidenceThreshold) || 0.55;
    const pycorrectorThreshold = Number(this.settings.pycorrectorConfidenceThreshold) || 0.925;
    const ruleId = String((match && match.ruleId) || "");
    const shortMessage = String((match && match.shortMessage) || "");
    const ruleThreshold = MATCH_MIN_CONFIDENCE_BY_RULE[ruleId] || 0;
    const sourceThreshold = MATCH_MIN_CONFIDENCE_BY_SOURCE[shortMessage] || 0;
    const engineThreshold = isPycorrectorMatch(match) ? pycorrectorThreshold : 0;
    return Math.max(globalThreshold, engineThreshold, ruleThreshold, sourceThreshold);
  }

  shouldSuppressPycorrectorNoise(match, text, protectedTerms = BUILTIN_DOMAIN_PROTECTED_TOKENS) {
    if (!text || !isPycorrectorMatch(match)) return false;
    const token = String(match.token || "").trim();
    const suggestion = getPrimaryReplacementValue(match).trim();
    const confidence = Number(match.confidence || 0);
    if (!token || !suggestion || token === suggestion) return false;
    if (protectedTerms.has(token) && confidence < 0.995) return true;

    const cedictRuntime = this.getJsCedictRuntime();
    const hasCedict = Boolean(cedictRuntime && cedictRuntime.ready && cedictRuntime.words && cedictRuntime.words.size);
    if (
      hasCedict &&
      /^[\u4e00-\u9fff]{2,6}$/.test(token) &&
      /^[\u4e00-\u9fff]{1,6}$/.test(suggestion) &&
      cedictRuntime.words.has(token) &&
      cedictRuntime.words.has(suggestion) &&
      confidence < 0.97
    ) {
      return true;
    }

    const lineText = getLineTextAroundMatch(text, match);
    if (!lineText) return false;
    if (isLikelyCodeLikeLine(lineText) && confidence < 0.995) return true;
    if (token.length === 1 && getAsciiLikeRatio(lineText) >= 0.2 && confidence < 0.98) return true;
    return false;
  }

  buildSuppressedMatchDiagnostic(match, reason, text = "", extra = {}) {
    return {
      line: this.countLineByOffset(text, match.from),
      from: Number(match.from || 0),
      to: Number(match.to || 0),
      token: String(match.token || ""),
      suggestion: getPrimaryReplacementValue(match),
      rule_id: String((match && match.ruleId) || ""),
      confidence: Number(match.confidence || 0),
      engine: String(match.engine || ""),
      reason: String(reason || ""),
      excerpt: truncateText(getLineTextAroundMatch(text, match), 80),
      ...extra
    };
  }

  filterMatchesDetailed(filePath, matches, text = "") {
    const dictionary = new Set(this.settings.userDictionary || []);
    const protectedTerms = this.getProtectedTermsSet();
    const idiomTerms = this.getIdiomTermsSet();
    const documentProtectedTerms = collectDocumentProtectedTerms(text);
    const allProtectedTerms = new Set([...protectedTerms, ...documentProtectedTerms]);
    const kept = [];
    const suppressed = [];
    const suppressedReasonSummary = {};
    let suppressedCount = 0;
    const addSuppressed = (match, reason, extra = {}) => {
      suppressedCount += 1;
      const key = String(reason || "unknown");
      suppressedReasonSummary[key] = (suppressedReasonSummary[key] || 0) + 1;
      if (suppressed.length >= MAX_FILTER_DIAGNOSTIC_ITEMS) return;
      suppressed.push(this.buildSuppressedMatchDiagnostic(match, key, text, extra));
    };
    for (const match of matches) {
      const confidence = Number(match.confidence || 0);
      const threshold = this.getMatchConfidenceThreshold(match);
      if (confidence < threshold) {
        addSuppressed(match, "confidence_below_threshold", {
          threshold
        });
        continue;
      }
      if (this.shouldSuppressPycorrectorNoise(match, text, allProtectedTerms)) {
        addSuppressed(match, "pycorrector_noise");
        continue;
      }
      if (dictionary.has(match.token)) {
        addSuppressed(match, "user_dictionary");
        continue;
      }
      if (allProtectedTerms.has(String(match.token || "").trim())) {
        addSuppressed(match, "protected_term_token");
        continue;
      }
      if (
        String((match && match.ruleId) || "") === "CEDICT_OOV_RULE" &&
        allProtectedTerms.has(getPrimaryReplacementValue(match).trim())
      ) {
        addSuppressed(match, "protected_term_suggestion");
        continue;
      }
      if (shouldSuppressReplacementByKnownIdiom(match, text, idiomTerms)) {
        addSuppressed(match, "idiom_context");
        continue;
      }
      if (shouldSuppressReplacementByProtectedPhrase(match, text, allProtectedTerms)) {
        addSuppressed(match, "protected_phrase_context");
        continue;
      }
      if (shouldSuppressLiteraryContextReplacement(match, text)) {
        addSuppressed(match, "literary_context");
        continue;
      }
      const ignoreKey = this.buildIgnoreKey(filePath, match);
      if (this.sessionIgnored.has(ignoreKey)) {
        addSuppressed(match, "session_ignored", {
          ignore_key: ignoreKey
        });
        continue;
      }
      kept.push(match);
    }
    const overlapResult = suppressLowValueOverlapsDetailed(kept);
    for (const item of overlapResult.suppressed) {
      addSuppressed(item.match, item.reason, {
        preferred_rule_id: String((item.preferred && item.preferred.ruleId) || ""),
        preferred_token: String((item.preferred && item.preferred.token) || ""),
        preferred_suggestion: getPrimaryReplacementValue(item.preferred)
      });
    }
    return {
      filtered: overlapResult.filtered,
      suppressed,
      suppressedCount,
      suppressedReasonSummary
    };
  }

  filterMatches(filePath, matches, text = "") {
    return this.filterMatchesDetailed(filePath, matches, text).filtered;
  }

  buildIgnoreKey(filePath, match) {
    return `${filePath || "unknown"}::${makeMatchKey(match)}::${match.token || ""}`;
  }

  async runDetectionForFile(file, options = {}) {
    if (!(file instanceof TFile)) return;
    const source = options.source || "manual";
    const isManualTrigger = this.isManualDetectionTrigger(source);
    if (!isManualTrigger && source !== "vault") return;
    const manualWindowRemainingMs = Math.max(0, (this.manualDetectionWindowUntil || 0) - Date.now());
    if (
      !isManualTrigger &&
      this.settings.pythonManualTriggerOnly &&
      source !== "vault" &&
      manualWindowRemainingMs > 0
    ) {
      return;
    }
    const snapshot = await this.resolveDetectionSnapshot(file, options);
    const editorView = snapshot.editorView || options.editorView || null;
    const showNotice = Boolean(options.showNotice);
    const version = this.bumpDetectionVersion(file.path, snapshot.textHash);

    await this.enqueueFileDetection(file.path, async () => {
      const startedAt = Date.now();
      const timestamp = new Date().toLocaleTimeString();
      const requestId = this.nextDetectionRequestId(source);
      const stageDurations = {
        readMs: snapshot.readMs,
        gateMs: 0,
        detectMs: 0,
        filterMs: 0
      };
      const shouldTrackProgress = isManualTrigger && source !== "vault";
      let detectHeartbeat = null;
      const pushProgress = (stage, percent) => {
        if (!shouldTrackProgress) return;
        if (!isStillLatest()) return;
        this.setResultPanelProgress(file.path, {
          active: true,
          requestId,
          source,
          stage: String(stage || ""),
          percent: clampProgressPercent(percent),
          startedAt
        }).catch(() => {});
      };
      const stopDetectHeartbeat = () => {
        if (!detectHeartbeat) return;
        clearInterval(detectHeartbeat);
        detectHeartbeat = null;
      };
      const isStillLatest = () => this.isLatestDetectionVersion(file.path, version, snapshot.textHash);

      if (shouldTrackProgress) {
        if (!isStillLatest()) return;
        await this.setResultPanelProgress(file.path, {
          active: true,
          requestId,
          source,
          stage: "准备纠错",
          percent: 5,
          startedAt
        });
      }

      try {
        pushProgress("读取内容", 15);

        const text = snapshot.text;
        const textHash = snapshot.textHash;
        const useEditorText = Boolean(snapshot.fromEditor && editorView);
        pushProgress("解析可检测区域", 28);

        if (this.fileSkipByFrontmatter(file, text)) {
          if (editorView && this.canApplyDetectionSnapshot(editorView, file.path, textHash)) {
            this.clearHighlights(editorView);
          }
          if (!isStillLatest()) return;
          const skipStageSnapshot = buildStageDurations(stageDurations, Date.now() - startedAt);
          await this.updateResultPanel({
            source: "file",
            filePath: file.path,
            items: [],
            textHash,
            diagnostics: {
              trigger: source,
              engine: "skip",
              durationMs: Date.now() - startedAt,
              timestamp,
              requestId,
              engineSource: "skip",
              stageDurations: skipStageSnapshot,
              fallbackReason: "",
              rawText: toPrettyJson({
                request_id: requestId,
                file_path: file.path,
                text_hash: textHash,
                trigger: source,
                engine_source: "skip",
                stage_durations: skipStageSnapshot
              })
            }
          });
          if (showNotice) new Notice("当前文件已配置跳过检测。");
          return;
        }

        const allowPythonForTrigger = this.shouldUsePythonForTrigger(source);
        const ranges = extractDetectableRanges(text);
        const jsRuleVersion =
          this.engineManager &&
          this.engineManager.jsEngine &&
          typeof this.engineManager.jsEngine.getRuleCacheVersion === "function"
            ? this.engineManager.jsEngine.getRuleCacheVersion()
            : "";
        let gateResult = { state: "skipped", waitedMs: 0, attempts: this.pythonStartupGateAttemptCount || 0, fallbackReason: "" };
        const frontCacheKey = this.buildFrontDetectionCacheKey({
          filePath: file.path,
          textHash,
          ranges,
          engineMode: this.settings.engineMode,
          allowPython: allowPythonForTrigger,
          maxSuggestions: this.settings.maxSuggestions,
          jsRuleVersion
        });
        const allowFrontCache = !isManualTrigger;
        if (!allowFrontCache) {
          this.frontDetectionCache.delete(frontCacheKey);
        }
        let detectResult = allowFrontCache ? this.getFrontDetectionCache(frontCacheKey) : null;
        const frontCacheHit = Boolean(detectResult);
        if (!frontCacheHit) {
          const gateStartedAt = Date.now();
          gateResult = allowPythonForTrigger
            ? await this.applyPythonStartupHealthGate()
            : { state: "skipped", waitedMs: 0, attempts: this.pythonStartupGateAttemptCount || 0, fallbackReason: "" };
          stageDurations.gateMs = Date.now() - gateStartedAt;
          pushProgress("启动门控检查", 40);
        }
        const detectStartedAt = Date.now();
        const detectStageStartedAt = Date.now();
        if (!frontCacheHit) pushProgress("调用引擎检测", 48);
        if (shouldTrackProgress && !frontCacheHit) {
          detectHeartbeat = setInterval(() => {
            const elapsedSeconds = Math.max(1, Math.floor((Date.now() - detectStageStartedAt) / 1000));
            const percent = Math.min(88, 48 + elapsedSeconds * 2);
            pushProgress(`调用引擎检测（${elapsedSeconds}s）`, percent);
          }, 900);
        }
        if (!detectResult) {
          detectResult = await this.engineManager.detect(text, {
            ranges,
            maxSuggestions: this.settings.maxSuggestions,
            forceJsOnly: !allowPythonForTrigger,
            filePath: file.path,
            textHash,
            triggerSource: source
          });
        }
        stopDetectHeartbeat();
        stageDurations.detectMs = Date.now() - detectStartedAt;
        if (!isStillLatest()) return;
        if (allowFrontCache && !frontCacheHit && detectResult && !detectResult.fallbackReason && !detectResult.partial) {
          this.setFrontDetectionCache(frontCacheKey, detectResult, {
            textLength: text.length
          });
        }
        pushProgress("整理候选结果", 90);

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
            ? "当前为自动触发，按策略仅使用 JS。点击“开始纠错”调用 pycorrector。"
            : "";
        const fallbackReason = detectResult.fallbackReason || gateStableFallbackReason || startupFallbackReason || "";
        const engineSource = detectResult.engineUsed || "unknown";
        const pythonPartial = Boolean(detectResult && detectResult.partial);
        const qualityHint = buildQualityHint(engineSource, fallbackReason, pythonPartial);

        const filterStartedAt = Date.now();
        const rawMatches = detectResult.matches || [];
        const filterResult = this.filterMatchesDetailed(file.path, rawMatches, text);
        const filtered = filterResult.filtered;
        const suppressedMatches = Array.isArray(filterResult.suppressed) ? filterResult.suppressed : [];
        const suppressedMatchCount = Number.isFinite(Number(filterResult.suppressedCount))
          ? Number(filterResult.suppressedCount)
          : suppressedMatches.length;
        const suppressedReasonSummary = isPlainObject(filterResult.suppressedReasonSummary)
          ? filterResult.suppressedReasonSummary
          : {};
        stageDurations.filterMs = Date.now() - filterStartedAt;
        if (!isStillLatest()) return;
        pushProgress("写入结果面板", 96);
        if (editorView && useEditorText && this.canApplyDetectionSnapshot(editorView, file.path, textHash)) {
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
        const jsVariantFormRuleCount = jsEngine && Array.isArray(jsEngine.variantFormRules) ? jsEngine.variantFormRules.length : 0;
        const panelItemCount = this.latestPanelPayload && Array.isArray(this.latestPanelPayload.items)
          ? this.latestPanelPayload.items.length
          : 0;
        const vaultScanItemCount = this.latestPanelPayload && this.latestPanelPayload.source === "vault" && Array.isArray(this.latestPanelPayload.items)
          ? this.latestPanelPayload.items.length
          : 0;
        const diagnosticsSnapshot = toPrettyJson({
        request_id: requestId,
        file_path: file.path,
        text_hash: textHash,
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
        python_partial_result: pythonPartial,
        python_check_timed_out: pythonEngine ? Boolean(pythonEngine.lastCheckTimedOut) : false,
        python_timeout_budget_ms: pythonEngine ? Number(pythonEngine.lastCheckTimeoutBudgetMs || 0) : 0,
        python_fallback_rule_count: pythonEngine ? pythonEngine.fallbackRuleCount || 0 : 0,
        js_cedict_enabled: this.settings.jsCedictEnhanced,
        js_cedict_ready: cedictRuntime.ready,
        js_cedict_loaded_from: cedictRuntime.loadedFrom || "",
        js_cedict_error: cedictRuntime.error || "",
        js_cedict_word_count: cedictRuntime.words ? cedictRuntime.words.size : 0,
        js_cedict_confusion_count: cedictRuntime.charConfusions ? cedictRuntime.charConfusions.size : 0,
        js_runtime_dir: jsEngine ? jsEngine.runtimeDir || "" : "",
        js_runtime_dir_candidates: jsEngine && Array.isArray(jsEngine.runtimeDirCandidates) ? jsEngine.runtimeDirCandidates : [],
        js_shared_rules_path: jsEngine ? jsEngine.sharedRulesPath || "" : "",
        js_shared_rules_exists: jsEngine ? fs.existsSync(jsEngine.sharedRulesPath || "") : false,
        js_shared_rules_error: jsEngine ? jsEngine.sharedRulesLoadError || "" : "",
        js_shared_typo_rule_count: jsSharedTypoRuleCount,
        js_variant_rules_path: jsEngine ? jsEngine.variantFormsPath || "" : "",
        js_variant_rules_exists: jsEngine ? fs.existsSync(jsEngine.variantFormsPath || "") : false,
        js_variant_rules_error: jsEngine ? jsEngine.variantFormsLoadError || "" : "",
        js_variant_form_rule_count: jsVariantFormRuleCount,
        js_domain_terms_path: jsEngine ? jsEngine.domainTermsPath || "" : "",
        js_domain_terms_exists: jsEngine ? fs.existsSync(jsEngine.domainTermsPath || "") : false,
        js_domain_terms_error: jsEngine ? jsEngine.domainTermsLoadError || "" : "",
        js_idiom_terms_path: jsEngine ? jsEngine.idiomTermsPath || "" : "",
        js_idiom_terms_exists: jsEngine ? fs.existsSync(jsEngine.idiomTermsPath || "") : false,
        js_idiom_terms_error: jsEngine ? jsEngine.idiomTermsLoadError || "" : "",
        js_idiom_term_count: jsEngine && jsEngine.idiomTerms instanceof Set ? jsEngine.idiomTerms.size : 0,
        python_check_cache_size: pythonEngine ? pythonEngine.checkCacheSize || 0 : 0,
        front_cache_size: this.frontDetectionCache ? this.frontDetectionCache.size : 0,
        panel_item_count: panelItemCount,
        vault_scan_item_count: vaultScanItemCount,
        front_cache_hit: frontCacheHit,
        stage_durations: stageSnapshot,
        match_count_raw: rawMatches.length,
        match_count_filtered: filtered.length,
        suppressed_match_count: suppressedMatchCount,
        suppressed_match_reason_summary: suppressedReasonSummary,
        suppressed_matches: suppressedMatches
        });
        if (!isStillLatest()) return;
        await this.updateResultPanel({
          source: "file",
          filePath: file.path,
          textHash,
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
          pythonPartial,
          qualityHint,
          extraText: frontCacheHit ? "检测结果命中前端缓存。" : startupGateText || triggerHintText,
          rawText: diagnosticsSnapshot
        }
        });

        if (showNotice) {
          new Notice(`✅ 检测完成: 共 ${filtered.length} 条纠错建议`);
        }
        if (isManualTrigger) {
          this.manualDetectionWindowUntil = Date.now() + 8000;
        }
      } finally {
        stopDetectHeartbeat();
        if (shouldTrackProgress) {
          if (!isStillLatest()) return;
          await this.setResultPanelProgress(file.path, {
            active: false,
            requestId,
            source,
            stage: "检测完成",
            percent: 100,
            startedAt
          });
        }
      }
    }, snapshot.textHash);
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
    this.trimSessionIgnores();
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
      items: [],
      itemsTruncated: false
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
      const filtered = this.filterMatches(file.path, raw.matches || [], content);
      if (!filtered.length) continue;

      report.hitFiles += 1;
      report.totalMatches += filtered.length;
      for (const match of filtered.slice(0, 12)) {
        if (report.items.length >= MAX_SCAN_REPORT_ITEMS) {
          report.itemsTruncated = true;
          break;
        }
        const line = this.countLineByOffset(content, match.from);
        const excerpt = truncateText(
          content.slice(Math.max(0, match.from - 12), Math.min(content.length, match.to + 16)).replace(/\r?\n/g, " "),
          MAX_PANEL_EXCERPT_LENGTH
        );
        report.items.push({
          filePath: file.path,
          from: match.from,
          to: match.to,
          token: match.token || "",
          suggestion: (match.replacements && match.replacements[0] && match.replacements[0].value) || "",
          engine: String(match.engine || "").trim() || "unknown",
          line,
          excerpt
        });
      }
    }

    await this.updateResultPanel({
      source: "vault",
      filePath: "",
      items: report.items,
      totalItemCount: report.totalMatches
    });
    new ScanReportModal(this.app, report).open();
  }
};
