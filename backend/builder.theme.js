"use strict";

const fs = require("fs");
const path = require("path");

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const DEFAULTS = {
  slug: "mono", label: "Mono", dark: false,
  bg: "#FFFFFF", surface: "#FFFFFF", surfaceAlt: "#F7F8FA", field: "#F4F5F7",
  border: "#E3E5E8", accent: "#111827", accentSoft: "#EDEFF2", onAccent: "#FFFFFF",
  text: "#111827", muted: "#6B7280", success: "#16A34A", danger: "#DC2626",
  warn: "#B45309", logoText: "DV", brand: "DESI VIDEOS",
  tagline: "Desi special content available", hero: [],
};

const COLOR_KEYS = [
  "bg", "surface", "surfaceAlt", "field", "border", "accent", "accentSoft",
  "onAccent", "text", "muted", "success", "danger", "warn",
];

function themesDir(templateDir) {
  return path.join(templateDir, "themes");
}

function list(templateDir) {
  const root = themesDir(templateDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root).sort()) {
    const file = path.join(root, name, "theme.json");
    if (!fs.existsSync(file)) continue;
    try {
      const t = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!t.slug) t.slug = name;
      out.push(t);
    } catch (_) {}
  }
  return out;
}

function load(templateDir, slug) {
  const safe = SLUG.test(String(slug || "")) ? String(slug) : "mono";
  const file = path.join(themesDir(templateDir), safe, "theme.json");
  if (!fs.existsSync(file)) return { ...DEFAULTS, slug: safe };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")), slug: safe };
  } catch (_) {
    return { ...DEFAULTS, slug: safe };
  }
}

function toArgb(hex) {
  const h = String(hex || "").replace("#", "").trim().toUpperCase();
  if (h.length === 6) return "#FF" + h;
  if (h.length === 8) return "#" + h;
  return "#FF000000";
}

function inject(templateDir, workDir, slug, appName) {
  const theme = load(templateDir, slug);
  if (appName) theme.brand = String(appName);

  const assets = path.join(workDir, "app", "src", "main", "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "theme.json"), JSON.stringify(theme, null, 2), "utf8");

  const values = path.join(workDir, "app", "src", "main", "res", "values");
  fs.mkdirSync(values, { recursive: true });

  const lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"];
  for (const key of COLOR_KEYS) {
    const name = "theme_" + key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    lines.push(`    <color name="${name}">${toArgb(theme[key])}</color>`);
  }
  lines.push("</resources>");
  fs.writeFileSync(path.join(values, "theme.xml"), lines.join("\n") + "\n", "utf8");

  return theme;
}

module.exports = { list, load, inject, themesDir, DEFAULTS, COLOR_KEYS };