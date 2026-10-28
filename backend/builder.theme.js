"use strict";

/**
 * backend/builder.theme.js
 *
 * Theme discovery + injection.
 * Template structure:
 *   apk_template/themes/<slug>/theme.json     <- optional metadata
 *   apk_template/themes/<slug>/colors.xml     <- optional, {{placeholders}} supported
 *   apk_template/themes/<slug>/themes.xml
 *   apk_template/themes/<slug>/...            <- koi bhi extra res file
 *
 * theme.json:
 * {
 *   "label": "Mono Dark",
 *   "dark": true,
 *   "colors": { "primary": "#111111", "accent": "#00E0B8", "background": "#0B0B0C" }
 * }
 *
 * themes dir na ho to built-in themes use hote hain (crash nahi).
 */

const fs = require("fs");
const path = require("path");

const BUILTIN = {
  mono: {
    label: "Mono",
    dark: true,
    colors: {
      primary: "#111111",
      primaryDark: "#000000",
      onPrimary: "#FFFFFF",
      accent: "#00E0B8",
      onAccent: "#001B16",
      background: "#0B0B0C",
      surface: "#151517",
      onSurface: "#EAEAEA",
      onSurfaceMuted: "#9A9A9F",
      divider: "#2A2A2E",
      bubbleIn: "#1C1C1F",
      bubbleOut: "#0E3B33",
    },
  },
  light: {
    label: "Light",
    dark: false,
    colors: {
      primary: "#1565C0",
      primaryDark: "#0D47A1",
      onPrimary: "#FFFFFF",
      accent: "#00897B",
      onAccent: "#FFFFFF",
      background: "#F5F6F8",
      surface: "#FFFFFF",
      onSurface: "#141414",
      onSurfaceMuted: "#5F6368",
      divider: "#DADCE0",
      bubbleIn: "#FFFFFF",
      bubbleOut: "#D7EEFF",
    },
  },
};

const SLUG_RE = /[^a-z0-9_-]/g;
const TPL_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function sanitizeSlug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(SLUG_RE, "")
    .slice(0, 40);
}

function themesDir(templateDir) {
  return path.join(String(templateDir || ""), "themes");
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function render(text, vars) {
  return String(text).replace(TPL_RE, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  );
}

function copyDir(src, dest, skip = new Set()) {
  let entries = [];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyDir(from, to, skip);
    } else if (e.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

/** template ke saare available themes */
function list(templateDir) {
  const dir = themesDir(templateDir);
  const out = [];
  let entries = [];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    entries = [];
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slug = sanitizeSlug(e.name);
    if (!slug) continue;
    const meta = readJson(path.join(dir, e.name, "theme.json")) || {};
    out.push({
      slug,
      label: String(meta.label || e.name),
      dark: !!meta.dark,
      builtin: false,
    });
  }

  if (!out.length) {
    for (const [slug, meta] of Object.entries(BUILTIN)) {
      out.push({ slug, label: meta.label, dark: !!meta.dark, builtin: true });
    }
  }

  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function resolveTheme(templateDir, slug) {
  const wanted = sanitizeSlug(slug);
  const dir = wanted ? path.join(themesDir(templateDir), wanted) : null;
  const meta = dir ? readJson(path.join(dir, "theme.json")) : null;

  if (meta) {
    return {
      slug: wanted,
      dir,
      meta,
      label: String(meta.label || wanted),
      dark: !!meta.dark,
      builtin: false,
    };
  }

  const key = wanted && BUILTIN[wanted] ? wanted : "mono";
  const b = BUILTIN[key];
  return { slug: key, dir: dir && isDir(dir) ? dir : null, meta: b, label: b.label, dark: !!b.dark, builtin: true };
}

function resValuesDir(workDir) {
  const appRes = path.join(workDir, "app", "src", "main", "res");
  const flatRes = path.join(workDir, "src", "main", "res");
  if (isDir(appRes)) return path.join(appRes, "values");
  if (isDir(flatRes)) return path.join(flatRes, "values");
  return path.join(appRes, "values");
}

function colorsXml(colors) {
  const rows = Object.entries(colors).map(
    ([k, v]) => `    <color name="${k}">${String(v)}</color>`
  );
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${rows.join("\n")}\n</resources>\n`;
}

function themesXml(colors) {
  const c = (k, d) => colors[k] || d;
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.TPC" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="colorPrimary">@color/primary</item>
        <item name="colorPrimaryDark">@color/primaryDark</item>
        <item name="colorAccent">@color/accent</item>
        <item name="android:colorBackground">@color/background</item>
        <item name="android:textColorPrimary">@color/onSurface</item>
        <item name="android:textColorSecondary">@color/onSurfaceMuted</item>
        <item name="android:statusBarColor">${c("primaryDark", "@color/primaryDark")}</item>
        <item name="android:navigationBarColor">${c("background", "@color/background")}</item>
    </style>

    <style name="Theme.TPC.Splash" parent="Theme.TPC">
        <item name="android:windowBackground">@color/background</item>
    </style>
</resources>
`;
}

/**
 * Theme ko workDir me inject karta hai.
 * @returns {{slug:string,label:string,dark:boolean,colors:object,builtin:boolean}}
 */
function inject(templateDir, workDir, slug, appName = "") {
  const t = resolveTheme(templateDir, slug);
  const colors = { ...BUILTIN.mono.colors, ...((t.meta && t.meta.colors) || {}) };
  const vars = { theme: t.slug, appName: String(appName || ""), ...colors };

  // 1. theme ke apne raw files copy karo (theme.json chhod ke)
  if (t.dir) copyDir(t.dir, workDir, new Set(["theme.json"]));

  // 2. colors.xml / themes.xml render karo
  const valuesDir = resValuesDir(workDir);
  fs.mkdirSync(valuesDir, { recursive: true });

  const tplColors = t.dir ? path.join(t.dir, "colors.xml") : null;
  const tplThemes = t.dir ? path.join(t.dir, "themes.xml") : null;

  writeFile(
    path.join(valuesDir, "colors.xml"),
    tplColors && fs.existsSync(tplColors)
      ? render(fs.readFileSync(tplColors, "utf8"), vars)
      : colorsXml(colors)
  );

  writeFile(
    path.join(valuesDir, "themes.xml"),
    tplThemes && fs.existsSync(tplThemes)
      ? render(fs.readFileSync(tplThemes, "utf8"), vars)
      : themesXml(colors)
  );

  // 3. gradle ke liye resolved theme metadata
  writeFile(
    path.join(workDir, "theme.json"),
    JSON.stringify(
      { slug: t.slug, label: t.label, dark: t.dark, colors, appName: String(appName || "") },
      null,
      2
    )
  );

  writeFile(
    path.join(workDir, "theme.properties"),
    [
      `theme=${t.slug}`,
      `themeLabel=${t.label}`,
      `themeDark=${t.dark ? "true" : "false"}`,
      ...Object.entries(colors).map(([k, v]) => `color.${k}=${v}`),
    ].join("\n") + "\n"
  );

  return { slug: t.slug, label: t.label, dark: t.dark, colors, builtin: t.builtin };
}

module.exports = { list, inject, themesDir, resolveTheme, sanitizeSlug, BUILTIN };