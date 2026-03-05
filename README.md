# lazy-mobile-mcp

Local **Model Context Protocol (MCP)** server for **Android and iOS mobile automation** with **performance telemetry**.  
Control real devices and simulators using `screenshot`, `tap`, `swipe`, `input_text`, `launch_app`, and collect baseline metrics (`cpu`, `memory`, `launch time`) with session history in SQLite.

Keywords: MCP server, mobile automation, Android ADB automation, iOS simulator automation, WebDriverAgent, app performance telemetry.

## Why This Project

- Build a local MCP bridge for AI clients over `stdio`.
- Automate Android via ADB and iOS via `simctl` / `devicectl` / WDA.
- Keep operations traceable with `trace_id` in responses and logs.
- Persist sessions, samples, and artifacts in SQLite for reproducibility.

## Features

- `stdio` MCP transport for local AI tooling.
- Single active device model (`select_device`) with optional per-call `device_id`.
- Android adapter via ADB CLI.
- iOS adapter via Xcode tools with macOS guard and graceful degradation.
- WDA endpoint auto-discovery for iOS interactive actions.
- JSON logging and unified error contract.
- SQLite persistence for `sessions`, `perf_samples`, `artifacts`, `audit_logs`.

## Tool Index

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

## Architecture

- TypeScript MCP server + worker (tool contracts, validation, policy, trace ID)
- Android adapter (`adb`)
- iOS adapter (`simctl`, `devicectl`, WDA)
- SQLite storage (`artifacts/mobile.db`)

## Prerequisites

- Node.js 20+
- Android: `adb` in `PATH`
- iOS (optional): macOS + `xcrun` (`simctl`/`devicectl`)
- For iOS interactive actions (`tap/swipe/input`): reachable WebDriverAgent endpoint

## Install

```bash
npm install
```

## Install From npm

```bash
npm install lazy_mobile_mcp
```

## Quick Start (Codex)

Requires `codex` CLI in `PATH`.

Published package:

```bash
npx -y lazy_mobile_mcp@latest setup-codex
```

Verify registration:

```bash
codex mcp get lazy-mobile-mcp
```

Then open a new Codex session and call `mobile.list_devices`.

Current local checkout:

```bash
node bin/lazy-mobile-mcp.js setup-codex --local --name lazy-mobile-mcp-local
```

## Codex One-Command Setup (Advanced)

Optional overrides:

```bash
npx -y lazy_mobile_mcp@latest setup-codex \
  --name lazy-mobile-mcp \
  --sqlite-path "$HOME/.codex/mcp-data/lazy-mobile/mobile.db" \
  --adb-bin adb \
  --wda-base-url http://127.0.0.1:8100
```

Local checkout with the same overrides:

```bash
node bin/lazy-mobile-mcp.js setup-codex \
  --local \
  --name lazy-mobile-mcp-local \
  --sqlite-path "$HOME/.codex/mcp-data/lazy-mobile/mobile.db" \
  --adb-bin adb
```

Run with `npx`:

```bash
npx -y lazy_mobile_mcp@latest
```

Global install:

```bash
npm install -g lazy_mobile_mcp
lazy-mobile-mcp
```

## Run

Development:

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

## Configuration

- `SQLITE_PATH` (default `artifacts/mobile.db`)
- `DEVICE_ALLOWLIST` (comma-separated)
- `LOG_LEVEL` (`debug|info|warn|error`)
- `ADB_BIN` (default `adb`)
- `WDA_BASE_URL` (optional override for iOS WDA endpoint)

If `WDA_BASE_URL` is not set, the adapter probes common local endpoints (`127.0.0.1` / `localhost`, ports `8100/8101/8200/8201` + local listening ports).

## iOS Capability Notes

- Simulator: screenshot + launch/stop + WDA interactive actions.
- Physical device: launch/stop via `devicectl`; screenshot and interactive actions via WDA.
- Non-macOS host: iOS tools return `ERR_IOS_UNAVAILABLE_ON_HOST`.

## Testing

```bash
npm test
```

Recommended local MCP smoke:

```bash
node dist/cli.js --help
node dist/cli.js setup-codex --help
```
