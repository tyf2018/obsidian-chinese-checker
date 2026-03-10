#!/usr/bin/env python3
"""Diagnose pycorrector runtime for Obsidian plugin."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SUPPORTED_PYTHON_MAJOR = 3
SUPPORTED_PYTHON_MINOR = 11


def http_get_json(url: str, timeout: float = 1.5):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310
        data = resp.read().decode("utf-8")
        return json.loads(data)


def http_post_json(url: str, payload: dict, timeout: float = 6.0):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310
        data = resp.read().decode("utf-8")
        return json.loads(data)


def http_options(url: str, timeout: float = 3.0):
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
        return int(resp.status), {str(k).lower(): str(v) for k, v in resp.headers.items()}


def print_line(text: str):
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def wait_until_ready(base_url: str, timeout_sec: float = 15.0):
    end = time.time() + timeout_sec
    last = {}
    while time.time() < end:
        try:
            health = http_get_json(f"{base_url}/health")
            last = health
            status = str(health.get("pycorrector_status", ""))
            if status and status not in {"init", "loading"}:
                return health
        except Exception:
            pass
        time.sleep(0.4)
    return last


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    service = script_dir / "python_engine_service.py"
    host = "127.0.0.1"
    port = 27123
    base_url = f"http://{host}:{port}"

    print_line("=== pycorrector environment check ===")
    print_line(f"Python executable: {sys.executable}")
    print_line(f"Python version   : {sys.version.split()[0]}")
    print_line(f"Python required  : {SUPPORTED_PYTHON_MAJOR}.{SUPPORTED_PYTHON_MINOR}.x")
    print_line(f"data dir         : {os.environ.get('PYCORRECTOR_DATA_DIR', '')}")
    print_line(f"lm path          : {os.environ.get('PYCORRECTOR_LM_PATH', '')}")
    if (sys.version_info.major, sys.version_info.minor) != (SUPPORTED_PYTHON_MAJOR, SUPPORTED_PYTHON_MINOR):
        print_line("python support   : NOT supported")
        print_line(
            f"reason           : python_version_unsupported "
            f"(current={sys.version.split()[0]}, required={SUPPORTED_PYTHON_MAJOR}.{SUPPORTED_PYTHON_MINOR}.x)"
        )
        return 1
    print_line("python support   : supported")

    try:
        import pycorrector  # type: ignore

        print_line(f"pycorrector      : installed ({pycorrector.__version__})")
    except Exception as exc:  # pylint: disable=broad-except
        print_line(f"pycorrector      : NOT usable ({exc})")

    try:
        import torch  # type: ignore

        print_line(f"torch            : installed ({torch.__version__})")
    except Exception as exc:  # pylint: disable=broad-except
        print_line(f"torch            : NOT usable ({exc})")

    started = False
    proc = None

    try:
        health = http_get_json(f"{base_url}/health")
        print_line(f"service health   : running ({health})")
    except Exception:
        if not service.exists():
            print_line(f"service file     : missing ({service})")
            return 1
        print_line("service health   : not running, try start local service...")
        proc = subprocess.Popen(  # nosec B603
            [sys.executable, str(service), "--host", host, "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=str(script_dir),
        )
        started = True
        ok = False
        for _ in range(20):
            time.sleep(0.25)
            try:
                health = http_get_json(f"{base_url}/health")
                ok = True
                break
            except Exception:
                continue
        if not ok:
            print_line("service health   : failed to start")
            return 1
        print_line(f"service health   : started ({health})")

    if str(health.get("pycorrector_status", "")) in {"init", "loading"}:
        settled = wait_until_ready(base_url, timeout_sec=15.0)
        if settled:
            health = settled
            print_line(f"service status   : settled ({health})")
    print_line(f"service lm path  : {health.get('pycorrector_lm_path', '')}")

    try:
        status_code, headers = http_options(f"{base_url}/check")
        has_cors = bool(headers.get("access-control-allow-origin", ""))
        if status_code not in {200, 204} or not has_cors:
            print_line(
                "cors preflight  : failed "
                f"(status={status_code}, allow_origin={headers.get('access-control-allow-origin', '')})"
            )
            return 1
        print_line("cors preflight  : ok")
    except urllib.error.URLError as exc:
        print_line(f"cors preflight  : failed ({exc})")
        return 1

    try:
        payload = {
            "text": "今天天齐不太好。配眼睛。",
            "ranges": [],
            "max_suggestions": 10,
        }
        result = http_post_json(f"{base_url}/check", payload)
        print_line(f"check engine     : {result.get('engine')}")
        matches = result.get("matches") or []
        print_line(f"check matches    : {len(matches)}")
        for idx, item in enumerate(matches[:5], 1):
            token = item.get("token")
            repl = ""
            reps = item.get("replacements") or []
            if reps and isinstance(reps[0], dict):
                repl = reps[0].get("value", "")
            print_line(f"  {idx}. {token} -> {repl}")
        return 0
    except urllib.error.URLError as exc:
        print_line(f"check request    : failed ({exc})")
        return 1
    finally:
        if started and proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except Exception:  # pylint: disable=broad-except
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
