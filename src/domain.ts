/**
 * 线路解析（域名韧性核心）
 *
 * 设计前提：站点域名会周期性轮换，且封锁是「按 SNI 域名逐个点」而不是按 IP 段，
 * 所以新域名上线后默认是通的，直到被单独拉黑。
 *
 * 因此本模块不把域名写死在业务代码里，而是维护一个「候选池 + 健康探测 + 报错挖矿」
 * 的三层结构：
 *   1. 候选池：种子线路 + 历史发现 + 用户手填
 *   2. 健康探测：对每个候选发一个轻量搜索请求，按响应形态判定 ok / 维护 / 拦截
 *   3. 报错挖矿：站点自己的错误文案里通常会带官网地址（"請到官網更新最新APP(URL)"），
 *      这是最诚实的域名发布渠道，比任何导航站都准，直接从 message 里正则抽取。
 */

import { cache, pluginConfig } from "breeze-plugin-kit";
import {
  APP_UA,
  CACHE_KEY,
  CFG,
  PROBE_CACHE_TTL_MS,
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  SEED_API_BASES,
  WEB_UA,
} from "./config";

export type ProbeKind = "ok" | "maintenance" | "blocked" | "html" | "http" | "network" | "api-error";

export type ProbeResult = {
  base: string;
  ok: boolean;
  kind: ProbeKind;
  status?: number;
  message?: string;
  /** 从响应文本里挖到的候选域名 */
  discovered: string[];
  latencyMs: number;
};

export type PoolEntry = {
  base: string;
  origin: string;
  source: "seed" | "discovered" | "manual";
  addedAt: number;
  lastOkAt?: number;
  lastFailAt?: number;
  failCount?: number;
};

export type ResolveOptions = {
  /** 忽略健康缓存，强制重新探测 */
  force?: boolean;
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** 从 api 线路反推站点主域，用于 Origin 头 */
export function siteOriginOf(apiBase: string): string {
  const host = hostOf(apiBase).replace(/^(api|mapi)\./, "");
  return host ? `https://${host}` : "https://copy4000.com";
}

export function isValidApiBase(value: unknown): value is string {
  const text = String(value ?? "").trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return /^https?:$/.test(parsed.protocol) && parsed.pathname.includes("/api/v3");
  } catch {
    return false;
  }
}

/** 把 pluginConfig 里可能被包了一层的值拆出来 */
export function unwrapStored(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).value;
  }
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (!text) return "";
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "value" in (parsed as Record<string, unknown>)) {
        return (parsed as Record<string, unknown>).value;
      }
      return parsed;
    } catch {
      return raw;
    }
  }
  return raw;
}

export async function loadString(key: string, fallback = ""): Promise<string> {
  try {
    const raw = await pluginConfig.load(key, fallback);
    const value = unwrapStored(raw);
    return value == null ? fallback : String(value);
  } catch {
    return fallback;
  }
}

export async function saveString(key: string, value: string): Promise<void> {
  await Promise.allSettled([pluginConfig.save(key, value), cache.set(key, value)]);
}

// ---------------------------------------------------------------------------
// 候选池
// ---------------------------------------------------------------------------

function seedEntries(): PoolEntry[] {
  const now = Date.now();
  return SEED_API_BASES.map((base) => ({
    base,
    origin: siteOriginOf(base),
    source: "seed" as const,
    addedAt: now,
  }));
}

export async function loadPool(): Promise<PoolEntry[]> {
  let stored: PoolEntry[] = [];
  try {
    const raw = await pluginConfig.load(CFG.pool, "[]");
    const parsed = unwrapStored(raw);
    const list = typeof parsed === "string" ? (JSON.parse(parsed || "[]") as unknown) : parsed;
    if (Array.isArray(list)) {
      stored = list
        .map((item) => item as PoolEntry)
        .filter((item) => isValidApiBase(item?.base));
    }
  } catch {
    stored = [];
  }

  const seen = new Set<string>();
  const merged: PoolEntry[] = [];
  for (const entry of [...stored, ...seedEntries()]) {
    const base = String(entry.base ?? "").trim();
    if (!base || seen.has(base)) continue;
    seen.add(base);
    merged.push({
      base,
      origin: entry.origin || siteOriginOf(base),
      source: entry.source ?? "seed",
      addedAt: entry.addedAt ?? Date.now(),
      lastOkAt: entry.lastOkAt,
      lastFailAt: entry.lastFailAt,
      failCount: entry.failCount ?? 0,
    });
  }
  // 最近成功的排前面，其余保持种子顺序
  merged.sort((a, b) => (b.lastOkAt ?? 0) - (a.lastOkAt ?? 0));
  return merged;
}

