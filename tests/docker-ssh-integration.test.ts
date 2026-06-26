import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer } from "./mock-server.js";

describe("Docker and SSH Integration", () => {
  before(() => {
    process.env.MCP_BEARER_TOKEN = "my-secure-token";
    startServer(3000);
  });

  after(() => {
    stopServer();
  });

  async function callTool(name: string, args: any) {
    const res = await fetch("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer my-secure-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: args },
        id: 1,
      }),
    });
    const data = (await res.json()) as any;
    if (data.error) {
      throw new Error(data.error.message);
    }
    return JSON.parse(data.result.content[0].text);
  }

  it("should get Docker status containing 5 healthy containers", async () => {
    const result = await callTool("get_docker_status", {
      target: "production",
    });
    assert.strictEqual(result.target, "production");
    assert.strictEqual(result.total, 5);
    assert.ok(Array.isArray(result.containers));
    const names = result.containers.map((c: any) => c.name);
    assert.ok(names.includes("vulmini_db"));
    assert.ok(names.includes("vulmini_app"));
    assert.ok(names.includes("vulmini_web"));
    assert.strictEqual(result.containers[0].state, "running");
    assert.match(result.containers[0].status, /healthy/);
  });

  it("should deploy the Docker stack successfully", async () => {
    const res = await fetch("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer my-secure-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "deploy_stack", arguments: { target: "production" } },
        id: 1,
      }),
    });
    const data = (await res.json()) as any;
    assert.ok(data.result);
    assert.match(
      data.result.content[0].text,
      /Docker Stack deployed successfully/,
    );
  });

  it("should retrieve system health metrics", async () => {
    const health = await callTool("get_system_health", {
      target: "production",
    });
    assert.strictEqual(health.cpu_cores, 2);
    assert.ok(Array.isArray(health.load_average));
    assert.strictEqual(health.load_average.length, 3);
    assert.strictEqual(health.memory_total_mb, 4096);
    assert.strictEqual(health.disk_total_gb, 80);
    assert.strictEqual(health.uptime_human, "1h");
  });

  it("should fetch WordPress error logs", async () => {
    const result = await callTool("fetch_error_logs", {
      target: "production",
      lines: 100,
    });
    assert.strictEqual(result.target, "production");
    assert.strictEqual(result.lines_requested, 100);
    assert.match(result.log_content, /debug.log/);
  });

  it("should fetch Nginx logs", async () => {
    const result = await callTool("fetch_nginx_logs", {
      target: "production",
      log_type: "error",
      lines: 50,
    });
    assert.strictEqual(result.target, "production");
    assert.strictEqual(result.log_type, "error");
    assert.strictEqual(result.lines_requested, 50);
    assert.match(result.log_content, /Nginx/);
  });

  it("should configure WordPress presets successfully", async () => {
    const res = await fetch("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer my-secure-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "wp_configure_preset",
          arguments: {
            target: "production",
            preset: "landing",
            title: "Test Site",
            admin_user: "dev",
            admin_password: "SecurePassword123!",
          },
        },
        id: 1,
      }),
    });
    const data = (await res.json()) as any;
    assert.ok(data.result);
    assert.match(
      data.result.content[0].text,
      /WordPress preset 'landing' configured successfully/,
    );
  });
});
