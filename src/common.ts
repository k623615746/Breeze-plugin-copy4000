/** 契约对象构造工具 */

import type {
  ActionItem,
  ComicInfoPageAction,
  ComicListItem,
  ImageItem,
  MetadataListItem,
  PagingInfo,
  StringMap,
} from "breeze-plugin-kit";
import { PLUGIN_ID } from "./config";
import type { ApiComic } from "./types";

export const NOT_FOUND_IMAGE_URL = "https://www.copy4000.com/favicon.ico";
export const PLACEHOLDER_IMAGE_PATH = "placeholder/image-404.png";

const EMPTY_ACTION = {} as ComicInfoPageAction;

export function toStringMap(value: unknown): StringMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function createActionItem(
  name: unknown,
  onTap: ComicInfoPageAction = EMPTY_ACTION,
  extern: StringMap = {},
): ActionItem {
  return { name: String(name ?? ""), onTap, extern };
}

export function createImage(
  input: {
    id?: string;
    url?: string;
    name?: string;
    path?: string;
    extern?: StringMap;
  } = {},
): ImageItem {
  return {
    id: String(input.id ?? ""),
    url: String(input.url ?? "").trim() || NOT_FOUND_IMAGE_URL,
    name: String(input.name ?? ""),
    path: String(input.path ?? "").trim() || PLACEHOLDER_IMAGE_PATH,
    extern: input.extern ?? {},
  };
}

export function createMetadataList(
  type: string,
  name: string,
  values: unknown,
  mapItem?: (value: string) => ActionItem,
): MetadataListItem {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  return {
    type,
    name,
    value: list
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0)
      .map((item) => (mapItem ? mapItem(item) : createActionItem(item))),
  };
}

export function createPaging(page: number, pages: number, total: number): PagingInfo {
  const safePages = Math.max(1, pages);
  return { page, pages: safePages, total, hasReachedMax: page >= safePages };
}

function formatDate(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return text.slice(0, 16);
  return new Date(parsed).toISOString().slice(0, 16).replace("T", " ");
}

export function mapComicToItem(comic: ApiComic): ComicListItem {
  const id = String(comic.path_word ?? comic.uuid ?? "").trim();
  const title = String(comic.name ?? "未知漫画");
  const authors = (comic.author ?? []).map((item) => String(item.name ?? "")).filter(Boolean);
  const themes = (comic.theme ?? []).map((item) => String(item.name ?? "")).filter(Boolean);
  const cover = String(comic.cover ?? "").trim();
  const updatedAt = formatDate(comic.datetime_updated);
  const statusText = String(comic.status?.display ?? "");
  const finished = /完結|完结/.test(statusText);

  return {
    source: PLUGIN_ID,
    id,
    title,
    subtitle: authors.length > 0 ? authors.join(" / ") : String(comic.alias ?? "").slice(0, 40),
    finished,
    likesCount: Number(comic.popular ?? 0),
    viewsCount: Number(comic.popular ?? 0),
    updatedAt,
    cover: createImage({
      id,
      url: cover,
      name: `${id}.jpg`,
      path: `comic/${id}/cover.jpg`,
      extern: { url: cover },
    }),
    metadata: [
      createMetadataList("author", "作者", authors),
      createMetadataList("tags", "标签", themes),
      createMetadataList("status", "状态", statusText ? [statusText] : []),
    ],
    raw: {
      id,
      uuid: comic.uuid,
      name: title,
      alias: comic.alias,
      author: authors.join(","),
      description: comic.brief,
      image: cover,
      status: statusText,
      last_chapter_name: comic.last_chapter?.name,
      update_at: comic.datetime_updated,
      popular: comic.popular,
      tags: themes,
    },
    extern: { pathWord: id, uuid: comic.uuid ?? "" },
  };
}
