import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, resetState } from "./mock-server.js";

describe("Vulmini Workflow Scenarios", () => {
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
        "Authorization": "Bearer my-secure-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: args },
        id: Date.now() + Math.floor(Math.random() * 1000)
      })
    });
    const data = await res.json() as any;
    if (data.error) {
      throw new Error(data.error.message);
    }
    return JSON.parse(data.result.content[0].text);
  }

  async function pollSnapshot(snapshotId: string) {
    for (let i = 0; i < 20; i++) {
      const snap = await callTool("get_snapshot_status", { snapshot_id: snapshotId });
      if (snap.status === "complete") {
        return snap;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timeout waiting for snapshot ${snapshotId}`);
  }

  async function pollInstance(instanceId: string) {
    for (let i = 0; i < 20; i++) {
      const inst = await callTool("get_instance_status", { instance_id: instanceId });
      if (inst.status === "active") {
        return inst;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timeout waiting for instance ${instanceId}`);
  }

  // 1. Twin-Instance WordPress Update Flow
  it("should complete the full Twin-Instance update loop successfully", async () => {
    if (process.env.MOCK_SERVER_EXTERNAL === "true") {
      await fetch("http://localhost:3000/reset", { method: "POST" });
    }
    resetState();

    // Step 1: Deploy production VPS
    const prodVps = await callTool("create_production_vps", {});
    assert.ok(prodVps.instance_id);
    assert.strictEqual(prodVps.status, "pending");

    // Wait for production VPS to become active
    const prodInstance = await pollInstance(prodVps.instance_id);
    assert.strictEqual(prodInstance.status, "active");

    // Step 2: Create a snapshot of the production instance
    const snapshotResult = await callTool("create_snapshot", {
      instance_id: prodInstance.id,
      description: "Pre-upgrade backup"
    });
    assert.ok(snapshotResult.snapshot_id);
    assert.strictEqual(snapshotResult.status, "pending");

    // Step 3: Wait for the snapshot to become complete
    const completeSnapshot = await pollSnapshot(snapshotResult.snapshot_id);
    assert.strictEqual(completeSnapshot.status, "complete");

    // Step 4: Create ephemeral staging from the snapshot
    const stagingVps = await callTool("create_ephemeral_staging", {
      snapshot_id: completeSnapshot.id
    });
    assert.ok(stagingVps.instance_id);
    assert.strictEqual(stagingVps.status, "pending");

    // Step 5: Wait for staging to become active
    const stagingInstance = await pollInstance(stagingVps.instance_id);
    assert.strictEqual(stagingInstance.status, "active");

    // Step 6: Set staging host IP
    const hostResult = await fetch("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "Authorization": "Bearer my-secure-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "set_staging_host", arguments: { host: stagingInstance.main_ip } },
        id: 99
      })
    });
    const hostData = await hostResult.json() as any;
    assert.match(hostData.result.content[0].text, /Staging host set/);

    // Step 7: Check plugin status on staging
    const stagingPlugins = await callTool("wp_plugin_status", { target: "staging" });
    assert.strictEqual(stagingPlugins.updates_available, 1);
    assert.strictEqual(stagingPlugins.plugins_with_updates[0].name, "sfwd-lms");

    // Step 8: Update plugins on staging
    const stagingUpdate = await callTool("wp_run_update", { target: "staging", plugin_slug: "sfwd-lms" });
    assert.match(stagingUpdate.output, /Updated 1 of 1 plugins/);

    // Verify plugins are updated on staging
    const stagingPluginsPost = await callTool("wp_plugin_status", { target: "staging" });
    assert.strictEqual(stagingPluginsPost.updates_available, 0);

    // Step 9: Run health check on staging
    const stagingHealth = await callTool("wp_health_check", { target: "staging" });
    assert.strictEqual(stagingHealth.is_healthy, true);

    // Step 10: Run backup on production
    const prodBackup = await callTool("wp_run_backup", { target: "production", scope: "full" });
    assert.match(prodBackup.output, /Backup created/);

    // Step 11: Update production plugins
    const prodUpdate = await callTool("wp_run_update", { target: "production", plugin_slug: "sfwd-lms" });
    assert.match(prodUpdate.output, /Updated 1 of 1 plugins/);

    // Step 12: Run db migration on production
    const prodMigration = await callTool("wp_db_migrate", { target: "production" });
    assert.match(prodMigration.output, /Database migrated/);

    // Step 13: Run health check on production
    const prodHealth = await callTool("wp_health_check", { target: "production" });
    assert.strictEqual(prodHealth.is_healthy, true);

    // Step 14: Destroy staging instance
    const destroyResult = await callTool("destroy_ephemeral_staging", {
      instance_id: stagingInstance.id
    });
    assert.match(destroyResult.message, /destroyed successfully/);

    // Verify staging instance is removed
    const listInstances = await callTool("list_instances", {});
    const stagingExists = listInstances.some((i: any) => i.id === stagingInstance.id);
    assert.strictEqual(stagingExists, false);
  });

  // 2. Concurrency Tests
  it("should handle multiple concurrent JSON-RPC requests correctly", async () => {
    const promises = Array.from({ length: 10 }).map((_, idx) => {
      return fetch("http://localhost:3000/mcp", {
        method: "POST",
        headers: {
          "Authorization": "Bearer my-secure-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
          id: idx
        })
      });
    });

    const responses = await Promise.all(promises);
    for (const res of responses) {
      assert.strictEqual(res.status, 200);
      const data = await res.json() as any;
      assert.strictEqual(data.jsonrpc, "2.0");
      assert.ok(data.result);
      assert.strictEqual(data.result.tools.length, 22);
    }
  });

  // 3. SSE Stream Keep-Alive Checks
  it("should send keep-alive comment events on SSE stream", async () => {
    const response = await fetch("http://localhost:3000/mcp", {
      method: "GET",
      headers: {
        "Authorization": "Bearer my-secure-token",
        "Accept": "text/event-stream"
      }
    });
    assert.strictEqual(response.status, 200);

    const reader = response.body?.getReader();
    if (!reader) {
      assert.fail("SSE stream body reader is undefined");
    }

    // Read initial handshake chunk
    const { value: handshakeVal } = await reader.read();
    const handshakeText = new TextDecoder().decode(handshakeVal);
    assert.match(handshakeText, /event: endpoint/);

    // Read subsequent keep-alive comment chunk
    const { value: keepAliveVal } = await reader.read();
    const keepAliveText = new TextDecoder().decode(keepAliveVal);
    assert.match(keepAliveText, /: keep-alive/);

    await reader.cancel();
    reader.releaseLock();
  });
});
