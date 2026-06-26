import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, timingSafeCompare } from "./mock-server.js";

describe("Gateway Routing & Authentication", () => {
  before(() => {
    process.env.MCP_BEARER_TOKEN = "my-secure-token";
    startServer(3000);
  });

  after(() => {
    stopServer();
  });

  // Tests for Feature 2: Bearer Authentication
  describe("Bearer Authentication (Timing-Safe Check)", () => {
    it("should accept valid token", async () => {
      const response = await fetch("http://localhost:3000/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer my-secure-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      assert.strictEqual(response.status, 200);
    });

    it("should reject missing token", async () => {
      const response = await fetch("http://localhost:3000/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      assert.strictEqual(response.status, 401);
    });

    it("should reject incorrect token of same length", async () => {
      const response = await fetch("http://localhost:3000/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer my-secure-tokea", // same length: 15 chars
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      assert.strictEqual(response.status, 401);
    });

    it("should reject incorrect token of different length", async () => {
      const response = await fetch("http://localhost:3000/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer short", // different length
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      assert.strictEqual(response.status, 401);
    });

    it("should verify timingSafeCompare behaves correctly", () => {
      assert.strictEqual(timingSafeCompare("key1", "key1"), true);
      assert.strictEqual(timingSafeCompare("key1", "key2"), false);
      assert.strictEqual(timingSafeCompare("key1", "longerkey"), false);
      assert.strictEqual(timingSafeCompare("longerkey", "key1"), false);
    });
  });

  // Tests for Feature 1: GET/POST /mcp Routing
  describe("GET/POST /mcp Routing", () => {
    it("should establish SSE event-stream on GET /mcp", async () => {
      const response = await fetch("http://localhost:3000/mcp", {
        method: "GET",
        headers: {
          Authorization: "Bearer my-secure-token",
          Accept: "text/event-stream",
        },
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        response.headers.get("content-type"),
        "text/event-stream",
      );
      assert.strictEqual(response.headers.get("x-accel-buffering"), "no");
      assert.strictEqual(response.headers.get("cache-control"), "no-cache");

      const reader = response.body?.getReader();
      if (!reader) {
        assert.fail("Response body reader is undefined");
      }
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.match(text, /event: endpoint/);
      assert.match(text, /data: \/mcp/);
      await reader.cancel();
      reader.releaseLock();
    });
  });

  // Tests for Feature 4: Nginx routing proxy, buffering, redirect logic
  describe("Nginx Routing Proxy & Redirect Logic", () => {
    it("should simulate HTTPS redirection correctly", async () => {
      const response = await fetch(
        "http://localhost:3000/nginx-redirect-test",
        {
          redirect: "manual",
        },
      );
      assert.strictEqual(response.status, 301);
      assert.strictEqual(
        response.headers.get("location"),
        "https://vulmini.cdk.app/mcp",
      );
    });
  });
});
