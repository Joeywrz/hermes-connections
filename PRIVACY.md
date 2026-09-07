# Privacy and active checks

Enabling the plugin permits active optional-service checks when the page or status chip loads and every 60 seconds. Registration alone does not probe. MCP inventory uses the passive status RPC; manual refresh invokes active MCP tests and bounded retry, which can establish connections.

| Service | Existing prerequisite | Check |
|---|---|---|
| Hevy | macOS keychain service `hevy-api`, current user account | Reads keychain credential, requests `https://api.hevyapp.com/v1/user/info` |
| TickTick | `HERMES_HOME/ticktick/token.json` with `access_token` | Requests `https://api.ticktick.com/open/v1/project`; no token refresh |
| GitHub | `gh` and existing authentication | Runs `gh api user --silent` |
| Apple Calendar | macOS and separately trusted Apple Calendar plugin script | Runs its `scripts/list_calendars.js` via osascript; returns no calendar names |

Keychain and Calendar may show permission dialogs. A temporary Hermes profile does not isolate macOS permissions or `gh` authentication. The backend host performs these checks; remote-client credentials are not used. Missing optional prerequisites may hide a service, not prove health.

Responses expose fixed health labels and observation timestamps, not raw tokens, calendars, HTTP response bodies or command output. Other health-provider plugins are trusted executable code; SDK field validation does not detect secrets embedded in allowed display strings.

This repository contains source and synthetic tests, not runtime config, credentials, logs, databases or screenshots. Non-macOS systems do not receive macOS-only integrations. The plugin does not provide cross-platform Hevy credential storage or a login flow.
