"use strict";

const fs = require("fs");
const path = require("path");

const BASE_COLORS = {
  primary: "#111111",
  primaryDark: "#000000",
  onPrimary: "#FFFFFF",
  accent: "#00E0B8",
  accentSoft: "#0E3B33",
  onAccent: "#001B16",
  background: "#0B0B0C",
  surface: "#151517",
  surfaceAlt: "#1C1C1F",
  onSurface: "#EAEAEA",
  onSurfaceMuted: "#9A9A9F",
  divider: "#2A2A2E",
  bubbleIn: "#1C1C1F",
  bubbleOut: "#0E3B33",
};

function theme(label, dark, overrides) {
  return { label, dark, colors: { ...BASE_COLORS, ...(overrides || {}) } };
}

const BUILTIN = {
  mono: theme("Mono", true, {}),
  light: theme("Light", false, {
    primary: "#1565C0",
    primaryDark: "#0D47A1",
    accent: "#00897B",
    accentSoft: "#D7EEFF",
    onAccent: "#FFFFFF",
    background: "#F5F6F8",
    surface: "#FFFFFF",
    surfaceAlt: "#EFEFF2",
    onSurface: "#141414",
    onSurfaceMuted: "#5F6368",
    divider: "#DADCE0",
    bubbleIn: "#FFFFFF",
    bubbleOut: "#D7EEFF",
  }),
  midnight: theme("Midnight", true, {
    primary: "#0B1224",
    primaryDark: "#05070F",
    accent: "#7C5CFF",
    accentSoft: "#221B45",
    onAccent: "#FFFFFF",
    background: "#05070F",
    surface: "#0D1428",
    surfaceAlt: "#121A33",
    onSurface: "#E6EAFF",
    onSurfaceMuted: "#8C97C2",
    divider: "#1E2A4D",
    bubbleIn: "#121A33",
    bubbleOut: "#241C52",
  }),
  ocean: theme("Ocean", true, {
    primary: "#062A3A",
    primaryDark: "#031A26",
    accent: "#22D3EE",
    accentSoft: "#0B3B4D",
    onAccent: "#00212B",
    background: "#04131C",
    surface: "#082430",
    surfaceAlt: "#0C2E3D",
    onSurface: "#E2F6FF",
    onSurfaceMuted: "#7FB2C7",
    divider: "#14455A",
    bubbleIn: "#0C2E3D",
    bubbleOut: "#0B4657",
  }),
  sunset: theme("Sunset", true, {
    primary: "#2A1020",
    primaryDark: "#180812",
    accent: "#FB7185",
    accentSoft: "#43182A",
    onAccent: "#2A0714",
    background: "#170B14",
    surface: "#23101D",
    surfaceAlt: "#2E1526",
    onSurface: "#FFE8F0",
    onSurfaceMuted: "#C79AAC",
    divider: "#4A2138",
    bubbleIn: "#2E1526",
    bubbleOut: "#4A1C33",
  }),
  forest: theme("Forest", true, {
    primary: "#0C2018",
    primaryDark: "#06120E",
    accent: "#34D399",
    accentSoft: "#123A2C",
    onAccent: "#00291B",
    background: "#08150F",
    surface: "#0F2419",
    surfaceAlt: "#143021",
    onSurface: "#E4FBEF",
    onSurfaceMuted: "#84B8A0",
    divider: "#1E4632",
    bubbleIn: "#143021",
    bubbleOut: "#12402C",
  }),
  neon: theme("Neon", true, {
    primary: "#0A0A12",
    primaryDark: "#04040A",
    accent: "#39FF14",
    accentSoft: "#123016",
    onAccent: "#04210A",
    background: "#05050C",
    surface: "#0E0E1A",
    surfaceAlt: "#141426",
    onSurface: "#EAFBEA",
    onSurfaceMuted: "#8FA88F",
    divider: "#22331F",
    bubbleIn: "#141426",
    bubbleOut: "#173A1C",
  }),
  rose: theme("Rose", false, {
    primary: "#FFFFFF",
    primaryDark: "#F1E4EA",
    accent: "#E11D74",
    accentSoft: "#FDE4F0",
    onAccent: "#FFFFFF",
    background: "#FFF7FB",
    surface: "#FFFFFF",
    surfaceAlt: "#FBEFF5",
    onSurface: "#26121C",
    onSurfaceMuted: "#8A6C7A",
    divider: "#F2D9E5",
    bubbleIn: "#FFFFFF",
    bubbleOut: "#FDE4F0",
  }),
  slate: theme("Slate", false, {
    primary: "#1E293B",
    primaryDark: "#0F172A",
    accent: "#3B82F6",
    accentSoft: "#DBEAFE",
    onAccent: "#FFFFFF",
    background: "#F1F5F9",
    surface: "#FFFFFF",
    surfaceAlt: "#E8EEF6",
    onSurface: "#0F172A",
    onSurfaceMuted: "#64748B",
    divider: "#CBD5E1",
    bubbleIn: "#FFFFFF",
    bubbleOut: "#DBEAFE",
  }),
};

