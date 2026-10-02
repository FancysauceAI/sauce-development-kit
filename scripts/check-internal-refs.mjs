#!/usr/bin/env node
// Fails when the tree, a commit message, or a PR body carries something only
// an employee could resolve. This repository is written for a stranger.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PATTERNS = [
  [/\bFAN-\d+\b/, "internal ticket id"],
  [/linear\.app\//i, "internal ticket link"],
  [/fancysauce\.ai\/internal/i, "internal URL"],
  [/\b(staging|preview)\.fancysauce\.ai\b/i, "internal environment hostname"],
  // Anchored so an ordinary sentence about documentation plans cannot trip it,
  // while a real path reference — bare, quoted, bracketed, or fenced — does.
  [/(^|[\s"'([`])docs\/plans\//, "internal design-doc path"],
  [/claude\.ai\/code\//, "assistant session link"],
];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);
// `.changeset/*.md` is deliberately absent: those entries become the CHANGELOG.
// This scanner is exempt because its own regex sources are the patterns; the
// two changeset files are upstream scaffolding.
const SKIP_FILES = new Set([
  ".changeset/README.md",
  ".changeset/config.json",
  "scripts/check-internal-refs.mjs",
]);
const SCANNABLE = /\.([mc]?[jt]sx?|json|ya?ml|md|txt)$/;

const toPosix = (p) => p.split(sep).join("/");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Symlinks are skipped rather than followed: a link out of the tree is not
    // this repository's content, and a link back into it is a cycle.
    if (entry.isSymbolicLink()) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(p);
    } else if (entry.isFile() && SCANNABLE.test(entry.name)) {
      yield p;
    }
  }
}

function scan(text, label) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const [re, why] of PATTERNS)
      if (re.test(line)) hits.push(`${label}:${i + 1}: ${why}: ${line.trim()}`);
  });
  return hits;
}

// A file's own name can carry a reference the contents never mention.
function scanPath(path) {
  const hits = [];
  for (const [re, why] of PATTERNS) if (re.test(path)) hits.push(`${path}: ${why}: in file path`);
  return hits;
}

function scanFile(path, label) {
  return [...scanPath(label), ...scan(readFileSync(path, "utf8"), label)];
}

const args = process.argv.slice(2);
let hits = [];
if (args.length === 0) {
  for (const f of walk(process.cwd())) {
    const rel = toPosix(relative(process.cwd(), f));
    if (SKIP_FILES.has(rel)) continue;
    hits.push(...scanFile(f, rel));
  }
} else if (args[0] === "--stdin") {
  hits = scan(readFileSync(0, "utf8"), "stdin");
} else {
  for (const f of args) hits.push(...scanFile(f, toPosix(f)));
}
if (hits.length) {
  console.error("Internal references found:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("No internal references.");
