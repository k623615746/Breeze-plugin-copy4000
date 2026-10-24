/**
 * 拷贝漫画插件（copy4000 线路）
 *
 * 关键设计：所有业务请求都经过 api.ts，域名由 domain.ts 动态解析。
 * 线路失效时插件会自动：换线 → 报错挖矿 → 更新候选池，无需用户介入。
 */

import type {
  AdvancedSearchContract,
  CapabilitiesBundleContract,
  ChapterContentContract,
  ChapterPage,
  ChapterPayload,
  ChapterSummary,
  ComicDetailContract,
  ComicDetailNormal,
  ComicDetailPayload,
  ComicListSceneBundleContract,
  ComicPagedListContract,
  ComicListItem,
  CreatorPageAction,
  FilterBundleContract,
  GetFunctionPagePayload,
  FunctionPageContract,
  InfoContract,
  LoginBundleContract,
  LoginSubmitPayload,
  LoginSubmitResult,
  ReadSnapshotContract,
  ReadSnapshotPayload,
  SearchComicPayload,
  SearchResultContract,
  SettingChangedPayload,
  SettingsBundleContract,
  UserInfoBundleContract,
} from "breeze-plugin-kit";
import { authConfig, buildLoginBundle, cache, flutterTools, pluginConfig, readLoginValues, runtime } from "breeze-plugin-kit";
import { apiGet, apiGetAuthed, apiPostForm, loadToken, qs } from "./api";
import {
  createActionItem,
  createImage,
  createMetadataList,
  createPaging,
  mapComicToItem,
  toStringMap,
} from "./common";
import {
  CACHE_KEY,
  CACHE_TTL_MS,
  CFG,
  CHAPTER_PAGE_SIZE,
  DOWNLOAD_CANCELLED_MESSAGE,
  HOME_PAGE_SIZE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SEARCH_PAGE_SIZE,
} from "./config";
import {
  apiBasesFromHost,
  currentBase,
  discoverFromErrors,
  getLockedBase,
  hostOf,
  loadPool,
  loadString,
  probeAll,
  rememberBase,
  resolveApiBase,
  saveString,
  setLockedBase,
} from "./domain";
import { buildPluginInfo } from "./get-info";
import type {
  ApiChapterContent,
  ApiChapterList,
  ApiCollectList,
  ApiComic,
  ApiDetailResult,
  ApiMemberInfo,
  ApiNewestList,
  ApiRankList,
  ApiRecommendList,
  ApiSearchResult,
} from "./types";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function pageOf(payload: { page?: number }): number {
  return Math.max(1, Number(payload.page ?? 1) || 1);
}

function str(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function listPaging(page: number, size: number, total: number, items: number) {
  const realTotal = Number(total) > 0 ? Number(total) : items;
  const pages = Math.max(1, Math.ceil(realTotal / size));
  return createPaging(page, pages, realTotal);
}

function toComicItems(list: unknown): ComicListItem[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => {
      const map = toStringMap(row);
      const comic = toStringMap(map.comic);
      if (str(comic.path_word)) return comic as ApiComic;
      const book = toStringMap(map.book);
      if (str(book.path_word)) return book as ApiComic;
      if (str(map.path_word)) return map as ApiComic;
      return null;
    })
    .filter((item): item is ApiComic => item !== null)
    .map((item) => mapComicToItem(item));
}

async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  try {
    const hit = await cache.get<T | null>(key, null);
    if (hit) return hit;
  } catch {
    // ignore
  }
  const value = await loader();
  try {
    await cache.set(key, value);
  } catch {
    // ignore
  }
  return value;
}

// ---------------------------------------------------------------------------
// 章节
// ---------------------------------------------------------------------------

type ChapterRow = {
  uuid: string;
  name: string;
  group: string;
  date: string;
  size: number;
};

function normalizeGroups(raw: unknown): Array<{ pathWord: string; name: string }> {
  const list = Array.isArray(raw) ? raw : Object.values(toStringMap(raw));
  const groups = list
    .map((item) => {
      const map = toStringMap(item);
      return { pathWord: str(map.path_word), name: str(map.name, "默认") };
    })
    .filter((item) => item.pathWord);
  return groups.length > 0 ? groups : [{ pathWord: "default", name: "默认" }];
}

