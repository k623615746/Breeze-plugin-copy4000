/** 拷贝漫画 v3 API 的数据结构（只声明用到的字段） */

export type ApiAuthor = { name?: string; path_word?: string };
export type ApiTheme = { name?: string; path_word?: string };
export type ApiDisplay = { value?: number | string; display?: string };

export type ApiComic = {
  uuid?: string;
  name?: string;
  alias?: string;
  path_word?: string;
  cover?: string;
  popular?: number;
  datetime_updated?: string;
  datetime_created?: string;
  brief?: string;
  author?: ApiAuthor[];
  theme?: ApiTheme[];
  status?: ApiDisplay;
  region?: ApiDisplay;
  free_type?: ApiDisplay;
  restrict?: ApiDisplay;
  reclass?: ApiDisplay;
  last_chapter?: { uuid?: string; name?: string };
  groups?: ApiGroup[] | Record<string, ApiGroup>;
  ban?: number;
};

export type ApiGroup = {
  name?: string;
  path_word?: string;
  count?: number;
};

export type ApiSearchResult = {
  list?: ApiComic[];
  total?: number;
  limit?: number;
  offset?: number;
};

export type ApiDetailResult = {
  comic?: ApiComic;
  popular?: number;
  groups?: Record<string, ApiGroup> | ApiGroup[];
  is_lock?: boolean;
  is_login?: boolean;
};

export type ApiChapterItem = {
  name?: string;
  uuid?: string;
  index?: number;
  size?: number;
  count?: number;
  ordered?: number;
  group_path_word?: string;
  group_name?: string;
  datetime_created?: string;
};

export type ApiChapterList = {
  list?: ApiChapterItem[];
  total?: number;
  limit?: number;
  offset?: number;
};

export type ApiChapterContent = {
  chapter?: {
    uuid?: string;
    name?: string;
    contents?: Array<{ url?: string }>;
    words?: number[];
    size?: number;
    prev?: string | null;
    next?: string | null;
  };
  comic?: ApiComic;
  is_lock?: boolean;
};

export type ApiRankList = {
  list?: Array<{ comic?: ApiComic; book?: ApiComic; popular?: number; sort?: number }>;
  total?: number;
  limit?: number;
  offset?: number;
};

export type ApiRecommendList = {
  list?: Array<{ comic?: ApiComic; type?: number }>;
  total?: number;
  limit?: number;
  offset?: number;
};

export type ApiNewestList = {
  list?: Array<{ comic?: ApiComic; datetime_created?: string }>;
  total?: number;
  limit?: number;
  offset?: number;
};

export type ApiCollectList = {
  list?: Array<{ uuid?: number; comic?: ApiComic }>;
  total?: number;
  limit?: number;
  offset?: number;
};

export type ApiMemberInfo = {
  username?: string;
  nickname?: string;
  avatar?: string;
  user_id?: string;
};
