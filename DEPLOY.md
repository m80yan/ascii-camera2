# 通过 Git 部署到 Vercel

## 1. 数据说明

- 画廊 **默认展示多张内置示例图**（所有访客相同）。
- 用户通过 **上传 / 相机** 保存的内容默认在 **本机 localStorage**（与示例图合并展示）。
- **可选云端同步**：配置后，Gallery **定时轮询** 拉取远端并与本机合并；上传、删除、相机保存 **去抖后推送**。适合 Notion 嵌入等存储分区不一致时对齐作品。
- **Notion 嵌入内上传**：保存时会自动打开极小的同源弹窗 `gallery-bridge.html`，把同一条作品写入 **顶层首方** `localStorage`，使 **View original** 打开的 `gallery.html` 能立刻看到刚上传的图（需在浏览器允许本站弹出窗口）。部署时请确保 **`gallery-bridge.html`** 与 `gallery.html` 一并上传。
- **推荐 [Supabase](https://supabase.com)**（免费层一般够用）。**JSONBin** 仍可作备选，但免费层常出现 `Requests exhausted`。

## 2. Supabase 与 Vercel 环境变量（推荐）

1. 新建 Supabase 项目 → **SQL Editor** 执行：

```sql
create table if not exists public.ascii_gallery_sync (
  id text primary key,
  body jsonb not null default '{"schema":1,"updatedAt":0,"photos":[]}'::jsonb
);

insert into public.ascii_gallery_sync (id, body)
values ('default', '{"schema":1,"updatedAt":0,"photos":[]}'::jsonb)
on conflict (id) do nothing;

alter table public.ascii_gallery_sync enable row level security;

drop policy if exists "ascii_gallery_sync_select" on public.ascii_gallery_sync;
drop policy if exists "ascii_gallery_sync_insert" on public.ascii_gallery_sync;
drop policy if exists "ascii_gallery_sync_update" on public.ascii_gallery_sync;

create policy "ascii_gallery_sync_select" on public.ascii_gallery_sync
  for select using (true);
create policy "ascii_gallery_sync_insert" on public.ascii_gallery_sync
  for insert with check (true);
create policy "ascii_gallery_sync_update" on public.ascii_gallery_sync
  for update using (true);
```

（上述 RLS 允许匿名读写整表，**anon key 也会出现在前端包里**——仅适合非敏感作品列表；勿存隐私数据。）

2. **Project Settings → API**：复制 **Project URL** 与 **anon public** key。

3. Vercel → **Project → Settings → Environment Variables**（至少勾选 **Production**，若用 Preview 链接测试也需勾选 **Preview**）：

   - `ASCII_CAMERA_SUPABASE_URL` = `https://xxxx.supabase.co`（勿尾斜杠）  
   - `ASCII_CAMERA_SUPABASE_ANON_KEY` = anon key  

   可选：`ASCII_CAMERA_SUPABASE_TABLE`（默认 `ascii_gallery_sync`）、`ASCII_CAMERA_SUPABASE_ROW_ID`（默认 `default`）。

4. **保存变量后必须重新 Deploy 一次**（或触发新构建），以便 `npm run build` → `inject-config.js` 把变量写入 `config.local.js`。仅改变量不重新构建时，线上仍会是无云端状态。

5. 部署完成后打开站点：若 Gallery 顶部 **不再** 出现橙色「云端未配置」提示条，说明前端已读到 Supabase 配置。

**若你确认 `https://你的域名/config.local.js` 里已有 URL 与 key，但嵌入页仍提示未配置：** 多半是 **Gallery 页面实际请求的 config 地址** 与 **你在地址栏打开的不是同一个**（例如 `gallery.html` 在子路径时，旧版相对路径会请求子路径下的 `config.local.js` 导致 404）。当前代码已改为在 **https 下始终加载站点根路径的 `/config.local.js`**。请重新部署后，在 **Gallery 所在页面** 打开开发者工具 → **Network**，确认 **`config.local.js`** 为 **200** 且域名为你的站点。

**若同时配置了 Supabase 与 JSONBin，优先使用 Supabase。**

### 验证 Supabase 是否可用

在已部署站点上打开 **顶层** `gallery.html`（非 Notion 嵌入），按 F12 打开控制台，执行：

```js
AsciiCameraGalleryCloudSync.getSyncStatus()
```

若返回 `enabled: true` 且 `provider: "supabase"`，说明前端已读到 URL 与 anon key。再上传或保存一张作品，等待约 1 秒后再次执行；若 `lastPushOk: true`（且需要时 `lastPullOk: true`），说明与 Supabase 的读写请求成功。若 `lastPushError` / `lastPullError` 有内容，多为 RLS、表名、行 id 或网络（含嵌入页拦截 `fetch`）问题。

### Notion 嵌入里「配置了云端但仍不同步」

1. 部署后的 **Gallery 页面顶部** 会有一行 **云端同步状态**（绿色为正常，红色为失败并带简短原因）。先看红字内容。
2. 在 **Notion 里打开嵌入页** → 浏览器 **F12** → **Network**，筛选 **`supabase`** 或 **`rest/v1`**：  
   - 若对 `xxxx.supabase.co` 的请求为 **红色 Failed** 或 **(blocked)**，说明 **当前环境禁止向 Supabase 发请求**（企业策略、隐私插件、或宿主限制）。可换 **手机流量 / 另一网络** 或在 **地址栏直接打开** `https://你的域名/gallery.html`（非嵌入）对比：若仅嵌入失败，多半是 **iframe 内跨站请求被拦**。
3. 在 **Supabase → Table Editor** 打开表 **`ascii_gallery_sync`**，点 **`default` 那一行**，看 **`body`** 里的 **`photos`** 是否在有人保存后 **会更新**。若 **始终不变**，说明 **上传请求未成功写入**（重点查 RLS、anon key、表名）。若 **会变** 但别人看不到，则是 **别人浏览器拉取失败**（Network 里看 GET 是否 200）。

## 3. JSONBin（备选）

若仍想用 JSONBin：设置 `ASCII_CAMERA_BIN_ID` 与 `ASCII_CAMERA_API_KEY`（X-Master-Key）；Bin 初始 JSON 建议 `{"schema":1,"updatedAt":0,"photos":[]}`。免费额度用尽时会无法读写。

## 4. Vercel 项目设置

- **Framework Preset**：Other  
- **Build Command**：`npm run build`（与 `vercel.json` 一致即可）  
- **Output Directory**：`.`（当前目录）  
- **Install Command**：`npm install`（可留默认）

## 5. Git 与推送

```bash
cd "/path/to/ASCII Camera"
git init
git add .
git commit -m "Initial commit"
```

在 GitHub / GitLab 新建空仓库，按平台提示：

```bash
git remote add origin <你的仓库 HTTPS 或 SSH>
git branch -M main
git push -u origin main
```

在 [vercel.com](https://vercel.com) **Add New Project** → Import 该仓库 → Deploy。

## 6. 访问

部署完成后打开：`https://<你的域名>/gallery.html` 与 `https://<你的域名>/camera.html`。