const DEFAULT_SLUG = "mono";
const MAX_HERO = 3;
const SLUG_RE = /[^a-z0-9_-]/g;
const TPL_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

let _cache = { key: "", at: 0, data: [] };

function invalidate() {
  _cache = { key: "", at: 0, data: [] };
}

function sanitizeSlug(s) {
  return String(s === null || s === undefined ? "" : s)
    .trim()
    .toLowerCase()
    .replace(SLUG_RE, "")
    .slice(0, 40);
}

function sanitizeColor(v, fallback) {
  if (v === null || v === undefined) return fallback;
  let s = String(v).trim().replace(/["'<>]/g, "");
  if (!s) return fallback;
  if (s.startsWith("@")) return s.slice(0, 60);
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s.toLowerCase();
  return fallback;
}

function sanitizeText(v, max) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max || 40);
}

function sanitizeHero(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const u of arr) {
    const s = String(u === null || u === undefined ? "" : u).trim();
    if (!/^https?:\/\//i.test(s)) continue;
    out.push(s.slice(0, 400));
    if (out.length >= MAX_HERO) break;
  }
  return out;
}

function normalizeColors(raw, base) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  const keys = new Set([...Object.keys(BASE_COLORS), ...Object.keys(src)]);
  for (const k of keys) {
    const key = String(k).replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
    if (!key) continue;
    out[key] = sanitizeColor(src[k], (base && base[key]) || BASE_COLORS[key] || "#000000");
  }
  return out;
}

function baseColorsFor(slug, meta) {
  const s = sanitizeSlug(slug);
  if (s && BUILTIN[s]) return BUILTIN[s].colors;
  const dark = meta && meta.dark !== undefined ? !!meta.dark : true;
  return dark ? BUILTIN.mono.colors : BUILTIN.light.colors;
}

