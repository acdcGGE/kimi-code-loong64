#!/usr/bin/env node
/**
 * 10-package-linux.mjs — 把 electron-builder 的 --dir 产物构造成 loong64 安装包。
 *
 * 为什么不让 electron-builder 直接出 deb / pacman：
 *   electron-builder 26.x 的这两个 target 走 fpm（构建时从 GitHub 下载的 x86_64
 *   AppImage），loong64 上既下不动也跑不了；AppImage 运行时同理。因此移植层保持
 *   linux.target=["dir"]，再由本脚本用**本机原生 loong64 工具**（dpkg-deb 1.22.6、
 *   bsdtar/libarchive 3.7.4、zstd 1.5.7）从解包目录构造两种标准格式，零网络依赖。
 *
 * 安装布局（两种包一致，与 electron-builder 的 Linux 约定对齐）：
 *   /opt/<pkg>/                     Electron 应用（原 linux-loong64-unpacked 内容）
 *   /usr/bin/<exe>              ->  /opt/<pkg>/<exe>   （符号链接）
 *   /usr/share/applications/<pkg>.desktop
 *   /usr/share/icons/hicolor/<size>/apps/<pkg>.png
 *   /usr/share/doc/<pkg>/copyright
 *
 * 用法：
 *   node scripts/10-package-linux.mjs                  生成 deb + pacman
 *   node scripts/10-package-linux.mjs --check         只审计已有产物（幂等）
 *   node scripts/10-package-linux.mjs --only deb|pacman
 *   --out <dir>        产物目录（默认 <源码树>/packages/desktop/dist）
 *   --pkgrel <n>       Arch pkgrel，默认 1
 *   --keep-stage       保留 build/package-stage 供排查
 *   -v                 输出外部命令
 *
 * 可覆盖项（环境变量）：
 *   KIMI_ROOT                   上游仓库路径
 *   PACKAGING_DEB_DEPENDS        逗号分隔，覆盖自动反查出的 deb Depends
 *   PACKAGING_PACMAN_DEPENDS     逗号分隔，覆盖 Arch depend 列表
 *   PACKAGING_PKGREL             pkgrel
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveKimiRoot } from "./_layout.mjs";

const portRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kimiRoot = resolveKimiRoot(portRoot);
const desktopDir = join(kimiRoot, "apps", "desktop");
const unpackedDir = join(desktopDir, "dist-app", "linux-loong64-unpacked");
const defaultOutDir = join(desktopDir, "dist-app");
const stageRoot = join(portRoot, "build", "package-stage");
const reportPath = join(portRoot, "report", "linux-packages.json");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const checkOnly = has("--check");
const keepStage = has("--keep-stage");
const only = valueOf("--only", "all");
const outDir = resolve(valueOf("--out", defaultOutDir));
const pkgrel = valueOf("--pkgrel", process.env.PACKAGING_PKGREL || "1");
const verbose = has("-v");

const log = (...parts) => console.log("[pkg]", ...parts);
const fail = (msg) => {
  throw new Error(msg);
};

function run(file, args, options = {}) {
  if (verbose) log("$", file, args.join(" "));
  const r = spawnSync(file, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (r.error) fail(`${file}: ${r.error.message}`);
  if (r.status !== 0) {
    fail(`${file} ${args.join(" ")} -> exit ${r.status}\n${(r.stderr || "").slice(0, 1500)}`);
  }
  return r.stdout ?? "";
}

function tryRun(file, args) {
  const r = spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** bash -o pipefail 包一层，避免 bsdtar | zstd 里上游失败被吞掉。 */
function runPipe(script) {
  return run("bash", ["-c", `set -o pipefail; ${script}`]);
}

