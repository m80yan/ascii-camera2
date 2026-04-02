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

create policy "ascii_gallery_sync_select" on public.ascii_gallery_sync
  for select using (true);
create policy "ascii_gallery_sync_insert" on public.ascii_gallery_sync
  for insert with check (true);
create policy "ascii_gallery_sync_update" on public.ascii_gallery_sync
  for update using (true);
```

（上述 RLS 允许匿名读写整表，**anon key 也会出现在前端包里**——仅适合非敏感作品列表；勿存隐私数据。）

2. **Project Settings → API**：复制 **Project URL** 与 **anon public** key。

3. Vercel → **Environment Variables**：

   - `ASCII_CAMERA_SUPABASE_URL` = `https://xxxx.supabase.co`（勿尾斜杠）  
   - `ASCII_CAMERA_SUPABASE_ANON_KEY` = anon key  

   可选：`ASCII_CAMERA_SUPABASE_TABLE`（默认 `ascii_gallery_sync`）、`ASCII_CAMERA_SUPABASE_ROW_ID`（默认 `default`）。

4. 重新 Deploy；`npm run build` 会写入 `config.local.js`。

**若同时配置了 Supabase 与 JSONBin，优先使用 Supabase。**

### 验证 Supabase 是否可用

在已部署站点上打开 **顶层** `gallery.html`（非 Notion 嵌入），按 F12 打开控制台，执行：

```js
AsciiCameraGalleryCloudSync.getSyncStatus()
```

若返回 `enabled: true` 且 `provider: "supabase"`，说明前端已读到 URL 与 anon key。再上传或保存一张作品，等待约 1 秒后再次执行；若 `lastPushOk: true`（且需要时 `lastPullOk: true`），说明与 Supabase 的读写请求成功。若 `lastPushError` / `lastPullError` 有内容，多为 RLS、表名、行 id 或网络（含嵌入页拦截 `fetch`）问题。

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
