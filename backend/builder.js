'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK_ROOT = path.join(ROOT, 'builds');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts');
const KEYSTORE_DIR = path.join(ROOT, 'data', 'keystores');

const SKIP_TOP = new Set([
  '.git', '.github', '.gradle', '.idea',
  'builds', 'artifacts', 'data',
  'backend', 'admin', 'node_modules'
]);

function shouldSkip(rel) {
  const seg = rel.split(path.sep);
  if (SKIP_TOP.has(seg[0])) return true;
  if (seg[0] === 'app' && seg[1] === 'build') return true;
  if (seg[0] === 'app' && seg[1] === '.cxx') return true;
  return false;
}

async function copyTree(src, dest, base) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const rel = base ? path.join(base, e.name) : e.name;
    if (shouldSkip(rel)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyTree(s, d, rel);
    } else if (e.isSymbolicLink()) {
      try { await fsp.symlink(await fsp.readlink(s), d); } catch { /* ignore */ }
    } else {
      await fsp.copyFile(s, d);
    }
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const st = fs.createReadStream(file);
    st.on('data', (d) => h.update(d));
    st.on('end', () => resolve(h.digest('hex')));
    st.on('error', reject);
  });
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32'
    });
    let out = '';
    const pipe = (b) => { out += b.toString(); };
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    child.on('error', reject);
    child.on('close', (code) => {
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${out.slice(-2000)}`));
    });
  });
}

function toolPath(name) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  if (name === 'apksigner' && sdk) {
    const p = path.join(sdk, 'build-tools', process.env.BUILD_TOOLS_VERSION || '35.0.0', 'apksigner' + (process.platform === 'win32' ? '.bat' : ''));
    if (fs.existsSync(p)) return p;
  }
  return name;
}

async function ensureKeystore(app) {
  await fsp.mkdir(KEYSTORE_DIR, { recursive: true });
  const file = path.join(KEYSTORE_DIR, `${app.appId}.jks`);
  if (fs.existsSync(file)) return file;

  const alias = app.keystoreAlias || 'release';
  await run('keytool', [
    '-genkeypair',
    '-keystore', file,
    '-storetype', 'JKS',
    '-alias', alias,
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass', app.keystorePassword,
    '-keypass', app.keystorePassword,
    '-dname', `CN=TPC-${app.appId},OU=Mobile,O=TPC,L=NA,ST=NA,C=IN`,
    '-noprompt'
  ], ROOT);

  return file;
}

class BuildQueue {
  constructor(opts = {}) {
    this.concurrency = Number(opts.concurrency) || 1;
    this.onEvent = opts.onEvent || (() => {});
    this.pending = [];
    this.running = 0;
    this.active = new Map();
  }

  stats() {
    return { queued: this.pending.length, running: this.running, concurrency: this.concurrency };
  }

  enqueue(build, app) {
    build.status = 'queued';
    build.queued_at = Date.now();
    this.pending.push({ build, app });
    this.pump();
    this.onEvent({ type: 'build', data: { buildId: build.buildId, status: 'queued' } });
  }

  pump() {
    while (this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      this.running++;
      this.active.set(job.build.buildId, job.build);
      this.run(job)
        .catch(() => {})
        .finally(() => {
          this.running--;
          this.active.delete(job.build.buildId);
          this.pump();
        });
    }
  }

  cancel(buildId) {
    const live = this.active.get(buildId);
    if (live) {
      live.canceled = true;
      try { live._proc && live._proc.kill('SIGTERM'); } catch { /* ignore */ }
      return live;
    }
    const i = this.pending.findIndex((j) => j.build.buildId === buildId);
    if (i >= 0) {
      const job = this.pending.splice(i, 1)[0];
      job.build.status = 'canceled';
      job.build.finished_at = Date.now();
      this.onEvent({ type: 'build', data: { buildId, status: 'canceled' } });
      return job.build;
    }
    return null;
  }

  logLine(build, text) {
    String(text).split(/\r?\n/).forEach((raw) => {
      const line = raw.replace(/\s+$/, '');
      if (!line) return;
      build.log_tail.push(line);
      if (build.log_tail.length > 500) build.log_tail.splice(0, build.log_tail.length - 500);
      this.onEvent({ type: 'build_log', data: { buildId: build.buildId, line } });
    });
  }

  execGradle(cmd, args, cwd, build) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          ANDROID_HOME: process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '',
          ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || '',
          GRADLE_OPTS: '-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx3g'
        },
        shell: process.platform === 'win32'
      });
      build._proc = child;
      child.stdout.on('data', (b) => this.logLine(build, b.toString()));
      child.stderr.on('data', (b) => this.logLine(build, b.toString()));
      child.on('error', (e) => { build._proc = null; reject(e); });
      child.on('close', (code) => {
        build._proc = null;
        if (build.canceled) return reject(new Error('canceled'));
        code === 0 ? resolve() : reject(new Error(`gradle exit ${code}`));
      });
    });
  }

  async run(job) {
    const { build, app } = job;
    const ws = path.join(WORK_ROOT, build.buildId);
    const started = Date.now();

    build.status = 'running';
    build.started_at = started;
    build.log_tail = [];
    this.onEvent({ type: 'build', data: { buildId: build.buildId, status: 'running' } });

    try {
      this.logLine(build, `[1/7] workspace ${ws}`);
      await fsp.rm(ws, { recursive: true, force: true });
      await copyTree(ROOT, ws, '');
      this.logLine(build, '[2/7] template copied');

      const keystoreFile = await ensureKeystore(app);
      this.logLine(build, '[3/7] keystore ready');

      await fsp.writeFile(path.join(ws, 'builder.properties'), [
        `appId=${app.appId}`,
        `appName=${app.name}`,
        `package=${app.package}`,
        `versionCode=${build.versionCode}`,
        `versionName=${build.versionName}`,
        `baseUrl=${build.baseUrl || ''}`,
        `buildId=${build.buildId}`,
        ''
      ].join('\n'));

      await fsp.writeFile(path.join(ws, 'keystore.properties'), [
        `storeFile=${keystoreFile}`,
        'storeType=JKS',
        `storePassword=${app.keystorePassword}`,
        `keyAlias=${app.keystoreAlias || 'release'}`,
        `keyPassword=${app.keystorePassword}`,
        ''
      ].join('\n'));

      const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
      await fsp.writeFile(path.join(ws, 'local.properties'), `sdk.dir=${sdk}\n`);
      this.logLine(build, '[4/7] builder.properties + keystore.properties written');

      const wrapperFile = path.join(ws, 'gradlew');
const wrapperProperties = path.join(
  ws,
  'gradle',
  'wrapper',
  'gradle-wrapper.properties'
);

if (!fs.existsSync(wrapperFile)) {
  throw new Error('Gradle wrapper missing: gradlew was not copied into build workspace');
}

if (!fs.existsSync(wrapperProperties)) {
  throw new Error('Gradle wrapper config missing: gradle/wrapper/gradle-wrapper.properties');
}

if (process.platform !== 'win32') {
  await fsp.chmod(wrapperFile, 0o755);
}

const task = build.variant === 'debug'
  ? 'assembleDebug'
  : 'assembleRelease';

this.logLine(build, `[5/7] Gradle wrapper: ${wrapperFile}`);
this.logLine(build, `Workspace: ${ws}`);
this.logLine(build, `Task: ${task}`);

await this.execGradle(
  process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
  [
    task,
    '-PappIdBuild=true',
    '--no-daemon',
    '--console=plain',
    '--stacktrace'
  ],
  ws,
  build
);
      this.logLine(build, 'BUILD SUCCESSFUL');

      const outDir = path.join(ws, 'app', 'build', 'outputs', 'apk', build.variant);
      const files = await fsp.readdir(outDir).catch(() => []);
      const apkName = files.find((f) => f.endsWith('.apk') && !f.endsWith('-unsigned.apk'));
      if (!apkName) throw new Error(`koi signed APK nahi mila: ${outDir}`);

      const srcApk = path.join(outDir, apkName);
      await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
      const outApk = path.join(ARTIFACT_DIR, `${build.buildId}.apk`);
      await fsp.copyFile(srcApk, outApk);

      try {
        await run(toolPath('apksigner'), ['verify', '--verbose', outApk], ROOT);
        build.signed = true;
        this.logLine(build, '[6/7] apksigner verify ok');
      } catch {
        build.signed = false;
        this.logLine(build, '[6/7] apksigner verify SKIPPED');
      }

      build.apk_size = (await fsp.stat(outApk)).size;
      build.apk_sha256 = await sha256File(outApk);
      build.duration_ms = Date.now() - started;
      build.finished_at = Date.now();
      build.download_ready = true;
      build.status = 'success';
      this.logLine(build, `[7/7] published ${build.buildId}.apk`);

      if (process.env.KEEP_WORKSPACES !== '1') {
        await fsp.rm(ws, { recursive: true, force: true });
      }
    } catch (err) {
      build.finished_at = Date.now();
      build.duration_ms = Date.now() - started;
      build.error = err.message;
      build.status = build.canceled ? 'canceled' : 'failed';
      this.logLine(build, `ERROR: ${err.message}`);
    } finally {
      build.log_tail = build.log_tail.slice(-300);
      this.onEvent({ type: 'build', data: { buildId: build.buildId, status: build.status } });
    }
  }
}

module.exports = { BuildQueue, ensureKeystore, ARTIFACT_DIR, KEYSTORE_DIR, ROOT, toolPath };