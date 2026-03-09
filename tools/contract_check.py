#!/usr/bin/env python3
"""Contract check for local python typo engine."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Dict, List, Tuple


def http_get_json(url: str, timeout: float) -> Dict[str, object]:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310
        return json.loads(resp.read().decode("utf-8"))


def http_post_json(url: str, payload: Dict[str, object], timeout: float) -> Dict[str, object]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310
        return json.loads(resp.read().decode("utf-8"))


def http_options(url: str, timeout: float) -> Tuple[int, Dict[str, str]]:
    req = urllib.request.Request(
        url,
        method="OPTIONS",
        headers={
            "Origin": "app://obsidian.md",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310
        header_map = {str(k).lower(): str(v) for k, v in resp.headers.items()}
        return int(resp.status), header_map


def check_health(data: Dict[str, object], allow_legacy: bool) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []
    if not isinstance(data, dict):
        return ["health response is not a JSON object"], warnings

    required = ["service_version", "pycorrector_status", "pycorrector_available"]
    missing = [key for key in required if key not in data]
    if missing:
        if allow_legacy and data.get("ok") is True:
            warnings.append(f"health missing fields (legacy allowed): {', '.join(missing)}")
        else:
            errors.append(f"health missing fields: {', '.join(missing)}")

    if "service_version" in data and not isinstance(data.get("service_version"), str):
        errors.append("health.service_version must be string")
    if "pycorrector_status" in data and not isinstance(data.get("pycorrector_status"), str):
        errors.append("health.pycorrector_status must be string")
    if "pycorrector_available" in data:
        available = data.get("pycorrector_available")
        if isinstance(available, bool):
            pass
        elif available is None and str(data.get("pycorrector_status", "")) in {"init", "loading"}:
            warnings.append("health.pycorrector_available is null while status is init/loading")
        else:
            errors.append("health.pycorrector_available must be boolean (or null when init/loading)")
    return errors, warnings


def check_check(data: Dict[str, object], allow_legacy: bool) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []
    if not isinstance(data, dict):
        return ["check response is not a JSON object"], warnings

    if "matches" not in data:
        errors.append("check missing field: matches")
    elif not isinstance(data["matches"], list):
        errors.append("check.matches must be array")

    recommended = ["service_version", "engine_detail", "pycorrector_status", "pycorrector_available"]
    missing_recommended = [key for key in recommended if key not in data]
    if missing_recommended:
        message = f"check missing recommended fields: {', '.join(missing_recommended)}"
        if allow_legacy:
            warnings.append(message)
        else:
            errors.append(message)

    if isinstance(data.get("matches"), list):
        for idx, item in enumerate(data["matches"][:10]):
            if not isinstance(item, dict):
                errors.append(f"check.matches[{idx}] must be object")
                continue
            if "from" in item and not isinstance(item["from"], int):
                errors.append(f"check.matches[{idx}].from must be int")
            if "to" in item and not isinstance(item["to"], int):
                errors.append(f"check.matches[{idx}].to must be int")
            if "replacements" in item and not isinstance(item["replacements"], list):
                errors.append(f"check.matches[{idx}].replacements must be array")
    if "pycorrector_available" in data:
        available = data.get("pycorrector_available")
        if isinstance(available, bool):
            pass
        elif available is None and str(data.get("pycorrector_status", "")) in {"init", "loading"}:
            warnings.append("check.pycorrector_available is null while status is init/loading")
        else:
            errors.append("check.pycorrector_available must be boolean (or null when init/loading)")
    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify local typo engine HTTP contract")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=27123, type=int)
    parser.add_argument("--timeout", default=3.0, type=float)
    parser.add_argument("--allow-legacy", action="store_true", help="Allow legacy response without full metadata")
    args = parser.parse_args()

    base_url = f"http://{args.host}:{args.port}"
    all_errors: List[str] = []
    all_warnings: List[str] = []

    try:
        health = http_get_json(f"{base_url}/health", timeout=args.timeout)
        errors, warnings = check_health(health, allow_legacy=args.allow_legacy)
        all_errors.extend(errors)
        all_warnings.extend(warnings)
        print("[health] ok")
    except urllib.error.URLError as exc:
        print(f"[health] request failed: {exc}")
        return 1
    except Exception as exc:  # pylint: disable=broad-except
        print(f"[health] unexpected error: {exc}")
        return 1

    try:
        status, headers = http_options(f"{base_url}/check", timeout=args.timeout)
        if status not in {200, 204}:
            print(f"[options] invalid status: {status}")
            return 1
        allow_origin = headers.get("access-control-allow-origin", "")
        if not allow_origin:
            print("[options] missing access-control-allow-origin")
            return 1
        print("[options] ok")
    except urllib.error.URLError as exc:
        print(f"[options] request failed: {exc}")
        return 1
    except Exception as exc:  # pylint: disable=broad-except
        print(f"[options] unexpected error: {exc}")
        return 1

    try:
        check_result = http_post_json(
            f"{base_url}/check",
            {
                "text": "今天天齐不太好。配眼睛。",
                "ranges": [],
                "max_suggestions": 10,
            },
            timeout=max(args.timeout, 6.0),
        )
        errors, warnings = check_check(check_result, allow_legacy=args.allow_legacy)
        all_errors.extend(errors)
        all_warnings.extend(warnings)
        print("[check] ok")
    except urllib.error.URLError as exc:
        print(f"[check] request failed: {exc}")
        return 1
    except Exception as exc:  # pylint: disable=broad-except
        print(f"[check] unexpected error: {exc}")
        return 1

    if all_warnings:
        print("\nWarnings:")
        for item in all_warnings:
            print(f"- {item}")

    if all_errors:
        print("\nErrors:")
        for item in all_errors:
            print(f"- {item}")
        return 1

    print("\nContract check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