async function fetchGroupChapters(pathWord: string, group: string): Promise<ChapterRow[]> {
  const rows: ChapterRow[] = [];
  let offset = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    const query = qs({ limit: CHAPTER_PAGE_SIZE, offset, platform: 1 });
    const data = await apiGet<ApiChapterList>(
      `/comic/${encodeURIComponent(pathWord)}/group/${encodeURIComponent(group)}/chapters${query}`,
    );
    const list = Array.isArray(data.list) ? data.list : [];
    for (const item of list) {
      const uuid = str(item.uuid);
      if (!uuid) continue;
      rows.push({
        uuid,
        name: str(item.name, uuid),
        group,
        date: str(item.datetime_created),
        size: Number(item.size ?? 0),
      });
    }
    const total = Number(data.total ?? 0);
    offset += list.length;
    if (list.length === 0 || (total > 0 && offset >= total) || list.length < CHAPTER_PAGE_SIZE) break;
  }
  return rows;
}

async function loadChapters(pathWord: string, groupsRaw: unknown): Promise<{
  chapters: ChapterRow[];
  groupTitles: Map<string, string>;
}> {
  const groups = normalizeGroups(groupsRaw);
  const groupTitles = new Map<string, string>();
  const all: ChapterRow[] = [];
  for (const group of groups) {
    groupTitles.set(group.pathWord, group.name);
    const rows = await fetchGroupChapters(pathWord, group.pathWord);
    all.push(...rows);
  }
  return { chapters: all, groupTitles };
}

function toChapterSummaries(
  rows: ChapterRow[],
  groupTitles: Map<string, string>,
): ChapterSummary[] {
  return rows.map((row, index) => {
    const groupName = groupTitles.get(row.group) ?? "默认";
    const multiGroup = groupTitles.size > 1;
    return {
      id: row.uuid,
      requestId: row.uuid,
      logicalKey: row.uuid,
      storageChapterId: row.uuid,
      name: multiGroup ? `${groupName}—${row.name}` : row.name,
      order: index + 1,
      groupTitle: multiGroup ? groupName : null,
      extern: { group: row.group, date: row.date },
    };
  });
}

