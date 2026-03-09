# Python 引擎协议（v1）

本文定义 Obsidian 插件与本地 Python 服务的 HTTP 契约。

## 1. 基本约定

1. 服务地址：`http://{host}:{port}`。  
2. 编码：`application/json; charset=utf-8`。  
3. 推荐超时：
   - `/health`：1200ms
   - `/check`：由插件配置 `pythonTimeoutMs` 控制
4. CORS：服务必须支持 preflight（`OPTIONS /check`）并返回 `Access-Control-Allow-Origin`。

## 2. `GET /health`

### 2.1 响应（推荐字段）

```json
{
  "ok": true,
  "service_version": "0.4.0",
  "pycorrector_status": "ready",
  "pycorrector_available": true,
  "pycorrector_loading": false,
  "pycorrector_impl": "module.correct",
  "pycorrector_error": ""
}
```

### 2.2 字段说明

1. `service_version`：服务版本字符串。  
2. `pycorrector_status`：`init | loading | ready | unavailable`。  
3. `pycorrector_available`：是否可调用 pycorrector；当 `pycorrector_status` 为 `init/loading` 时可为 `null`。  
4. `pycorrector_error`：不可用时的错误原因。

### 2.3 兼容策略

1. 新服务应返回 `service_version`。  
2. 旧服务若仅返回 `{ "ok": true }`，前端可视为“有限兼容”，但会记为 `serviceVersion=unknown`。

## 3. `OPTIONS /check`

用于 CORS preflight，推荐响应为 `204`（`200` 也可接受）。

### 3.1 期望响应头

1. `Access-Control-Allow-Origin`
2. `Access-Control-Allow-Methods`
3. `Access-Control-Allow-Headers`

## 4. `POST /check`

### 4.1 请求体

```json
{
  "text": "今天天齐不太好。配眼睛。",
  "ranges": [{"from": 0, "to": 12}],
  "max_suggestions": 200
}
```

### 4.2 响应（推荐字段）

```json
{
  "matches": [],
  "engine": "pycorrector",
  "engine_detail": "pycorrector+hint",
  "service_version": "0.4.0",
  "pycorrector_status": "ready",
  "pycorrector_available": true,
  "pycorrector_loading": false,
  "pycorrector_impl": "module.correct",
  "pycorrector_error": ""
}
```

### 4.3 必需字段（v1）

1. `matches`：数组。  
2. 推荐同时返回：`service_version`、`engine_detail`、`pycorrector_status`、`pycorrector_available`。

### 4.4 `matches` 元素结构

```json
{
  "from": 3,
  "to": 5,
  "token": "天齐",
  "message": "pycorrector 建议替换为“天气”",
  "shortMessage": "pycorrector",
  "replacements": [{"value": "天气"}],
  "ruleId": "PYCORRECTOR_RULE",
  "category": "TYPOS",
  "confidence": 0.9
}
```

## 5. 错误约定

1. HTTP 非 2xx 视为请求失败。  
2. 2xx 但 JSON 结构不兼容，前端记 `python_service_incompatible`。  
3. 前端保留 JS 回退路径，避免阻塞编辑流程。
