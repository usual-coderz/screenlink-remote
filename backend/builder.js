"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn: spawnProc, spawnSync } = require("child_process");
const express = require("express");

const config = require("./config");
const db = require("./database");
const u = require("./utils");
const themes = require("./builder.theme");
const linker = require("./builder.link");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const IS_WIN = process.platform === "win32";
const WIN_EXT = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
const IS_WORKER_PROC = process.argv.includes("--worker");
const WORKER_ID = `${os.hostname()}:${process.pid}`;

const SDK_ZIP_URL =
  "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip";
const JDK_URL =
  "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse";

const BASE_DIR = config.BASE_DIR || path.resolve(__dirname, "..");
const LOCK_STALE_MS = 15 * 60 * 1000;
const PEER_WAIT_MS = 20 * 60 * 1000;

const truthy = (v) => ["1", "true", "yes"].includes(String(v || "").toLowerCase());
const falsy = (v) => ["0", "false", "no"].includes(String(v || "").toLowerCase());

const builderConfig = {
  WORKER_MODE:
    process.env.BUILDER_WORKER_MODE || (IS_WORKER_PROC ? "inline" : "api"),
  ENGINE: process.env.BUILDER_ENGINE || "node",
  MAX_CONCURRENT_BUILDS: parseInt(process.env.MAX_CONCURRENT_BUILDS || "2", 10),
  DEFAULT_VARIANT: process.env.DEFAULT_VARIANT || "prod",
  DEFAULT_THEME: process.env.DEFAULT_THEME || "mono",

  STORAGE_ROOT: process.env.STORAGE_ROOT || path.join(BASE_DIR, "storage"),
  BUILD_ROOT: process.env.BUILD_ROOT || path.join(BASE_DIR, "storage", "builds"),
  KEYSTORE_DIR: process.env.KEYSTORE_DIR || path.join(BASE_DIR, "storage", "keystores"),
  GRADLE_ROOT: process.env.GRADLE_ROOT || path.join(BASE_DIR, "storage", "gradle"),
  TEMPLATE_DIR: process.env.TEMPLATE_DIR || "",
  PY_BUILDER: process.env.PY_BUILDER || "python3",

  GRADLE_BIN: process.env.GRADLE_BIN || "gradle",
  GRADLE_VERSION: process.env.GRADLE_VERSION || "8.9",
  KEYTOOL_BIN: process.env.KEYTOOL_BIN || "keytool",
  APKSIGNER_BIN: process.env.APKSIGNER_BIN || "apksigner",
  ZIPALIGN_BIN: process.env.ZIPALIGN_BIN || "zipalign",
  DOCKER_BIN: process.env.DOCKER_BIN || "docker",

  USE_DOCKER: truthy(process.env.USE_DOCKER),
  REQUIRE_SIGNATURE: !falsy(process.env.REQUIRE_SIGNATURE || "true"),
  CLEAN_WORKDIR: truthy(process.env.CLEAN_WORKDIR),
  AUTO_SDK: !falsy(process.env.AUTO_SDK || "true"),
  AUTO_JDK: !falsy(process.env.AUTO_JDK || "true"),
  AUTO_GRADLE: !falsy(process.env.AUTO_GRADLE || "true"),

  START_QUEUE: !falsy(process.env.BUILDER_START_QUEUE || "true"),
  SKIP_WARMUP: truthy(process.env.BUILDER_SKIP_WARMUP),

  BUILD_TIMEOUT_MS: parseInt(process.env.BUILD_TIMEOUT_MS || String(20 * 60 * 1000), 10),
  BUILD_POLL_MS: parseInt(process.env.BUILD_POLL_MS || "1500", 10),
  BUILD_STALE_MS: parseInt(process.env.BUILD_STALE_MS || String(60 * 60 * 1000), 10),
  MAX_LOG_LINES: 500,
  QUOTA_PER_DAY: parseInt(process.env.BUILD_QUOTA_PER_DAY || "0", 10),
};

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firstDir(cands) {
  for (const c of cands) {
    if (!c) continue;
    const abs = path.resolve(c);
    if (isDir(abs)) return abs;
  }
  return null;
}

/** dono spelling: apk_template (sahi) aur apk_templete (purana folder naam) */
function resolveTemplateDir() {
  if (process.env.TEMPLATE_DIR) {
    const abs = path.resolve(process.env.TEMPLATE_DIR);
    if (isDir(abs)) return abs;
  }
  return firstDir([
    path.join(BASE_DIR, "backend", "apk_template"),
    path.join(BASE_DIR, "backend", "apk_templete"),
    path.join(BASE_DIR, "apk_template"),
    path.join(BASE_DIR, "apk_templete"),
    path.join(process.cwd(), "backend", "apk_template"),
    path.join(process.cwd(), "backend", "apk_templete"),
    path.join(process.cwd(), "apk_template"),
    path.join(process.cwd(), "apk_templete"),
    path.join(__dirname, "apk_template"),
    path.join(__dirname, "apk_templete"),
    path.join(__dirname, "..", "backend", "apk_template"),
    path.join(__dirname, "..", "backend", "apk_templete"),
  ]);
}

/**
 * Managed SDK ko priority — distro ka /usr/lib/android-sdk adhoora hota hai
 * (na cmdline-tools, na licenses, na naye platform packages).
 */
function managedSdkRoot() {
  for (const e of [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME]) {
    if (e && isDir(path.join(e, "cmdline-tools"))) return path.resolve(e);
  }
  return path.join(builderConfig.STORAGE_ROOT, "android-sdk");
}

function resolveAndroidSdk() {
  const managed = managedSdkRoot();
  if (isDir(path.join(managed, "cmdline-tools")) || isDir(path.join(managed, "platforms"))) {
    return managed;
  }
  for (const c of [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME]) {
    if (c && isDir(path.resolve(c))) return path.resolve(c);
  }
  return null;
}

/** template se zaroori SDK level nikalo */
function detectCompileSdk(tmpl) {
  for (const rel of [
    "app/build.gradle",
    "app/build.gradle.kts",
    "build.gradle",
    "build.gradle.kts",
  ]) {
    const f = path.join(tmpl || "", rel);
    if (!isFile(f)) continue;
    try {
      const txt = fs.readFileSync(f, "utf8");
      const m = txt.match(/compileSdk(?:Version)?\s*[= ]\s*(\d{2})/);
      if (m) return parseInt(m[1], 10);
    } catch (_) {}
  }
  return 34;
}

