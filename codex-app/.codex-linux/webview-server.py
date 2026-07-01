#!/usr/bin/env python3
import ctypes
import ctypes.util
import functools
import http.server
import os
import signal
import sys
import json
import pathlib
import urllib.request


def _install_parent_death_signal():
    # Ensure the kernel terminates this process if the launcher (parent) exits
    # without invoking its cleanup trap (SIGKILL, OOM, crash). Without this,
    # the HTTP server can outlive the launcher and block its webview port,
    # which is fatal for multi-instance launches pinned to a single port.
    if sys.platform != "linux":
        return
    libc_name = ctypes.util.find_library("c") or "libc.so.6"
    try:
        libc = ctypes.CDLL(libc_name, use_errno=True)
    except OSError:
        return
    PR_SET_PDEATHSIG = 1
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0:
        return
    # The parent may have died between fork() and prctl(); in that case the
    # death signal never fires. Bail out now so the port is freed promptly.
    if os.getppid() == 1:
        os._exit(0)


_install_parent_death_signal()


port = int(sys.argv[1])
bind = "127.0.0.1"
if len(sys.argv) >= 4 and sys.argv[2] == "--bind":
    bind = sys.argv[3]


HOME = pathlib.Path.home()
CODEX_CONFIG_PATH = HOME / ".codex" / "config.toml"
CLIPROXY_CONFIG_PATH = pathlib.Path(os.environ.get("CLIPROXYAPI_CONFIG", HOME / "CLIProxyAPI" / "config.yaml"))
CLIPROXY_BASE_URL = os.environ.get("CLIPROXYAPI_BASE_URL", "http://127.0.0.1:8317").rstrip("/")
if CLIPROXY_BASE_URL.endswith("/v1"):
    CLIPROXY_BASE_URL = CLIPROXY_BASE_URL[:-3]
CLIPROXY_PROVIDER_NAME = "cliproxyapi"
CLIPROXY_PROVIDER_BLOCK = """[model_providers.cliproxyapi]
name = "CLIProxyAPI Data Plane"
base_url = "http://127.0.0.1:8317/v1"
env_key = "CLIPROXYAPI_PROXY_CLIENT_KEY"
wire_api = "responses"
"""


def _read_current_codex_model():
    try:
        for raw in CODEX_CONFIG_PATH.read_text(encoding="utf-8").splitlines():
            stripped = raw.strip()
            if stripped.startswith("model ") or stripped.startswith("model="):
                _, value = stripped.split("=", 1)
                return value.strip().strip('"')
    except OSError:
        return ""
    return ""


def _write_codex_model(model):
    model = str(model or "").strip()
    if not model:
        raise ValueError("model is required")

    existing = ""
    try:
        existing = CODEX_CONFIG_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        CODEX_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    lines = existing.splitlines()
    out = []
    saw_model = False
    saw_provider = False
    saw_reasoning_effort = False
    saw_provider_block = False
    in_provider_block = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_provider_block = stripped == "[model_providers.cliproxyapi]"
            if in_provider_block:
                saw_provider_block = True
            out.append(line)
            continue

        if not in_provider_block and (stripped.startswith("model ") or stripped.startswith("model=")):
            out.append(f'model = "{model}"')
            saw_model = True
            continue
        if not in_provider_block and (stripped.startswith("model_provider ") or stripped.startswith("model_provider=")):
            out.append(f'model_provider = "{CLIPROXY_PROVIDER_NAME}"')
            saw_provider = True
            continue
        if not in_provider_block and (
            stripped.startswith("model_reasoning_effort ") or stripped.startswith("model_reasoning_effort=")
        ):
            out.append('model_reasoning_effort = "high"')
            saw_reasoning_effort = True
            continue

        if in_provider_block:
            if stripped.startswith("base_url"):
                out.append('base_url = "http://127.0.0.1:8317/v1"')
                continue
            if stripped.startswith("env_key"):
                out.append('env_key = "CLIPROXYAPI_PROXY_CLIENT_KEY"')
                continue
            if stripped.startswith("wire_api"):
                out.append('wire_api = "responses"')
                continue

        out.append(line)

    prefix = []
    if not saw_model:
        prefix.append(f'model = "{model}"')
    if not saw_provider:
        prefix.append(f'model_provider = "{CLIPROXY_PROVIDER_NAME}"')
    if not saw_reasoning_effort:
        prefix.append('model_reasoning_effort = "high"')
    if prefix:
        out = prefix + ([""] if out else []) + out

    content = "\n".join(out).rstrip() + "\n"
    if not saw_provider_block:
        content += "\n" + CLIPROXY_PROVIDER_BLOCK

    CODEX_CONFIG_PATH.write_text(content, encoding="utf-8")


