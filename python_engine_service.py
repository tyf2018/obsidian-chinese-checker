#!/usr/bin/env python3
"""Python local typo engine service.

Primary engine: pycorrector (if installed)
Fallback engine: small built-in rule set
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import socket
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Dict, Iterable, List, Optional, Tuple

SERVICE_VERSION = "0.4.0"
LOCAL_DATA_DIR = os.environ.get(
    "PYCORRECTOR_DATA_DIR", os.path.join(os.path.expanduser("~"), ".pycorrector", "datasets")
)
LOCAL_SMALL_LM_NAME = "people_chars_lm.klm"
LOCAL_SMALL_LM_PATH = os.path.join(LOCAL_DATA_DIR, LOCAL_SMALL_LM_NAME)
LOCAL_SMALL_LM_URL = "https://github.com/shibing624/pycorrector/releases/download/0.4.3/people_chars_lm.klm"

_PYCORRECTOR = None
_PYCORRECTOR_CORRECT_FN: Optional[Callable[[str], object]] = None
_PYCORRECTOR_IMPL = ""
_PYCORRECTOR_LM_PATH = ""
_PYCORRECTOR_LOADED = False
_PYCORRECTOR_LOADING = False
_PYCORRECTOR_ERROR = ""
_PYCORRECTOR_LOCK = threading.Lock()


def _trim_error(text: object) -> str:
    value = str(text or "").replace("\r", " ").replace("\n", " ").strip()
    return value[:240]


def _classify_pycorrector_error(exc: Exception) -> str:
    message = _trim_error(exc)
    lowered = message.lower()
    if (
        "url fetch failure" in lowered
        or "deepspeech.bj.bcebos.com" in lowered
        or "urlopen error" in lowered
        or "winerror 10013" in lowered
    ):
        return "model_download_blocked"
    if ("no module named" in lowered and "kenlm" in lowered) or (
        "kenlm" in lowered and ("dll load failed" in lowered or "cannot open shared object file" in lowered)
    ):
        return "missing_kenlm"
    if "torch" in lowered:
        return "missing_torch"
    if "no module named" in lowered:
        return message
    return message or exc.__class__.__name__


def _resolve_preferred_lm_path() -> str:
    env_path = os.environ.get("PYCORRECTOR_LM_PATH", "").strip()
    if env_path and os.path.exists(env_path):
        return env_path
    if os.path.exists(LOCAL_SMALL_LM_PATH):
        return LOCAL_SMALL_LM_PATH
    try:
        os.makedirs(LOCAL_DATA_DIR, exist_ok=True)
        urllib.request.urlretrieve(LOCAL_SMALL_LM_URL, LOCAL_SMALL_LM_PATH)  # nosec B310
    except Exception:  # pylint: disable=broad-except
        return ""
    return LOCAL_SMALL_LM_PATH if os.path.exists(LOCAL_SMALL_LM_PATH) else ""


def _parse_pycorrector_output(raw_output: object, source_text: str) -> Tuple[str, List[object]]:
    if isinstance(raw_output, tuple):
        if len(raw_output) >= 2:
            corrected_text = str(raw_output[0]) if raw_output[0] is not None else source_text
            details = raw_output[1]
            if details is None:
                details = []
            if not isinstance(details, list):
                details = list(details) if isinstance(details, tuple) else [details]
            return corrected_text, details
        if len(raw_output) == 1:
            return str(raw_output[0]), []
    if isinstance(raw_output, str):
        return raw_output, []
    return source_text, []


def _resolve_pycorrector_correct_fn(module_obj: object) -> Tuple[Optional[Callable[[str], object]], str, str]:
    global _PYCORRECTOR_LM_PATH
    direct_fn = getattr(module_obj, "correct", None)
    if callable(direct_fn):
        _PYCORRECTOR_LM_PATH = ""
        return direct_fn, "module.correct", ""

    try:
        from pycorrector.corrector import Corrector  # type: ignore

        preferred_lm_path = _resolve_preferred_lm_path()
        if preferred_lm_path:
            corrector = Corrector(language_model_path=preferred_lm_path)
            _PYCORRECTOR_LM_PATH = preferred_lm_path
        else:
            corrector = Corrector()
            _PYCORRECTOR_LM_PATH = ""
    except Exception as exc:  # pylint: disable=broad-except
        _PYCORRECTOR_LM_PATH = ""
        return None, "", _classify_pycorrector_error(exc)

    correct_fn = getattr(corrector, "correct", None)
    if not callable(correct_fn):
        return None, "", "corrector_has_no_correct"
    return correct_fn, "Corrector.correct", ""


def _probe_pycorrector_capability(correct_fn: Callable[[str], object]) -> str:
    try:
        probe_output = correct_fn("今天是个好日子")
        _parse_pycorrector_output(probe_output, "今天是个好日子")
        return ""
    except Exception as exc:  # pylint: disable=broad-except
        return _classify_pycorrector_error(exc)


def _load_pycorrector_once() -> None:
    global _PYCORRECTOR, _PYCORRECTOR_CORRECT_FN, _PYCORRECTOR_IMPL, _PYCORRECTOR_LM_PATH
    global _PYCORRECTOR_LOADED, _PYCORRECTOR_LOADING, _PYCORRECTOR_ERROR

    if _PYCORRECTOR_LOADED:
        return

    with _PYCORRECTOR_LOCK:
        if _PYCORRECTOR_LOADED:
            return
        _PYCORRECTOR_LOADING = True
        try:
            import pycorrector as pycorrector_module  # type: ignore

            correct_fn, impl, resolve_error = _resolve_pycorrector_correct_fn(pycorrector_module)
            if resolve_error:
                _PYCORRECTOR = None
                _PYCORRECTOR_CORRECT_FN = None
                _PYCORRECTOR_IMPL = ""
                _PYCORRECTOR_LM_PATH = ""
                _PYCORRECTOR_ERROR = resolve_error
            elif correct_fn is None:
                _PYCORRECTOR = None
                _PYCORRECTOR_CORRECT_FN = None
                _PYCORRECTOR_IMPL = ""
                _PYCORRECTOR_LM_PATH = ""
                _PYCORRECTOR_ERROR = "pycorrector_api_unavailable"
            else:
                probe_error = _probe_pycorrector_capability(correct_fn)
                if probe_error:
                    _PYCORRECTOR = pycorrector_module
                    _PYCORRECTOR_CORRECT_FN = None
                    _PYCORRECTOR_IMPL = impl
                    _PYCORRECTOR_ERROR = probe_error
                else:
                    _PYCORRECTOR = pycorrector_module
                    _PYCORRECTOR_CORRECT_FN = correct_fn
                    _PYCORRECTOR_IMPL = impl
                    _PYCORRECTOR_ERROR = ""
        except Exception as exc:  # pylint: disable=broad-except
            _PYCORRECTOR = None
            _PYCORRECTOR_CORRECT_FN = None
            _PYCORRECTOR_IMPL = ""
            _PYCORRECTOR_LM_PATH = ""
            _PYCORRECTOR_ERROR = _classify_pycorrector_error(exc)
        finally:
            _PYCORRECTOR_LOADED = True
            _PYCORRECTOR_LOADING = False


def _is_pycorrector_available() -> Optional[bool]:
    if not _PYCORRECTOR_LOADED:
        return None
    return _PYCORRECTOR_CORRECT_FN is not None


def _pycorrector_status() -> str:
    if _PYCORRECTOR_LOADING:
        return "loading"
    if not _PYCORRECTOR_LOADED:
        return "init"
    if _PYCORRECTOR_CORRECT_FN is not None:
        return "ready"
    return "unavailable"


def _ensure_pycorrector_background() -> None:
    global _PYCORRECTOR_LOADING
    if _PYCORRECTOR_LOADED or _PYCORRECTOR_LOADING:
        return

    def _worker():
        _load_pycorrector_once()

    _PYCORRECTOR_LOADING = True
    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()


FALLBACK_PHRASE_RULES: List[Tuple[str, str, float]] = [
    ("因该", "应该", 0.97),
    ("己经", "已经", 0.97),
    ("必需", "必须", 0.93),
    ("再接再励", "再接再厉", 0.98),
    ("一股作气", "一鼓作气", 0.94),
    ("按步就班", "按部就班", 0.91),
    ("迫不急待", "迫不及待", 0.95),
    ("出奇不意", "出其不意", 0.9),
    ("相形见拙", "相形见绌", 0.9),
    ("配眼睛", "配眼镜", 0.97),
]

DUPLICATE_REGEX = re.compile(r"(的的|了了|是是|地地|得得|在在|和和)")

CONFUSION_CHAR_MAP: Dict[str, Tuple[str, ...]] = {
    "齐": ("气", "其", "期"),
    "像": ("相",),
    "再": ("在",),
    "在": ("再",),
    "做": ("作",),
    "神": ("什",),
}

WORD_HINTS: Tuple[str, ...] = (
    "在干什么",
    "什么",
    "天气",
    "再接再厉",
    "相形见绌",
)


def _normalize_ranges(ranges: Iterable[Dict[str, int]]) -> List[Tuple[int, int]]:
    normalized: List[Tuple[int, int]] = []
    for item in ranges:
        left = int(item.get("from", 0))
        right = int(item.get("to", 0))
        if right <= left:
            continue
        normalized.append((left, right))
    if not normalized:
        return []
    normalized.sort(key=lambda x: (x[0], x[1]))
    merged: List[Tuple[int, int]] = [normalized[0]]
    for left, right in normalized[1:]:
        prev_left, prev_right = merged[-1]
        if left <= prev_right:
            merged[-1] = (prev_left, max(prev_right, right))
        else:
            merged.append((left, right))
    return merged


def _in_ranges(index_from: int, index_to: int, ranges: List[Tuple[int, int]]) -> bool:
    if not ranges:
        return True
    for left, right in ranges:
        if index_from >= left and index_to <= right:
            return True
    return False


def _make_match(
    start: int,
    end: int,
    token: str,
    replacement: str,
    rule_id: str,
    confidence: float,
    source: str,
) -> Dict[str, object]:
    return {
        "from": start,
        "to": end,
        "message": f"{source} 建议替换为“{replacement}”",
        "shortMessage": source,
        "replacements": [{"value": replacement}],
        "ruleId": rule_id,
        "category": "TYPOS",
        "confidence": confidence,
        "token": token,
    }


def _iter_detail_items(detail_obj: object):
    if isinstance(detail_obj, dict):
        yield detail_obj
        return
    if isinstance(detail_obj, (list, tuple)):
        if len(detail_obj) == 4 and not isinstance(detail_obj[0], (list, tuple, dict)):
            yield detail_obj
            return
        for item in detail_obj:
            yield from _iter_detail_items(item)


def _parse_pycorrector_detail(
    detail_item: object, text: str, corrected_text: str
) -> Tuple[str, str, int, int, float] | None:
    wrong = ""
    right = ""
    begin = -1
    end = -1
    confidence = 0.92

    if isinstance(detail_item, dict):
        wrong = str(detail_item.get("wrong") or detail_item.get("error") or "")
        right = str(detail_item.get("correct") or detail_item.get("right") or "")
        begin = int(detail_item.get("begin_idx", detail_item.get("start_idx", -1)))
        end = int(detail_item.get("end_idx", detail_item.get("end", -1)))
        if "prob" in detail_item:
            try:
                confidence = max(0.5, min(0.99, float(detail_item["prob"])))
            except Exception:  # pylint: disable=broad-except
                confidence = 0.92
    elif isinstance(detail_item, (list, tuple)):
        raw = list(detail_item)
        if len(raw) >= 4:
            if isinstance(raw[0], (int, float)) and isinstance(raw[1], (int, float)):
                begin = int(raw[0])
                end = int(raw[1])
                wrong = str(raw[2]) if not isinstance(raw[2], (int, float)) else ""
                right = str(raw[3]) if not isinstance(raw[3], (int, float)) else ""
            elif isinstance(raw[2], (int, float)) and isinstance(raw[3], (int, float)):
                wrong = str(raw[0])
                right = str(raw[1])
                begin = int(raw[2])
                end = int(raw[3])
            else:
                return None
        elif len(raw) >= 3:
            wrong = str(raw[0])
            begin = int(raw[1])
            end = int(raw[2])
            right = ""
    else:
        return None

    if begin < 0 or end <= begin:
        return None
    if begin < len(text) and end <= len(text):
        source_span = text[begin:end]
    else:
        source_span = ""
    if begin < len(corrected_text) and end <= len(corrected_text):
        corrected_span = corrected_text[begin:end]
    else:
        corrected_span = ""

    if not wrong:
        wrong = source_span or corrected_span
    if not right:
        right = corrected_span

    if right == wrong and source_span and corrected_span and source_span != corrected_span:
        wrong = source_span
        right = corrected_span
    if not right or right == wrong:
        return None
    return wrong, right, begin, end, confidence


def _extract_matches_from_diff(
    text: str, corrected_text: str, ranges: List[Tuple[int, int]]
) -> List[Dict[str, object]]:
    sequence = difflib.SequenceMatcher(a=text, b=corrected_text, autojunk=False)
    matches: List[Dict[str, object]] = []
    for tag, i1, i2, j1, j2 in sequence.get_opcodes():
        if tag != "replace":
            continue
        if not _in_ranges(i1, i2, ranges):
            continue
        wrong = text[i1:i2]
        right = corrected_text[j1:j2]
        if not wrong or not right or wrong == right:
            continue
        matches.append(
            _make_match(
                start=i1,
                end=i2,
                token=wrong,
                replacement=right,
                rule_id="PYCORRECTOR_DIFF_RULE",
                confidence=0.9,
                source="pycorrector",
            )
        )
    return matches


def _detect_by_confusion_word_hint(
    text: str, ranges: List[Tuple[int, int]], max_suggestions: int
) -> List[Dict[str, object]]:
    matches: List[Dict[str, object]] = []
    seen = set()
    text_len = len(text)

    for hint in WORD_HINTS:
        hint_len = len(hint)
        if hint_len <= 1 or hint_len > text_len:
            continue
        for start in range(0, text_len - hint_len + 1):
            end = start + hint_len
            if not _in_ranges(start, end, ranges):
                continue
            source = text[start:end]
            if source == hint:
                continue

            diff_pos = []
            for idx, (left, right) in enumerate(zip(source, hint)):
                if left != right:
                    diff_pos.append((idx, left, right))
                if len(diff_pos) > 1:
                    break
            if len(diff_pos) != 1:
                continue

            idx, left_char, right_char = diff_pos[0]
            candidates = CONFUSION_CHAR_MAP.get(left_char, ())
            if right_char not in candidates:
                continue

            key = (start, end, hint)
            if key in seen:
                continue
            seen.add(key)
            matches.append(
                _make_match(
                    start=start,
                    end=end,
                    token=source,
                    replacement=hint,
                    rule_id="CONFUSION_HINT_RULE",
                    confidence=0.78,
                    source="混淆集上下文",
                )
            )

    matches.sort(key=lambda item: (int(item["from"]), -float(item["confidence"])))
    if max_suggestions > 0:
        matches = matches[:max_suggestions]
    return matches


def _detect_by_pycorrector(
    text: str, ranges: List[Tuple[int, int]], max_suggestions: int
) -> List[Dict[str, object]]:
    global _PYCORRECTOR_CORRECT_FN, _PYCORRECTOR_ERROR
    available = _is_pycorrector_available()
    if available is None:
        _ensure_pycorrector_background()
        return []
    if available is False or _PYCORRECTOR_CORRECT_FN is None:
        return []

    matches: List[Dict[str, object]] = []
    seen = set()
    corrected_text = text
    details: List[object] = []

    try:
        raw_output = _PYCORRECTOR_CORRECT_FN(text)
        corrected_text, details = _parse_pycorrector_output(raw_output, text)
    except Exception as exc:  # pylint: disable=broad-except
        _PYCORRECTOR_CORRECT_FN = None
        _PYCORRECTOR_ERROR = _classify_pycorrector_error(exc)
        corrected_text = text
        details = []

    for detail in _iter_detail_items(details):
        parsed = _parse_pycorrector_detail(detail, text, corrected_text)
        if parsed is None:
            continue
        wrong, right, begin, end, confidence = parsed
        if not _in_ranges(begin, end, ranges):
            continue
        key = (begin, end, right)
        if key in seen:
            continue
        seen.add(key)
        matches.append(
            _make_match(
                start=begin,
                end=end,
                token=wrong,
                replacement=right,
                rule_id="PYCORRECTOR_RULE",
                confidence=confidence,
                source="pycorrector",
            )
        )

    if not matches and corrected_text != text:
        matches.extend(_extract_matches_from_diff(text, corrected_text, ranges))

    matches.sort(key=lambda item: (int(item["from"]), -float(item["confidence"])))
    if max_suggestions > 0:
        matches = matches[:max_suggestions]
    return matches


def _detect_by_fallback(
    text: str, ranges: List[Tuple[int, int]], max_suggestions: int
) -> List[Dict[str, object]]:
    seen = set()
    matches: List[Dict[str, object]] = []

    for wrong, correct, confidence in FALLBACK_PHRASE_RULES:
        start = text.find(wrong)
        while start >= 0:
            end = start + len(wrong)
            if _in_ranges(start, end, ranges):
                key = (start, end, correct)
                if key not in seen:
                    seen.add(key)
                    matches.append(
                        _make_match(
                            start=start,
                            end=end,
                            token=text[start:end],
                            replacement=correct,
                            rule_id="FALLBACK_COMMON_PHRASE_RULE",
                            confidence=confidence,
                            source="Python 规则引擎",
                        )
                    )
            start = text.find(wrong, start + 1)

    for duplicate in DUPLICATE_REGEX.finditer(text):
        start, end = duplicate.span()
        if not _in_ranges(start, end, ranges):
            continue
        replacement = duplicate.group(0)[0]
        key = (start, end, replacement)
        if key in seen:
            continue
        seen.add(key)
        matches.append(
            _make_match(
                start=start,
                end=end,
                token=text[start:end],
                replacement=replacement,
                rule_id="FALLBACK_DUPLICATE_RULE",
                confidence=0.82,
                source="Python 规则引擎",
            )
        )

    matches.sort(key=lambda item: (int(item["from"]), -float(item["confidence"])))
    if max_suggestions > 0:
        matches = matches[:max_suggestions]
    return matches


def _merge_match_groups(
    groups: List[List[Dict[str, object]]], max_suggestions: int
) -> List[Dict[str, object]]:
    merged_by_span: Dict[Tuple[int, int], Dict[str, object]] = {}

    for group in groups:
        for item in group:
            start = int(item["from"])
            end = int(item["to"])
            if end <= start:
                continue
            replacements = list(item.get("replacements") or [])
            replacement_value = ""
            if replacements:
                replacement_value = str(replacements[0].get("value", ""))
            span_key = (start, end)
            existing = merged_by_span.get(span_key)
            if existing is None:
                merged_by_span[span_key] = {
                    **item,
                    "replacements": [r for r in replacements if isinstance(r, dict)],
                }
                continue

            existing_replacements = existing.get("replacements")
            if not isinstance(existing_replacements, list):
                existing_replacements = []
                existing["replacements"] = existing_replacements
            existing_values = {
                str(rep.get("value", ""))
                for rep in existing_replacements
                if isinstance(rep, dict)
            }
            if replacement_value and replacement_value not in existing_values:
                existing_replacements.append({"value": replacement_value})

            current_confidence = float(item.get("confidence", 0))
            existing_confidence = float(existing.get("confidence", 0))
            if current_confidence > existing_confidence:
                existing["message"] = item.get("message", existing.get("message", ""))
                existing["shortMessage"] = item.get(
                    "shortMessage", existing.get("shortMessage", "")
                )
                existing["ruleId"] = item.get("ruleId", existing.get("ruleId", ""))
                existing["confidence"] = current_confidence
                existing["token"] = item.get("token", existing.get("token", ""))

    merged = list(merged_by_span.values())
    merged.sort(key=lambda item: (int(item["from"]), -float(item.get("confidence", 0))))
    if max_suggestions > 0:
        merged = merged[:max_suggestions]
    return merged


def detect_with_meta(
    text: str, ranges: List[Dict[str, int]], max_suggestions: int
) -> Tuple[List[Dict[str, object]], str]:
    normalized_ranges = _normalize_ranges(ranges)

    pycorrector_matches = _detect_by_pycorrector(
        text=text, ranges=normalized_ranges, max_suggestions=max_suggestions
    )
    hint_matches = _detect_by_confusion_word_hint(
        text=text, ranges=normalized_ranges, max_suggestions=max_suggestions
    )
    fallback_matches = _detect_by_fallback(
        text=text, ranges=normalized_ranges, max_suggestions=max_suggestions
    )
    merged = _merge_match_groups(
        [pycorrector_matches, hint_matches, fallback_matches], max_suggestions
    )

    used_layers = []
    if pycorrector_matches:
        used_layers.append("pycorrector")
    if hint_matches:
        used_layers.append("hint")
    if fallback_matches:
        used_layers.append("fallback")
    if not used_layers:
        used_layers.append("none")
    return merged, "+".join(used_layers)


def detect(text: str, ranges: List[Dict[str, int]], max_suggestions: int) -> List[Dict[str, object]]:
    matches, _ = detect_with_meta(text=text, ranges=ranges, max_suggestions=max_suggestions)
    return matches


def get_engine_meta() -> Dict[str, object]:
    return {
        "service_version": SERVICE_VERSION,
        "pycorrector_status": _pycorrector_status(),
        "pycorrector_loaded": _PYCORRECTOR_LOADED,
        "pycorrector_loading": _PYCORRECTOR_LOADING,
        "pycorrector_available": _is_pycorrector_available(),
        "pycorrector_impl": _PYCORRECTOR_IMPL,
        "pycorrector_lm_path": _PYCORRECTOR_LM_PATH,
        "pycorrector_error": _PYCORRECTOR_ERROR,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "PythonTypoEngine/0.2"

    def _set_cors_headers(self) -> None:
        # Obsidian desktop runs in app:// origin; allow local loopback API access.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")

    def _json_response(self, status: int, payload: Dict[str, object]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._set_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            payload = {"ok": True}
            payload.update(get_engine_meta())
            self._json_response(200, payload)
            return
        self._json_response(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/check":
            self._json_response(404, {"error": "not found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body.decode("utf-8"))
            text = str(data.get("text", ""))
            ranges = data.get("ranges") or []
            max_suggestions = int(data.get("max_suggestions", 300))
            matches, engine_detail = detect_with_meta(
                text=text, ranges=ranges, max_suggestions=max_suggestions
            )
            self._json_response(
                200,
                {
                    "matches": matches,
                    "engine": "pycorrector" if _is_pycorrector_available() else "fallback",
                    "engine_detail": engine_detail,
                    **get_engine_meta(),
                },
            )
        except Exception as exc:  # pylint: disable=broad-except
            self._json_response(400, {"error": str(exc), "matches": []})

    def log_message(self, format_str: str, *args) -> None:  # noqa: A003
        return


class ExclusiveThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def _classify_server_startup_error(exc: Exception) -> str:
    if isinstance(exc, OSError):
        if exc.errno in {98, 10048}:
            return "bind_address_in_use"
        if exc.errno in {13, 10013}:
            return "bind_permission_denied"
    return f"server_startup_error:{exc.__class__.__name__}:{_trim_error(exc)}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Python local typo engine service")
    parser.add_argument("--host", default="127.0.0.1", help="listen host")
    parser.add_argument("--port", default=27123, type=int, help="listen port")
    args = parser.parse_args()

    _ensure_pycorrector_background()
    try:
        server = ExclusiveThreadingHTTPServer((args.host, args.port), Handler)
    except Exception as exc:  # pylint: disable=broad-except
        print(_classify_server_startup_error(exc), file=sys.stderr)
        raise SystemExit(2)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
