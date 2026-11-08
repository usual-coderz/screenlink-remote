"use strict";

/**
 * backend/builder.link.js
 *
 * Template <-> build job linking:
 * - builder.properties
 * - keystore.properties
 * - strings.xml app_name
 * - local.properties
 *
 * Features:
 * - PKCS12 support for newly generated keystores.
 * - JKS compatibility for existing keystores.
 * - Consistent password handling.
 * - Java properties escaping.
 * - Safe application ID and app name handling.
 * - Android SDK path configuration.
 */

const fs = require("fs");
const path = require("path");

const config = require("./config");

const KEYS = [
  "appId",
  "appName",
  "apiBase",
  "versionCode",
  "versionName",
  "baseUrl",
  "appSecret",
  "buildId",
  "theme",
  "minify",
  "shrinkResources",
  "abiFilters",
];

const APP_ID_RE =
  /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

const DEFAULT_APP_ID = "com.tpc.panel";
const DEFAULT_KEYSTORE_TYPE = "PKCS12";

const isWin = process.platform === "win32";

/* -------------------------------------------------------
 * FILE HELPERS
 * ----------------------------------------------------- */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function write(file, lines) {
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
  });

  fs.writeFileSync(
    file,
    lines.join("\n") + "\n",
    "utf8"
  );
}

/* -------------------------------------------------------
 * JAVA PROPERTIES ESCAPING
 * ----------------------------------------------------- */

function esc(value) {
  let s = String(
    value === undefined || value === null ? "" : value
  )
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, "\\t");

  let out = "";

  for (const ch of s) {
    const code = ch.codePointAt(0);

    if (ch === "\\") {
      out += "\\\\";
    } else if (code > 0x7e) {
      if (code <= 0xffff) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      } else {
        const cp = code - 0x10000;
        const high = 0xd800 + (cp >> 10);
        const low = 0xdc00 + (cp & 0x3ff);

        out +=
          `\\u${high.toString(16).padStart(4, "0")}` +
          `\\u${low.toString(16).padStart(4, "0")}`;
      }
    } else {
      out += ch;
    }
  }

  return out;
}

function escKey(k) {
  return String(k).replace(/([\\=:\s])/g, "\\$1");
}

function escPath(p) {
  return esc(
    String(p).replace(/\\/g, isWin ? "\\\\" : "\\")
  );
}

/* -------------------------------------------------------
 * XML ESCAPING
 * ----------------------------------------------------- */

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* -------------------------------------------------------
 * APPLICATION ID
 * ----------------------------------------------------- */

function sanitizeAppId(raw) {
  let s = String(raw || "").trim().toLowerCase();

  if (!s) return DEFAULT_APP_ID;

  s = s.replace(/[^a-z0-9._]/g, "");

  s = s
    .replace(/\.{2,}/g, ".")
    .replace(/^[._]+|[._]+$/g, "");

  if (!s) return DEFAULT_APP_ID;

  if (!s.includes(".")) {
    s = `${DEFAULT_APP_ID}.${s}`;
  }

  const parts = s
    .split(".")
    .map((p) => (/^[a-z_]/.test(p) ? p : `a${p}`));

  s = parts.join(".");

  return APP_ID_RE.test(s) ? s : DEFAULT_APP_ID;
}

/* -------------------------------------------------------
 * APPLICATION NAME
 * ----------------------------------------------------- */

function sanitizeAppName(raw) {
  const s = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();

  return s.slice(0, 60) || "TPC Panel";
}

/* -------------------------------------------------------
 * API BASE URL
 * ----------------------------------------------------- */

function resolveApiBase(job = {}, cfg = {}) {
  const raw = String(
    job.apiBase ||
      job.baseUrl ||
      cfg.apiBase ||
      cfg.baseUrl ||
      config.PUBLIC_BASE_URL ||
      ""
  ).trim();

  return raw.replace(/\/+$/, "");
}

/* -------------------------------------------------------
 * BOOLEAN HELPERS
 * ----------------------------------------------------- */

function truthy(v, def) {
  if (v === undefined || v === null || v === "") {
    return def;
  }

  return ["1", "true", "yes", "on"].includes(
    String(v).toLowerCase()
  );
}

/* -------------------------------------------------------
 * BUILDER PROPERTIES
 * ----------------------------------------------------- */

function writeBuilderProps(workDir, job = {}) {
  const cfg = job.config || {};

  const appId = sanitizeAppId(
    cfg.applicationId || job.package || ""
  );

  const appName = sanitizeAppName(
    job.appName || cfg.name || ""
  );

  const apiBase = resolveApiBase(job, cfg);

  const map = {
    appId,

    appName,

    apiBase,

    versionCode:
      parseInt(
        cfg.versionCode || job.versionCode || 1,
        10
      ) || 1,

    versionName: String(
      cfg.versionName || job.versionName || "1.0"
    ),

    baseUrl: apiBase,

    appSecret: String(
      job.appSecret ||
        cfg.appSecret ||
        job.secret ||
        ""
    ),

    buildId: String(
      job.buildId || job._id || ""
    ),

    theme: String(
      job.theme || cfg.theme || "mono"
    ),

    minify: String(
      truthy(cfg.minify, true)
    ),

    shrinkResources: String(
      truthy(cfg.shrinkResources, true)
    ),

    abiFilters: String(
      cfg.abiFilters || ""
    ),
  };

  write(
    path.join(workDir, "builder.properties"),

    KEYS.map(
      (k) => `${escKey(k)}=${esc(map[k])}`
    )
  );

  return map;
}

