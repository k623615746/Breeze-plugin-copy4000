/** 插件全局常量与候选线路池 */

export const PLUGIN_ID = "371d33c6-a901-434a-a0ae-d4ea80c7612f";
export const PLUGIN_NAME = "拷贝漫画 Copy4000";
export const PLUGIN_VERSION = "0.1.1";

/** 当前主线路（copy4000 系列） */
export const PRIMARY_API_BASE = "https://api.copy4000.com/api/v3";

/**
 * 种子线路池。
 * 这里只放"曾经可用"的已知线路，作为域名轮换时的探测起点。
 * 真正的新域名靠 domain.ts 的报错解析动态发现，不依赖这张表。
 */
export const SEED_API_BASES: string[] = [
  PRIMARY_API_BASE,
  "https://api.mangacopy.com/api/v3",
  "https://api.copy2000.online/api/v3",
  "https://api.copy3000.com/api/v3",
  "https://mapi.copy20.com/api/v3",
  "https://mapi.copy2000.site/api/v3",
  "https://api.2025copy.com/api/v3",
  "https://api.2026copy.com/api/v3",
  "https://mapi.hotmangasd.com/api/v3",
  "https://api.manga2025.com/api/v3",
  "https://mapi.hotmangasf.com/api/v3",
  "https://mapi.hotmangasg.com/api/v3",
];

/** 客户端版本号，站点会校验；失效时可在设置页改 */
export const DEFAULT_VERSION = "2025.05.09";
export const HOTMANGA_VERSION = "2025.02.12";
export const DEFAULT_PLATFORM = "1";

/** 破解版 APP 的 UA —— 用它请求时服务端会回吐"请到官网下载最新 APP(新域名)" */
export const APP_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 Mobile Safari/537.36 iDOKit/1.0.0 RSSX/1.0.0";

export const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 配置键 */
export const CFG = {
  apiBase: "api.base", // 当前生效线路
  apiLock: "api.lock", // 手动锁定线路（空 = 自动）
  pool: "api.pool", // 动态发现到的线路（JSON 数组）
  platform: "api.platform",
  version: "api.version",
  imageReferer: "image.referer",
  token: "auth.token",
  username: "auth.username",
  password: "auth.password",
} as const;

export const CACHE_KEY = {
  base: "copy4000:apiBase:v1",
  pool: "copy4000:pool:v1",
  baseHealth: "copy4000:health:v1",
  search: "copy4000:search:",
  detail: "copy4000:detail:",
  chapters: "copy4000:chapters:",
  content: "copy4000:content:",
} as const;

export const SEARCH_PAGE_SIZE = 20;
export const HOME_PAGE_SIZE = 18;
export const CHAPTER_PAGE_SIZE = 500;
export const CACHE_TTL_MS = 1000 * 60 * 10;

/**
 * 探测超时。
 * 注意区分两种失败：域名被封是 TLS 重置，几十毫秒就失败；
 * 站点限流是慢响应，可能要 5~8 秒。所以超时要给够，避免把"慢"误判成"死"。
 */
export const PROBE_TIMEOUT_MS = 10000;
export const PROBE_CONCURRENCY = 4;
/** 探测结果缓存时间：避免每次翻页都重探 */
export const PROBE_CACHE_TTL_MS = 1000 * 60 * 5;

export const DOWNLOAD_CANCELLED_MESSAGE = "__DOWNLOAD_TASK_CANCELLED__";
