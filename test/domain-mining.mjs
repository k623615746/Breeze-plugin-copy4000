// 独立验证域名挖矿算法（不依赖 breeze-plugin-kit）
const NOISE = ["cloudflare.com","github.com","google.com","apple.com","sentry.io","w3.org"];
const HOST_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|cc|site|online|club|top|xyz|info|io|me|tv|fun|vip|pro|link|app|dev|moe|art|shop|store|live|life|wiki|world|space|website|press|host|cloud|co))\b/gi;
const BRAND_RE = /copy|manga|relamanhua|hotmanga|manhuaren|baozimh|colamanga/i;

const isNoise = (h) => NOISE.some((n) => h === n || h.endsWith("." + n));
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };

function apiBasesFromHost(host) {
  const clean = host.toLowerCase().replace(/^www\./, "");
  if (!clean || isNoise(clean)) return [];
  if (/^(api|mapi)\./.test(clean)) return [`https://${clean}/api/v3`];
  return [`https://api.${clean}/api/v3`, `https://mapi.${clean}/api/v3`, `https://${clean}/api/v3`];
}

function extract(text, currentBase = "") {
  const currentHost = hostOf(currentBase);
  const digits = (currentHost.match(/\d{3,}/g) ?? []).join("");
  const scored = []; const seen = new Set();
  const urls = text.match(/https?:\/\/[^\s"'<>()（）【】\]]+/gi) ?? [];
  for (const u of urls) {
    const host = hostOf(u);
    if (!host || isNoise(host)) continue;
    let s = 1;
    if (/download|app|index|home/i.test(u)) s += 4;
    if (BRAND_RE.test(host)) s += 2;
    if (digits && host.includes(digits)) s += 3;
    for (const b of apiBasesFromHost(host)) { if (seen.has(b)) continue; seen.add(b); scored.push({ b, s }); }
  }
  const hosts = text.match(HOST_RE) ?? [];
  for (const h of hosts) {
    const c = h.toLowerCase();
    if (isNoise(c)) continue;
    let s = 0;
    if (BRAND_RE.test(c)) s += 2;
    if (digits && c.includes(digits)) s += 3;
    if (s === 0) continue;
    for (const b of apiBasesFromHost(c)) { if (seen.has(b)) continue; seen.add(b); scored.push({ b, s }); }
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.b);
}

const cases = [
  ["用户给的原始报错", "請到官網更新最新APP(**https://www.copy4000.com/download**)，您或您身邊的人曾經下載過破解版本的拷貝漫畫，請卸載後到正版官網下載。", "https://api.copy4000.com/api/v3"],
  ["纯文本官网地址", "請到官網更新最新APP(https://www.copy5000.com/download)", "https://api.copy5000.com/api/v3"],
  ["无协议裸域名", "请到官网 www.copy6000.com 下载最新版", "https://api.copy6000.com/api/v3"],
  ["API 域名直给", "请使用 https://api.mangacopy.com/api/v3 接口", "https://api.mangacopy.com/api/v3"],
  ["含噪声", "错误 <a href=\"https://cdn.jsdelivr.net/x.js\"> 请访问 https://copy7000.com/download", "https://api.copy7000.com/api/v3"],
];

let pass = 0;
for (const [name, text, expect] of cases) {
  const got = extract(text, "https://api.copy4000.com/api/v3");
  const ok = got[0] === expect;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}\n  → ${got.slice(0, 3).join(" | ") || "(空)"}`);
}
console.log(`\n${pass}/${cases.length} 通过`);
