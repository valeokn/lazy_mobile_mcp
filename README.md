# lazy-mobile-mcp

A local MCP server for mobile device control and lightweight performance telemetry.

## Features

- `stdio` MCP transport for local AI clients.
- Single active device model with explicit selection.
- Android support via ADB CLI adapter layer.
- iOS support via Xcode tools (`simctl` + `devicectl`) with host capability guard.
- Tool-level trace IDs and JSON logs.
- SQLite persistence for sessions, samples, artifacts, and audit logs.

## Tool Set

- `mobile.list_devices`
- `mobile.select_device`
- `mobile.get_capabilities`
- `mobile.screenshot`
- `mobile.tap`
- `mobile.swipe`
- `mobile.input_text`
- `mobile.launch_app`
- `mobile.stop_app`
- `mobile.start_perf_session`
- `mobile.stop_perf_session`
- `mobile.get_perf_samples`

## Prerequisites

- Node.js 20+
- Python 3.11+
- Android: `adb` available in `PATH`
- iOS (optional): macOS + `xcrun` (`simctl`/`devicectl`); WDA URL if interactive tap/swipe/input is required

## Install

```bash
npm install
python3 -m pip install -r python/requirements.txt
```

### Install From npm

Install locally in another project:

```bash
npm install lazy_mobile_mcp
python3 -m pip install -r node_modules/lazy_mobile_mcp/python/requirements.txt
```

Run via `npx`:

```bash
npx lazy-mobile-mcp
```

For global install:

```bash
npm install -g lazy_mobile_mcp
python3 -m pip install -r "$(npm root -g)/lazy_mobile_mcp/python/requirements.txt"
lazy-mobile-mcp
```

## Run

```bash
npm run dev
```

For production build:

```bash
npm run build
npm start
```

## Configuration

Use environment variables:

- `PYTHON_BIN` (default `python3`)
- `PYTHON_WORKER_PATH` (default `python/worker.py`)
- `SQLITE_PATH` (default `artifacts/mobile.db`)
- `DEVICE_ALLOWLIST` (comma-separated)
- `LOG_LEVEL` (`debug|info|warn|error`)
- `WDA_BASE_URL` (optional override for iOS WDA endpoint)
  - If omitted, the adapter auto-discovers local WDA endpoints (localhost 8100/8101/8200/8201 + listening ports probe).

Current iOS status:
- Simulator: screenshot + app launch/stop (auto-boot before screenshot/launch).
- Physical: app launch/stop via `devicectl`; screenshot via WDA (explicit or auto-discovered endpoint).
- iOS tap/swipe/input: use WDA per-device session management (create/reuse/invalidate-recreate).
- iOS WDA endpoint: explicit `WDA_BASE_URL` is preferred, but automatic local discovery is enabled.

## Testing

```bash
npm test
python3 -m pytest python/tests
```
