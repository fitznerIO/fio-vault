import { describe, test, expect } from "bun:test";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

/**
 * Tests that the prompt() helper reads sequential lines correctly from stdin,
 * including special characters like @, which broke with raw-mode approaches.
 */

// Mirror the actual cli.ts implementation: readline with terminal:false + async iterator.
function makePromptFn(mockLines: string[]) {
  const readable = Readable.from(mockLines.join("\n") + "\n");
  const rl = createInterface({ input: readable, terminal: false });
  const lines = rl[Symbol.asyncIterator]();

  async function prompt(question: string): Promise<string> {
    const { value, done } = await lines.next();
    return done ? "" : value.trim();
  }

  return { prompt };
}

describe("cli prompt", () => {
  test("reads multiple sequential prompts", async () => {
    const { prompt } = makePromptFn(["Global Vault", "sascha@example.com", "s3cr3t"]);
    expect(await prompt("Name: ")).toBe("Global Vault");
    expect(await prompt("Email: ")).toBe("sascha@example.com");
    expect(await prompt("Passphrase: ")).toBe("s3cr3t");
  });

  test("preserves @ character in email input", async () => {
    const { prompt } = makePromptFn(["user@domain.com"]);
    const email = await prompt("Email: ");
    expect(email).toBe("user@domain.com");
    expect(email).toContain("@");
  });

  test("@ survives in second and third sequential prompt", async () => {
    const { prompt } = makePromptFn(["Vault", "admin@company.org", "pass123"]);
    await prompt("Name: ");
    const email = await prompt("Email: ");
    const pass = await prompt("Passphrase: ");
    expect(email).toBe("admin@company.org");
    expect(email).toContain("@");
    expect(pass).toBe("pass123");
  });

  test("trims whitespace from input", async () => {
    const { prompt } = makePromptFn(["  hello@test.com  "]);
    expect(await prompt("Email: ")).toBe("hello@test.com");
  });

  test("returns empty string on EOF", async () => {
    const { prompt } = makePromptFn([]);
    expect(await prompt("Email: ")).toBe("");
  });

  test("handles special characters beyond @", async () => {
    const { prompt } = makePromptFn(["p@$$w0rd!#&*"]);
    expect(await prompt("Passphrase: ")).toBe("p@$$w0rd!#&*");
  });
});