function detectBuildToolsVersion(tmpl) {
  for (const rel of [
    "app/build.gradle",
    "app/build.gradle.kts",
    "build.gradle",
    "build.gradle.kts",
  ]) {
    const f = path.join(tmpl || "", rel);
    if (!isFile(f)) continue;
    try {
      const txt = fs.readFileSync(f, "utf8");
      const m = txt.match(/buildToolsVersion\s*[= ]\s*["']?([\d.]+)/);
      if (m) return m[1];
    } catch (_) {}
  }
  return "34.0.0";
}

function sdkHas(sdkDir, compileSdk, btVersion) {
  if (!sdkDir) return false;
  return (
    isDir(path.join(sdkDir, "platforms", `android-${compileSdk}`)) &&
    isDir(path.join(sdkDir, "build-tools", btVersion))
  );
}

/** Gradle jo licenses file padhta hai — seedha likh do. */
function writeLicenseHashes(root) {
  const dir = path.join(root, "licenses");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const files = {
    "android-sdk-license":
      "\n8933bad161af4178b1185d1a37fbf41ea5269c55\nd56f5187479451eabf01fb78af6dfcb131a6481e\n24333f8a63b6825ea9c5514f83c2829b004d1fee\n",
    "android-sdk-preview-license": "\n84831b9409646a918e30573bab4c9c91346d8abd\n",
    "android-googletv-license": "\n601085b94cd77f0b54ff86406957099ebe79c4d6\n",
    "android-sdk-arm-dbt-license": "\n859f317696f67ef3d7f30a50a5560e7834b43903\n",
  };
  for (const [name, body] of Object.entries(files)) {
    try { fs.writeFileSync(path.join(dir, name), body); } catch (_) {}
  }
}

/** gradle.properties me ek key set/update karo (duplicate na bane). */
function setGradleProp(workDir, key, value) {
  const file = path.join(workDir, "gradle.properties");
  let txt = "";
  try { txt = fs.readFileSync(file, "utf8"); } catch (_) {}
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  if (re.test(txt)) {
    txt = txt.replace(re, `${key}=${value}`);
  } else {
    txt = (txt ? txt.trimEnd() + "\n" : "") + `${key}=${value}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, txt, "utf8");
}

function whichSync(cmd) {
  if (!cmd) return null;
  const c = String(cmd).trim();
  if (!c) return null;
  if (c.includes("/") || c.includes("\\")) return isFile(c) ? c : null;
  const exts = IS_WIN ? WIN_EXT : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, c + ext);
      if (isFile(full)) return full;
    }
  }
  return null;
}

function resolveJavaHome() {
  const cands = [
    process.env.JAVA_HOME,
    process.env.JDK_ROOT,
    "/usr/lib/jvm/java-17-openjdk-amd64",
    "/usr/lib/jvm/java-11-openjdk-amd64",
    "/usr/lib/jvm/default-java",
    "/opt/java/openjdk",
    path.join(process.env.HOME || "", ".jdk"),
  ].filter(Boolean);

  for (const c of cands) {
    if (isFile(path.join(c, "bin", "java"))) return c;
  }

  const j = whichSync("java");
  if (j) {
    try {
      const home = path.dirname(path.dirname(fs.realpathSync(j)));
      if (isFile(path.join(home, "bin", "java"))) return home;
    } catch (_) {}
  }

  const root = process.env.JDK_ROOT || path.join(builderConfig.STORAGE_ROOT, "jdk");
  if (isDir(root)) {
    try {
      for (const d of fs.readdirSync(root)) {
        const cand = path.join(root, d);
        if (isFile(path.join(cand, "bin", "java"))) return cand;
      }
    } catch (_) {}
  }
  return null;
}

builderConfig.TEMPLATE_DIR =
  resolveTemplateDir() || path.join(BASE_DIR, "apk_template");
builderConfig.ANDROID_SDK = resolveAndroidSdk();

function ensureDirs() {
  for (const d of [
    builderConfig.STORAGE_ROOT,
    builderConfig.BUILD_ROOT,
    builderConfig.KEYSTORE_DIR,
    builderConfig.GRADLE_ROOT,
    lockDir(),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!process.env.GRADLE_USER_HOME) {
    process.env.GRADLE_USER_HOME = path.join(builderConfig.STORAGE_ROOT, ".gradle");
  }
  fs.mkdirSync(process.env.GRADLE_USER_HOME, { recursive: true });
}

// ------------------------------------------------- download / lock helpers

function lockDir() {
  return path.join(builderConfig.STORAGE_ROOT, ".locks");
}

function lockPath(name) {
  return path.join(lockDir(), `${name}.lock`);
}

function acquireLock(name) {
  const p = lockPath(name);
  fs.mkdirSync(lockDir(), { recursive: true });
  try {
    fs.writeFileSync(p, `${process.pid}`, { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(p);
        return acquireLock(name);
      }
    } catch (_) {}
    return false;
  }
}

function releaseLock(name) {
  try { fs.unlinkSync(lockPath(name)); } catch (_) {}
}

async function waitForMarker(marker, timeoutMs = PEER_WAIT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (isFile(marker)) return true;
    await sleep(3000);
  }
  return false;
}

function zipOk(p) {
  if (!isFile(p)) return false;
  return spawnSync("unzip", ["-t", p], { stdio: "ignore" }).status === 0;
}

function tarOk(p) {
  if (!isFile(p)) return false;
  return spawnSync("tar", ["-tzf", p], { stdio: "ignore" }).status === 0;
}

function downloadValidated(url, dest, validator, label) {
  const part = `${dest}.part`;
  try { fs.rmSync(part, { force: true }); } catch (_) {}

  const d = spawnSync(
    "curl",
    ["-fsSL", "--retry", "3", "--retry-delay", "2", "--connect-timeout", "20", "-o", part, url],
    { encoding: "utf8" }
  );
  if (d.status !== 0) {
    try { fs.rmSync(part, { force: true }); } catch (_) {}
    throw new Error(`${label} download fail: ${d.stderr || d.status}`);
  }

  if (!validator(part)) {
    try { fs.rmSync(part, { force: true }); } catch (_) {}
    throw new Error(`${label} download corrupt (validation fail)`);
  }

  fs.renameSync(part, dest);
  return dest;
}

function dropIfCorrupt(file, validator) {
  if (!isFile(file)) return;
  if (validator(file)) return;
  try { fs.rmSync(file, { force: true }); } catch (_) {}
  console.warn("[builder] corrupt file delete: %s", path.basename(file));
}

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const genSecret = () => crypto.randomBytes(24).toString("base64url");
const oid = (v) => { try { return new db.ObjectId(String(v)); } catch (_) { return null; } };
const unwrap = (r) => (r && Object.prototype.hasOwnProperty.call(r, "value") ? r.value : r);

function safeEq(a, b) {
  try {
    const ba = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function ensureExec(p) {
  if (!p || IS_WIN) return p;
  try { fs.chmodSync(p, 0o755); } catch (_) {}
  return p;
}

function applyJavaHome(javaHome) {
  if (!javaHome) return null;
  process.env.JAVA_HOME = javaHome;
  const bin = path.join(javaHome, "bin");
  if (!String(process.env.PATH || "").split(path.delimiter).includes(bin)) {
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ""}`;
  }
  return javaHome;
}

function wrapperJar(dir) {
  return path.join(dir, "gradle", "wrapper", "gradle-wrapper.jar");
}

function wrapperDistUrl(workDir) {
  for (const f of [
    workDir && path.join(workDir, "gradle", "wrapper", "gradle-wrapper.properties"),
    path.join(builderConfig.TEMPLATE_DIR, "gradle", "wrapper", "gradle-wrapper.properties"),
  ]) {
    if (!f || !isFile(f)) continue;
    try {
      const txt = fs.readFileSync(f, "utf8");
      const m = txt.match(/^\s*distributionUrl\s*=\s*(.+?)\s*$/m);
      if (m) return m[1].replace(/\\:/g, ":").replace(/\\/g, "").trim();
    } catch (_) {}
  }
  return null;
}

function resolveGradle(workDir) {
  const override = String(builderConfig.GRADLE_BIN || "").trim();
  if (override && override !== "gradle") {
    const abs = whichSync(override);
    if (abs) {
      return { bin: ensureExec(abs), prefixArgs: [], source: "GRADLE_BIN", shell: IS_WIN };
    }
  }
  const wrapper = IS_WIN ? "gradlew.bat" : "gradlew";
  for (const dir of [workDir, builderConfig.TEMPLATE_DIR].filter(Boolean)) {
    if (isFile(path.join(dir, wrapper)) && isFile(wrapperJar(dir))) {
      return {
        bin: ensureExec(path.join(dir, wrapper)),
        prefixArgs: [],
        source: "gradle-wrapper",
        shell: IS_WIN,
      };
    }
  }
  const onPath = whichSync("gradle");
  if (onPath) return { bin: onPath, prefixArgs: [], source: "PATH", shell: IS_WIN };

  const java = whichSync("java");
  if (java) {
    for (const dir of [workDir, builderConfig.TEMPLATE_DIR].filter(Boolean)) {
      const jar = wrapperJar(dir);
      if (isFile(jar)) {
        return { bin: java, prefixArgs: ["-jar", jar], source: "wrapper-jar", shell: false };
      }
    }
  }
  return null;
}

function gradleHint() {
  return (
    "gradle nahi mila. (a) apk_template mein gradlew + gradle/wrapper/gradle-wrapper.jar daalo, " +
    "(b) gradle install karo, (c) GRADLE_BIN set karo, ya (d) USE_DOCKER=1."
  );
}

/** request se public origin nikaalo — APK me inject hota hai. */
function requestBaseUrl(req) {
  const proto =
    String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim() ||
    "http";
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();
  if (!host) return config.PUBLIC_BASE_URL || "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function preflight() {
  const javaHome = resolveJavaHome();
  const needCompile = detectCompileSdk(builderConfig.TEMPLATE_DIR);
  const needBt = detectBuildToolsVersion(builderConfig.TEMPLATE_DIR);
  const sdkRoot = resolveAndroidSdk();
  const sdkOk = sdkHas(sdkRoot, needCompile, needBt);

  const tools = {
    gradle: null,
    docker: null,
    java: javaHome ? path.join(javaHome, "bin", "java") : null,
    python: null,
    keytool: null,
    android_sdk: sdkRoot,
    java_home: javaHome,
    wrapper_jar: isFile(wrapperJar(builderConfig.TEMPLATE_DIR)),
    wrapper_jar_path: wrapperJar(builderConfig.TEMPLATE_DIR),
  };
  const problems = [];

  if (!tools.java) tools.java = whichSync("java");
  tools.docker = whichSync(builderConfig.DOCKER_BIN) || whichSync("docker");
  tools.python = whichSync(builderConfig.PY_BUILDER);
  tools.keytool =
    whichSync(builderConfig.KEYTOOL_BIN) ||
    (javaHome && isFile(path.join(javaHome, "bin", "keytool"))
      ? path.join(javaHome, "bin", "keytool")
      : null);

  const g = resolveGradle(builderConfig.TEMPLATE_DIR);
  tools.gradle = g ? { path: g.bin, source: g.source } : null;

  const templateOk = isDir(builderConfig.TEMPLATE_DIR);
  const themeList = themes.list(builderConfig.TEMPLATE_DIR);

  if (!templateOk) problems.push(`TEMPLATE_DIR missing: ${builderConfig.TEMPLATE_DIR}`);
  if (templateOk && themeList.length === 0) {
    problems.push(`koi theme nahi mila: ${themes.themesDir(builderConfig.TEMPLATE_DIR)}`);
  }

  if (builderConfig.ENGINE === "python") {
    if (!tools.python) problems.push(`PY_BUILDER "${builderConfig.PY_BUILDER}" PATH par nahi mila.`);
  } else if (builderConfig.USE_DOCKER) {
    if (!tools.docker) problems.push("USE_DOCKER=1 par docker nahi mila.");
  } else if (!g && !builderConfig.AUTO_GRADLE) {
    problems.push(gradleHint());
  }

  if (builderConfig.ENGINE === "node" && !builderConfig.USE_DOCKER && !sdkOk && !builderConfig.AUTO_SDK) {
    problems.push(
      `SDK me android-${needCompile} / build-tools;${needBt} missing (${sdkRoot || "koi sdk nahi"})`
    );
  }
  if (builderConfig.REQUIRE_SIGNATURE && !tools.java && !builderConfig.AUTO_JDK) {
    problems.push("java nahi mila — signing fail hoga.");
  }

  return {
    ok: problems.length === 0,
    platform: process.platform,
    worker_mode: builderConfig.WORKER_MODE,
    engine: builderConfig.ENGINE,
    use_docker: builderConfig.USE_DOCKER,
    auto_jdk: builderConfig.AUTO_JDK,
    auto_sdk: builderConfig.AUTO_SDK,
    auto_gradle: builderConfig.AUTO_GRADLE,
    start_queue: builderConfig.START_QUEUE,
    skip_warmup: builderConfig.SKIP_WARMUP,
    template_ok: templateOk,
    template_dir: builderConfig.TEMPLATE_DIR,
    sdk_root: sdkRoot,
    compile_sdk: needCompile,
    build_tools: needBt,
    sdk_ok: sdkOk,
    themes: themeList.map((t) => ({ slug: t.slug, label: t.label, dark: !!t.dark })),
    tools,
    problems,
  };
}

function runProcess(bin, args, opts, onData, timeoutMs) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawnProc(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...opts,
      });
    } catch (e) {
      return reject(e);
    }

    let failed = false;
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch (_) {}
    }, timeoutMs);

    p.stdout.on("data", onData);
    p.stderr.on("data", onData);

    p.on("error", (e) => {
      failed = true;
      clearTimeout(timer);
      if (e.code === "ENOENT") reject(new Error(`spawn ${bin} ENOENT. ${gradleHint()}`));
      else reject(e);
    });

    p.on("close", (code, signal) => {
      if (failed) return;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} exit ${code}${signal ? ` signal=${signal}` : ""}`));
    });
  });
}

function findApk(root) {
  const stack = [root];
  let fallback = null;
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".apk")) {
        if (/release/i.test(e.name)) return full;
        fallback = fallback || full;
      }
    }
  }
  return fallback;
}

// ------------------------------------------------------------ runtimes

let _javaPromise = null;
const _sdkPromises = new Map();
const _gradlePromises = new Map();

async function ensureJavaRuntime(log) {
  const existing = resolveJavaHome();
  if (existing) { applyJavaHome(existing); return existing; }

  const root = process.env.JDK_ROOT || path.join(builderConfig.STORAGE_ROOT, "jdk");
  fs.mkdirSync(root, { recursive: true });

  const marker = path.join(root, ".home");
  if (isFile(marker)) {
    const saved = fs.readFileSync(marker, "utf8").trim();
    if (isFile(path.join(saved, "bin", "java"))) {
      applyJavaHome(saved);
      return saved;
    }
  }

  if (!acquireLock("jdk")) {
    log("jdk warmup peer ke paas — wait");
    if (!(await waitForMarker(marker))) throw new Error("jdk warmup timeout (peer)");
    const saved = fs.readFileSync(marker, "utf8").trim();
    applyJavaHome(saved);
    return saved;
  }

  try {
    const tgz = path.join(root, "jdk.tar.gz");
    dropIfCorrupt(tgz, tarOk);
    if (!isFile(tgz)) {
      log("downloading jdk 17 (temurin)…");
      downloadValidated(JDK_URL, tgz, tarOk, "jdk");
    }

    log("extracting jdk…");
    const ex = spawnSync("tar", ["-xzf", tgz, "-C", root], { encoding: "utf8" });
    if (ex.status !== 0) {
      try { fs.rmSync(tgz, { force: true }); } catch (_) {}
      throw new Error(`jdk extract fail: ${ex.stderr || ex.status}`);
    }

    let home = null;
    for (const d of fs.readdirSync(root)) {
      const cand = path.join(root, d);
      if (isFile(path.join(cand, "bin", "java"))) { home = cand; break; }
    }
    if (!home) throw new Error("jdk extract ke baad bin/java nahi mila");

    try { fs.chmodSync(path.join(home, "bin", "java"), 0o755); } catch (_) {}
    try { fs.chmodSync(path.join(home, "bin", "keytool"), 0o755); } catch (_) {}
    fs.writeFileSync(marker, home);

    applyJavaHome(home);
    return home;
  } finally {
    releaseLock("jdk");
  }
}

async function ensureAndroidSdkRuntime(log, need = {}) {
  const compileSdk = parseInt(need.compileSdk, 10) || 34;
  const buildTools = String(need.buildTools || "34.0.0");

  const root = managedSdkRoot();
  if (sdkHas(root, compileSdk, buildTools)) {
    writeLicenseHashes(root);
    builderConfig.ANDROID_SDK = root;
    return root;
  }

  fs.mkdirSync(root, { recursive: true });
  writeLicenseHashes(root);

  const ready = path.join(root, ".ready");

  if (!acquireLock("android-sdk")) {
    log("sdk warmup peer ke paas — wait");
    if (!(await waitForMarker(ready))) throw new Error("sdk warmup timeout (peer)");
    builderConfig.ANDROID_SDK = root;
    return root;
  }

  try {
    // cmdline-tools zaroori hai — na ho to download karo
    const cmdline = path.join(root, "cmdline-tools", "latest");
    if (!isFile(path.join(cmdline, "bin", "sdkmanager"))) {
      const zip = path.join(root, "cmdline-tools.zip");
      dropIfCorrupt(zip, zipOk);
      if (!isFile(zip)) {
        log("downloading android cmdline-tools…");
        downloadValidated(SDK_ZIP_URL, zip, zipOk, "cmdline-tools");
      }

      const tmp = path.join(root, "tmp");
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });

      const un = spawnSync("unzip", ["-q", "-o", zip, "-d", tmp], { encoding: "utf8" });
      if (un.status !== 0) {
        try { fs.rmSync(zip, { force: true }); } catch (_) {}
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error(`unzip fail: ${un.stderr || un.status}`);
      }

      fs.rmSync(cmdline, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(cmdline), { recursive: true });
      fs.renameSync(path.join(tmp, "cmdline-tools"), cmdline);
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    const sdkmanager = path.join(cmdline, "bin", "sdkmanager");
    try { fs.chmodSync(sdkmanager, 0o755); } catch (_) {}

    const env = { ...process.env };
    if (!env.JAVA_HOME) applyJavaHome(resolveJavaHome());

    writeLicenseHashes(root);
    log("accepting android licenses…");
    spawnSync(
      "sh",
      ["-c", `yes | "${sdkmanager}" --sdk_root="${root}" --licenses >/dev/null 2>&1`],
      { encoding: "utf8", env }
    );
    writeLicenseHashes(root);

    const pkgs = [
      "platform-tools",
      `platforms;android-${compileSdk}`,
      `build-tools;${buildTools}`,
    ];
    if (compileSdk !== 34) pkgs.push("platforms;android-34", "build-tools;34.0.0");

    log(`installing ${pkgs.join(", ")}…`);
    const inst = spawnSync(sdkmanager, [`--sdk_root=${root}`, ...pkgs], {
      encoding: "utf8",
      env,
    });
    if (inst.status !== 0) {
      writeLicenseHashes(root);
      throw new Error(`sdkmanager fail: ${inst.stderr || inst.status}`);
    }

    if (!sdkHas(root, compileSdk, buildTools)) {
      throw new Error(
        `sdk install ke baad bhi package nahi mile (android-${compileSdk}/${buildTools})`
      );
    }

    process.env.ANDROID_HOME = root;
    process.env.ANDROID_SDK_ROOT = root;
    builderConfig.ANDROID_SDK = root;
    fs.writeFileSync(ready, new Date().toISOString());
    return root;
  } finally {
    releaseLock("android-sdk");
  }
}

async function ensureGradleRuntime(log, workDir) {
  const url =
    wrapperDistUrl(workDir) ||
    `https://services.gradle.org/distributions/gradle-${builderConfig.GRADLE_VERSION}-bin.zip`;
  const file = (url.split("/").pop() || "").replace(/\.zip$/i, "");
  const name = file.replace(/-(bin|all)$/i, "") || `gradle-${builderConfig.GRADLE_VERSION}`;
  const root = builderConfig.GRADLE_ROOT;
  const home = path.join(root, name);
  const bin = path.join(home, "bin", IS_WIN ? "gradle.bat" : "gradle");
  if (isFile(bin)) return ensureExec(bin);

  fs.mkdirSync(root, { recursive: true });
  const ready = path.join(home, ".ready");
  const lockName = `gradle-${name}`;

  if (!acquireLock(lockName)) {
    log(`${name} warmup peer ke paas — wait`);
    if (!(await waitForMarker(ready))) throw new Error(`${name} warmup timeout (peer)`);
    return ensureExec(bin);
  }

  try {
    if (isFile(bin)) return ensureExec(bin);

    const zip = path.join(root, `${name}.zip`);
    dropIfCorrupt(zip, zipOk);
    if (!isFile(zip)) {
      log(`downloading ${name}…`);
      downloadValidated(url, zip, zipOk, name);
    }

    log(`extracting ${name}…`);
    const un = spawnSync("unzip", ["-q", "-o", zip, "-d", root], { encoding: "utf8" });
    if (un.status !== 0) {
      try { fs.rmSync(zip, { force: true }); } catch (_) {}
      throw new Error(`gradle unzip fail: ${un.stderr || un.status}`);
    }

    if (!isFile(bin)) throw new Error(`gradle bin nahi mila: ${bin}`);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(ready, new Date().toISOString());
    return ensureExec(bin);
  } finally {
    releaseLock(lockName);
  }
}

