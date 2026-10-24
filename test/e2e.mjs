// copy4000 全链路联调：搜索 → 详情 → 章节 → 图片 URL → 图片可达性
// 用法: node test/e2e.mjs [关键词]
const BASE = "https://api.copy4000.com/api/v3";
const HEADERS = {
  Accept: "application/json",
  version: "2025.05.09",
  Origin: "https://copy4000.com",
  region: "0",
  webp: "0",
  platform: "1",
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 Mobile Safari/537.36 iDOKit/1.0.0 RSSX/1.0.0",
};

const keyword = process.argv[2] || "海贼王";
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(5)}ms]`, ...a);

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  const json = JSON.parse(text);
  if (Number(json.code) !== 200) throw new Error(`${path} -> code=${json.code} ${json.message}`);
  return json.results;
}

const search = await get(`/search/comic?q=${encodeURIComponent(keyword)}&limit=3&offset=0&platform=1`);
const first = search.list?.[0];
log(`搜索「${keyword}」命中 ${search.total} 条，首条：${first.name} (${first.path_word})`);

const detail = await get(`/comic2/${first.path_word}?platform=1`);
const groups = Array.isArray(detail.groups) ? detail.groups : Object.values(detail.groups || {});
log(`详情：作者 ${(detail.comic.author || []).map((a) => a.name).join("/")}，分组 ${groups.length} 个`);

const group = groups.find((g) => g.path_word === "default") || groups[0];
const chapters = await get(`/comic/${first.path_word}/group/${group.path_word}/chapters?limit=3&offset=0`);
log(`章节（${group.name}）：共 ${chapters.total} 话，首话 ${chapters.list[0].name}`);

const ch = chapters.list[0];
const content = await get(`/comic/${first.path_word}/chapter2/${ch.uuid}?platform=1`);
const pages = content.chapter.contents || [];
log(`章节「${ch.name}」图片 ${pages.length} 张，首张 ${pages[0]?.url}`);

const img = await fetch(pages[0].url, {
  headers: { Referer: "https://copy4000.com/", "User-Agent": HEADERS["User-Agent"] },
  signal: AbortSignal.timeout(20000),
});
const buf = Buffer.from(await img.arrayBuffer());
const magic = buf.subarray(0, 3).toString("hex");
log(`图片 HTTP ${img.status}，${buf.length} 字节，magic=${magic} ${magic.startsWith("ffd8ff") ? "(JPEG ✓)" : ""}`);

console.log("\n链路完整：搜索 → 详情 → 章节 → 图片 → 图片字节");
