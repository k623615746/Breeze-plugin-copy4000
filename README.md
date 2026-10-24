# breeze-plugin-copy4000

Breeze 漫画阅读器插件，接入拷贝漫画 **copy4000** 线路。

和常见写法不同，这个插件不把域名写死在代码里：域名由运行时解析，失效后能自己找回来。

---

## 一、为什么不能写死域名

站点域名会周期性轮换，封锁按 **SNI 域名逐个点**，不是整段 IP。同一段 Cloudflare IP 上，`mangacopy.com` 被 TLS 重置、`copy4000.com` 全通，就是证据。

推论：**每换一个新域名，它默认是通的，直到被单独加进名单。** 所以插件的问题不是"哪个域名能用"，而是"怎么在旧域名死掉后拿到新域名"。

答案在站点自己的错误文案里：

```
請到官網更新最新APP(https://www.copy4000.com/download)，您或您身邊的人曾經下載過破解版本的拷貝漫畫...
```

报错信息是最诚实的域名发布渠道——它必须告诉你去哪下载。插件把这句正则化，就成了自动发现机制。

---

## 二、三层线路防御

| 层 | 机制 | 触发时机 | 代码 |
| --- | --- | --- | --- |
| 1 | 健康缓存 + 候选池并发探测 | 每次解析线路 | `domain.ts: resolveApiBase` |
| 2 | 报错挖矿（正则提取新域名） | 全部候选都探测失败 | `domain.ts: discoverFromErrors` |
| 3 | 手动锁定 | 用户已知新域名 | `设置 → 手动锁定线路` |

### 第 1 层：探测

对每个候选发一个轻量搜索请求（`/search/comic?q=海贼王&limit=1`），按响应形态分类：

| 判定 | 依据 | 处理 |
| --- | --- | --- |
| `ok` | `code === 200` | 立即采用，写入健康缓存（5 分钟） |
| `maintenance` | HTML 含「服務器升級中」 | 跳过 |
| `html` | 返回 HTML 不是 JSON | 跳过 |
| `network` | TLS 重置 / 超时（10s） | 跳过 |
| `api-error` | `code !== 200` | 跳过，同时把 `message` 丢给挖矿器 |

探测分批并发（4 个一批），任意一批出现可用线路就停止，避免 12 条候选串行等 72 秒。

### 第 2 层：报错挖矿

全部候选都失败时，用**破解版 APP 的 UA**（`iDOKit/1.0.0 RSSX/1.0.0`）再请求一轮——服务端会以为你在用盗版客户端，回吐"请到官网下载最新 APP"并附上新域名。

挖矿器从响应文本里抽候选域名，按可信度打分：

- 出现在 `/download`、`/app` 之类落地路径前的 → **+4**
- 含品牌词（`copy` / `manga` / `relamanhua` / `hotmanga`）→ **+2**
- 数字段与当前域名一致（`copy4000` → `copy4000`）→ **+3**
- 过滤 Cloudflare / GitHub / Google 等噪声域名

每个 host 展开成三种 API 形态再探测：`api.{host}` / `mapi.{host}` / `{host}` + `/api/v3`。

只要还有**一个**旧域名活着，就能问出新域名——这是链式发现。

### 第 3 层：手动锁定

设置页填 `copy5000.com` 或完整 `https://api.copy5000.com/api/v3` 都行，插件自动补全成 API 形态。留空恢复自动。

---

## 三、业务请求的容错

### 一个必须知道的坑：UA 决定生死

实测（2026-10）同一个 `/comic2/{path_word}` 请求：

| User-Agent | 结果 |
| --- | --- |
| `iDOKit/1.0.0 RSSX/1.0.0`（破解版 APP 特征） | `code 200` |
| 普通 Chrome | `code 210 請到官網更新最新APP(...)` |
| 普通 Safari (iOS) | `code 210` |

所以插件**默认就用 APP UA**，浏览器 UA 只作为反向兜底。搜索接口不校验 UA，详情/章节接口校验。

`api.ts` 里每个请求两条兜底：

1. **反盗版文案**（`破解` / `官網` / `download`）→ 换浏览器 UA 重试同一条线路
2. 网络错误 / 维护页 / 其他 `code` → 标记该线路失败 → 强制重新解析线路 → 重试一次

### 另一个坑：超时不能设太短