function sha256(file) {
  const h = createHash("sha256");
  h.update(readFileSync(file));
  return h.digest("hex");
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------- 元数据解析

async function resolveMetadata() {
  if (!existsSync(unpackedDir)) fail(`找不到 --dir 产物：${unpackedDir}`);
  for (const required of ["resources/app.asar"]) {
    if (!existsSync(join(unpackedDir, required))) fail(`产物不完整，缺少 ${required}`);
  }

  // 从产物里真实存在的可执行文件名反推 flavor，比依赖构建期 env 可靠。
  const exeName = ["kimi-code"].find((name) => existsSync(join(unpackedDir, name)));
  if (!exeName) fail(`产物里找不到 kimi-code 可执行文件`);

  let identity = null;
  try {
    const mod = await import(
      pathToFileURL(join(desktopDir, "scripts", "desktop-product-identity.mjs")).href
    );
    identity = Object.values(mod.desktopProductIdentities ?? {}).find(
      (item) => item.linuxExecutableName === exeName,
    );
  } catch {
    // 上游模块不可用时走保守 fallback。
  }
  if (!identity) {
    const preview = exeName.endsWith("-preview");
    identity = {
      flavor: preview ? "preview" : "production",
      productName: preview ? "Kimi Code Preview" : "Kimi Code",
      linuxExecutableName: exeName,
      linuxPackageName: exeName,
    };
  }

  const rootPkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
  const version = rootPkg.version;
  if (!version) fail("根 package.json 没有 version");
  const electronVersion = readFileSync(join(unpackedDir, "version"), "utf8").trim();

  return {
    version,
    electronVersion,
    exeName,
    pkg: identity.linuxPackageName,
    productName: identity.productName,
    flavor: identity.flavor,
    debName: `${identity.linuxPackageName}_${version}_loong64.deb`,
    pacmanName: `${identity.linuxPackageName}-${version}-${pkgrel}-loong64.pkg.tar.zst`,
    // 上游 electron-builder 的 artifactName，供发布流水线对齐（文件名含空格，仅作提示）
    upstreamArtifactHint: `KimiCode-${version}-linux-loong64_TEST.\${ext}`,
  };
}

// ---------------------------------------------------------------- 依赖反查

/**
 * deb 的 Depends 不硬编码：Electron 主二进制的 DT_NEEDED 逐个用 `dpkg -S` 反查成
 * 构建机上的真实包名。这样在 Deepin 25 / loongnix 这类包名尚未 t64 化的系统上
 * 得到 libgtk-3-0、libnss3 等可解析名字，而不是 x86 时代写死的过期集合。
 * Essential 包（libc6 等）由系统保证，不写入 Depends。
 */
function resolveDebDepends(exeName) {
  const override = process.env.PACKAGING_DEB_DEPENDS;
  if (override) {
    return {
      depends: override
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      source: "PACKAGING_DEB_DEPENDS",
      unresolved: [],
      filtered: [],
      baselineSonames: [],
    };
  }

  const elf = run("readelf", ["-d", join(unpackedDir, exeName)]);
  const needed = [...elf.matchAll(/NEEDED[^\]]*\[([^\]]+)\]/g)].map((m) => m[1]);
  const bundled = new Set(readdirSync(unpackedDir));

  // dpkg -S 是「路径子串匹配」：本机任何第三方包只要带了同名 .so 都会被返回。
  // 实测这台机器上有 gcc-14.4.0(/opt/...)、noctalia(/usr/local/...)、
  // liblol(/usr/lib/loongarch64-debian-linux-gnuow/preload/) 三个误命中，直接写进
  // Depends 会让包在别的机器上装不上（本机恰好都装了，自检会假阳性）。
  // 只认系统多架构库目录下的直接子文件。
  const tripletProbe = tryRun("dpkg-architecture", ["-qDEB_HOST_MULTIARCH"]);
  const gccProbe = tryRun("gcc", ["-dumpmachine"]);
  const triplet =
    (tripletProbe.ok && tripletProbe.stdout.trim()) ||
    (gccProbe.ok && gccProbe.stdout.trim()) ||
    "loongarch64-linux-gnu";
  const systemLibPrefixes = [
    `/usr/lib/${triplet}/`,
    `/lib/${triplet}/`,
    "/usr/lib64/",
    "/lib64/",
  ];
  // Deepin 25 把 libc6 等包的 Priority/Essential 都改成 optional/no，
  // dpkg 元数据过滤不可靠，改用显式基线名单（Policy 规定无需声明）。
  const baseline = new Set([
    "libc6",
    "libgcc-s1",
    "libstdc++6",
    "zlib1g",
    "libcrypt1",
  ]);

  const pkgs = new Set();
  const unresolved = [];
  const filtered = new Set();
  const baselineSonames = [];
  for (const lib of needed) {
    if (bundled.has(lib)) continue; // libffmpeg.so 等随包自带
    const r = tryRun("dpkg", ["-S", lib]);
    const found = new Set();
    let baselineHit = false;
    if (r.ok) {
      for (const line of r.stdout.split("\n")) {
        const m = line.match(/^([A-Za-z0-9][^:\s]*?)(?::[A-Za-z0-9-]+)?:\s+(\/\S+)/);
        if (!m) continue;
        const [, name, path] = m;
        if (/-dev\b|-dbg|-dbgsym|-doc\b/.test(name)) {
          filtered.add(`${name} (-dev/-dbg)`);
          continue;
        }
        if (basename(path) !== lib) continue; // 精确对齐 soname
        const prefix = systemLibPrefixes.find((p) => path.startsWith(p));
        if (!prefix || path.slice(prefix.length).includes("/")) {
          filtered.add(`${name} (非系统库目录 ${path})`);
          continue;
        }
        if (baseline.has(name)) {
          filtered.add(`${name} (基线运行库)`);
          baselineHit = true;
          continue;
        }
        found.add(name);
      }
    }
    // 只解析到 libc6 / libgcc-s1 这类基线运行库的 soname 不需要声明依赖，
    // 也不该被当成「反查失败」告警。
    if (found.size === 0) {
      if (baselineHit) baselineSonames.push(lib);
      else unresolved.push(lib);
    }
    for (const name of found) pkgs.add(name);
  }

  // Electron 通过 dlopen / xdg-open 使用，不出现在 DT_NEEDED 里。
  if (tryRun("dpkg-query", ["-W", "xdg-utils"]).ok) pkgs.add("xdg-utils");

  return {
    depends: [...pkgs].sort(),
    source: `readelf DT_NEEDED(${needed.length}) + dpkg -S（系统库目录白名单 ${triplet}）`,
    unresolved,
    filtered: [...filtered].sort(),
    baselineSonames,
  };
}

