import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as gpg from "../gpg";
import { cmdGet } from "../cli";

describe("cmdGet — TTY guard", () => {
  let tmpDir: string;
  let isConfiguredSpy: ReturnType<typeof spyOn>;
  let decryptSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  const savedIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fio-vault-cliget-"));
    mkdirSync(join(tmpDir, "vault"), { recursive: true });
    writeFileSync(
      join(tmpDir, "vault", "manifest.json"),
      JSON.stringify({ "api-key": "API_KEY" }),
    );

    isConfiguredSpy = spyOn(gpg, "isConfigured").mockResolvedValue(true);
    decryptSpy = spyOn(gpg, "decrypt").mockImplementation(async (key: string) =>
      key === "api-key" ? "super-secret-value" : null,
    );

    stdoutWrites = [];
    stderrWrites = [];
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    consoleErrorSpy = spyOn(console, "error").mockImplementation((...args: any[]) => {
      stderrWrites.push(args.join(" "));
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    isConfiguredSpy.mockRestore();
    decryptSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: savedIsTTY,
      configurable: true,
      writable: true,
    });
  });

  function setTTY(value: boolean | undefined) {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
      writable: true,
    });
  }

  test("non-interactive (isTTY false), no --allow-raw → exit 3, no value on stdout", async () => {
    setTTY(false);
    const code = await cmdGet("api-key", tmpDir, false, false);
    expect(code).toBe(3);
    expect(stdoutWrites.join("")).not.toContain("super-secret-value");
    expect(stderrWrites.join("")).toContain("--allow-raw");
    expect(stderrWrites.join("")).toContain("exec");
  });

  test("isTTY undefined (pipe/capture), no --allow-raw → exit 3", async () => {
    setTTY(undefined);
    const code = await cmdGet("api-key", tmpDir, false, false);
    expect(code).toBe(3);
    expect(stdoutWrites.join("")).not.toContain("super-secret-value");
  });

  test("--allow-raw → prints value (any context)", async () => {
    setTTY(false);
    const code = await cmdGet("api-key", tmpDir, false, true);
    expect(code).toBe(0);
    expect(stdoutWrites.join("")).toBe("super-secret-value");
  });

  test("interactive TTY, no --allow-raw → prints (legacy behavior)", async () => {
    setTTY(true);
    const code = await cmdGet("api-key", tmpDir, false, false);
    expect(code).toBe(0);
    expect(stdoutWrites.join("")).toBe("super-secret-value");
  });

  test("block exit (3) differs from not-found exit (1)", async () => {
    // not found → exit 1 (reachable via --allow-raw so the guard does not pre-empt)
    setTTY(false);
    const notFound = await cmdGet("missing-key", tmpDir, false, true);
    expect(notFound).toBe(1);

    // blocked → exit 3
    const blocked = await cmdGet("api-key", tmpDir, false, false);
    expect(blocked).toBe(3);

    expect(blocked).not.toBe(notFound);
  });
});
