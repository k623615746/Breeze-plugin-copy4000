// 校验 manifest 里每个 fnPath 都能在 bundle 导出中找到
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf-8"));
const mod = require("../dist/breeze-plugin-copy4000.bundle.cjs");
const plugin = mod.default ?? mod;

const exported = new Set(Object.keys(plugin));
const wanted = [];

for (const fn of manifest.function ?? []) {
  const scene = fn.action?.payload?.scene;
  if (scene?.body?.request?.fnPath) wanted.push([`function:${fn.id}`, scene.body.request.fnPath]);
  if (scene?.filter?.fnPath) wanted.push([`function:${fn.id}/filter`, scene.filter.fnPath]);
}

// 设置页 / 能力按钮的 fnPath 也要存在
for (const section of plugin.getSettingsBundle ? (await plugin.getSettingsBundle()).scheme.sections : []) {
  for (const field of section.fields ?? []) {
    if (field.fnPath) wanted.push([`setting:${field.key}`, field.fnPath]);
  }
}
for (const action of plugin.getCapabilitiesBundle ? (await plugin.getCapabilitiesBundle()).scheme.actions : []) {
  if (action.fnPath) wanted.push([`capability:${action.key}`, action.fnPath]);
}

// 登录页的提交函数
if (plugin.getLoginBundle) {
  const login = await plugin.getLoginBundle();
  if (login.scheme?.action?.fnPath) wanted.push(["login:submit", login.scheme.action.fnPath]);
}

let bad = 0;
for (const [where, fnPath] of wanted) {
  const ok = exported.has(fnPath);
  if (!ok) bad += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${where} → ${fnPath}`);
}
console.log(`\n${wanted.length - bad}/${wanted.length} 个 fnPath 可解析`);
process.exit(bad === 0 ? 0 : 1);
