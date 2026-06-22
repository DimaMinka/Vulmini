import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer } from "./mock-server.js";

describe("MCP JSON-RPC Protocol Compliance", () => {
  before(() => {
    process.env.MCP_BEARER_TOKEN = "my-secure-token";
    startServer(3000);
  });

  after(() => {
    stopServer();
  });

  async function sendRpc(payload: any) {
    const res = await fetch("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "Authorization": "Bearer my-secure-token",
        "Content-Type": "application/json"
      },
      body: typeof payload === "string" ? payload : JSON.stringify(payload)
    });
    return res;
  }

  it("should return tools list with correct JSON-RPC structure", async () => {
    const res = await sendRpc({
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 10
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.jsonrpc, "2.0");
    assert.strictEqual(data.id, 10);
    assert.ok(data.result);
    assert.ok(Array.isArray(data.result.tools));
    assert.strictEqual(data.result.tools.length, 21);
    const toolNames = data.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("list_instances"));
    assert.ok(toolNames.includes("wp_plugin_status"));
  });

  it("should reject invalid JSON payload with Parse Error (-32700)", async () => {
    const res = await sendRpc("{ invalid json }");
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.strictEqual(data.jsonrpc, "2.0");
    assert.strictEqual(data.id, null);
    assert.ok(data.error);
    assert.strictEqual(data.error.code, -32700);
    assert.strictEqual(data.error.message, "Parse error");
  });

  it("should reject missing jsonrpc field with Invalid Request (-32600)", async () => {
    const res = await sendRpc({
      method: "tools/list",
      params: {},
      id: 11
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.ok(data.error);
    assert.strictEqual(data.error.code, -32600);
  });

  it("should reject unknown method with Method Not Found (-32601)", async () => {
    const res = await sendRpc({
      jsonrpc: "2.0",
      method: "invalid_method",
      params: {},
      id: 12
    });
    assert.strictEqual(res.status, 404);
    const data = await res.json() as any;
    assert.ok(data.error);
    assert.strictEqual(data.error.code, -32601);
  });

  it("should reject calling an unknown tool with Method Not Found (-32601)", async () => {
    const res = await sendRpc({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "non_existent_tool", arguments: {} },
      id: 13
    });
    assert.strictEqual(res.status, 404);
    const data = await res.json() as any;
    assert.ok(data.error);
    assert.strictEqual(data.error.code, -32601);
  });

  it("should validate input schema: missing required parameters", async () => {
    const res = await sendRpc({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "wp_plugin_status", arguments: {} },
      id: 14
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.ok(data.error);
    assert.strictEqual(data.error.code, -32602);
    assert.match(data.error.message, /Invalid params/);
  });

  it("should validate input schema: invalid parameter types", async () => {
    const res = await sendRpc({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "get_instance_status", arguments: { instance_id: "not-a-uuid" } },
      id: 15
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.ok(data.error);
    assert.strictEqual(data.error.code, -32602);
  });
});
