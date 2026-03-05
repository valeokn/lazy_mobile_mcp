# Tool Contract

All tool responses include `trace_id` in successful structured content and in every error payload.

## Error Format

```json
{
  "error": "Human readable message",
  "code": "ERR_xxx",
  "trace_id": "uuid-v4"
}
```

Additional validation error:
- `ERR_PAYLOAD_TOO_LARGE`: returned by `mobile.screenshot` when `save=false` and PNG payload is larger than 8MB.

## Tools

### `mobile.list_devices`
- Input:
```json
{ "platform": "android|ios|all" }
```
- Output:
```json
{ "devices": [{ "device_id": "...", "platform": "android|ios", "state": "...", "capabilities": {} }] }
```

### `mobile.select_device`
- Input:
```json
{ "device_id": "string" }
```
- Output:
```json
{ "selected_device": { "device_id": "string", "platform": "android|ios" } }
```

### `mobile.get_capabilities`
- Input:
```json
{ "device_id": "string?" }
```
- Output:
```json
{ "actions": ["..."], "metrics": ["..."], "unsupported": ["..."] }
```

### `mobile.screenshot`
- Input:
```json
{ "device_id": "string?", "format": "png", "save": true }
```
- Output when `save=true`:
```json
{ "artifact_id": "uuid", "path": "artifacts/screenshots/<uuid>.png", "width": 0, "height": 0, "saved": true }
```
- Output when `save=false`:
```json
{ "artifact_id": null, "path": null, "width": 0, "height": 0, "saved": false, "mime_type": "image/png", "image_base64": "..." }
```
Notes:
- `save=true` persists screenshot metadata into `artifacts`.
- `save=false` does not persist files/rows and returns inline base64 payload.
- `save=false` enforces an 8MB payload limit (`ERR_PAYLOAD_TOO_LARGE` on overflow).
- iOS simulator path auto-boots simulator if needed.
- iOS physical screenshot uses WDA `/screenshot`; if `WDA_BASE_URL` is not set, server attempts local WDA auto-discovery.

### `mobile.tap`
- Input:
```json
{ "device_id": "string?", "x": 100, "y": 300 }
```
- Output:
```json
{ "ok": true }
```
Notes:
- iOS route uses a device-specific WDA session.
- If `WDA_BASE_URL` is not set, server attempts local WDA auto-discovery.

### `mobile.swipe`
- Input:
```json
{ "device_id": "string?", "x1": 100, "y1": 300, "x2": 400, "y2": 300, "duration_ms": 300 }
```
- Output:
```json
{ "ok": true }
```
Notes:
- iOS route uses a device-specific WDA session.
- If `WDA_BASE_URL` is not set, server attempts local WDA auto-discovery.

### `mobile.input_text`
- Input:
```json
{ "device_id": "string?", "text": "hello" }
```
- Output:
```json
{ "ok": true }
```
Notes:
- iOS route uses a device-specific WDA session.
- If `WDA_BASE_URL` is not set, server attempts local WDA auto-discovery.

### `mobile.launch_app`
- Input:
```json
{ "device_id": "string?", "app_id": "com.example.app", "cold_start": false }
```
- Output:
```json
{ "ok": true, "launch_ms": 321.4, "cold_start_requested": false, "cold_start_applied": false }
```
Notes:
- `cold_start=true` attempts app stop before launch on both Android and iOS.

### `mobile.stop_app`
- Input:
```json
{ "device_id": "string?", "app_id": "com.example.app" }
```
- Output:
```json
{ "ok": true }
```

### `mobile.start_perf_session`
- Input:
```json
{ "device_id": "string?", "app_id": "com.example.app", "interval_ms": 1000, "metrics": ["cpu_pct", "memory_mb"] }
```
- Output:
```json
{ "session_id": "uuid", "started_at": "ISO-8601" }
```

### `mobile.stop_perf_session`
- Input:
```json
{ "session_id": "uuid" }
```
- Output:
```json
{ "sample_count": 42, "summary": { "session_id": "uuid", "ended_at": "ISO-8601" } }
```

### `mobile.get_perf_samples`
- Input:
```json
{ "session_id": "uuid", "limit": 100, "cursor": 0 }
```
- Output:
```json
{ "samples": [{ "id": 1, "ts": "ISO-8601", "cpu_pct": 10.0, "memory_mb": 120.0, "launch_ms": 0.0, "fps": null, "jank_pct": null, "metric_flags": { "cpu_pct": "ok" } }], "next_cursor": 1 }
```