function resolvePacmanDepends() {
  const override = process.env.PACKAGING_PACMAN_DEPENDS;
  if (override) {
    return override
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // 与 electron-builder.config.js 的 PACMAN_RUNTIME_DEPENDENCIES 保持一致。
  return ["gtk3", "nss", "libxss", "libxtst", "libnotify", "alsa-lib", "mesa", "xdg-utils"];
}

function checkDependsInstalled(depends) {
  const satisfied = [];
  const missing = [];
  for (const name of depends) {
    const r = tryRun("dpkg-query", ["-W", "-f=${Status}", name]);
    (r.ok && r.stdout.includes("install ok installed") ? satisfied : missing).push(name);
  }
  return { satisfied, missing };
}

// ---------------------------------------------------------------- 安装布局

// kimi-code 只提供单张 build/icon.png；按 file(1) 读出的真实像素尺寸落到对应 hicolor 目录，
// 桌面环境会按需缩放，不凭空捏造多尺寸副本。
function findIconSize(iconFile) {
  const r = tryRun("file", ["-b", iconFile]);
  const m = r.ok && r.stdout.match(/(\d+)\s*x\s*(\d+)/);
  return m ? `${m[1]}x${m[2]}` : "256x256";
}

function desktopFile(meta) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${meta.productName}`,
    "GenericName=AI Coding Assistant",
    "Comment=Kimi Code Desktop App",
    `Exec=/usr/bin/${meta.exeName} %U`,
    `Icon=${meta.pkg}`,
    "Terminal=false",
    "Categories=Development;IDE;",
    "MimeType=x-scheme-handler/kimi-code;",
    `StartupWMClass=${meta.exeName}`,
    "",
  ].join("\n");
}

function copyrightFile(meta) {
  return [
    `Kimi Code ${meta.version} — LoongArch64 (loong64) community port, ${meta.productName} flavor.`,
    "",
    "This package is produced by kimi-code-loong64-port/scripts/10-package-linux.mjs",
    "from the electron-builder --dir output. It is not an official upstream release.",
    "",
    "Upstream Kimi Code is licensed under MIT (see LICENSE). Bundled Electron / Chromium",
    "components keep their own licenses; see LICENSE.electron.txt and",
    "LICENSES.chromium.html under /opt/" + meta.pkg + "/.",
    "",
    "Third-party native binaries injected by the port are listed in",
    "THIRD-PARTY-NOTICES.md of the porting project.",
    "",
  ].join("\n");
}

function postinstFile(meta) {
  return [
    "#!/bin/sh",
    "set -e",
    `sandbox="/opt/${meta.pkg}/chrome-sandbox"`,
    'if [ -e "$sandbox" ]; then',
    '  chown root:root "$sandbox" 2>/dev/null || true',
    '  chmod 4755 "$sandbox" 2>/dev/null || true',
    "fi",
    "if command -v update-desktop-database >/dev/null 2>&1; then",
    "  update-desktop-database -q /usr/share/applications || true",
    "fi",
    "if command -v gtk-update-icon-cache >/dev/null 2>&1; then",
    "  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true",
    "fi",
    "",
  ].join("\n");
}

function postrmFile() {
  return [
    "#!/bin/sh",
    "set -e",
    "if command -v update-desktop-database >/dev/null 2>&1; then",
    "  update-desktop-database -q /usr/share/applications || true",
    "fi",
    "if command -v gtk-update-icon-cache >/dev/null 2>&1; then",
    "  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true",
    "fi",
    "",
  ].join("\n");
}

function buildStage(meta, debDepends) {
  log("构造安装布局（复制 805 MB，请稍候）…");
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });

  const optDir = join(stageRoot, "opt", meta.pkg);
  mkdirSync(optDir, { recursive: true });
  run("cp", ["-a", `${unpackedDir}/.`, `${optDir}/`]);

  // Chromium 沙箱 helper 必须是 root:root 4755；--root-owner-group / bsdtar 负责属主，
  // setuid 位在打包前落到 staging 上，deb 与 pacman 两边都能保留。
  const sandbox = join(optDir, "chrome-sandbox");
  if (existsSync(sandbox)) chmodSync(sandbox, 0o4755);

  const binDir = join(stageRoot, "usr", "bin");
  mkdirSync(binDir, { recursive: true });
  // 相对软链：从 /usr/bin 回两级到根再进 /opt，安装到 / 时与绝对软链等价，
  // 但把包解到任意前缀（dpkg-deb -x / 容器 / 校验）时也能正确解析。
  symlinkSync(`../../opt/${meta.pkg}/${meta.exeName}`, join(binDir, meta.exeName));

  const appsDir = join(stageRoot, "usr", "share", "applications");
  mkdirSync(appsDir, { recursive: true });
  writeFileSync(join(appsDir, `${meta.pkg}.desktop`), desktopFile(meta), "utf8");

  const iconSrc = join(desktopDir, "build", "icon.png");
  let iconCount = 0;
  if (existsSync(iconSrc)) {
    const size = findIconSize(iconSrc);
    const dstDir = join(stageRoot, "usr", "share", "icons", "hicolor", size, "apps");
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(iconSrc, join(dstDir, `${meta.pkg}.png`));
    iconCount = 1;
  }

  const docDir = join(stageRoot, "usr", "share", "doc", meta.pkg);
  mkdirSync(docDir, { recursive: true });
  writeFileSync(join(docDir, "copyright"), copyrightFile(meta), "utf8");

  // ---- deb 控制文件（DEBIAN/ 不会被打进 data.tar，pacman 侧显式排除） ----
  const debianDir = join(stageRoot, "DEBIAN");
  mkdirSync(debianDir, { recursive: true });
  const duOut = run("du", ["-sk", join(stageRoot, "opt"), join(stageRoot, "usr")]);
  const installedKiB = duOut
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => sum + (parseInt(line, 10) || 0), 0);
  const control = [
    `Package: ${meta.pkg}`,
    `Version: ${meta.version}`,
    "Section: devel",
    "Priority: optional",
    "Architecture: loong64",
    "Maintainer: Kimi Code <dev@kimi.com>",
    `Installed-Size: ${installedKiB}`,
    `Depends: ${debDepends.join(", ")}`,
    `Description: ${meta.productName} - Kimi Code Desktop App (LoongArch64)`,
    ` Native LoongArch64 build of Kimi Code ${meta.version}, bundles Electron ${meta.electronVersion}.`,
    " Produced by the community loong64 port; not an official upstream release.",
    "",
  ].join("\n");
  writeFileSync(join(debianDir, "control"), control, "utf8");
  writeFileSync(join(debianDir, "postinst"), postinstFile(meta), "utf8");
  chmodSync(join(debianDir, "postinst"), 0o755);
  writeFileSync(join(debianDir, "postrm"), postrmFile(), "utf8");
  chmodSync(join(debianDir, "postrm"), 0o755);

  return { installedKiB, iconCount, control };
}

// ---------------------------------------------------------------- pacman 元数据

function writePacmanMetadata(meta, pacmanDepends, installedBytes) {
  const builddate = run("date", ["+%s"]).trim();
  const pkgver = `${meta.version}-${pkgrel}`;
  const pkginfo = [
    `# Generated by kimi-code-loong64-port/scripts/10-package-linux.mjs`,
    `pkgname = ${meta.pkg}`,
    `pkgbase = ${meta.pkg}`,
    `pkgver = ${pkgver}`,
    `pkgdesc = ${meta.productName} - Kimi Code Desktop App for LoongArch64`,
    `builddate = ${builddate}`,
    `packager = Kimi Code <dev@kimi.com>`,
    `size = ${installedBytes}`,
    `arch = loong64`,
    `license = custom`,
    ...pacmanDepends.map((dep) => `depend = ${dep}`),
    "",
  ].join("\n");
  const buildinfo = [
    "format = 2",
    `pkgname = ${meta.pkg}`,
    `pkgbase = ${meta.pkg}`,
    `pkgver = ${pkgver}`,
    `pkgarch = loong64`,
    `pkgpath = ${outDir}`,
    `startdir = ${portRoot}`,
    "buildtool = kimi-code-loong64-port",
    "buildtoolver = 10",
    "buildenv = !distcc",
    "options = !strip",
    "packager = Kimi Code <dev@kimi.com>",
    `builddate = ${builddate}`,
    "",
  ].join("\n");
  writeFileSync(join(stageRoot, ".PKGINFO"), pkginfo, "utf8");
  writeFileSync(join(stageRoot, ".BUILDINFO"), buildinfo, "utf8");

  // makepkg 的 .MTREE 是 gzip 压缩的 bsdtar mtree，pacman 用它做文件校验。
  runPipe(
    `bsdtar -cf - --format=mtree -C '${stageRoot}' opt usr | gzip -9 > '${join(stageRoot, ".MTREE")}'`,
  );
  return { pkginfo, buildinfo, pkgver, builddate };
}

