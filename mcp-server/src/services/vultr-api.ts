// ==========================================
// VULMINI — Vultr API v2 Client
// ==========================================
// HTTP Client for Vultr REST API.
// Manages instances, snapshots, and Object Storage.

import type {
  VultrInstance,
  VultrSnapshot,
  VultrObjectStorage,
  CreateInstanceRequest,
  CreateSnapshotRequest,
} from "../types/vultr.js";

const VULTR_API_BASE = "https://api.vultr.com/v2";

export class VultrApiClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  // ── Private Helpers ──

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${VULTR_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // DELETE returns 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Vultr API error ${response.status} ${method} ${path}: ${errorText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  // ── SSH Keys ──

  /** List all SSH keys */
  async listSshKeys(): Promise<{
    ssh_keys: Array<{
      id: string;
      name: string;
      ssh_key: string;
      date_created: string;
    }>;
  }> {
    return this.request("GET", "/ssh-keys");
  }

  /** Create a new SSH key */
  async createSshKey(
    name: string,
    sshKey: string,
  ): Promise<{
    ssh_key: {
      id: string;
      name: string;
      ssh_key: string;
      date_created: string;
    };
  }> {
    return this.request("POST", "/ssh-keys", { name, ssh_key: sshKey });
  }

  // ── Instances ──

  /** List all VPS instances */
  async listInstances(): Promise<VultrInstance[]> {
    const data = await this.request<{ instances: VultrInstance[] }>(
      "GET",
      "/instances",
    );
    return data.instances;
  }

  /** Get a specific instance by ID */
  async getInstance(instanceId: string): Promise<VultrInstance> {
    const data = await this.request<{ instance: VultrInstance }>(
      "GET",
      `/instances/${instanceId}`,
    );
    return data.instance;
  }

  /** Create a new instance (e.g., from snapshot for staging) */
  async createInstance(params: CreateInstanceRequest): Promise<VultrInstance> {
    const data = await this.request<{ instance: VultrInstance }>(
      "POST",
      "/instances",
      params,
    );
    return data.instance;
  }

  /** Delete an instance permanently */
  async deleteInstance(instanceId: string): Promise<void> {
    await this.request<void>("DELETE", `/instances/${instanceId}`);
  }

  /**
   * Wait for an instance to reach "active" status.
   * Polls every `intervalMs` up to `maxAttempts` times.
   */
  async waitForInstanceActive(
    instanceId: string,
    intervalMs = 10_000,
    maxAttempts = 60,
  ): Promise<VultrInstance> {
    for (let i = 0; i < maxAttempts; i++) {
      const instance = await this.getInstance(instanceId);
      if (instance.status === "active" && instance.power_status === "running") {
        return instance;
      }
      console.error(
        `[Vulmini] Instance ${instanceId}: status=${instance.status}, power=${instance.power_status} (attempt ${i + 1}/${maxAttempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Instance ${instanceId} did not become active within ${(maxAttempts * intervalMs) / 1000}s`,
    );
  }

  // ── Snapshots ──

  /** List all snapshots */
  async listSnapshots(): Promise<VultrSnapshot[]> {
    const data = await this.request<{ snapshots: VultrSnapshot[] }>(
      "GET",
      "/snapshots",
    );
    return data.snapshots;
  }

  /** Get a specific snapshot */
  async getSnapshot(snapshotId: string): Promise<VultrSnapshot> {
    const data = await this.request<{ snapshot: VultrSnapshot }>(
      "GET",
      `/snapshots/${snapshotId}`,
    );
    return data.snapshot;
  }

  /** Create a snapshot from an instance */
  async createSnapshot(params: CreateSnapshotRequest): Promise<VultrSnapshot> {
    const data = await this.request<{ snapshot: VultrSnapshot }>(
      "POST",
      "/snapshots",
      params,
    );
    return data.snapshot;
  }

  /** Delete a snapshot */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.request<void>("DELETE", `/snapshots/${snapshotId}`);
  }

  /** Wait for a snapshot to reach "complete" status */
  async waitForSnapshotComplete(
    snapshotId: string,
    intervalMs = 15_000,
    maxAttempts = 120,
  ): Promise<VultrSnapshot> {
    for (let i = 0; i < maxAttempts; i++) {
      const snapshot = await this.getSnapshot(snapshotId);
      if (snapshot.status === "complete") {
        return snapshot;
      }
      console.error(
        `[Vulmini] Snapshot ${snapshotId}: status=${snapshot.status} (attempt ${i + 1}/${maxAttempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Snapshot ${snapshotId} did not complete within ${(maxAttempts * intervalMs) / 1000}s`,
    );
  }

  // ── Object Storage ──

  /** List Object Storage subscriptions */
  async listObjectStorage(): Promise<VultrObjectStorage[]> {
    const data = await this.request<{
      object_storages: VultrObjectStorage[];
    }>("GET", "/object-storage");
    return data.object_storages;
  }

  /** Get a specific Object Storage subscription */
  async getObjectStorage(storageId: string): Promise<VultrObjectStorage> {
    const data = await this.request<{ object_storage: VultrObjectStorage }>(
      "GET",
      `/object-storage/${storageId}`,
    );
    return data.object_storage;
  }
}
