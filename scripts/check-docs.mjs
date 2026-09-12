#!/usr/bin/env node
// Documentation checker: verifies structural invariants of the repository's
// documentation system. Rules themselves live in
// .agent/skills/documentation/SKILL.md — this script only enforces the ones
// that can be judged mechanically.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  // Smoke fixtures (kept only when DSH_SMOKE_KEEP=1) are scratch trees: they
  // contain seeded repositories whose README files are not project documents.
  ".dsh-smoke",
]);

// Directories managed by the bilingual documentation rules.
const AGENT_NOTE_DIR = path.join(REPO_ROOT, ".agent", "note");
const PLANS_ACTIVE_DIR = path.join(REPO_ROOT, "docs", "plans", "active");
const PLANS_COMPLETED_DIR = path.join(REPO_ROOT, "docs", "plans", "completed");
const DECISIONS_DIR = path.join(REPO_ROOT, "docs", "decisions");

// CHECK 6: documentation that intentionally discusses path formats (e.g. the
// Documentation Skill showing what NOT to write) can be exempted here instead
// of scattering special cases through the checks. Entries are matched as
// substrings against the full relative file path.
const ABSOLUTE_PATH_ALLOWLIST = [];

const ADR_NAME_PATTERN = /^ADR-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SCRATCHPAD_NOTE_NAME =
  /^(temp|tmp|draft\d*|test\d*|new|final\d*|notes\d+|scratch|scratchpad)\.md$/i;
const WRONG_ENGLISH_SUFFIX = /(_en|\.eng|\.english|-en)\.md$/i;

function findMarkdownFiles(dir = REPO_ROOT, result = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      findMarkdownFiles(path.join(dir, entry.name), result);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(path.join(dir, entry.name));
    }
  }
  return result;
}

const ALL_MARKDOWN_FILES = findMarkdownFiles();
const RELATIVE_MARKDOWN_FILES = ALL_MARKDOWN_FILES.map((p) => path.relative(REPO_ROOT, p));

function stripCodeFences(text) {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

function newResult(name) {
  return { name, issues: [] };
}

function issue(level, check, message, file, line) {
  return { level, check, message, file, line };
}

// CHECK 1
function checkReadmePairs() {
  const result = newResult("README bilingual pairs");
  for (const rel of RELATIVE_MARKDOWN_FILES) {
    const base = path.basename(rel);
    const dir = path.dirname(path.join(REPO_ROOT, rel));
    if (base === "README.md" && !existsSync(path.join(dir, "README.en.md"))) {
      result.issues.push(issue("error", result.name, "Missing counterpart: README.en.md", rel));
    }
    if (base === "README.en.md" && !existsSync(path.join(dir, "README.md"))) {
      result.issues.push(issue("error", result.name, "Missing counterpart: README.md", rel));
    }
  }
  return result;
}

// CHECK 2
function checkAgentNotePairs() {
  const result = newResult("Agent note bilingual pairs");
  const noteFiles = RELATIVE_MARKDOWN_FILES.filter(
    (rel) => path.resolve(REPO_ROOT, path.dirname(rel)) === AGENT_NOTE_DIR
  );
  const present = new Set(noteFiles.map((rel) => path.basename(rel)));
  for (const rel of noteFiles) {
    const base = path.basename(rel);
    const counterpart = base.endsWith(".en.md")
      ? base.slice(0, -6) + ".md"
      : base.slice(0, -3) + ".en.md";
    if (!present.has(counterpart)) {
      result.issues.push(issue("error", result.name, `Missing counterpart: ${counterpart}`, rel));
    }
  }
  return result;
}

// CHECK 3
function checkWrongEnglishSuffixes() {
  const result = newResult("English document suffixes");
  for (const rel of RELATIVE_MARKDOWN_FILES) {
    const base = path.basename(rel);
    if (WRONG_ENGLISH_SUFFIX.test(base)) {
      result.issues.push(
        issue("error", result.name, `Wrong English-suffix form, use ".en.md": ${base}`, rel)
      );
    }
  }
  return result;
}

// CHECK 4
function checkReadmeNavigation() {
  const result = newResult("README language navigation");
  for (const rel of RELATIVE_MARKDOWN_FILES) {
    const base = path.basename(rel);
    if (base !== "README.md" && base !== "README.en.md") continue;
    const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    if (base === "README.md" && !text.includes("README.en.md")) {
      result.issues.push(
        issue("error", result.name, "Chinese README does not link to README.en.md", rel)
      );
    }
    if (base === "README.en.md" && !text.includes("README.md")) {
      result.issues.push(
        issue("error", result.name, "English README does not link to README.md", rel)
      );
    }
  }
  return result;
}

// CHECK 5
function checkMarkdownLinks() {
  const result = newResult("Markdown local links");
  const linkPattern = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  for (const rel of RELATIVE_MARKDOWN_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    const text = stripCodeFences(readFileSync(abs, "utf8"));
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(linkPattern)) {
        let target = match[1];
        if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
        if (target.startsWith("#")) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:, ...
        let pathname = target.split("#")[0];
        try {
          pathname = decodeURIComponent(pathname);
        } catch {
          // keep raw target when percent-decoding fails
        }
        if (pathname === "") continue;
        const resolved = path.resolve(path.dirname(abs), pathname);
        if (!existsSync(resolved)) {
          result.issues.push(
            issue("error", result.name, `Broken link: ${target}`, rel, index + 1)
          );
        }
      }
    }
  }
  return result;
}

