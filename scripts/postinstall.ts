#!/usr/bin/env bun

const warnings: string[] = [];

async function check(cmd: string, name: string, install: string): Promise<void> {
  try {
    const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) !== 0) {
      warnings.push(`  - ${name} (${cmd}) not found. Install: ${install}`);
    }
  } catch {
    warnings.push(`  - ${name} (${cmd}) not found. Install: ${install}`);
  }
}

await check("gpg", "GnuPG", "brew install gnupg (macOS) / apt install gnupg (Linux)");
await check("pass", "pass", "brew install pass (macOS) / apt install pass (Linux)");

if (warnings.length > 0) {
  console.warn("\n[fio-vault] Missing system dependencies:\n");
  for (const w of warnings) console.warn(w);
  console.warn("\n  fio-vault requires gpg and pass to encrypt/decrypt secrets.");
  console.warn("  See: https://github.com/fitznerIO/fio-vault#requirements\n");
}
