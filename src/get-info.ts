import type { InfoContract } from "breeze-plugin-kit";
import { PLUGIN_ID, PLUGIN_NAME } from "./config";

const SOURCE = PLUGIN_ID;

function listEntry(
  id: string,
  title: string,
  fnPath: string,
  extern: Record<string, unknown> = {},
): InfoContract["function"][number] {
  return {
    id,
    title,
    action: {
      type: "openComicList" as const,
      payload: {
        scene: {
          title,
          source: SOURCE,
          body: {
            type: "pluginPagedComicList" as const,
            request: { fnPath, core: {}, extern },
          },
          filter: { fnPath: "getRankingFilterBundle", extern },
        },
      },
    },
  };
}

export function buildPluginInfo(): InfoContract {
  return {
    name: PLUGIN_NAME,
    uuid: PLUGIN_ID,
    iconUrl: "https://www.copy4000.com/favicon.ico",
    describe: "拷贝漫画（copy4000 线路），内置域名失效自动探测与报错挖矿",
    version: "0.1.3",
    home: "https://github.com/k623615746/breeze-plugin-copy4000",
    // 不填 npmName：客户端会优先查 npm，包不存在时直接报「远程插件文件不存在（404）」，
    // 不会回退到 updateUrl。只有真正发布到 npm 后再填。
    updateUrl: "https://api.github.com/repos/k623615746/breeze-plugin-copy4000/releases/latest",
    haveCloudFavorite: true,
    function: [
      listEntry("rank", "排行榜", "getRankingData", { source: "rank" }),
      listEntry("newest", "最近更新", "getRankingData", { source: "newest" }),
      listEntry("recommend", "编辑推荐", "getRankingData", { source: "recommend" }),
    ],
  };
}

export function buildManifestInfo(): InfoContract {
  return buildPluginInfo();
}