async function getDetailRaw(pathWord: string) {
  return cached(`${CACHE_KEY.detail}${pathWord}`, async () => {
    const data = await apiGet<ApiDetailResult>(
      `/comic2/${encodeURIComponent(pathWord)}${qs({ platform: 1 })}`,
    );
    return data;
  });
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

async function searchComic(payload: SearchComicPayload = {}): Promise<SearchResultContract> {
  const extern = toStringMap(payload.extern);
  const page = pageOf(payload);
  const keyword = str(payload.keyword, str(extern.keyword));
  if (!keyword) throw new Error("请输入搜索关键词");

  const offset = (page - 1) * SEARCH_PAGE_SIZE;
  const query = qs({
    q: keyword,
    q_type: str(extern.scope),
    limit: SEARCH_PAGE_SIZE,
    offset,
    platform: 1,
  });
  const data = await apiGet<ApiSearchResult>(`/search/comic${query}`);
  const items = toComicItems(data.list);
  const paging = listPaging(page, SEARCH_PAGE_SIZE, Number(data.total ?? 0), items.length);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: { version: "1.0.0" as const, type: "searchResult" as const, source: PLUGIN_ID, list: "comicGrid" },
    data: { paging, items },
    paging,
    items,
  };
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

async function getComicDetail(payload: ComicDetailPayload = {}): Promise<ComicDetailContract> {
  const pathWord = str(payload.comicId);
  if (!pathWord) throw new Error("comicId 不能为空");

  const detail = await getDetailRaw(pathWord);
  const comic = toStringMap(detail.comic) as ApiComic;
  const { chapters, groupTitles } = await loadChapters(pathWord, detail.groups ?? comic.groups);
  const eps = toChapterSummaries(chapters, groupTitles);

  const authors = (comic.author ?? []).map((item) => str(item.name)).filter(Boolean);
  const themes = (comic.theme ?? []).map((item) => str(item.name)).filter(Boolean);
  const statusText = str(comic.status?.display);
  const regionText = str(comic.region?.display);

  const normal: ComicDetailNormal = {
    comicInfo: {
      id: pathWord,
      title: str(comic.name, pathWord),
      titleMeta: [
        createActionItem(statusText ? `状态：${statusText}` : "状态：未知"),
        createActionItem(`章节数：${eps.length}`),
        createActionItem(`热度：${Number(comic.popular ?? 0)}`),
      ],
      creator: {
        id: authors[0] ?? "",
        name: authors.join(" / "),
        // 作者头像留空：占位 url 会让空卡片一直显示
        avatar: { id: "", url: "", name: "", path: "", extern: {} },
        onTap: {} as CreatorPageAction,
        extern: {},
      },
      description: str(comic.brief, "暂无简介"),
      cover: createImage({
        id: pathWord,
        url: str(comic.cover),
        name: `${pathWord}.jpg`,
        path: `comic/${pathWord}/cover.jpg`,
        extern: { url: str(comic.cover) },
      }),
      metadata: [
        createMetadataList("author", "作者", authors),
        createMetadataList("tags", "标签", themes),
        createMetadataList("status", "状态", statusText ? [statusText] : []),
        createMetadataList("region", "地区", regionText ? [regionText] : []),
        createMetadataList("alias", "别名", str(comic.alias).split(",").filter(Boolean).slice(0, 6)),
      ],
      extern: { pathWord, uuid: str(comic.uuid) },
    },
    eps,
    recommend: [],
    totalViews: Number(comic.popular ?? 0),
    totalLikes: Number(comic.popular ?? 0),
    totalComments: 0,
    isFavourite: false,
    isLiked: false,
    allowComments: false,
    allowLike: false,
    allowCollected: false,
    allowDownload: true,
    allowCommentsReason: "该图源暂不支持评论",
    allowLikeReason: "该图源暂不支持点赞",
    allowCollectedReason: "拷贝漫画云端收藏需登录，当前版本暂未开放",
    extern: {},
  };

  return {
    source: PLUGIN_ID,
    comicId: pathWord,
    extern: payload.extern ?? null,
    scheme: { version: "1.0.0" as const, type: "comicDetail" as const, source: PLUGIN_ID },
    data: { normal, raw: { comic, groups: Array.from(groupTitles.entries()) } },
  };
}

// ---------------------------------------------------------------------------
// 章节内容
// ---------------------------------------------------------------------------

type LoadedChapter = {
  pathWord: string;
  chapter: ChapterSummary;
  pages: ChapterPage[];
  chapters: ChapterSummary[];
};

async function loadChapter(pathWord: string, chapterId: string): Promise<LoadedChapter> {
  if (!pathWord) throw new Error("comicId 不能为空");
  if (!chapterId) throw new Error("chapterId 不能为空");

  const content = await cached(`${CACHE_KEY.content}${pathWord}:${chapterId}`, async () => {
    const query = qs({ platform: 1 });
    return apiGet<ApiChapterContent>(
      `/comic/${encodeURIComponent(pathWord)}/chapter2/${encodeURIComponent(chapterId)}${query}`,
    );
  });

  const rawContents = content.chapter?.contents ?? [];
  const pages: ChapterPage[] = rawContents
    .map((item, index) => {
      const url = str(item.url);
      if (!url) return null;
      const name = `${String(index + 1).padStart(3, "0")}.jpg`;
      return {
        id: `${chapterId}-${index + 1}`,
        name,
        path: `comic/${pathWord}/${chapterId}/${name}`,
        url,
        extern: {},
      };
    })
    .filter((item): item is ChapterPage => item !== null);

  const detail = await getDetailRaw(pathWord);
  const comic = toStringMap(detail.comic) as ApiComic;
  const { chapters, groupTitles } = await loadChapters(pathWord, detail.groups ?? comic.groups);
  const eps = toChapterSummaries(chapters, groupTitles);
  const matched = eps.find((item) => item.requestId === chapterId) ?? {
    id: chapterId,
    requestId: chapterId,
    logicalKey: chapterId,
    storageChapterId: chapterId,
    name: str(content.chapter?.name, chapterId),
    order: 1,
    extern: {},
  };

  return { pathWord, chapter: matched, pages, chapters: eps };
}

async function getReadSnapshot(payload: ReadSnapshotPayload = {}): Promise<ReadSnapshotContract> {
  const pathWord = str(payload.comicId);
  const chapterId = str(payload.chapterId);
  const loaded = await loadChapter(pathWord, chapterId);
  const detail = await getDetailRaw(pathWord);
  const comic = toStringMap(detail.comic) as ApiComic;

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    data: {
      comic: {
        id: pathWord,
        source: PLUGIN_ID,
        title: str(comic.name, pathWord),
        extern: { pathWord },
      },
      chapter: {
        ...loaded.chapter,
        pages: loaded.pages,
      },
      chapters: loaded.chapters.map((item) => ({
        id: item.id,
        name: item.name,
        order: item.order,
        extern: item.extern,
      })),
    },
  };
}

