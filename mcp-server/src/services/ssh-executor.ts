// ==========================================
// VULMINI — SSH Command Executor
// ==========================================
// Executes commands on remote VPS hosts via SSH.
// Used by WP-CLI and telemetry to manage the server.

import { Client } from "ssh2";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

/** Result of executing an SSH command */
export interface SshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** SSH connection config */
export interface SshConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
}

export class SshExecutor {
  private config: SshConfig;

  constructor(config: SshConfig) {
    this.config = config;
  }

  /**
   * Resolve ~ to home directory in the private key path
   */
  private resolveKeyPath(keyPath: string): string {
    if (keyPath.startsWith("~")) {
      return resolve(homedir(), keyPath.slice(2));
    }
    return resolve(keyPath);
  }

  /**
   * Execute a command on the remote server via SSH.
   * Returns stdout, stderr, and exit code.
   * Timeout: 60 seconds by default.
   */
  async execute(
    command: string,
    options?: {
      host?: string;
      timeoutMs?: number;
    },
  ): Promise<SshCommandResult> {
    const host = options?.host ?? this.config.host;
    const timeoutMs = options?.timeoutMs ?? 60_000;

    return new Promise((resolve, reject) => {
      const conn = new Client();
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        conn.end();
        reject(
          new Error(
            `SSH command timed out after ${timeoutMs}ms: ${command.slice(0, 100)}`,
          ),
        );
      }, timeoutMs);

      conn.on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            reject(err);
            return;
          }

          stream.on("data", (data: Buffer) => {
            stdout += data.toString();
          });

          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });

          stream.on("close", (code: number) => {
            clearTimeout(timer);
            conn.end();
            if (!timedOut) {
              resolve({
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode: code ?? 0,
              });
            }
          });
        });
      });

      conn.on("error", (err) => {
        clearTimeout(timer);
        if (!timedOut) {
          reject(new Error(`SSH connection error to ${host}: ${err.message}`));
        }
      });

      const privateKey = readFileSync(
        this.resolveKeyPath(this.config.privateKeyPath),
      );

      conn.connect({
        host,
        port: this.config.port,
        username: this.config.username,
        privateKey,
        readyTimeout: 10_000,
      });
    });
  }

  /**
   * Execute a command inside a Docker container on the remote server.
   * Uses `docker exec` to run commands in the specified container.
   */
  async executeInContainer(
    containerName: string,
    command: string,
    options?: {
      host?: string;
      timeoutMs?: number;
      user?: string;
    },
  ): Promise<SshCommandResult> {
    const user = options?.user ? `--user ${options.user}` : "";
    const dockerCommand = `docker exec ${user} ${containerName} ${command}`;
    return this.execute(dockerCommand, {
      host: options?.host,
      timeoutMs: options?.timeoutMs ?? 120_000, // Docker commands may be slower
    });
  }
  /**
   * Upload a file to the remote server via SFTP.
   */
  async uploadFile(
    localPath: string,
    remotePath: string,
    options?: { host?: string },
  ): Promise<void> {
    const host = options?.host ?? this.config.host;

    return new Promise((resolvePromise, reject) => {
      const conn = new Client();

      conn.on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          sftp.fastPut(localPath, remotePath, {}, (err) => {
            conn.end();
            if (err) {
              reject(err);
            } else {
              resolvePromise();
            }
          });
        });
      });

      conn.on("error", (err) => {
        reject(
          new Error(`SFTP SSH connection error to ${host}: ${err.message}`),
        );
      });

      const privateKey = readFileSync(
        this.resolveKeyPath(this.config.privateKeyPath),
      );

      conn.connect({
        host,
        port: this.config.port,
        username: this.config.username,
        privateKey,
        readyTimeout: 10_000,
      });
    });
  }
}