// CHECK 6
function checkAbsolutePaths() {
  const result = newResult("Absolute paths");
  const patterns = [
    [/\/(Users|home)\//, "Unix home absolute path"],
    [/[A-Za-z]:\\Users\\/i, "Windows user absolute path"],
    [/file:\/\//i, "file:// URL"],
  ];
  for (const rel of RELATIVE_MARKDOWN_FILES) {
    if (ABSOLUTE_PATH_ALLOWLIST.some((allowed) => rel.includes(allowed))) continue;
    const text = stripCodeFences(readFileSync(path.join(REPO_ROOT, rel), "utf8"));
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const [pattern, label] of patterns) {
        if (pattern.test(line)) {
          result.issues.push(
            issue("error", result.name, `Accidental ${label}: ${line.trim().slice(0, 80)}`, rel, index + 1)
          );
        }
      }
    }
  }
  return result;
}

// CHECK 7
function checkAgentNoteFilenames() {
  const result = newResult("Agent note filenames");
  const noteFiles = RELATIVE_MARKDOWN_FILES.filter(
    (rel) => path.resolve(REPO_ROOT, path.dirname(rel)) === AGENT_NOTE_DIR
  );
  for (const rel of noteFiles) {
    if (SCRATCHPAD_NOTE_NAME.test(path.basename(rel))) {
      result.issues.push(
        issue("error", result.name, "Scratchpad-style filename in .agent/note/", rel)
      );
    }
  }
  return result;
}

// CHECK 8
function checkPlanConflicts() {
  const result = newResult("Plan lifecycle");
  const listFiles = (dir) => {
    if (!existsSync(dir)) return [];
    return RELATIVE_MARKDOWN_FILES.filter(
      (rel) => path.resolve(REPO_ROOT, path.dirname(rel)) === dir
    ).map((rel) => path.basename(rel));
  };
  const active = new Set(listFiles(PLANS_ACTIVE_DIR));
  for (const name of listFiles(PLANS_COMPLETED_DIR)) {
    if (active.has(name)) {
      result.issues.push(
        issue("error", result.name, `Same plan exists in both active/ and completed/: ${name}`)
      );
    }
  }
  return result;
}

// CHECK 9
function checkAdrNames() {
  const result = newResult("ADR naming");
  const seenNumbers = new Map();
  const adrFiles = RELATIVE_MARKDOWN_FILES.filter((rel) => {
    if (path.resolve(REPO_ROOT, path.dirname(rel)) !== DECISIONS_DIR) return false;
    const base = path.basename(rel);
    return base !== "README.md" && base !== "README.en.md";
  });
  for (const rel of adrFiles) {
    const base = path.basename(rel);
    if (!ADR_NAME_PATTERN.test(base)) {
      result.issues.push(
        issue("error", result.name, `Invalid ADR filename, expected "ADR-NNNN-short-title.md": ${base}`, rel)
      );
      continue;
    }
    const number = base.slice(4, 8);
    if (seenNumbers.has(number)) {
      result.issues.push(
        issue("error", result.name, `Duplicate ADR number ${number}: ${base} and ${seenNumbers.get(number)}`, rel)
      );
    } else {
      seenNumbers.set(number, base);
    }
  }
  return result;
}

// CHECK 10
function checkEmptyDocuments() {
  const result = newResult("Empty documents");
  for (const rel of RELATIVE_MARKDOWN_FILES) {
    const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    if (text.trim() === "") {
      result.issues.push(issue("error", result.name, "Empty markdown document", rel));
    }
  }
  return result;
}

const CHECKS = [
  checkReadmePairs,
  checkAgentNotePairs,
  checkWrongEnglishSuffixes,
  checkReadmeNavigation,
  checkMarkdownLinks,
  checkAbsolutePaths,
  checkAgentNoteFilenames,
  checkPlanConflicts,
  checkAdrNames,
  checkEmptyDocuments,
];

function main() {
  const results = CHECKS.map((check) => check());
  let errors = 0;
  let warnings = 0;

  console.log("Documentation checks\n");
  for (const result of results) {
    const resultErrors = result.issues.filter((i) => i.level === "error");
    const resultWarnings = result.issues.filter((i) => i.level === "warning");
    errors += resultErrors.length;
    warnings += resultWarnings.length;
    if (result.issues.length === 0) {
      console.log(`[PASS] ${result.name}`);
      continue;
    }
    console.log(`[FAIL] ${result.name}`);
    for (const item of result.issues) {
      const location = [item.file, item.line].filter(Boolean).join(":");
      console.log(`       ${location ? location : "(repository)"}`);
      console.log(`       ${item.level.toUpperCase()}: ${item.message}`);
    }
  }
  console.log(`\n${errors} ${errors === 1 ? "error" : "errors"}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}.`);
  if (errors > 0) {
    console.log("\nDocumentation checks failed.");
    process.exitCode = 1;
  } else {
    console.log("\nDocumentation checks passed.");
  }
}

main();