function normalizeMeta(meta, slug, fallbackLabel) {
  const m = meta && typeof meta === "object" ? meta : {};
  const dark = m.dark === undefined ? true : !!m.dark;
  const base = baseColorsFor(slug, { dark });
  return {
    label: sanitizeText(m.label || fallbackLabel || slug, 40) || String(slug || DEFAULT_SLUG),
    dark,
    colors: normalizeColors(m.colors, base),
    hero: sanitizeHero(m.hero),
    brand: sanitizeText(m.brand, 30),
    tagline: sanitizeText(m.tagline, 60),
    logoText: sanitizeText(m.logoText, 4),
  };
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

function copyDir(src, dest, skip) {
  let entries = [];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    if (skip && skip.has(e.name)) continue;
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

function dirSignature(dir) {
  try {
    const st = fs.statSync(dir);
    return `${dir}:${st.mtimeMs}`;
  } catch (_) {
    return `${dir}:missing`;
  }
}

function builtinEntry(slug) {
  const b = BUILTIN[slug];
  const m = normalizeMeta(b, slug, b.label);
  return {
    slug,
    label: m.label,
    dark: m.dark,
    builtin: true,
    colors: m.colors,
    hero: m.hero,
    brand: m.brand,
    tagline: m.tagline,
    logoText: m.logoText,
  };
}

function list(templateDir) {
  const dir = themesDir(templateDir);
  const key = dirSignature(dir);
  if (_cache.key === key && _cache.data.length) return _cache.data;

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
    const meta = readJson(path.join(dir, e.name, "theme.json"));
    const m = normalizeMeta(meta, slug, e.name);
    out.push({
      slug,
      label: m.label,
      dark: m.dark,
      builtin: false,
      colors: m.colors,
      hero: m.hero,
      brand: m.brand,
      tagline: m.tagline,
      logoText: m.logoText,
    });
  }

  if (!out.length) {
    for (const slug of Object.keys(BUILTIN)) out.push(builtinEntry(slug));
  }

  out.sort((a, b) => a.slug.localeCompare(b.slug));
  _cache = { key, at: Date.now(), data: out };
  return out;
}

function catalog(templateDir) {
  return list(templateDir);
}

function count(templateDir) {
  return list(templateDir).length;
}

function resolveTheme(templateDir, slug) {
  const wanted = sanitizeSlug(slug);
  const dir = wanted ? path.join(themesDir(templateDir), wanted) : null;
  const meta = dir ? readJson(path.join(dir, "theme.json")) : null;

  if (meta) {
    const m = normalizeMeta(meta, wanted, wanted);
    return {
      slug: wanted,
      dir,
      meta: m,
      label: m.label,
      dark: m.dark,
      colors: m.colors,
      hero: m.hero,
      brand: m.brand,
      tagline: m.tagline,
      logoText: m.logoText,
      builtin: false,
    };
  }

  const key = wanted && BUILTIN[wanted] ? wanted : DEFAULT_SLUG;
  const m = normalizeMeta(BUILTIN[key], key, BUILTIN[key].label);
  return {
    slug: key,
    dir: dir && isDir(dir) ? dir : null,
    meta: m,
    label: m.label,
    dark: m.dark,
    colors: m.colors,
    hero: m.hero,
    brand: m.brand,
    tagline: m.tagline,
    logoText: m.logoText,
    builtin: true,
  };
}

function get(templateDir, slug) {
  return resolveTheme(templateDir, slug);
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
        <item name="colorOnPrimary">@color/onPrimary</item>
        <item name="android:colorBackground">@color/background</item>
        <item name="android:textColorPrimary">@color/onSurface</item>
        <item name="android:textColorSecondary">@color/onSurfaceMuted</item>
        <item name="android:statusBarColor">${c("primaryDark", "@color/primaryDark")}</item>
        <item name="android:navigationBarColor">${c("background", "@color/background")}</item>
    </style>

    <style name="Theme.TPC.Splash" parent="Theme.TPC">
        <item name="android:windowBackground">@color/background</item>
    </style>

    <style name="Theme.TPC.Bubble.In" parent="Theme.TPC">
        <item name="android:background">@color/bubbleIn</item>
    </style>

    <style name="Theme.TPC.Bubble.Out" parent="Theme.TPC">
        <item name="android:background">@color/bubbleOut</item>
    </style>
</resources>
`;
}

function scaffold(templateDir, slug, meta) {
  const s = sanitizeSlug(slug) || "custom";
  const dir = path.join(themesDir(templateDir), s);
  if (isDir(dir)) return { slug: s, dir, created: false };

  const m = normalizeMeta(meta, s, s);
  fs.mkdirSync(dir, { recursive: true });

  writeFile(
    path.join(dir, "theme.json"),
    JSON.stringify(
      {
        label: m.label,
        dark: m.dark,
        colors: m.colors,
        hero: m.hero,
        brand: m.brand,
        tagline: m.tagline,
        logoText: m.logoText,
      },
      null,
      2
    )
  );

  writeFile(path.join(dir, "colors.xml"), colorsXml(m.colors));
  writeFile(path.join(dir, "themes.xml"), themesXml(m.colors));

  invalidate();
  return { slug: s, dir, created: true };
}

function inject(templateDir, workDir, slug, appName) {
  const t = resolveTheme(templateDir, slug);
  const colors = t.colors;
  const name = sanitizeText(appName, 60);

  const vars = {
    theme: t.slug,
    themeLabel: t.label,
    themeDark: t.dark ? "true" : "false",
    appName: name,
    brand: t.brand,
    tagline: t.tagline,
    logoText: t.logoText,
    ...colors,
  };

  if (t.dir) copyDir(t.dir, workDir, new Set(["theme.json"]));

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

  writeFile(
    path.join(workDir, "theme.json"),
    JSON.stringify(
      {
        slug: t.slug,
        label: t.label,
        dark: t.dark,
        colors,
        hero: t.hero,
        brand: t.brand,
        tagline: t.tagline,
        logoText: t.logoText,
        appName: name,
      },
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
      `themeBrand=${t.brand}`,
      `themeTagline=${t.tagline}`,
      `themeLogoText=${t.logoText}`,
      `themeHeroCount=${t.hero.length}`,
      ...t.hero.map((u, i) => `themeHero${i + 1}=${u}`),
      ...Object.entries(colors).map(([k, v]) => `color.${k}=${v}`),
    ].join("\n") + "\n"
  );

  return {
    slug: t.slug,
    label: t.label,
    dark: t.dark,
    colors,
    hero: t.hero,
    brand: t.brand,
    tagline: t.tagline,
    logoText: t.logoText,
    builtin: t.builtin,
  };
}

const apply = inject;

module.exports = {
  BUILTIN,
  BASE_COLORS,
  DEFAULT_SLUG,
  list,
  catalog,
  count,
  get,
  inject,
  apply,
  resolveTheme,
  scaffold,
  invalidate,
  themesDir,
  sanitizeSlug,
  sanitizeColor,
  sanitizeText,
  sanitizeHero,
  normalizeColors,
  normalizeMeta,
  colorsXml,
  themesXml,
};