async function getChapter(payload: ChapterPayload = {}): Promise<ChapterContentContract> {
  const pathWord = str(payload.comicId);
  const chapterId = str(payload.chapterId);
  const loaded = await loadChapter(pathWord, chapterId);
  const detail = await getDetailRaw(pathWord);
  const comic = toStringMap(detail.comic) as ApiComic;

  return {
    source: PLUGIN_ID,
    comicId: pathWord,
    chapterId: loaded.chapter.id,
    extern: payload.extern ?? null,
    scheme: { version: "1.0.0" as const, type: "chapterContent" as const, source: PLUGIN_ID },
    data: {
      comic: {
        id: pathWord,
        source: PLUGIN_ID,
        title: str(comic.name, pathWord),
        extern: { pathWord },
      },
      chapter: {
        ...loaded.chapter,
        pages: loaded.pages,
      },
      chapters: loaded.chapters,
    },
  };
}

// ---------------------------------------------------------------------------
// 图片下载
// ---------------------------------------------------------------------------

async function fetchImageBytes({
  url = "",
  timeoutMs = 30000,
  taskGroupKey = "",
}: {
  url?: string;
  timeoutMs?: number;
  taskGroupKey?: string;
}): Promise<Uint8Array> {
  const target = str(url);
  if (!target) throw new Error("图片地址为空");
  if (taskGroupKey && (await runtime.isTaskGroupCancelled(taskGroupKey))) {
    return new Uint8Array(new ArrayBuffer(0));
  }

  // 图片 CDN 校验 Referer，必须带上站点主域
  const base = currentBase() || (await resolveApiBase());
  const referer = (await loadString(CFG.imageReferer, "")) || `https://${hostOf(base).replace(/^(api|mapi)\./, "")}/`;

  const res = await fetch(target, {
    headers: {
      "x-rquickjs-host-offload-binary-v1": "1",
      Referer: referer,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`图片下载失败：${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function getDownloadConcurrency(): Promise<{ concurrency: number }> {
  return { concurrency: 4 };
}

// ---------------------------------------------------------------------------
// 列表（排行 / 最新 / 推荐）
// ---------------------------------------------------------------------------

async function getRankingData(payload: SearchComicPayload = {}): Promise<ComicPagedListContract> {
  const extern = toStringMap(payload.extern);
  const source = str(extern.source, "rank");
  const page = pageOf(payload);
  const offset = (page - 1) * HOME_PAGE_SIZE;

  let path = "";
  if (source === "newest") {
    path = `/update/newest${qs({ limit: HOME_PAGE_SIZE, offset, platform: 3 })}`;
  } else if (source === "recommend") {
    path = `/recs${qs({ limit: HOME_PAGE_SIZE, offset, platform: 3 })}`;
  } else {
    const dateMap: Record<string, string> = { 日榜: "day", 周榜: "week", 月榜: "month", 总榜: "total" };
    const audienceMap: Record<string, string> = { 男频: "male", 女频: "female" };
    path = `/ranks${qs({
      type: str(extern.rankType, "1"),
      date_type: dateMap[str(extern.dateType, "日榜")] ?? "day",
      audience_type: audienceMap[str(extern.audience, "男频")] ?? "male",
      limit: HOME_PAGE_SIZE,
      offset,
      platform: 3,
    })}`;
  }

  type Row = { list?: unknown[]; total?: number };
  const data = await apiGet<Row>(path);
  const items = toComicItems(data.list);
  const total = Number(data.total ?? 0) || items.length;
  const pages = Math.max(1, Math.ceil(total / HOME_PAGE_SIZE));

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: { version: "1.0.0" as const, type: "searchResult" as const, source: PLUGIN_ID, list: "comicGrid" },
    data: { hasReachedMax: page >= pages, items },
  };
}

async function getRankingFilterBundle(): Promise<FilterBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      fields: [
        {
          key: "dateType",
          kind: "choice" as const,
          label: "榜单",
          options: [
            { label: "日榜", value: "日榜", result: { extern: { dateType: "日榜" } } },
            { label: "周榜", value: "周榜", result: { extern: { dateType: "周榜" } } },
            { label: "月榜", value: "月榜", result: { extern: { dateType: "月榜" } } },
            { label: "总榜", value: "总榜", result: { extern: { dateType: "总榜" } } },
          ],
        },
        {
          key: "audience",
          kind: "choice" as const,
          label: "频道",
          options: [
            { label: "男频", value: "男频", result: { extern: { audience: "男频" } } },
            { label: "女频", value: "女频", result: { extern: { audience: "女频" } } },
          ],
        },
      ],
    },
    data: { values: { dateType: "日榜", audience: "男频" } },
  };
}

async function getComicListSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0" as const, type: "comicListSceneBundle" as const },
    data: {
      scene: {
        title: "排行榜",
        source: PLUGIN_ID,
        body: {
          type: "pluginPagedComicList" as const,
          request: { fnPath: "getRankingData", core: {}, extern: { source: "rank" } },
        },
        filter: { fnPath: "getRankingFilterBundle", extern: { source: "rank" } },
      },
    },
  };
}

async function getAdvancedSearchScheme(): Promise<AdvancedSearchContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "advancedSearch" as const,
      title: "高级搜索",
      fields: [
        {
          key: "scope",
          kind: "choice" as const,
          label: "搜索范围",
          options: [
            { label: "全部", value: "" },
            { label: "标题", value: "name" },
            { label: "作者", value: "author" },
            { label: "汉化组", value: "local" },
          ],
        },
      ],
    },
    data: { values: { scope: "" } },
  };
}

// ---------------------------------------------------------------------------
// 线路诊断（能力按钮）
// ---------------------------------------------------------------------------

function describeBase(base: string): string {
  return hostOf(base) || base;
}

async function diagnoseDomains(): Promise<Record<string, unknown>> {
  const results = await probeAll();
  const okList = results.filter((item) => item.ok);
  const lines = results
    .slice(0, 6)
    .map((item) => `${item.ok ? "✅" : "❌"} ${describeBase(item.base)} (${item.kind}, ${item.latencyMs}ms)`);

  await flutterTools.showToast({
    message:
      okList.length > 0
        ? `可用线路 ${okList.length} 条，当前：${describeBase(okList[0].base)}`
        : "全部线路不可用，请尝试「从报错挖新域名」或手动填写",
    level: okList.length > 0 ? "success" : "error",
    seconds: 4,
  });
  return { ok: okList.length > 0, lines, current: okList[0]?.base ?? "" };
}

async function mineDomains(): Promise<Record<string, unknown>> {
  const found = await discoverFromErrors();
  if (found.length === 0) {
    await flutterTools.showToast({
      message: "没有从报错里发现新域名，请手动填写",
      level: "warning",
      seconds: 4,
    });
    return { found: [] };
  }
  const pool = await loadPool();
  const probe = await probeAll();
  const hit = probe.find((item) => item.ok);
  await flutterTools.showToast({
    message: `发现 ${found.length} 个候选：${found.slice(0, 3).map(describeBase).join("、")}${
      hit ? `，已切换到 ${describeBase(hit.base)}` : ""
    }`,
    level: "success",
    seconds: 6,
  });
  return { found, poolSize: pool.length, current: hit?.base ?? "" };
}

async function clearCache(): Promise<Record<string, unknown>> {
  await Promise.allSettled([
    cache.set(CACHE_KEY.detail + "", null),
    cache.set(CACHE_KEY.baseHealth, null),
  ]);
  await flutterTools.showToast({ message: "缓存已清理", level: "success", seconds: 2 });
  return { ok: true };
}

async function showCurrentBase(): Promise<Record<string, unknown>> {
  const base = await resolveApiBase();
  const pool = await loadPool();
  await flutterTools.showToast({
    message: `当前线路：${describeBase(base)}｜候选 ${pool.length} 条`,
    level: "info",
    seconds: 4,
  });
  return { base, poolSize: pool.length };
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  const locked = await getLockedBase();
  const platform = await loadString(CFG.platform, "1");
  const version = await loadString(CFG.version, "2025.05.09");
  const token = await loadToken();

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "settings" as const,
      sections: [
        {
          title: "线路（域名失效时看这里）",
          fields: [
            {
              key: CFG.apiLock,
              kind: "text",
              label: "手动锁定线路（留空 = 自动探测）",
              fnPath: "onApiLockChanged",
            },
            {
              key: CFG.platform,
              kind: "choice",
              label: "platform 参数",
              fnPath: "onPlatformChanged",
              options: [
                { label: "1（默认）", value: "1" },
                { label: "2", value: "2" },
                { label: "3", value: "3" },
              ],
            },
            {
              key: CFG.version,
              kind: "text",
              label: "客户端版本号",
              fnPath: "onVersionChanged",
            },
          ],
        },
        {
          title: "账号",
          fields: [
            {
              key: CFG.token,
              kind: "password",
              label: "手动填 Token（一般不用，用下方「账号登录」）",
              fnPath: "onTokenChanged",
            },
          ],
        },
      ],
    },
    data: {
      canShowUserInfo: true,
      canLogin: true,
      loginTitle: "拷贝漫画账号",
      loginSubtitle: "登录后可同步云端收藏",
      values: {
        [CFG.apiLock]: locked,
        [CFG.platform]: platform || "1",
        [CFG.version]: version || "2025.05.09",
        [CFG.token]: token ? "******" : "",
      },
    },
  };
}

async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "capabilities" as const,
      actions: [
        { key: "login", title: "检查登录状态", fnPath: "checkLogin" },
        { key: "logout", title: "退出登录", fnPath: "logout" },
        { key: "diagnose", title: "重新探测所有线路", fnPath: "diagnoseDomains" },
        { key: "mine", title: "从报错挖新域名", fnPath: "mineDomains" },
        { key: "show", title: "查看当前线路", fnPath: "showCurrentBase" },
        { key: "clear", title: "清理缓存", fnPath: "clearCache" },
      ],
    },
    data: {},
  };
}

const EMPTY_AVATAR = { id: "", url: "", name: "", path: "", extern: {} };

async function getUserInfoBundle(): Promise<UserInfoBundleContract> {
  const base = currentBase() || (await getLockedBase());
  const routeLines = [
    `当前线路：${base ? describeBase(base) : "未解析"}`,
    `插件版本：${PLUGIN_VERSION}`,
  ];
  const token = await loadToken();

  if (!token) {
    return {
      source: PLUGIN_ID,
      scheme: { version: "1.0.0" as const, type: "userInfo" as const },
      data: { title: "未登录", avatar: EMPTY_AVATAR, lines: ["登录后可同步云端收藏", ...routeLines] },
    };
  }

  try {
    const me = await apiGetAuthed<ApiMemberInfo>(`/member/info${qs({ platform: 1 })}`);
    const name = str(me.nickname, str(me.username, "已登录"));
    const avatarUrl = str(me.avatar);
    return {
      source: PLUGIN_ID,
      scheme: { version: "1.0.0" as const, type: "userInfo" as const },
      data: {
        title: name,
        avatar: avatarUrl
          ? createImage({ id: "avatar", url: avatarUrl, name: "avatar", path: "user/avatar.jpg", extern: {} })
          : EMPTY_AVATAR,
        lines: [`账号：${name}`, ...routeLines],
      },
    };
  } catch (error) {
    return {
      source: PLUGIN_ID,
      scheme: { version: "1.0.0" as const, type: "userInfo" as const },
      data: {
        title: "登录已失效",
        avatar: EMPTY_AVATAR,
        lines: [`${String((error as Error)?.message ?? error)}`, ...routeLines],
      },
    };
  }
}

// 设置回调
async function onApiLockChanged(
  payload: SettingChangedPayload<string> = { extern: {}, key: "", value: "" },
): Promise<Record<string, unknown>> {
  const value = str(payload.value);
  if (value) {
    const bases = /\/api\/v3/.test(value) ? [value] : apiBasesFromHost(hostOf(value) || value);
    const target = bases[0] ?? value;
    await setLockedBase(target);
    await rememberBase(target, "manual");
    await flutterTools.showToast({ message: `已锁定 ${describeBase(target)}`, level: "success", seconds: 3 });
  } else {
    await setLockedBase("");
    await flutterTools.showToast({ message: "已恢复自动探测", level: "info", seconds: 2 });
  }
  return {};
}

async function onPlatformChanged(
  payload: SettingChangedPayload<string> = { extern: {}, key: "", value: "" },
): Promise<Record<string, unknown>> {
  await saveString(CFG.platform, str(payload.value, "1"));
  return {};
}

async function onVersionChanged(
  payload: SettingChangedPayload<string> = { extern: {}, key: "", value: "" },
): Promise<Record<string, unknown>> {
  await saveString(CFG.version, str(payload.value, "2025.05.09"));
  return {};
}

async function onTokenChanged(
  payload: SettingChangedPayload<string> = { extern: {}, key: "", value: "" },
): Promise<Record<string, unknown>> {
  const value = str(payload.value);
  if (!value || value === "******") return {};
  await authConfig.save(CFG.token, value);
  try {
    const me = await apiGetAuthed<ApiMemberInfo>(`/member/info${qs({ platform: 1 })}`);
    await flutterTools.showToast({
      message: `已登录：${str(me.nickname, str(me.username, "账号"))}`,
      level: "success",
      seconds: 3,
    });
  } catch (error) {
    await flutterTools.showToast({
      message: `Token 无效：${String((error as Error)?.message ?? error)}`,
      level: "error",
      seconds: 4,
    });
  }
  return {};
}

/** 站点登录口令 = base64(password + "-1729")，salt 固定 1729 */
function encodePassword(password: string): string {
  const bytes = new TextEncoder().encode(`${password}-1729`);
  const runtimeFn = (globalThis as { bytesToBase64?: (input: Uint8Array) => string }).bytesToBase64;
  if (typeof runtimeFn === "function") return runtimeFn(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function getLoginBundle(): Promise<LoginBundleContract> {
  let account = "";
  try {
    account = String(await authConfig.load(CFG.username, "")).trim();
  } catch {
    account = "";
  }
  return buildLoginBundle(PLUGIN_ID, {
    title: "拷贝漫画登录",
    fields: [
      { key: "username", kind: "text", label: "用户名 / 邮箱", required: true },
      { key: "password", kind: "password", label: "密码", required: true },
    ],
    submitFnPath: "submitLogin",
    submitText: "登录",
    values: account ? { username: account } : {},
  });
}

/**
 * 取登录表单值。
 * 文档写表单值放在 `core.values`，但 kit 的 readLoginValues 只读 `payload.values`，
 * 两种形态都兜住，避免宿主版本差异导致永远读到空值。
 */
function readFormValues(payload: LoginSubmitPayload): Record<string, string> {
  const direct = readLoginValues(payload);
  if (direct.username || direct.password) return direct;
  const core = (payload as { core?: { values?: Record<string, unknown> } }).core;
  if (core?.values) {
    const nested = readLoginValues({ values: core.values } as LoginSubmitPayload);
    if (nested.username || nested.password) return nested;
  }
  return direct;
}

async function submitLogin(payload: LoginSubmitPayload = {}): Promise<LoginSubmitResult> {
  const values = readFormValues(payload);
  const username = str(values.username);
  const password = String(values.password ?? "");
  if (!username) throw new Error("请填写用户名");
  if (!password) throw new Error("请填写密码");

  const body = new URLSearchParams({
    username,
    password: encodePassword(password),
    salt: "1729",
  }).toString();

  const data = await apiPostForm<ApiMemberInfo & { token?: string }>("/login", body);
  const token = str(data.token);
  if (!token) throw new Error("登录成功但站点未返回 token");

  await Promise.allSettled([
    authConfig.save(CFG.token, token),
    authConfig.save(CFG.username, username),
  ]);

  return {
    source: PLUGIN_ID,
    message: `登录成功：${str(data.nickname, str(data.username, username))}`,
    data: { ok: true },
  };
}

async function logout(): Promise<Record<string, unknown>> {
  await Promise.allSettled([authConfig.save(CFG.token, ""), authConfig.save(CFG.username, "")]);
  await flutterTools.showToast({ message: "已退出登录", level: "info", seconds: 2 });
  return { ok: true };
}

async function checkLogin(): Promise<Record<string, unknown>> {
  const token = await loadToken();
  if (!token) {
    await flutterTools.showToast({ message: "当前未登录", level: "warning", seconds: 3 });
    return { ok: false };
  }
  try {
    const me = await apiGetAuthed<ApiMemberInfo>(`/member/info${qs({ platform: 1 })}`);
    await flutterTools.showToast({
      message: `已登录：${str(me.nickname, str(me.username, "账号"))}`,
      level: "success",
      seconds: 3,
    });
    return { ok: true };
  } catch (error) {
    await flutterTools.showToast({
      message: `登录已失效：${String((error as Error)?.message ?? error)}`,
      level: "error",
      seconds: 4,
    });
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

async function init(): Promise<{ source: string; data: { ok: boolean } }> {
  try {
    const base = await resolveApiBase();
    console.log(`[copy4000] init ok, base=${base}`);
    return { source: PLUGIN_ID, data: { ok: true } };
  } catch (error) {
    console.log(`[copy4000] init failed: ${String((error as Error)?.message ?? error)}`);
    return { source: PLUGIN_ID, data: { ok: false } };
  }
}

async function getInfo(): Promise<InfoContract> {
  return buildPluginInfo();
}

async function getFunctionPage(
  _payload: GetFunctionPagePayload = {},
): Promise<FunctionPageContract> {
  const base = currentBase() || (await getLockedBase());
  const pool = await loadPool();
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "page" as const,
      title: "线路状态",
      body: { type: "list" as const, children: [] },
    },
    data: {
      base: base ? describeBase(base) : "未解析",
      poolSize: pool.length,
      candidates: pool.slice(0, 8).map((item) => describeBase(item.base)),
    },
  };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export default {
  init,
  getInfo,

  searchComic,
  getComicDetail,
  getChapter,
  getReadSnapshot,
  fetchImageBytes,
  getDownloadConcurrency,

  getAdvancedSearchScheme,
  getComicListSceneBundle,
  getRankingData,
  getRankingFilterBundle,

  getSettingsBundle,
  getCapabilitiesBundle,
  getUserInfoBundle,
  getFunctionPage,

  // 登录
  getLoginBundle,
  submitLogin,
  logout,
  checkLogin,

  diagnoseDomains,
  mineDomains,
  showCurrentBase,
  clearCache,

  onApiLockChanged,
  onPlatformChanged,
  onVersionChanged,
  onTokenChanged,
};

void CACHE_TTL_MS;
void DOWNLOAD_CANCELLED_MESSAGE;
void pluginConfig;
