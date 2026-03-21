#!/usr/bin/env bun

/**
 * Installs the fio-vault Claude Code skill into ~/.claude/skills/fio-vault/
 * Run: bun scripts/install-skill.ts
 */

import { existsSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const projectSkillDir = join(import.meta.dirname, "..", "skill");
const targetDir = join(homedir(), ".claude", "skills", "fio-vault");

if (!existsSync(join(projectSkillDir, "SKILL.md"))) {
  console.error("Error: skill/SKILL.md not found in project.");
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
cpSync(projectSkillDir, targetDir, { recursive: true });

console.log(`fio-vault skill installed to: ${targetDir}`);
console.log("Claude Code will now use this skill for secret management tasks.");
