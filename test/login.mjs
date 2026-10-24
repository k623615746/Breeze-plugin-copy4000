// 登录接口诊断：证明 UA 是登录失败的根因
// 用法: node test/login.mjs [username] [password]
const BASE = "https://api.copy4000.com/api/v3";
const APP_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 Mobile Safari/537.36 iDOKit/1.0.0 RSSX/1.0.0";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const username = process.argv[2] || "testuser_not_exist";
const password = process.argv[3] || "test1234";
const encoded = Buffer.from(`${password}-1729`, "utf8").toString("base64");

const baseHeaders = {
  Accept: "application/json",
  version: "2025.05.09",
  Origin: "https://copy4000.com",
  region: "0",
  platform: "1",
  "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
};

async function attempt(label, ua) {
  const headers = { ...baseHeaders };
  if (ua) headers["User-Agent"] = ua;
  const body = new URLSearchParams({ username, password: encoded, salt: "1729" }).toString();
  const res = await fetch(`${BASE}/login`, { method: "POST", headers, body, signal: AbortSignal.timeout(20000) });
  const json = await res.json();
  const antiPiracy = /破解|官網|官网|download/i.test(String(json.message ?? ""));
  console.log(`${label.padEnd(12)} code=${json.code}  ${antiPiracy ? "[反盗版拦截]" : "[业务响应]"}  ${String(json.message).slice(0, 60)}`);
  return { json, antiPiracy };
}

const noUa = await attempt("无 UA", "");
const browser = await attempt("浏览器 UA", BROWSER_UA);
const app = await attempt("APP UA", APP_UA);

console.log("");
const pass = !noUa.antiPiracy === false && !browser.antiPiracy === false && app.antiPiracy === false;
console.log(pass ? "结论：只有 APP UA 能穿过反盗版拦截 → 登录必须带 APP UA" : "结论：响应形态与预期不符，需重新分析");

if (app.json.results?.token) {
  console.log(`登录成功，token 前缀：${String(app.json.results.token).slice(0, 12)}…`);
} else {
  console.log("（用测试账号，走到业务层即为通过）");
}
