# Project: Vulmini MCP HTTP Transport & Docker Stack Integration

## Architecture
- **Client ↔ Nginx Gateway**: Client makes requests over HTTPS to `https://vulmini.cdk.app/mcp`. Nginx handles TLS termination, redirects HTTP `/mcp` requests to HTTPS, and acts as a gateway proxy.
- **Nginx ↔ MCP Server**: Nginx proxies the `/mcp` endpoint to the `vulmini_mcp` container on port `3000` (or other designated port). Proxy buffering and caching are disabled (`proxy_buffering off;`, `proxy_cache off;`) for real-time Server-Sent Events (SSE) streaming.
- **MCP Server HTTP Transport**: The MCP server drops stdio transport and runs purely in HTTP mode using `express`. A unified `/mcp` endpoint handles both GET (handshake/event stream setup) and POST (JSON-RPC requests).
- **Security Check**: Static Bearer authentication checks the request's Authorization header against `MCP_BEARER_TOKEN`. Protection against timing attacks is achieved using `crypto.timingSafeEqual` with buffer length alignment.

## Code Layout
- `mcp-server/src/index.ts`: MCP server bootstrap, Express setup, SSE transport, and timing-safe authentication middleware.
- `mcp-server/Dockerfile`: Multi-stage build compilation for the TypeScript-based MCP server.
- `docker-compose.yml`: Definition for the `vulmini_mcp` service, networking, environment variables, and health checks.
- `nginx/default.conf`: Nginx reverse proxy configuration for `/mcp`.
- `tests/`: Opaque-box E2E test cases (Tiers 1-4) and test runner.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| 1 | E2E Testing Track | Design E2E test infrastructure, write Tier 1-4 test cases, publish `TEST_READY.md` | None | DONE |
| 2 | MCP HTTP & Auth Implementation | Refactor MCP server to Express-based HTTP server, add timing-safe bearer token check, and verify compilation | M1 | PLANNED |
| 3 | Docker & Nginx Integration | Create multi-stage `Dockerfile`, add `vulmini_mcp` service to `docker-compose.yml`, update Nginx reverse proxy configuration | M2 | PLANNED |
| 4 | E2E Verification | Deploy Docker stack locally, run E2E test suite (Tiers 1-4), run Reviewers, Challengers, and Forensic Auditor | M3 | PLANNED |
| 5 | Adversarial Hardening | Run Challenger-led adversarial coverage hardening (Tier 5), fix bugs, final Auditor check | M4 | PLANNED |

## Interface Contracts
### Client ↔ Nginx Gateway
- **GET /mcp**: Establishes Server-Sent Events (SSE) connection.
  - Headers: `Authorization: Bearer <token>`, `Accept: text/event-stream`
  - Returns: `200 OK` with `Content-Type: text/event-stream`, starts streaming SSE handshake.
- **POST /mcp**: Sends JSON-RPC messages.
  - Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
  - Body: JSON-RPC request (e.g. `{ "jsonrpc": "2.0", "method": "tools/list", "id": 1 }`)
  - Returns: `200 OK` with JSON-RPC response.
- **Unauthorized Requests**:
  - Missing or invalid token returns `401 Unauthorized` with clear timing-safe rejection.