export async function savePool(pool: PoolEntry[]): Promise<void> {
  const slim = pool
    .filter((item) => isValidApiBase(item.base))
    .slice(0, 60)
    .map((item) => ({
      base: item.base,
      origin: item.origin,
      source: item.source,
      addedAt: item.addedAt,
      lastOkAt: item.lastOkAt,
      lastFailAt: item.lastFailAt,
      failCount: item.failCount ?? 0,
    }));
  await Promise.allSettled([
    pluginConfig.save(CFG.pool, JSON.stringify(slim)),
    cache.set(CACHE_KEY.pool, slim),
  ]);
}

/** 把一个新发现的 base 并入池（去重） */
export async function rememberBase(base: string, source: PoolEntry["source"] = "discovered"): Promise<void> {
  if (!isValidApiBase(base)) return;
  const pool = await loadPool();
  const hit = pool.find((item) => item.base === base);
  if (hit) {
    if (source === "manual") hit.source = "manual";
    await savePool(pool);
    return;
  }
  pool.unshift({ base, origin: siteOriginOf(base), source, addedAt: Date.now(), failCount: 0 });
  await savePool(pool);
}

// ---------------------------------------------------------------------------
// 域名提取：从错误文案 / HTML 里挖候选线路
// ---------------------------------------------------------------------------

/** 噪声域名，出现在页面里但显然不是图源 */
const NOISE_HOSTS = [
  "cloudflare.com",
  "cloudflare.net",
  "github.com",
  "githubusercontent.com",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "apple.com",
  "microsoft.com",
  "mozilla.org",
  "w3.org",
  "sentry.io",
  "facebook.com",
  "twitter.com",
  "telegram.org",
  "jsdelivr.net",
  "unpkg.com",
  "fontawesome.com",
  "bootstrapcdn.com",
];

const HOST_RE =
  /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|cc|site|online|club|top|xyz|info|io|me|tv|fun|vip|pro|link|app|dev|moe|art|shop|store|live|life|wiki|world|space|website|press|host|cloud|co))\b/gi;

/** 站点品牌词，命中说明大概率是同源线路 */
const BRAND_RE = /copy|manga|relamanhua|hotmanga|manhuaren|baozimh|colamanga/i;

function isNoise(host: string): boolean {
  return NOISE_HOSTS.some((noise) => host === noise || host.endsWith(`.${noise}`));
}

/** 由 host 推出可能的 api base（api./mapi./裸域 三种形态） */
export function apiBasesFromHost(host: string): string[] {
  const clean = host.toLowerCase().replace(/^www\./, "");
  if (!clean || isNoise(clean)) return [];
  if (/^(api|mapi)\./.test(clean)) return [`https://${clean}/api/v3`];
  return [`https://api.${clean}/api/v3`, `https://mapi.${clean}/api/v3`, `https://${clean}/api/v3`];
}

/**
 * 从任意文本里提取候选线路，按可信度排序。
 * 优先：出现在 /download 之类落地路径前的域名（站点自己指路的官网地址）。
 */