def _cliproxy_api_key():
    return os.environ.get("CLIPROXYAPI_PROXY_CLIENT_KEY", "").strip()


def _json_response(handler, status, payload):
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def _yaml_value(value):
    value = value.split("#", 1)[0].strip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def _configured_cliproxy_models():
    try:
        lines = CLIPROXY_CONFIG_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []

    providers = []
    current_provider = None
    current_model = None
    in_openai_compatibility = False
    in_models = False

    def flush_provider():
        if current_provider and not current_provider.get("disabled"):
            prefix = current_provider.get("prefix", "").strip()
            for model in current_provider.get("models", []):
                name = (model.get("alias") or model.get("name") or "").strip()
                if prefix and name:
                    providers.append(f"{prefix}/{name}")

    for raw in lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if stripped == "openai-compatibility:":
            in_openai_compatibility = True
            continue
        if not in_openai_compatibility:
            continue
        if indent == 0:
            flush_provider()
            break
        if indent == 2 and stripped.startswith("- "):
            flush_provider()
            current_provider = {"prefix": "", "disabled": False, "models": []}
            current_model = None
            in_models = False
            rest = stripped[2:].strip()
            if rest.startswith("name:"):
                current_provider["name"] = _yaml_value(rest.split(":", 1)[1])
            continue
        if not current_provider or indent < 4:
            continue
        if stripped.startswith("prefix:"):
            current_provider["prefix"] = _yaml_value(stripped.split(":", 1)[1])
            continue
        if stripped.startswith("disabled:"):
            current_provider["disabled"] = _yaml_value(stripped.split(":", 1)[1]).lower() == "true"
            continue
        if stripped.startswith("models:"):
            in_models = True
            current_model = None
            continue
        if in_models and stripped.startswith("- "):
            current_model = {"name": "", "alias": ""}
            current_provider["models"].append(current_model)
            rest = stripped[2:].strip()
            if rest.startswith("name:"):
                current_model["name"] = _yaml_value(rest.split(":", 1)[1])
            continue
        if in_models and current_model and stripped.startswith("alias:"):
            current_model["alias"] = _yaml_value(stripped.split(":", 1)[1])

    flush_provider()
    return sorted(dict.fromkeys(providers), key=str.lower)


def _fetch_cliproxy_models_from_api():
    key = _cliproxy_api_key()
    if not key:
        raise RuntimeError("missing CLIProxyAPI key")
    request = urllib.request.Request(
        CLIPROXY_BASE_URL + "/v1/models",
        headers={"Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        payload = json.loads(response.read().decode("utf-8"))
    models = []
    for item in payload.get("data", []):
        model_id = str(item.get("id", "")).strip()
        if model_id:
            models.append(model_id)
    return sorted(dict.fromkeys(models), key=lambda value: ("/" not in value, value.lower()))


def _fetch_cliproxy_models():
    return _fetch_cliproxy_models_from_api()


class CodexWebviewHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] == "/__cliproxy/models":
            try:
                _json_response(
                    self,
                    200,
                    {
                        "models": _fetch_cliproxy_models(),
                        "current_model": _read_current_codex_model(),
                    },
                )
            except Exception as exc:
                _json_response(self, 502, {"error": str(exc)})
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?", 1)[0] == "/__cliproxy/select-model":
            try:
                length = int(self.headers.get("Content-Length", "0") or "0")
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                model = str(payload.get("model", "")).strip()
                available = set(_fetch_cliproxy_models())
                if model not in available:
                    _json_response(self, 400, {"error": "model is not registered in CLIProxyAPI"})
                    return
                _write_codex_model(model)
                _json_response(self, 200, {"ok": True, "current_model": model})
            except Exception as exc:
                _json_response(self, 500, {"error": str(exc)})
            return
        _json_response(self, 404, {"error": "not found"})

    def send_head(self):
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


handler = functools.partial(CodexWebviewHandler, directory=".")
with http.server.ThreadingHTTPServer((bind, port), handler) as httpd:
    httpd.serve_forever()