// ---------------------------------------------------------------- 构建

function buildDeb(meta, stage) {
  const dest = join(outDir, meta.debName);
  log(`dpkg-deb -> ${meta.debName}`);
  run("dpkg-deb", ["--root-owner-group", "-Zzstd", "-z3", "-b", stageRoot, dest]);
  return dest;
}

function buildPacman(meta, pacmanMeta) {
  const dest = join(outDir, meta.pacmanName);
  log(`bsdtar+zstd -> ${meta.pacmanName}`);
  // 显式给出条目顺序：元数据在前、payload 在后；DEBIAN/ 不进 Arch 包。
  runPipe(
    `bsdtar -cf - --uid 0 --gid 0 --uname root --gname root -C '${stageRoot}' ` +
      `.PKGINFO .BUILDINFO .MTREE opt usr | zstd -T0 -3 -c > '${dest}'`,
  );
  return dest;
}

// ---------------------------------------------------------------- 校验

function verify(meta, debPath, pacmanPath, debInfo, pacmanDepends) {
  const debDepends = debInfo.depends;
  const checks = [];
  const check = (name, pass, detail = "") => {
    checks.push({ name, pass: Boolean(pass), detail });
    log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const debExists = existsSync(debPath);
  const pacmanExists = existsSync(pacmanPath);
  check("deb 产物存在", debExists, debExists ? human(statSync(debPath).size) : debPath);
  check(
    "pacman 产物存在",
    pacmanExists,
    pacmanExists ? human(statSync(pacmanPath).size) : pacmanPath,
  );

  if (debExists) {
    const field = (name) => run("dpkg-deb", ["-f", debPath, name]).trim();
    check("deb Package 字段", field("Package") === meta.pkg, field("Package"));
    check("deb Version 字段", field("Version") === meta.version, field("Version"));
    check("deb Architecture 字段", field("Architecture") === "loong64", field("Architecture"));
    const depends = field("Depends");
    check("deb Depends 已写入", depends.length > 0, `${debDepends.length} 项`);
    // 反查时若把本机第三方包（/opt、/usr/local、私有子目录里的同名 .so）
    // 写进来，换台机器就装不上。这里断言被过滤掉的候选没有泄漏进 Depends。
    const leaked = debInfo.filtered
      .map((entry) => entry.split(" ")[0])
      .filter((name) => debDepends.includes(name));
    check("deb Depends 无误命中第三方包", leaked.length === 0, leaked.join(", ") || `已滤除 ${debInfo.filtered.length} 个候选`);

    const listing = run("dpkg-deb", ["-c", debPath]);
    check(
      "deb 内含 app.asar",
      listing.includes(`./opt/${meta.pkg}/resources/app.asar`),
    );
    check(
      "deb 内含可重定位 /usr/bin 软链",
      listing.includes(`./usr/bin/${meta.exeName} -> ../../opt/${meta.pkg}/${meta.exeName}`),
    );
    check(
      "deb 内含 desktop 文件",
      listing.includes(`./usr/share/applications/${meta.pkg}.desktop`),
    );
    check("deb 内 chrome-sandbox 为 setuid", /-rws.*chrome-sandbox/.test(listing));

    // 控制文件是二进制 tar 流，交给 shell 管道，避免经 Node 字符串转换损坏。
    const ctrlListing = run("sh", [
      "-c",
      `dpkg-deb --ctrl-tarfile '${debPath}' | tar -tf -`,
    ]);
    check(
      "deb 含 postinst / postrm 维护脚本",
      ctrlListing.includes("postinst") && ctrlListing.includes("postrm"),
      ctrlListing.trim().replace(/\n/g, " "),
    );

    const dv = tryRun("desktop-file-validate", [
      join(stageRoot, "usr", "share", "applications", `${meta.pkg}.desktop`),
    ]);
    check("desktop-file-validate 通过", dv.ok, dv.stderr.trim().slice(0, 200));
  }

  if (pacmanExists) {
    check("pacman 包 zstd 校验", tryRun("zstd", ["-t", pacmanPath]).ok);
    const entries = run("bsdtar", ["-tf", pacmanPath]).trim().split("\n");
    check("pacman 首个条目为 .PKGINFO", entries[0] === ".PKGINFO", entries[0]);
    check("pacman 不含 DEBIAN/", !entries.some((e) => e.startsWith("DEBIAN/")));
    check("pacman 含 opt/ 与 usr/ payload", entries.some((e) => e.startsWith("opt/")) && entries.some((e) => e.startsWith("usr/")));
    const pkginfo = run("bsdtar", ["-xOf", pacmanPath, ".PKGINFO"]);
    check("pacman arch = loong64", /^arch = loong64$/m.test(pkginfo));
    check("pacman pkgver 正确", pkginfo.includes(`pkgver = ${meta.version}-${pkgrel}`));
    check(
      "pacman depend 条目数",
      (pkginfo.match(/^depend = /gm) || []).length === pacmanDepends.length,
      `${pacmanDepends.length} 项`,
    );
    check("pacman 含 .MTREE / .BUILDINFO", entries.includes(".MTREE") && entries.includes(".BUILDINFO"));
  }

  const depStatus = checkDependsInstalled(debDepends);
  check(
    "构建机 deb 依赖已满足",
    depStatus.missing.length === 0,
    depStatus.missing.length ? `缺 ${depStatus.missing.join(", ")}` : `${depStatus.satisfied.length} 项齐全`,
  );

  return { checks, depStatus };
}

// ---------------------------------------------------------------- 入口

function auditOnly() {
  if (!existsSync(reportPath)) fail(`没有可审计的报告：${reportPath}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const checks = [];
  const check = (name, pass, detail = "") => {
    checks.push({ name, pass: Boolean(pass), detail });
    log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  for (const kind of ["deb", "pacman"]) {
    const entry = report[kind];
    if (!entry) {
      check(`${kind} 报告条目`, false);
      continue;
    }
    // 报告里的 path 是生成时的本机绝对路径，换机器或换布局后即失效；
    // 优先按 outDir + file 重新定位，path 仅作兼容回退。
    const resolved = entry.path && existsSync(entry.path) ? entry.path : join(outDir, entry.file);
    const exists = existsSync(resolved);
    check(`${kind} 产物存在`, exists, entry.file);
    if (!exists) continue;
    const size = statSync(resolved).size;
    check(`${kind} 体积一致`, size === entry.bytes, human(size));
    check(`${kind} sha256 一致`, sha256(resolved) === entry.sha256);
  }
  const bad = checks.filter((c) => !c.pass).length;
  log(`审计结果：${checks.length - bad} PASS / ${bad} FAIL`);
  if (bad) process.exitCode = 1;
  return checks;
}

async function main() {
  if (checkOnly) {
    auditOnly();
    return;
  }

  for (const tool of ["dpkg-deb", "bsdtar", "zstd", "gzip", "readelf", "dpkg", "dpkg-query", "cp", "du", "date", "bash"]) {
    const r = tryRun("sh", ["-c", `command -v ${tool}`]);
    if (!r.ok) fail(`缺少本机打包工具：${tool}`);
  }
  if (!["all", "deb", "pacman"].includes(only)) fail(`--only 只能是 all|deb|pacman，收到 ${only}`);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });

  const meta = await resolveMetadata();
  log(`身份 ${meta.flavor} / ${meta.productName} ${meta.version} / Electron ${meta.electronVersion}`);
  const debInfo = resolveDebDepends(meta.exeName);
  log(`deb Depends 反查：${debInfo.depends.length} 项（${debInfo.source}）`);
  log(
    `  滤除 ${debInfo.filtered.length} 个候选（第三方同名 .so / -dev / 基线运行库），` +
      `${debInfo.baselineSonames.length} 个 soname 由基线运行库兜底`,
  );
  if (debInfo.unresolved.length) {
    log(`警告：${debInfo.unresolved.length} 个 soname 未反查到包名：${debInfo.unresolved.join(", ")}`);
  }
  const pacmanDepends = resolvePacmanDepends();

  const stage = buildStage(meta, debInfo.depends);
  log(`布局完成：${stage.iconCount} 个图标，Installed-Size ${stage.installedKiB} KiB`);

  let debPath = join(outDir, meta.debName);
  let pacmanPath = join(outDir, meta.pacmanName);
  let pacmanMeta = null;
  if (only === "all" || only === "deb") debPath = buildDeb(meta, stage);
  if (only === "all" || only === "pacman") {
    pacmanMeta = writePacmanMetadata(meta, pacmanDepends, stage.installedKiB * 1024);
    pacmanPath = buildPacman(meta, pacmanMeta);
  }

  const { checks, depStatus } = verify(meta, debPath, pacmanPath, debInfo, pacmanDepends);

  const summary = (path) =>
    existsSync(path)
      ? { path, file: basename(path), bytes: statSync(path).size, sha256: sha256(path) }
      : null;
  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      unpackedDir,
      unpackedBytes: Number(run("du", ["-sb", unpackedDir]).split("\t")[0]),
      kimiRoot,
    },
    identity: { flavor: meta.flavor, productName: meta.productName, pkg: meta.pkg, exeName: meta.exeName, version: meta.version, electronVersion: meta.electronVersion },
    tools: {
      dpkgDeb: run("dpkg-deb", ["--version"]).trim().split("\n")[0],
      bsdtar: tryRun("bsdtar", ["--version"]).stdout.trim().split("\n")[0],
      zstd: tryRun("zstd", ["--version"]).stdout.trim(),
      architecture: run("dpkg", ["--print-architecture"]).trim(),
    },
    deb: summary(debPath)
      ? {
          ...summary(debPath),
          control: stage.control.trim(),
          depends: debInfo.depends,
          dependsSource: debInfo.source,
          dependsUnresolvedSonames: debInfo.unresolved,
          dependsFilteredCandidates: debInfo.filtered,
          dependsBaselineSonames: debInfo.baselineSonames,
          dependsSatisfiedOnBuilder: depStatus,
        }
      : null,
    pacman: summary(pacmanPath)
      ? {
          ...summary(pacmanPath),
          pkgrel,
          pkginfo: pacmanMeta?.pkginfo?.trim(),
          depends: pacmanDepends,
        }
      : null,
    layout: {
      appDir: `/opt/${meta.pkg}`,
      launcher: `/usr/bin/${meta.exeName} -> ../../opt/${meta.pkg}/${meta.exeName}`,
      desktop: `/usr/share/applications/${meta.pkg}.desktop`,
      icons: stage.iconCount,
      installedKiB: stage.installedKiB,
      chromeSandboxMode: "4755 root:root",
    },
    upstreamArtifactNameHint: meta.upstreamArtifactHint,
    checks,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`报告 -> ${reportPath}`);

  if (!keepStage) rmSync(stageRoot, { recursive: true, force: true });
  const failed = checks.filter((c) => !c.pass).length;
  log(`结果：${checks.length - failed} PASS / ${failed} FAIL`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[pkg] FATAL", error.message);
  process.exitCode = 1;
});