被封是 TLS 重置，几十毫秒就失败；站点限流是慢响应，实测能到 8 秒。把超时设成 3~6 秒会把"慢"误判成"死"，导致插件在正常线路上反复换线。当前探测超时 10 秒。

---

## 四、功能

| 能力 | 实现 |
| --- | --- |
| 搜索 | `/search/comic`，支持标题/作者/汉化组 |
| 详情 | `/comic2/{path_word}`，多汉化组章节自动分组 |
| 章节列表 | `/comic/{path}/group/{group}/chapters`，分页拉全 |
| 阅读 | `/comic/{path}/chapter2/{uuid}` |
| 下载 | `fetchImageBytes` 带 Referer（图片 CDN 校验） |
| 排行榜 | `/ranks`，日/周/月/总 × 男频/女频 |
| 最近更新 | `/update/newest` |
| 编辑推荐 | `/recs` |
| 登录 | `/login`，`base64(password + "-1729")` + `salt=1729` |
| 账号信息 | `/member/info`，设置页顶部显示昵称与头像 |
| 云端收藏 | `startFavoriteAction` / `continueFavoriteAction` 工作流 |
| 收藏列表 | `/member/collect/comics`，独立 tab |

---

## 五、云端收藏

Breeze 的新协议要求插件导出 `startFavoriteAction` / `continueFavoriteAction`，旧的三件套（`toggleFavorite` / `listFavoriteFolders` / `moveFavoriteToFolder`）已废弃。

### 接口

| 动作 | 接口 |
| --- | --- |
| 查收藏状态 | `GET /comic2/{path_word}/query` → `results.collect`（>0 为已收藏） |
| 加收藏 | `POST /member/collect/comic`，body `comic_id={uuid}&is_collect=1` |
| 取消收藏 | `DELETE /member/collect/comics`，body `ids={collectId}` |
| 收藏列表 | `GET /member/collect/comics`，`free_type=1&ordering=-datetime_modifier` |

### 三个容易踩的点

**1. `comic_id` 要 uuid，不是 path_word**

收藏接口认的是漫画 uuid，得先从 `/comic2/{path_word}` 取。传 path_word 会失败。

**2. 取消收藏要两步**

接口没有"按漫画取消"，只有"按收藏记录 ID 批量删除"。所以流程是：先 `/query` 拿 `collect` 字段（收藏记录 ID），再 `DELETE` 那个 ID。

**3. `/query` 对无效 token 不报错**

实测假 token 请求 `/comic2/{path}/query` 返回：

```json
{"code":200,"results":{"collect":null,"is_login":false}}
```

`code 200`、不抛错、`collect` 是 `null`——和"未收藏"长得一模一样。必须自己看 `is_login`，否则 token 失效会被静默当成未收藏。

而 `/member/collect/*` 是正常校验的，假 token 返回 `code 401 Invalid token header`。

### 拷贝漫画只有全局收藏

没有多收藏夹概念。所以：

- `add` / `removeAll` 直接完成
- `removeFromTarget` 只在 `context.target.id` 与当前收藏记录 ID 一致时才执行，否则返回 `TARGET_MISMATCH`，避免误删
- `move` 返回 `UNSUPPORTED_ACTION`，不伪装成"先删后加"

未登录时 `startFavoriteAction` 抛 `unauthorized`，宿主自动拉起登录页。

---

## 六、登录

设置页用户信息区底部有「拷贝漫画账号」入口（`data.canLogin`），点开填账号密码即可。

### 为什么登录必须带 APP UA

实测同一个 `/login` 请求：

| User-Agent | 结果 |
| --- | --- |
| 无 UA | `code 210 請到官網更新最新APP(...)` |
| 普通 Chrome | `code 210 請到官網更新最新APP(...)` |
| `iDOKit/1.0.0 RSSX/1.0.0` | `code 210 該賬戶不存在.` ← 业务响应 |

前两个是反盗版拦截，**永远登不上**，且提示文案会让人误以为是账号问题。只有 APP UA 能到业务层。

`test/login.mjs` 可以随时复现这个对比。

### 其它细节

- 密码加密：`base64(password + "-1729")`，`salt=1729` 固定
- 业务错误（账号不存在 / 密码错）同样是 `code 210`，但文案不含反盗版关键词，所以直接透传给用户、不触发换线
- token 存在 `auth.token`（`authConfig` 负责 JSON 信封），登录后自动写入
- 表单值读取做了双兜底：`payload.values` 和 `core.values` 都能取到（文档与 kit 实现不一致）

