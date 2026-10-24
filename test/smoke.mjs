// 本地冒烟：用 Node 模拟宿主环境加载打包产物，跑真实接口
// 用法: node test/smoke.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// —— 宿主运行时桩 ——
globalThis.bytesToBase64 = (bytes) => Buffer.from(bytes).toString("base64");
const store = new Map();
globalThis.bridge = {
  async call(route, ...args) {
    if (route.startsWith("cache.")) {
      const [, op, key, value] = route.split(".");
      void op;
      void key;
      void value;
      return null;
    }
    void args;
    return null;
  },
  callSync() {
    return null;
  },
};

const mod = require("../dist/breeze-plugin-copy4000.bundle.cjs");
const plugin = mod.default ?? mod;

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);
let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// 1. init
const initRes = await plugin.init();
log("init:", JSON.stringify(initRes.data));

// 2. 搜索
const search = await plugin.searchComic({ keyword: "海贼王", page: 1 });
const first = search.items?.[0];
log(`搜索：${search.items.length} 条，首条 ${first?.title} (${first?.id})`);
check("searchComic 返回条目", search.items.length > 0);
check("searchComic 契约完整", Boolean(search.paging && search.scheme?.type === "searchResult"));

// 3. 详情
const detail = await plugin.getComicDetail({ comicId: first.id });
const eps = detail.data.normal.eps;
log(`详情：${detail.data.normal.comicInfo.title}，${eps.length} 话，作者 ${detail.data.normal.comicInfo.creator.name}`);
check("getComicDetail 章节非空", eps.length > 0);
check("章节 order 全局唯一", new Set(eps.map((e) => e.order)).size === eps.length);

// 4. 阅读快照
const target = eps[0];
const snapshot = await plugin.getReadSnapshot({ comicId: first.id, chapterId: target.requestId });
const pages = snapshot.data.chapter.pages;
log(`阅读：${target.name}，${pages.length} 页，首图 ${pages[0]?.url?.slice(0, 60)}…`);
check("getReadSnapshot 有图片", pages.length > 0);
check("pages.url 非占位", pages[0].url.startsWith("http"));

// 5. 图片字节
const bytes = await plugin.fetchImageBytes({ url: pages[0].url, timeoutMs: 30000 });
const magic = Buffer.from(bytes).subarray(0, 3).toString("hex");
log(`图片：${bytes.length} 字节，magic=${magic}`);
check("fetchImageBytes 拿到 JPEG", magic === "ffd8ff");

// 6. 排行榜 / 设置
const rank = await plugin.getRankingData({ page: 1, extern: { source: "rank", dateType: "日榜", audience: "男频" } });
log(`排行榜：${rank.data.items.length} 条，hasReachedMax=${rank.data.hasReachedMax}`);
check("getRankingData 返回条目", rank.data.items.length > 0);

const settings = await plugin.getSettingsBundle();
log(`设置：${settings.scheme.sections.length} 个分组，当前锁定=${JSON.stringify(settings.data.values["api.lock"])}`);
check("getSettingsBundle 有线路字段", settings.scheme.sections[0].fields.length >= 3);

const caps = await plugin.getCapabilitiesBundle();
log(`能力：${caps.scheme.actions.map((a) => a.title).join(" / ")}`);

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