function ensureJavaOnce(log) {
  if (!_javaPromise) {
    _javaPromise = ensureJavaRuntime(log).catch((e) => {
      _javaPromise = null;
      throw e;
    });
  }
  return _javaPromise;
}

function ensureSdkOnce(log, need) {
  const key = `${(need && need.compileSdk) || 34}|${(need && need.buildTools) || "34.0.0"}`;
  if (!_sdkPromises.has(key)) {
    _sdkPromises.set(
      key,
      ensureAndroidSdkRuntime(log, need).catch((e) => {
        _sdkPromises.delete(key);
        throw e;
      })
    );
  }
  return _sdkPromises.get(key);
}

function ensureGradleOnce(log, workDir) {
  const url =
    wrapperDistUrl(workDir) ||
    `https://services.gradle.org/distributions/gradle-${builderConfig.GRADLE_VERSION}-bin.zip`;
  if (!_gradlePromises.has(url)) {
    _gradlePromises.set(
      url,
      ensureGradleRuntime(log, workDir).catch((e) => {
        _gradlePromises.delete(url);
        throw e;
      })
    );
  }
  return _gradlePromises.get(url);
}

// ------------------------------------------------------------ keystore

function keystoreCreds(appId) {
  fs.mkdirSync(builderConfig.KEYSTORE_DIR, { recursive: true });
  const file = path.join(builderConfig.KEYSTORE_DIR, `${appId}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
  }
  const creds = {
    storePassword: crypto.randomBytes(12).toString("base64url"),
    keyAlias: `app${String(appId).replace(/[^a-z0-9]/gi, "").slice(-6)}`,
    keyPassword: crypto.randomBytes(12).toString("base64url"),
  };
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  return creds;
}

async function loadKeystoreBlob(appId) {
  const c = db.keystores;
  if (!c) return null;
  try { return await c.findOne({ _id: appId }); } catch (_) { return null; }
}

async function saveKeystoreBlob(appId, jksPath, creds) {
  const c = db.keystores;
  if (!c) return;
  try {
    const jks = fs.readFileSync(jksPath).toString("base64");
    await c.updateOne(
      { _id: appId },
      { $set: { jks, creds, updated_at: db.utcNow() } },
      { upsert: true }
    );
  } catch (err) {
    console.warn("[builder] keystore save fail:", err.message);
  }
}

async function ensureKeystore(appId) {
  if (!builderConfig.REQUIRE_SIGNATURE) return null;
  const javaHome = resolveJavaHome();
  const keytool =
    whichSync(builderConfig.KEYTOOL_BIN) ||
    (javaHome && isFile(path.join(javaHome, "bin", "keytool"))
      ? path.join(javaHome, "bin", "keytool")
      : null);
  if (!keytool) return null;

  fs.mkdirSync(builderConfig.KEYSTORE_DIR, { recursive: true });
  const ks = path.join(builderConfig.KEYSTORE_DIR, `${appId}.jks`);
  const creds = keystoreCreds(appId);

  if (!fs.existsSync(ks)) {
    const blob = await loadKeystoreBlob(appId);
    if (blob && blob.jks) {
      try {
        fs.writeFileSync(ks, Buffer.from(blob.jks, "base64"), { mode: 0o600 });
        if (blob.creds) {
          fs.writeFileSync(
            path.join(builderConfig.KEYSTORE_DIR, `${appId}.json`),
            JSON.stringify(blob.creds, null, 2),
            { mode: 0o600 }
          );
          Object.assign(creds, blob.creds);
        }
      } catch (_) {}
    }
  }

  if (!fs.existsSync(ks)) {
    const r = spawnSync(
      keytool,
      [
        "-genkeypair", "-v", "-keystore", ks, "-alias", creds.keyAlias,
        "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
        "-storepass", creds.storePassword, "-keypass", creds.keyPassword,
        "-dname", `CN=${appId}, OU=apps, O=venice, L=NA, ST=NA, C=IN`,
      ],
      { encoding: "utf8", env: { ...process.env } }
    );
    if (r.status !== 0) return null;
    await saveKeystoreBlob(appId, ks, creds);
  }

  return { path: ks, ...creds };
}

// ------------------------------------------------------------ artifacts

let _s3 = null;
function getS3() {
  if (_s3 !== null) return _s3;
  try {
    const { S3Client } = require("@aws-sdk/client-s3");
    _s3 = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || "") === "1",
      credentials: process.env.S3_ACCESS_KEY_ID
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
    });
  } catch (_) {
    _s3 = false;
  }
  return _s3;
}

async function uploadArtifact(file, key) {
  const client = getS3();
  const bucket = process.env.S3_BUCKET;
  if (!client || !bucket) return null;
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const prefix = String(process.env.S3_PREFIX || "apks").replace(/^\/|\/$/g, "");
  const objKey = `${prefix}/${key}.apk`;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objKey,
      Body: fs.readFileSync(file),
      ContentType: "application/vnd.android.package-archive",
    })
  );
  const base = String(process.env.S3_PUBLIC_BASE || "").replace(/\/$/, "");
  return base ? `${base}/${objKey}` : null;
}

// ------------------------------------------------------------ shapes

function shapeApp(doc) {
  if (!doc) return null;
  const { _id, secret, secret_hash, ...rest } = doc;
  return { id: String(_id), ...rest };
}

function shapeBuild(doc) {
  if (!doc) return null;
  const { _id, artifact, ...rest } = doc;
  return {
    id: String(_id),
    buildId: String(_id),
    ...rest,
    has_artifact: !!((artifact && fs.existsSync(artifact)) || rest.artifact_url),
    download_url: `/api/builds/${String(_id)}/download`,
  };
}

async function quota() {
  const limit = builderConfig.QUOTA_PER_DAY;
  if (!limit || limit <= 0) return { unlimited: true, daily_limit: 0, used_today: 0 };
  let used = 0;
  try {
    if (db.builds) used = await db.builds.countDocuments({ created_at: { $gte: startOfDay() } });
  } catch (_) {}
  return { unlimited: false, daily_limit: limit, used_today: used };
}

async function requeueStale(maxAgeMs = builderConfig.BUILD_STALE_MS) {
  if (!db.builds) return;
  try {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const r = await db.builds.updateMany(
      { status: "running", started_at: { $lt: cutoff } },
      {
        $set: {
          status: "queued",
          error: "requeued after worker restart",
          requeued_at: db.utcNow(),
        },
      }
    );
    if (r.modifiedCount) console.log(`[builder] ${r.modifiedCount} stale build requeue`);
  } catch (err) {
    console.warn("[builder] requeueStale fail:", err.message);
  }
}

// ------------------------------------------------------------ queue

class BuildQueue {
  constructor() {
    this.running = false;
    this.active = 0;
    this._timer = null;
    this._requeued = false;
    this.counts = { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    if (!this._requeued) {
      this._requeued = true;
      await requeueStale();
    }
    this._tick().catch(() => {});
    this._loop();
  }

  async stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
  }

  _loop() {
    if (!this.running) return;
    this._timer = setTimeout(() => {
      this._tick()
        .catch(() => {})
        .finally(() => this._loop());
    }, builderConfig.BUILD_POLL_MS);
  }

  async _tick() {
    if (!this.running) return;
    if (!db.builds) return;

    while (this.active < builderConfig.MAX_CONCURRENT_BUILDS) {
      let job = null;
      try {
        job = unwrap(
          await db.builds.findOneAndUpdate(
            { status: "queued" },
            { $set: { status: "running", started_at: db.utcNow(), worker: WORKER_ID } },
            { sort: { _id: 1 }, returnDocument: db.ReturnDocument.AFTER }
          )
        );
      } catch (err) {
        console.warn("[builder] queue poll fail:", err.message);
        return;
      }

      if (!job) return;

      this.active += 1;
      this.counts.queued = Math.max(0, this.counts.queued - 1);
      this.counts.running = this.active;
      this._run(job);
    }
  }

  _run(job) {
    runBuild(job)
      .then(() => {
        this.counts.done += 1;
      })
      .catch(async (err) => {
        this.counts.failed += 1;
        try {
          await db.builds.updateOne(
            { _id: job._id },
            {
              $set: {
                status: "failed",
                error: String(err.message || err),
                finished_at: db.utcNow(),
              },
            }
          );
        } catch (_) {}
        userHub.broadcast(String(job.userId || ""), {
          type: "build",
          data: { buildId: String(job._id), status: "failed", error: String(err.message || err) },
        });
      })
      .finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.counts.running = this.active;
        this._tick().catch(() => {});
      });
  }

  async add(doc) {
    const res = await db.builds.insertOne({
      ...doc,
      status: "queued",
      created_at: db.utcNow(),
      log_tail: [],
    });
    this.counts.queued += 1;
    return res.insertedId;
  }

  stats() {
    return {
      ...this.counts,
      active: this.active,
      mode: builderConfig.WORKER_MODE,
      engine: builderConfig.ENGINE,
      max_concurrent: builderConfig.MAX_CONCURRENT_BUILDS,
      worker: WORKER_ID,
      started: this.running,
    };
  }
}

let _queue = null;
function initQueue() {
  if (!_queue) _queue = new BuildQueue();
  return _queue;
}
function getQueue() {
  return initQueue();
}

// ------------------------------------------------------------ warmup / bind

async function warmup() {
  if (builderConfig.SKIP_WARMUP) {
    console.log("[builder] warmup skip (secondary worker)");
    applyJavaHome(resolveJavaHome());
    return;
  }

  if (builderConfig.AUTO_JDK) {
    try {
      const jh = await ensureJavaOnce((m) => console.log("[builder] %s", m));
      console.log("[builder] java ready: %s", jh);
    } catch (e) {
      console.warn("[builder] java warmup fail: %s", e.message || e);
    }
  } else {
    applyJavaHome(resolveJavaHome());
  }

  if (builderConfig.AUTO_SDK && !builderConfig.USE_DOCKER) {
    try {
      const need = {
        compileSdk: detectCompileSdk(builderConfig.TEMPLATE_DIR),
        buildTools: detectBuildToolsVersion(builderConfig.TEMPLATE_DIR),
      };
      const sdk = await ensureSdkOnce((m) => console.log("[builder] %s", m), need);
      console.log("[builder] android sdk ready: %s (android-%s)", sdk, need.compileSdk);
    } catch (e) {
      console.warn("[builder] sdk warmup fail: %s", e.message || e);
    }
  }

  if (builderConfig.AUTO_GRADLE && !builderConfig.USE_DOCKER) {
    try {
      const gb = await ensureGradleOnce(
        (m) => console.log("[builder] %s", m),
        builderConfig.TEMPLATE_DIR
      );
      console.log("[builder] gradle ready: %s", gb);
    } catch (e) {
      console.warn("[builder] gradle warmup fail: %s", e.message || e);
    }
  }
}

function bindLoop() {
  const pf = preflight();
  if (pf.ok) {
    console.log(
      "[builder] preflight ok — mode=%s engine=%s themes=%d queue=%s warmup=%s template=%s sdk=%s",
      builderConfig.WORKER_MODE,
      builderConfig.ENGINE,
      pf.themes.length,
      builderConfig.START_QUEUE ? "on" : "off",
      builderConfig.SKIP_WARMUP ? "skip" : "on",
      builderConfig.TEMPLATE_DIR,
      pf.sdk_ok ? "ok" : "missing"
    );
  } else {
    for (const p of pf.problems) console.warn("[builder] WARN: %s", p);
  }

  if (builderConfig.START_QUEUE) getQueue().start().catch(() => {});
  warmup().catch(() => {});
  return pf;
}

// ------------------------------------------------------------ build

async function runBuild(job) {
  const t0 = Date.now();
  const buildId = String(job._id);
  const workDir = path.join(builderConfig.BUILD_ROOT, buildId);
  fs.mkdirSync(workDir, { recursive: true });

  const logs = [];
  let lastFlush = 0;

  const flush = async (force) => {
    const now = Date.now();
    if (!force && now - lastFlush < 1200) return;
    lastFlush = now;
    try {
      await db.builds.updateOne(
        { _id: job._id },
        { $set: { log_tail: logs.slice(-builderConfig.MAX_LOG_LINES) } }
      );
    } catch (_) {}
    userHub.broadcast(String(job.userId || ""), {
      type: "build",
      data: { buildId, status: "running", log_tail: logs.slice(-40) },
    });
  };

  const pushLog = (chunk) => {
    for (const line of String(chunk || "").replace(/\r/g, "").split("\n")) {
      if (!line.trim()) continue;
      logs.push(line.slice(0, 500));
    }
    while (logs.length > builderConfig.MAX_LOG_LINES) logs.shift();
    flush(false).catch(() => {});
  };

  const log = (s) => pushLog(`[builder] ${s}`);

  const canceled = async () => {
    try {
      const cur = await db.builds.findOne({ _id: job._id }, { projection: { status: 1 } });
      return cur && cur.status === "canceled";
    } catch (_) {
      return false;
    }
  };

  log(
    `build ${buildId} start — engine=${builderConfig.ENGINE} variant=${
      job.variant || builderConfig.DEFAULT_VARIANT
    } theme=${job.theme || builderConfig.DEFAULT_THEME}`
  );

  try {
    let javaHome = resolveJavaHome();
    if (!javaHome && builderConfig.AUTO_JDK) {
      try {
        javaHome = await ensureJavaOnce(log);
      } catch (e) {
        log(`jdk bootstrap fail: ${e.message || e}`);
      }
    }
    if (javaHome) {
      applyJavaHome(javaHome);
      log(`java home: ${javaHome}`);
    } else {
      log("warning: JAVA_HOME nahi mila");
    }

    if (builderConfig.ENGINE === "python") {
      const pyBin = whichSync(builderConfig.PY_BUILDER) || builderConfig.PY_BUILDER;
      log(`$ ${pyBin} -m backend.apk_builder.worker ${buildId}`);
      await runProcess(
        pyBin,
        ["-m", "backend.apk_builder.worker", buildId],
        { cwd: BASE_DIR, env: { ...process.env, BUILD_DIR: workDir } },
        pushLog,
        builderConfig.BUILD_TIMEOUT_MS
      );
    } else {
      const tmpl = builderConfig.TEMPLATE_DIR;

      if (isDir(tmpl)) {
        log(`copying template from ${tmpl}…`);
        fs.cpSync(tmpl, workDir, { recursive: true });
      } else if (
        fs.existsSync(path.join(workDir, "settings.gradle.kts")) ||
        fs.existsSync(path.join(workDir, "settings.gradle"))
      ) {
        log("template missing — workDir project use kar rahe hain");
      } else {
        throw new Error(`Template nahi mila: ${tmpl}`);
      }

      const wrapper = IS_WIN ? "gradlew.bat" : "gradlew";
      if (isFile(path.join(workDir, wrapper)) && !isFile(wrapperJar(workDir))) {
        log("warning: gradle-wrapper.jar missing — runtime gradle use hoga");
      }

      const compileSdk = detectCompileSdk(tmpl);
      const buildTools = detectBuildToolsVersion(tmpl);
      log(`sdk need: platforms;android-${compileSdk} build-tools;${buildTools}`);

      // AGP purana ho to naye compileSdk par warn karta hai — suppress
      setGradleProp(workDir, "android.suppressUnsupportedCompileSdk", String(compileSdk));

      let sdk = sdkHas(builderConfig.ANDROID_SDK, compileSdk, buildTools)
        ? builderConfig.ANDROID_SDK
        : null;
      if (!sdk && builderConfig.AUTO_SDK) {
        sdk = await ensureSdkOnce(log, { compileSdk, buildTools });
      }
      if (!sdk) sdk = resolveAndroidSdk();

      if (sdk) {
        process.env.ANDROID_HOME = sdk;
        process.env.ANDROID_SDK_ROOT = sdk;
        builderConfig.ANDROID_SDK = sdk;
        // har build pe fresh — stale path nahi rehna chahiye
        fs.writeFileSync(
          path.join(workDir, "local.properties"),
          `sdk.dir=${sdk.replace(/\\/g, "\\\\")}\n`
        );
        log(`android sdk: ${sdk}`);
      } else {
        log("warning: ANDROID_HOME nahi mila");
      }

      const themeSlug = String(job.theme || builderConfig.DEFAULT_THEME);
      const theme = themes.inject(tmpl, workDir, themeSlug, job.appName);
      log(`theme: ${theme.slug} — ${theme.label}`);

      const props = linker.writeBuilderProps(workDir, { ...job, buildId });
      linker.writeAppName(workDir, props.appName);
      log(`app: ${props.appName || "(unnamed)"} · id=${props.appId || "(default)"}`);
      log(`api base: ${props.apiBase || "(blank — runtime discover)"}`);

      const ks = await ensureKeystore(props.appId || buildId);
      linker.writeKeystoreProps(workDir, ks);
      if (ks) log(`keystore: ${path.basename(ks.path)}`);
      else log("warning: keystore skip — unsigned apk");

      const variant = String(job.variant || builderConfig.DEFAULT_VARIANT).toLowerCase();
      const task = variant === "debug" ? "assembleDebug" : "assembleRelease";

      let bin, args, opts;

      if (builderConfig.USE_DOCKER) {
        const dockerBin = whichSync(builderConfig.DOCKER_BIN) || whichSync("docker");
        if (!dockerBin) throw new Error("docker nahi mila (USE_DOCKER=1)");

        const mount = IS_WIN ? path.resolve(workDir).replace(/\\/g, "/") : workDir;
        args = ["run", "--rm", "-v", `${mount}:/w`, "-w", "/w"];

        if (sdk) {
          const sdkMount = IS_WIN ? path.resolve(sdk).replace(/\\/g, "/") : sdk;
          args.push(
            "-v", `${sdkMount}:/opt/android-sdk:ro`,
            "-e", "ANDROID_HOME=/opt/android-sdk",
            "-e", "ANDROID_SDK_ROOT=/opt/android-sdk"
          );
        }
        args.push("gradle:8", task);
        bin = dockerBin;
        opts = { cwd: workDir, env: { ...process.env } };
      } else {
        let g = resolveGradle(workDir);
        if (!g && builderConfig.AUTO_GRADLE) {
          const gb = await ensureGradleOnce(log, workDir);
          g = { bin: gb, prefixArgs: [], source: "runtime", shell: IS_WIN };
        }
        if (!g) throw new Error(gradleHint());
        bin = g.bin;
        args = [...(g.prefixArgs || []), "--no-daemon", "--console=plain", task];
        opts = { cwd: workDir, env: { ...process.env }, shell: g.shell };
        log(`gradle source=${g.source}`);
      }

      log(`$ ${bin} ${args.join(" ")}`);
      await runProcess(bin, args, opts, pushLog, builderConfig.BUILD_TIMEOUT_MS);
    }

    if (await canceled()) {
      log("canceled — artifact skipped");
      return;
    }

    const outRoot = path.join(workDir, "app", "build", "outputs", "apk");
    const artifact = fs.existsSync(outRoot) ? findApk(outRoot) : null;

    const patch = {
      status: "success",
      finished_at: db.utcNow(),
      duration_ms: Date.now() - t0,
      log_tail: logs.slice(-builderConfig.MAX_LOG_LINES),
    };

    if (artifact && fs.existsSync(artifact)) {
      try {
        const stable = path.join(builderConfig.BUILD_ROOT, `${buildId}.apk`);
        fs.copyFileSync(artifact, stable);
        const buf = fs.readFileSync(stable);
        patch.artifact = stable;
        patch.apk_name = path.basename(artifact);
        patch.apk_size = buf.length;
        patch.apk_sha256 = sha256hex(buf);
        log(
          `artifact: ${path.basename(artifact)} (${buf.length} bytes) sha256=${patch.apk_sha256.slice(0, 16)}…`
        );

        try {
          const url = await uploadArtifact(stable, buildId);
          if (url) {
            patch.artifact_url = url;
            log(`uploaded: ${url}`);
          }
        } catch (e) {
          log(`upload fail: ${e.message || e}`);
        }
      } catch (e) {
        log(`artifact read fail: ${e.message || e}`);
      }
    } else {
      log("warning: koi .apk output nahi mila");
    }

    await db.builds.updateOne({ _id: job._id }, { $set: patch });

    if (job.appId) {
      try {
        await db.apps.updateOne({ _id: oid(job.appId) }, { $inc: { builds_total: 1 } });
      } catch (_) {}
    }

    userHub.broadcast(String(job.userId || ""), {
      type: "build",
      data: {
        buildId,
        status: "success",
        apk_size: patch.apk_size || 0,
        duration_ms: patch.duration_ms,
        artifact_url: patch.artifact_url || null,
      },
    });
    log("done");
  } finally {
    await flush(true).catch(() => {});
    if (builderConfig.CLEAN_WORKDIR) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

// ------------------------------------------------------------ user hub

class UserHub {
  constructor() {
    this.rooms = new Map();
  }

  join(userId, ws) {
    if (!this.rooms.has(userId)) this.rooms.set(userId, new Set());
    this.rooms.get(userId).add(ws);
  }

  leave(userId, ws) {
    const s = this.rooms.get(userId);
    if (s) {
      s.delete(ws);
      if (!s.size) this.rooms.delete(userId);
    }
  }

  broadcast(userId, payload) {
    const s = this.rooms.get(userId);
    if (!s || !s.size) return;
    const data = JSON.stringify(payload);
    for (const ws of s) {
      try { ws.send(data); } catch (_) {}
    }
  }

  common(ws, req, userId) {
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      const type = String(msg.type || "").toLowerCase();
      if (type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong" })); } catch (_) {}
        return;
      }
      if (type === "subscribe" && msg.buildId) ws._buildId = String(msg.buildId);
    });
  }

  userSocket(ws, req) {
    const userId = new URL(req.url, "http://x").searchParams.get("userId") || "anon";
    this.join(userId, ws);
    this.common(ws, req, userId);
    ws.on("close", () => this.leave(userId, ws));
    ws.on("error", () => this.leave(userId, ws));
    try {
      ws.send(JSON.stringify({ type: "hello", server_time: db.utcNow().toISOString() }));
    } catch (_) {}
  }

  appSocket(ws, req) {
    this.common(ws, req, "app");
    try {
      ws.send(JSON.stringify({ type: "hello", server_time: db.utcNow().toISOString() }));
    } catch (_) {}
  }
}

const userHub = new UserHub();

// ------------------------------------------------------------ router

const jsonParser = express.json({
  verify: (req, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf.toString("utf8");
  },
});

function rawBody(req) {
  if (typeof req.rawBody === "string") return req.rawBody;
  try {
    return req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : "";
  } catch (_) {
    return "";
  }
}

async function verifyApp(req, res, next) {
  try {
    const appId = req.headers["x-app-id"];
    const ts = req.headers["x-timestamp"];
    const sig = req.headers["x-signature"];
    if (!appId || !ts || !sig) {
      throw new u.HttpError(401, "X-App-Id, X-Timestamp, X-Signature required");
    }

    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(skew) || skew > 300) {
      throw new u.HttpError(401, "Timestamp out of ±300s window");
    }

    const id = oid(appId);
    const app = id ? await db.apps.findOne({ _id: id }) : null;
    if (!app) throw new u.HttpError(401, "Unknown app");
    if (!app.secret) throw new u.HttpError(401, "App secret missing");

    const expected = crypto
      .createHmac("sha256", app.secret)
      .update(rawBody(req) + ts)
      .digest("hex");
    if (!safeEq(expected, String(sig).toLowerCase())) {
      throw new u.HttpError(401, "Bad signature");
    }

    req.app = app;
    next();
  } catch (e) {
    next(e);
  }
}

const router = express.Router();

router.use(jsonParser);

router.use((req, _res, next) => {
  if (req.rawBody === undefined) req.rawBody = rawBody(req);
  next();
});

router.use("/builder", express.static(path.join(__dirname, "public")));

router.get("/api/builder/config", ah(async (req, res) => {
  res.json({
    status: "ok",
    version: config.VERSION,
    worker_mode: builderConfig.WORKER_MODE,
    engine: builderConfig.ENGINE,
    variant: builderConfig.DEFAULT_VARIANT,
    default_theme: builderConfig.DEFAULT_THEME,
    template_ok: isDir(builderConfig.TEMPLATE_DIR),
    template_dir: builderConfig.TEMPLATE_DIR,
    public_base_url: config.PUBLIC_BASE_URL || null,
    themes: themes.list(builderConfig.TEMPLATE_DIR),
    queue: getQueue().stats(),
    quota: await quota(),
  });
}));

router.get("/api/builder/preflight", ah(async (req, res) => res.json(preflight())));

router.get("/api/builder/themes", ah(async (req, res) => {
  res.json({ themes: themes.list(builderConfig.TEMPLATE_DIR) });
}));

router.get("/api/apps", ah(async (req, res) => {
  const q = req.query.userId ? { userId: req.query.userId } : {};
  const apps = await db.apps.find(q).sort({ _id: -1 }).limit(200).toArray();
  res.json({ apps: apps.map(shapeApp), quota: await quota() });
}));

router.post("/api/apps", ah(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) throw new u.HttpError(400, "name required");

  const secret = genSecret();
  const doc = {
    userId: b.userId || "anon",
    name,
    package: b.package || "",
    variant: b.variant || builderConfig.DEFAULT_VARIANT,
    theme: b.theme || builderConfig.DEFAULT_THEME,
    config: b.config || {},
    secret,
    secret_last4: secret.slice(-4),
    secret_hash: sha256hex(secret),
    builds_total: 0,
    created_at: db.utcNow(),
  };
  const r = await db.apps.insertOne(doc);
  const app = { ...doc, _id: r.insertedId };
  u.logEvent("app_created", { appId: String(r.insertedId), name });
  res.json({ status: "ok", app: { ...shapeApp(app), secret } });
}));

router.post("/api/apps/:appId/secret/rotate", ah(async (req, res) => {
  const id = oid(req.params.appId);
  if (!id) throw new u.HttpError(400, "Bad appId");

  const secret = genSecret();
  const app = unwrap(
    await db.apps.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          secret,
          secret_last4: secret.slice(-4),
          secret_hash: sha256hex(secret),
          secret_rotated_at: db.utcNow(),
        },
      },
      { returnDocument: db.ReturnDocument.AFTER }
    )
  );
  if (!app) throw new u.HttpError(404, "App not found");

  res.json({ status: "ok", app: { ...shapeApp(app), secret } });
}));

router.delete("/api/apps/:appId", ah(async (req, res) => {
  const id = oid(req.params.appId);
  if (!id) throw new u.HttpError(400, "Bad appId");
  await db.apps.deleteOne({ _id: id });
  await db.builds.deleteMany({ appId: String(id) });
  res.json({ status: "ok" });
}));

router.get("/api/builds", ah(async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 60, 10), 200));
  const q = {};
  if (req.query.userId) q.userId = req.query.userId;
  if (req.query.appId) q.appId = req.query.appId;
  const rows = await db.builds.find(q).sort({ _id: -1 }).limit(limit).toArray();
  res.json({ builds: rows.map(shapeBuild), queue: getQueue().stats() });
}));

router.post("/api/builds", ah(async (req, res) => {
  const b = req.body || {};
  const appId = b.appId ? String(b.appId) : null;

  let app = null;
  if (appId) {
    const id = oid(appId);
    app = id ? await db.apps.findOne({ _id: id }) : null;
    if (!app) throw new u.HttpError(404, "App not found");
  }

  const q = await quota();
  if (!q.unlimited && q.used_today >= q.daily_limit) {
    throw new u.HttpError(429, `Daily build limit (${q.daily_limit}) reach ho gaya`);
  }

  const themeSlug = String(b.theme || (app && app.theme) || builderConfig.DEFAULT_THEME);

  const id = await getQueue().add({
    userId: b.userId || (app && app.userId) || "anon",
    appId,
    appName: (app && app.name) || b.appName || "App",
    package: b.package || (app && app.package) || "",
    variant: b.variant || (app && app.variant) || builderConfig.DEFAULT_VARIANT,
    theme: themeSlug,
    config: { ...(app && app.config ? app.config : {}), ...(b.config || {}) },
    baseUrl: b.baseUrl || requestBaseUrl(req),
  });

  if (builderConfig.START_QUEUE) getQueue()._tick().catch(() => {});

  u.logEvent("build_queued", { buildId: String(id), appId, theme: themeSlug });
  res.json({ status: "ok", build: { buildId: String(id), status: "queued" } });
}));

router.get("/api/builds/:id", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const doc = await db.builds.findOne({ _id: id });
  if (!doc) throw new u.HttpError(404, "Build not found");
  res.json({ build: shapeBuild(doc) });
}));

router.get("/api/builds/:id/log", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const doc = await db.builds.findOne(
    { _id: id },
    { projection: { log_tail: 1, status: 1, error: 1 } }
  );
  if (!doc) throw new u.HttpError(404, "Build not found");
  res.json({ status: doc.status, error: doc.error || null, log: (doc.log_tail || []).join("\n") });
}));

router.post("/api/builds/:id/cancel", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const r = await db.builds.updateOne(
    { _id: id, status: { $in: ["queued", "running"] } },
    { $set: { status: "canceled", finished_at: db.utcNow() } }
  );
  if (!r.matchedCount) throw new u.HttpError(409, "Build already finished");
  res.json({ status: "ok" });
}));

router.post("/api/builds/:id/retry", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const old = await db.builds.findOne({ _id: id });
  if (!old) throw new u.HttpError(404, "Build not found");

  const newId = await getQueue().add({
    userId: old.userId,
    appId: old.appId,
    appName: old.appName,
    package: old.package,
    variant: old.variant,
    theme: old.theme,
    config: old.config || {},
    baseUrl: old.baseUrl || config.PUBLIC_BASE_URL || null,
  });
  res.json({ status: "ok", build: { buildId: String(newId), status: "queued" } });
}));

router.get("/api/builds/:id/download", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const doc = await db.builds.findOne({ _id: id });
  if (!doc) throw new u.HttpError(404, "Build not found");

  const name =
    doc.apk_name || `${(doc.appName || "app").replace(/\s+/g, "-")}-${String(doc._id)}.apk`;

  if (doc.artifact && fs.existsSync(doc.artifact)) {
    res.setHeader("Cache-Control", "no-store");
    return res.download(doc.artifact, name);
  }
  if (doc.artifact_url) return res.redirect(302, doc.artifact_url);
  throw new u.HttpError(404, "APK not ready");
}));

router.post("/api/orders", verifyApp, ah(async (req, res) => {
  const doc = {
    appId: String(req.app._id),
    userId: req.app.userId || "anon",
    payload: req.body || {},
    created_at: db.utcNow(),
  };
  const r = await db.orders.insertOne(doc);
  res.json({
    status: "ok",
    order: { id: String(r.insertedId), appId: doc.appId, created_at: doc.created_at },
  });
}));

router.get("/api/orders", verifyApp, ah(async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 100, 10), 500));
  const rows = await db.orders
    .find({ appId: String(req.app._id) })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
  res.json({ orders: rows });
}));

router.post("/api/echo", verifyApp, ah(async (req, res) => {
  res.json({ status: "ok", appId: String(req.app._id), body: req.body || {} });
}));

module.exports = {
  config: builderConfig,
  ensureDirs,
  bindLoop,
  warmup,
  initQueue,
  getQueue,
  requeueStale,
  stats: () => getQueue().stats(),
  preflight,
  resolveGradle,
  resolveJavaHome,
  resolveAndroidSdk,
  managedSdkRoot,
  detectCompileSdk,
  detectBuildToolsVersion,
  sdkHas,
  writeLicenseHashes,
  ensureJavaRuntime,
  ensureAndroidSdkRuntime,
  ensureGradleRuntime,
  whichSync,
  themes,
  router,
  userHub,
  verifyApp,
  shapeApp,
  shapeBuild,
};