---

## 七、设置项

| 键 | 说明 |
| --- | --- |
| `api.lock` | 手动锁定线路，留空自动 |
| `api.platform` | `platform` 请求参数，默认 `1` |
| `api.version` | 客户端版本号，站点校验失效时改这里 |
| `auth.token` | 登录后自动写入；一般不用手填 |

设置页底部「操作」区：

- **检查登录状态** —— 调 `/member/info` 验证 token 是否还有效
- **退出登录** —— 清空 token
- **重新探测所有线路** —— 输出每条候选的连通状态与延迟
- **从报错挖新域名** —— 主动触发挖矿，发现后自动切换
- **查看当前线路** —— 当前线路 + 候选池大小
- **清理缓存** —— 清详情/章节缓存与健康缓存

---

## 八、安装到 Breeze

> **仓库命名**：Breeze 的列表脚本只收录名字以 `Breeze-plugin` 开头的仓库
> （`isPluginRepo` 里是 `name.startsWith("Breeze-plugin")`），并且要求根目录有
> `manifest.json`、`updateUrl` 对应的 release 至少有一个可下载附件。
> 本仓库因此命名为 `Breeze-plugin-copy4000`（本地目录仍是小写，无影响）。

两种方式：

1. **网络安装（推荐）**：插件商店 → 浏览安装 → 网络安装，填

   ```
   https://github.com/k623615746/Breeze-plugin-copy4000/releases/latest/download/breeze-plugin-copy4000.bundle.cjs
   ```

2. **本地文件**：插件商店 → 底部「更新」→ 本地文件 → 选 `dist/breeze-plugin-copy4000.bundle.cjs`

装好后进插件设置页可开**调试模式**填 bundle 地址，之后改代码能热更新（`init` / `getInfo` 的入口列表除外，那两项要重装）。

### 更新通道（踩过的坑）

`getInfo()` 里**只填 `updateUrl`，不填 `npmName`**：

```ts
updateUrl: "https://api.github.com/repos/k623615746/Breeze-plugin-copy4000/releases/latest"
```

原因是 Breeze 的 `fetchSelfChannelLatestVersion` 是这样写的：

```dart
if (npmName.isNotEmpty) return fetchNpmLatestVersion(npmName);  // 只查 npm
return fetchUpdateUrlLatestVersion(updateUrl);                  // 否则才走 updateUrl
```

**有 `npmName` 就只查 npm，不会回退 `updateUrl`。** 之前填了 `npmName` 却没发布到 npm，同步就报「远程插件文件不存在（404）」。

另外 release 必须同时提供 `.cjs.br` 和 `.cjs`——客户端优先选 `.br`（10KB vs 34KB），下载更快。

发布 checklist：

1. 改 `src/get-info.ts` 的 `version`（字面量，`generate-version.ts` 靠正则读它）
2. `npx rspack build` + `node --import tsx build/generate-brotli.ts`
3. Release tag 与 `version` 一致（`v` 前缀可有可无，比较时会 strip）
4. **两个资产都传**：`.bundle.cjs` + `.bundle.cjs.br`
5. `node test/update-channel.mjs` 验证整条通道

---

## 九、开发

```bash
npm install
npm run typecheck
npx rspack build     # 产物 dist/breeze-plugin-copy4000.bundle.cjs
```

自测脚本：

```bash
node test/domain-mining.mjs   # 域名挖矿算法（离线，5 个用例）
node test/e2e.mjs 海贼王       # 裸接口全链路
node test/smoke.mjs           # 加载打包产物跑真实接口
```

插件跑在 QuickJS-NG 里，不是 Node 也不是浏览器：单文件 bundle，无运行时 npm 依赖，持久化只能走 `cache` / `pluginConfig`。

---

## 十、已知边界

- **镜像站路线未接入**：`ios.2026copy.com` 那套走 SSR HTML + AES-128-CBC 解密（`dnts` 头、`ccz`/`cct` 密钥、`contentKey`），可以在 v3 API 全线死掉时作为第四条兜底。运行时有 `crypto.aesCbcPkcs7Decrypt`，技术上可行，未实现。
- **登录 salt 硬编码 1729**：站点改算法时登录会挂，阅读不受影响。
- **候选池上限 60 条**：自动发现会持续累积，超出按加入顺序淘汰。

---

仅供学习与个人使用。插件不托管任何内容，所有数据来自站点公开接口。