export function extractApiBasesFromText(text: string, currentBase = ""): string[] {
  const body = String(text ?? "");
  if (!body) return [];

  const currentHost = hostOf(currentBase);
  const currentDigits = (currentHost.match(/\d{3,}/g) ?? []).join("");

  const scored: Array<{ base: string; score: number }> = [];
  const seen = new Set<string>();

  // 1) 先抓完整 URL，路径含 download / app / index 的加权最高
  const urlRe = /https?:\/\/[^\s"'<>()（）【】\]]+/gi;
  const urls = body.match(urlRe) ?? [];
  for (const rawUrl of urls) {
    const host = hostOf(rawUrl);
    if (!host || isNoise(host)) continue;
    let score = 1;
    if (/download|app|index|home/i.test(rawUrl)) score += 4;
    if (BRAND_RE.test(host)) score += 2;
    if (currentDigits && host.includes(currentDigits)) score += 3;
    for (const base of apiBasesFromHost(host)) {
      if (seen.has(base)) continue;
      seen.add(base);
      scored.push({ base, score });
    }
  }

  // 2) 再抓裸域名（文案里常写成 "www.xxx.com" 或 "xxx.com/download"）
  const hosts = body.match(HOST_RE) ?? [];
  for (const host of hosts) {
    const clean = host.toLowerCase();
    if (isNoise(clean)) continue;
    let score = 0;
    if (BRAND_RE.test(clean)) score += 2;
    if (currentDigits && clean.includes(currentDigits)) score += 3;
    if (score === 0) continue;
    for (const base of apiBasesFromHost(clean)) {
      if (seen.has(base)) continue;
      seen.add(base);
      scored.push({ base, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.base);
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

function probeHeaders(apiBase: string, mode: "normal" | "induce"): Record<string, string> {
  const origin = siteOriginOf(apiBase);
  if (mode === "induce") {
    // 挖矿模式：故意用普通浏览器 UA 请求。服务端判定为非官方客户端后，
    // 会返回 code 210「請到官網更新最新APP(https://www.xxx.com/download)」——
    // 新域名就写在这句里。
    return {
      Accept: "application/json",
      Origin: origin,
      "User-Agent": WEB_UA,
      platform: "1",
      region: "0",
    };
  }
  return {
    Accept: "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8",
    version: "2025.05.09",
    Origin: origin,
    region: "0",
    webp: "0",
    platform: "1",
    // 详情/章节接口只认 APP UA，探测统一用它，避免"接口活着但被判 210"的误判
    "User-Agent": APP_UA,
  };
}

function classifyText(text: string): { kind: ProbeKind; message: string } {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "api-error", message: "空响应" };
  if (trimmed.startsWith("<")) {
    if (/升級中|升级中|維護|维护/.test(trimmed)) return { kind: "maintenance", message: "服务器升级中" };
    return { kind: "html", message: "返回 HTML 而非 JSON" };
  }
  try {
    const json = JSON.parse(trimmed) as { code?: number; message?: string };
    const code = Number(json.code ?? 0);
    const message = String(json.message ?? "");
    if (code === 200) return { kind: "ok", message };
    return { kind: "api-error", message: message || `code=${code}` };
  } catch {
    return { kind: "api-error", message: "响应不是合法 JSON" };
  }
}

export async function probeApiBase(base: string, mode: "normal" | "induce" = "normal"): Promise<ProbeResult> {
  const started = Date.now();
  const url = `${base}/search/comic?q=${encodeURIComponent("海贼王")}&limit=1&offset=0&platform=1`;
  try {
    const res = await fetch(url, {
      headers: probeHeaders(base, mode),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    const latencyMs = Date.now() - started;
    const { kind, message } = classifyText(text);
    const ok = kind === "ok";
    return {
      base,
      ok,
      kind: res.ok ? kind : kind === "ok" ? "http" : kind,
      status: res.status,
      message,
      discovered: ok ? [] : extractApiBasesFromText(text, base),
      latencyMs,
    };
  } catch (error) {
    return {
      base,
      ok: false,
      kind: "network",
      message: String((error as Error)?.message ?? error),
      discovered: [],
      latencyMs: Date.now() - started,
    };
  }
}

/** 并发探测，返回全部结果；任何一批出现可用线路即提前返回 */
async function probeMany(bases: string[], mode: "normal" | "induce" = "normal"): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (let i = 0; i < bases.length; i += PROBE_CONCURRENCY) {
    const batch = bases.slice(i, i + PROBE_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((base) => probeApiBase(base, mode)));
    for (const item of settled) {
      if (item.status === "fulfilled") results.push(item.value);
    }
    if (results.some((item) => item.ok)) return results;
  }
  return results;
}

// ---------------------------------------------------------------------------
// 健康缓存
// ---------------------------------------------------------------------------

type HealthCache = { base: string; at: number };

async function readHealth(): Promise<HealthCache | null> {
  try {
    const raw = await cache.get<HealthCache | null>(CACHE_KEY.baseHealth, null);
    if (!raw || typeof raw !== "object") return null;
    const base = String((raw as HealthCache).base ?? "");
    const at = Number((raw as HealthCache).at ?? 0);
    if (!isValidApiBase(base) || !at) return null;
    return { base, at };
  } catch {
    return null;
  }
}

async function writeHealth(base: string): Promise<void> {
  await Promise.allSettled([
    cache.set(CACHE_KEY.baseHealth, { base, at: Date.now() }),
    cache.set(CACHE_KEY.base, base),
    saveString(CFG.apiBase, base),
  ]);
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

let runtimeBase = "";
let resolving: Promise<string> | null = null;

/** 当前进程内已确认可用的线路（可能为空） */
export function currentBase(): string {
  return runtimeBase;
}

/** 记录一次失败，便于下次优先换线路 */
export async function reportFailure(base: string): Promise<void> {
  if (runtimeBase === base) runtimeBase = "";
  try {
    await cache.set(CACHE_KEY.baseHealth, null);
  } catch {
    // ignore
  }
  const pool = await loadPool();
  const hit = pool.find((item) => item.base === base);
  if (hit) {
    hit.lastFailAt = Date.now();
    hit.failCount = (hit.failCount ?? 0) + 1;
    await savePool(pool);
  }
}

/** 记录一次成功 */
export async function reportSuccess(base: string): Promise<void> {
  runtimeBase = base;
  const pool = await loadPool();
  const hit = pool.find((item) => item.base === base);
  if (hit) {
    hit.lastOkAt = Date.now();
    hit.failCount = 0;
  } else {
    pool.unshift({ base, origin: siteOriginOf(base), source: "discovered", addedAt: Date.now(), lastOkAt: Date.now(), failCount: 0 });
  }
  await savePool(pool);
  await writeHealth(base);
}

/** 手动锁定线路（空字符串 = 恢复自动） */
export async function setLockedBase(base: string): Promise<void> {
  const value = String(base ?? "").trim();
  if (value && !isValidApiBase(value)) throw new Error("线路地址必须形如 https://api.example.com/api/v3");
  await saveString(CFG.apiLock, value);
  if (value) {
    await rememberBase(value, "manual");
    await reportSuccess(value);
  } else {
    runtimeBase = "";
  }
}

export async function getLockedBase(): Promise<string> {
  const value = await loadString(CFG.apiLock, "");
  return isValidApiBase(value) ? value : "";
}

/**
 * 报错挖矿：拿候选线路去"故意触发错误"，从错误文案里提取新域名。
 * 这一步是域名轮换后自愈的关键——只要还有一个旧域名活着，就能问出新域名。
 */
export async function discoverFromErrors(candidates?: string[]): Promise<string[]> {
  const pool = await loadPool();
  const bases = (candidates && candidates.length > 0 ? candidates : pool.map((item) => item.base)).slice(0, 12);
  const found: string[] = [];
  const seen = new Set<string>();

  const settled = await Promise.allSettled(bases.map((base) => probeApiBase(base, "induce")));
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    for (const base of item.value.discovered) {
      if (seen.has(base)) continue;
      seen.add(base);
      found.push(base);
    }
  }
  for (const base of found) {
    await rememberBase(base, "discovered");
  }
  return found;
}

/**
 * 解析当前可用线路。
 * 顺序：手动锁定 → 进程内缓存 → 健康缓存 → 候选池探测 → 报错挖矿 → 抛错
 */
export async function resolveApiBase(options: ResolveOptions = {}): Promise<string> {
  const locked = await getLockedBase();
  if (locked) {
    runtimeBase = locked;
    return locked;
  }
  if (!options.force && runtimeBase) return runtimeBase;
  if (resolving) return resolving;

  resolving = (async () => {
    // 1) 健康缓存（5 分钟内直接复用，避免每次翻页都探测）
    if (!options.force) {
      const health = await readHealth();
      if (health && Date.now() - health.at < PROBE_CACHE_TTL_MS) {
        runtimeBase = health.base;
        return health.base;
      }
    }

    const pool = await loadPool();
    const ordered = pool.map((item) => item.base);
    const remembered = await loadString(CFG.apiBase, "");
    if (isValidApiBase(remembered)) {
      const idx = ordered.indexOf(remembered);
      if (idx > 0) ordered.splice(idx, 1);
      if (idx !== 0) ordered.unshift(remembered);
    }

    // 2) 先探当前线路，失败再全池并发
    const first = ordered.slice(0, 1);
    let results = first.length > 0 ? await probeMany(first) : [];
    let winner = results.find((item) => item.ok);
    if (!winner) {
      results = await probeMany(ordered.slice(1));
      winner = results.find((item) => item.ok);
    }

    if (winner) {
      await reportSuccess(winner.base);
      return winner.base;
    }

    // 3) 全部不可用 → 从错误文案里挖新域名，再探一轮
    const discovered: string[] = [];
    for (const item of results) {
      for (const base of item.discovered) {
        if (!discovered.includes(base)) discovered.push(base);
      }
    }
    if (discovered.length === 0) {
      const mined = await discoverFromErrors(ordered);
      discovered.push(...mined);
    } else {
      for (const base of discovered) await rememberBase(base, "discovered");
    }

    if (discovered.length > 0) {
      const retry = await probeMany(discovered.slice(0, 8));
      const hit = retry.find((item) => item.ok);
      if (hit) {
        await reportSuccess(hit.base);
        return hit.base;
      }
    }

    const detail = results
      .filter((item) => item.kind !== "network")
      .slice(0, 3)
      .map((item) => `${hostOf(item.base)}: ${item.message ?? item.kind}`)
      .join("；");
    throw new Error(
      `所有线路均不可用${detail ? `（${detail}）` : ""}。请到「设置 → 线路」手动填入新域名，或点「重新探测线路」。`,
    );
  })();

  try {
    return await resolving;
  } finally {
    resolving = null;
  }
}

/** 探测全部候选并返回明细，供设置页"重新探测"使用 */
export async function probeAll(): Promise<ProbeResult[]> {
  const pool = await loadPool();
  const bases = pool.map((item) => item.base).slice(0, 20);
  const results = await probeMany(bases);
  const ok = results.find((item) => item.ok);
  if (ok) await reportSuccess(ok.base);
  return results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.latencyMs - b.latencyMs);
}
