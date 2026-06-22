# Vulmini E2E Test Infrastructure Design & Feature Inventory

This document details the architecture, configuration, and components of the end-to-end (E2E) testing infrastructure built for Vulmini.

---

## 1. Testing Architecture Overview

To enable fast, deterministic, offline E2E validation of the Vulmini management stack, we use a **Stateful Mock Server** executing inside Node.js. 

```
┌──────────────────┐
│   Test Runner    │
│  (node:test/tsx) │
└────────┬─────────┘
         │
         │ (HTTP / GET SSE / POST JSON-RPC)
         ▼
┌──────────────────┐
│   Mock Server    │ <───> [Stateful In-Memory Infrastructure]
│   (Port 3000)    │       (VPS, Snapshots, Backups, Plugins state)
└──────────────────┘
```

The mock server simulates both the **Nginx reverse proxy gateway** and the **MCP server** itself. It provides the following interfaces:
1. **Bearer Token Authentication**: Replicates the timing-safe header validation.
2. **Server-Sent Events (SSE) Stream (`GET /mcp`)**: Replicates the event-stream handshake and persistent keep-alive signals.
3. **JSON-RPC Handling (`POST /mcp`)**: Validates protocol compliance (JSON-RPC 2.0 envelopes, parse errors, missing methods, input schemas) and routes calls to simulated infrastructure managers.

---

## 2. Tested Feature Inventory

The E2E test suite covers four distinct tiers of system validation:

### Tier 1: Gateway Routing & Auth (`gateway-routing.test.ts`)
- **GET /mcp SSE Streaming**: Verifies `200 OK`, `Content-Type: text/event-stream`, no buffering (`X-Accel-Buffering: no`), and initial endpoint data transmission.
- **Timing-Safe Auth**: Validates correct bearer token matching, missing token denials, same-length token rejection, different-length token rejection, and constant-time behavior.
- **Nginx Redirection**: Simulates HTTP to HTTPS 301 redirects and location routing.

### Tier 2: MCP Protocol Compliance (`protocol-compliance.test.ts`)
- **`tools/list` Formatting**: Asserts return envelope structures match MCP standards and contain all 21 tools with Zod schemas.
- **Input Validation**: Ensures parameter schemas (UUID formats, targets, enum types) trigger `-32602` Invalid Params errors.
- **RPC Protocol Errors**: Ensures malformed JSON yields `-32700` Parse Error and incorrect method calls yield `-32601` Method Not Found errors.

### Tier 3: Docker & SSH Integration (`docker-ssh-integration.test.ts`)
- **Docker Status**: Checks telemetry results of `get_docker_status` mapping to running, healthy containers.
- **OS Telemetry**: Tests `get_system_health` returning formatted load averages, RAM/disk limits, and CPU cores.
- **Stack Deployments**: Validates stack tar packaging and remote service initialization mock flows.
- **Logs Management**: Verifies `fetch_error_logs` and `fetch_nginx_logs` return tail limits.

### Tier 4: Real-World Twin-Instance Workflow (`workflow.test.ts`)
- **Twin-Instance Update Loop**: Runs the complete lifecycle:
  1. Spawning production VPS and polling until active.
  2. Generating pre-upgrade snapshot and polling until complete.
  3. Spawning ephemeral staging clone from snapshot.
  4. Setting staging host IP in configuration.
  5. Verifying available plugin updates on staging.
  6. Updating staging plugins and performing health checks.
  7. Taking production DB and codebase backups.
  8. Applying updates to production plugins.
  9. Executing DB migrations and LearnDash upgrades.
  10. Testing production health.
  11. Destroying ephemeral staging and verifying resource cleanup.
- **Concurrency**: Spawns multiple JSON-RPC calls concurrently to test thread safety and stream bandwidth.
- **SSE Keep-Alives**: Monitors SSE connections to ensure periodic keep-alive comments are written to prevent timeouts.

---

## 3. How to Run the Tests

To run the E2E test suite locally:

1. Navigate to the `mcp-server` directory:
   ```bash
   cd mcp-server
   ```
2. Run the test script:
   ```bash
   npm run test:e2e
   ```

The script will launch the mock server, execute all test files in order, report the results, and automatically shut down the server when complete.
