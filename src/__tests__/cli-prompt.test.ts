import { describe, test, expect } from "bun:test";

/**
 * Tests that the prompt line-reader correctly handles sequential reads
 * and special characters like @, which broke with raw-mode approaches.
 */

// Mirror the actual cli.ts readLine logic: buffered line splitting from a string.
function makePromptFn(mockLines: string[]) {
  const data = mockLines.join("\n") + "\n";
  let buf = data;

  function readLine(): string {
    const idx = buf.indexOf("\n");
    if (idx === -1) {
      const rest = buf;
      buf = "";
      return rest;
    }
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    return line;
  }

  function prompt(question: string): string {
    return readLine().trim();
  }

  return { prompt };
}

describe("cli prompt", () => {
  test("reads multiple sequential prompts", () => {
    const { prompt } = makePromptFn(["Global Vault", "sascha@example.com", "s3cr3t"]);
    expect(prompt("Name: ")).toBe("Global Vault");
    expect(prompt("Email: ")).toBe("sascha@example.com");
    expect(prompt("Passphrase: ")).toBe("s3cr3t");
  });

  test("preserves @ character in email input", () => {
    const { prompt } = makePromptFn(["user@domain.com"]);
    const email = prompt("Email: ");
    expect(email).toBe("user@domain.com");
    expect(email).toContain("@");
  });

  test("@ survives in second and third sequential prompt", () => {
    const { prompt } = makePromptFn(["Vault", "admin@company.org", "pass123"]);
    prompt("Name: ");
    const email = prompt("Email: ");
    const pass = prompt("Passphrase: ");
    expect(email).toBe("admin@company.org");
    expect(email).toContain("@");
    expect(pass).toBe("pass123");
  });

  test("trims whitespace from input", () => {
    const { prompt } = makePromptFn(["  hello@test.com  "]);
    expect(prompt("Email: ")).toBe("hello@test.com");
  });

  test("returns empty string on EOF", () => {
    const { prompt } = makePromptFn([]);
    expect(prompt("Email: ")).toBe("");
  });

  test("handles special characters beyond @", () => {
    const { prompt } = makePromptFn(["p@$$w0rd!#&*"]);
    expect(prompt("Passphrase: ")).toBe("p@$$w0rd!#&*");
  });
});
