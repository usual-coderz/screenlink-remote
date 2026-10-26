"use strict";

const fs = require("fs");
const path = require("path");

const KEYS = [
  "appId", "appName", "versionCode", "versionName", "baseUrl",
  "appSecret", "buildId", "theme", "minify", "shrinkResources",
];

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, " ")
    .trim();
}

function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

function writeBuilderProps(workDir, job) {
  const cfg = job.config || {};
  const map = {
    appId: cfg.applicationId || job.package || "",
    appName: job.appName || cfg.name || "",
    versionCode: cfg.versionCode || 1,
    versionName: cfg.versionName || "1.0",
    baseUrl: job.baseUrl || cfg.baseUrl || "",
    appSecret: cfg.appSecret || job.secret || "",
    buildId: job.buildId || String(job._id || ""),
    theme: job.theme || "mono",
    minify: cfg.minify === undefined ? "true" : String(!!cfg.minify),
    shrinkResources: cfg.shrinkResources === undefined ? "true" : String(!!cfg.shrinkResources),
  };
  write(path.join(workDir, "builder.properties"), KEYS.map((k) => `${k}=${esc(map[k])}`));
  return map;
}

function writeKeystoreProps(workDir, keystore) {
  const file = path.join(workDir, "keystore.properties");
  if (!keystore) {
    try { fs.rmSync(file, { force: true }); } catch (_) {}
    return null;
  }
  write(file, [
    `storeFile=${esc(keystore.path)}`,
    "storeType=JKS",
    `storePassword=${esc(keystore.storePassword)}`,
    `keyAlias=${esc(keystore.keyAlias)}`,
    `keyPassword=${esc(keystore.keyPassword)}`,
  ]);
  return file;
}

function writeAppName(workDir, appName) {
  if (!appName) return;
  const file = path.join(workDir, "app", "src", "main", "res", "values", "strings.xml");
  if (!fs.existsSync(file)) return;
  const safe = String(appName).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const xml = fs.readFileSync(file, "utf8")
    .replace(/<string name="app_name">[\s\S]*?<\/string>/, `<string name="app_name">${safe}</string>`);
  fs.writeFileSync(file, xml, "utf8");
}

module.exports = { writeBuilderProps, writeKeystoreProps, writeAppName };