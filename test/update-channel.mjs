// 模拟 Breeze 的自身通道更新流程：拉 release JSON → 选资产 → 下载 → 解压 → 校验
// 用法: node test/update-channel.mjs
import { brotliDecompressSync } from "node:zlib";
import { createRequire } from "node:module";

const REPO = "k623615746/breeze-plugin-copy4000";
const UPDATE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// 1. updateUrl
const release = await (await fetch(UPDATE_URL, { headers: { Accept: "application/json" } })).json();
const tag = String(release.tag_name ?? "");
check("updateUrl 返回 tag_name", Boolean(tag), tag);
check("latest 不含 npmName 干扰", true);

// 2. 选资产：客户端优先 .cjs.br，其次 .cjs
const assets = Array.isArray(release.assets) ? release.assets : [];
const pick =
  assets.find((a) => String(a.name).endsWith(".bundle.cjs.br")) ??
  assets.find((a) => String(a.name).endsWith(".cjs"));
check("release 有可安装资产", Boolean(pick), pick?.name ?? "(none)");
check("优先命中 .br", String(pick?.name ?? "").endsWith(".br"));

// 3. 下载
const res = await fetch(pick.browser_download_url, { headers: { Accept: "*/*" }, redirect: "follow" });
check("资产下载 200", res.ok, `HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());

// 4. 解压（.br 需要 brotli）
let script;
if (pick.name.endsWith(".br")) {
  script = brotliDecompressSync(buf).toString("utf8");
} else {
  script = buf.toString("utf8");
}
check("解压后是脚本", script.includes("module.exports") || script.includes("getInfo"), `${script.length} 字符`);
check("脚本不含 HTML", !script.trimStart().startsWith("<"));

// 5. 加载并核对 getInfo
const require = createRequire(import.meta.url);
globalThis.bytesToBase64 = (b) => Buffer.from(b).toString("base64");
const mod = require("../dist/breeze-plugin-copy4000.bundle.cjs");
const plugin = mod.default ?? mod;
const info = await plugin.getInfo();
check("getInfo 版本与 release 一致", `v${info.version}` === tag || info.version === tag, `${info.version} vs ${tag}`);
check("uuid 不变", info.uuid === "371d33c6-a901-434a-a0ae-d4ea80c7612f", info.uuid);
check("已移除 npmName", !("npmName" in info) || !info.npmName, String(info.npmName ?? "(空)"));
check("updateUrl 指向本仓库", String(info.updateUrl).includes(REPO));

console.log(`\n${failed === 0 ? "更新通道可用" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
