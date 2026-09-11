#!/usr/bin/env node
// Fails when the tree, a commit message, or a PR body carries something only
// an employee could resolve. This repository is written for a stranger.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PATTERNS = [
  [/\bFAN-\d+\b/, "internal ticket id"],
  [/linear\.app\//i, "internal ticket link"],
  [/fancysauce\.ai\/internal/i, "internal URL"],
  [/\b(staging|preview)\.fancysauce\.ai\b/i, "internal environment hostname"],
  [/docs\/plans\//, "internal design-doc path"],
  [/claude\.ai\/code\//, "assistant session link"],
];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".changeset", "coverage"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(m?[jt]s|json|md|ya?ml|txt)$/.test(name)) yield p;
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

const args = process.argv.slice(2);
let hits = [];
if (args.length === 0) {
  for (const f of walk(process.cwd()))
    hits.push(...scan(readFileSync(f, "utf8"), relative(process.cwd(), f)));
} else if (args[0] === "--stdin") {
  hits = scan(readFileSync(0, "utf8"), "stdin");
} else {
  for (const f of args) hits.push(...scan(readFileSync(f, "utf8"), f));
}
if (hits.length) {
  console.error("Internal references found:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("No internal references.");
