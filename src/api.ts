/** API 请求层：统一带签名头、自动换线、反盗版文案兜底 */

import { authConfig, buildUnauthorizedError } from "breeze-plugin-kit";
import { APP_UA, CFG, PLUGIN_ID, WEB_UA } from "./config";
import { loadString, reportFailure, resolveApiBase, siteOriginOf } from "./domain";

export type ApiEnvelope<T> = {
  code?: number;
  message?: string;
  results?: T;
};

const ANTI_PIRACY_RE = /破解|正版|官網|官网|download|更新最新app|更新最新 APP/i;

export async function apiHeaders(base: string, token = ""): Promise<Record<string, string>> {
  const version = (await loadString(CFG.version, "2025.05.09")) || "2025.05.09";
  const platform = (await loadString(CFG.platform, "1")) || "1";
  // 实测：详情/章节接口只认破解版 APP 的 UA（iDOKit 特征）。
  // 用普通浏览器 UA 会直接吃 code 210「請到官網更新最新APP(...)」，所以默认就用它。
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8",
    version,
    Origin: siteOriginOf(base),
    region: "0",
    webp: "0",
    "User-Agent": APP_UA,
  };
  if (platform.trim()) headers.platform = platform;
  if (token) headers.authorization = `Token ${token}`;
  return headers;
}

/** 反向兜底：APP 特征被风控限流时，换普通浏览器 UA 再试一次 */
function browserHeaders(base: string, token = ""): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    version: "2025.05.09",
    Origin: siteOriginOf(base),
    region: "0",
    webp: "0",
    platform: "1",
    "User-Agent": WEB_UA,
  };
  if (token) headers.authorization = `Token ${token}`;
  return headers;
}

async function rawGet(url: string, headers: Record<string, string>, timeoutMs: number) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { res, text };
}

function parse<T>(text: string): ApiEnvelope<T> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("空响应");
  if (trimmed.startsWith("<")) {
    throw new Error(/升級中|升级中|維護|维护/.test(trimmed) ? "服务器升级中，请稍后再试" : "线路返回异常页面");
  }
  return JSON.parse(trimmed) as ApiEnvelope<T>;
}

/**
 * 业务请求。
 * 失败路径：网络错误 / 维护页 / code!==200 → 记失败 → 换线重试一次。
 * 反盗版文案（code 210）→ 先换浏览器 UA 同线路重试，仍失败再换线。
 */
export async function apiGet<T>(
  path: string,
  options: { token?: string; timeoutMs?: number; allowRetry?: boolean } = {},
): Promise<T> {
  const allowRetry = options.allowRetry !== false;
  const timeoutMs = options.timeoutMs ?? 20000;
  const base = await resolveApiBase();

  const attempt = async (targetBase: string, browser: boolean): Promise<T> => {
    const headers = browser ? browserHeaders(targetBase, options.token) : await apiHeaders(targetBase, options.token);
    const { text } = await rawGet(`${targetBase}${path}`, headers, timeoutMs);
    const json = parse<T>(text);
    if (Number(json.code ?? 0) !== 200) {
      const message = String(json.message ?? `code=${json.code}`);
      const error = new Error(message) as Error & { antiPiracy?: boolean };
      error.antiPiracy = ANTI_PIRACY_RE.test(message);
      throw error;
    }
    return json.results as T;
  };

  try {
    return await attempt(base, false);
  } catch (error) {
    const err = error as Error & { antiPiracy?: boolean };
    if (err.antiPiracy && !options.token) {
      try {
        return await attempt(base, true);
      } catch {
        // 继续走换线
      }
    }
    if (!allowRetry) throw error;

    await reportFailure(base);
    const next = await resolveApiBase({ force: true });
    return attempt(next, false);
  }
}

/** 读取登录 token（authConfig 会处理宿主返回的 ok 信封） */
export async function loadToken(): Promise<string> {
  try {
    return String(await authConfig.load(CFG.token, "")).trim();
  } catch {
    return "";
  }
}

/** 带登录态的请求（收藏等）；未登录时抛 unauthorized，宿主会拉起登录页 */
export async function apiGetAuthed<T>(path: string): Promise<T> {
  const token = await loadToken();
  if (!token) throw buildUnauthorizedError(PLUGIN_ID, "请先登录拷贝漫画账号");
  return apiGet<T>(path, { token });
}

/**
 * 表单 POST（登录用）。
 *
 * 注意：登录接口必须带 APP UA，否则直接吃 code 210 反盗版提示——这是登录
 * "怎么点都失败"的根因。业务错误（账号不存在 / 密码错）同样是 code 210，
 * 但文案不含反盗版关键词，所以直接抛出、不触发换线。
 */
export async function apiPostForm<T>(
  path: string,
  body: string,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20000;
  const base = await resolveApiBase();

  const attempt = async (targetBase: string, browser: boolean): Promise<T> => {
    const headers = browser ? browserHeaders(targetBase) : await apiHeaders(targetBase);
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=utf-8";
    const res = await fetch(`${targetBase}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = parse<T>(await res.text());
    if (Number(json.code ?? 0) !== 200) {
      const message = String(json.message ?? `code=${json.code}`);
      const error = new Error(message) as Error & { antiPiracy?: boolean };
      error.antiPiracy = ANTI_PIRACY_RE.test(message);
      throw error;
    }
    return json.results as T;
  };

  try {
    return await attempt(base, false);
  } catch (error) {
    const err = error as Error & { antiPiracy?: boolean };
    if (!err.antiPiracy) throw error;
    try {
      return await attempt(base, true);
    } catch {
      // 继续换线
    }
    await reportFailure(base);
    const next = await resolveApiBase({ force: true });
    return attempt(next, false);
  }
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