/* -------------------------------------------------------
 * KEYSTORE PROPERTIES
 *
 * New keystores should be generated as PKCS12.
 *
 * Existing JKS keystores must explicitly provide
 * storeType: "JKS".
 *
 * Never silently change the format of an existing
 * keystore.
 * ----------------------------------------------------- */

function writeKeystoreProps(workDir, keystore) {
  const file = path.join(
    workDir,
    "keystore.properties"
  );

  if (!keystore || !keystore.path) {
    try {
      fs.rmSync(file, {
        force: true,
      });
    } catch (_) {}

    return null;
  }

  const keystorePath = path.resolve(
    String(keystore.path)
  );

  const storePassword = String(
    keystore.storePassword || ""
  );

  const keyAlias = String(
    keystore.keyAlias || ""
  );

  const storeType = String(
    keystore.storeType || DEFAULT_KEYSTORE_TYPE
  ).toUpperCase();

  if (!fs.existsSync(keystorePath)) {
    throw new Error(
      `Keystore file not found: ${keystorePath}`
    );
  }

  if (!fs.statSync(keystorePath).isFile()) {
    throw new Error(
      "Keystore path is not a regular file"
    );
  }

  if (!storePassword) {
    throw new Error(
      "Keystore storePassword is missing"
    );
  }

  if (!keyAlias) {
    throw new Error(
      "Keystore keyAlias is missing"
    );
  }

  if (!["JKS", "PKCS12"].includes(storeType)) {
    throw new Error(
      `Unsupported keystore type: ${storeType}`
    );
  }

  /*
   * PKCS12 uses the store password for the key.
   *
   * JKS may have a separate key password.
   */

  const keyPassword =
    storeType === "PKCS12"
      ? storePassword
      : String(
          keystore.keyPassword || storePassword
        );

  write(file, [
    `storeFile=${escPath(keystorePath)}`,

    `storeType=${esc(storeType)}`,

    `storePassword=${esc(storePassword)}`,

    `keyAlias=${esc(keyAlias)}`,

    `keyPassword=${esc(keyPassword)}`,
  ]);

  return file;
}

/* -------------------------------------------------------
 * STRINGS XML PATH
 * ----------------------------------------------------- */

function stringsXmlPath(workDir) {
  const candidates = [
    path.join(
      workDir,
      "app",
      "src",
      "main",
      "res",
      "values",
      "strings.xml"
    ),

    path.join(
      workDir,
      "src",
      "main",
      "res",
      "values",
      "strings.xml"
    ),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return candidates[0];
}

/* -------------------------------------------------------
 * APPLICATION NAME XML
 * ----------------------------------------------------- */

function writeAppName(workDir, appName) {
  const name = sanitizeAppName(appName);

  const file = stringsXmlPath(workDir);

  const safe = xmlEsc(name);

  const entry =
    `    <string name="app_name">${safe}</string>`;

  if (!fs.existsSync(file)) {
    write(file, [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<resources>",
      entry,
      "</resources>",
    ]);

    return file;
  }

  let xml = fs.readFileSync(file, "utf8");

  if (
    /<string\s+name="app_name"[\s\S]*?<\/string>/.test(
      xml
    )
  ) {
    xml = xml.replace(
      /<string\s+name="app_name"[\s\S]*?<\/string>/,
      entry.trim()
    );
  } else if (/<\/resources>/.test(xml)) {
    xml = xml.replace(
      /<\/resources>/,
      `${entry}\n</resources>`
    );
  } else {
    xml +=
      `\n<resources>\n${entry}\n</resources>\n`;
  }

  fs.writeFileSync(file, xml, "utf8");

  return file;
}

/* -------------------------------------------------------
 * ANDROID LOCAL PROPERTIES
 * ----------------------------------------------------- */

function writeLocalProperties(workDir, sdkDir) {
  if (!sdkDir) return null;

  const file = path.join(
    workDir,
    "local.properties"
  );

  const p = String(sdkDir).replace(
    /\\/g,
    isWin ? "\\\\" : "\\"
  );

  write(file, [
    `sdk.dir=${p}`,
  ]);

  return file;
}

/* -------------------------------------------------------
 * GRADLE PROPERTIES
 * ----------------------------------------------------- */

function writeGradleProps(workDir, opts = {}) {
  const lines = [];

  if (opts.jvmArgs) {
    lines.push(
      `org.gradle.jvmargs=${esc(opts.jvmArgs)}`
    );
  }

  if (opts.parallel !== undefined) {
    lines.push(
      `org.gradle.parallel=${truthy(
        opts.parallel,
        true
      )}`
    );
  }

  if (opts.caching !== undefined) {
    lines.push(
      `org.gradle.caching=${truthy(
        opts.caching,
        true
      )}`
    );
  }

  if (opts.daemon !== undefined) {
    lines.push(
      `org.gradle.daemon=${truthy(
        opts.daemon,
        false
      )}`
    );
  }

  if (!lines.length) return null;

  const file = path.join(
    workDir,
    "gradle.properties"
  );

  const existing = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trimEnd()
    : "";

  fs.mkdirSync(path.dirname(file), {
    recursive: true,
  });

  fs.writeFileSync(
    file,
    (existing ? existing + "\n" : "") +
      lines.join("\n") +
      "\n",
    "utf8"
  );

  return file;
}

/* -------------------------------------------------------
 * EXPORTS
 * ----------------------------------------------------- */

module.exports = {
  KEYS,

  DEFAULT_KEYSTORE_TYPE,

  esc,
  escKey,
  escPath,

  xmlEsc,

  sanitizeAppId,
  sanitizeAppName,

  resolveApiBase,

  writeBuilderProps,
  writeKeystoreProps,

  writeAppName,
  writeLocalProperties,

  writeGradleProps,
};