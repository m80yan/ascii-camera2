# Update log · 更新日志

按时间倒序（最新在上）。对应 Git 提交见括号内 hash。

---

## 2026-03-29 — 嵌入分区、云端双后端与相机页保留

### Notion / 存储分区与 `opener`

- **原因**：Notion iframe 内 Gallery 与顶层新标签 Camera 的 **`localStorage` 分区不同**，仅靠本机存储时嵌入里看不到抓拍；宿主还可能给 `target="_blank"` 加 **`noopener`**，导致无 **`window.opener`**。
- **Gallery**：「Open Camera」改为在用户点击里 **`window.open(camera.html, CAMERA_POPUP_WINDOW_NAME)`**（与 `gallery-storage.js` 中常量一致），尽量保留 `opener`。
- **Camera → Gallery**：保存时对 **`opener`** 同源 **`postMessage`**（类型 `GALLERY_PREPEND_MESSAGE_TYPE`）；仅当 **`galleryOpenerNeedsPostMessage(opener)`** 为真时发送（避免顶层 Gallery 与 Camera 同分区时重复写入）。Gallery 监听 `message` 后 `prependUserPhoto` + `refreshGallery`。
- **Camera（嵌入预览）**：iframe 内仍提示用新标签；**Open in new tab** / **Start Camera** 使用同一具名窗口打开，便于复用同一相机标签。

### 云端同步（`gallery-cloud-sync.js`）

- **双后端**：优先 **Supabase**（`ASCII_CAMERA_SUPABASE_URL` + `ASCII_CAMERA_SUPABASE_ANON_KEY`，PostgREST upsert）；可选 **JSONBin v3**（额度用尽时可改用 Supabase）。
- **行为**：Gallery 启动后 **`pullOnce`** 合并远端与本地，再 **`startPolling`**（默认约 16s）；上传 / 删除 / `postMessage` 收图用 **`schedulePush`** 去抖；相机页 **`pushFromLocal`** 不 `await`，避免网络卡住保存流程。
- **构建**：`scripts/inject-config.js` 写入 `config.local.js`（含 Supabase 表名、行 id 等可选变量）。详见 **`DEPLOY.md`**（含 Supabase SQL 与 RLS 示例）。
- **说明**：在部分嵌入环境中对 **`*.supabase.co` 的 `fetch` 可能失败**（`Failed to fetch`），与 JSONBin 是否可达取决于宿主策略；云端与 **`postMessage`** 为互补路径。
- **UI**：曾加入云端状态条与手动 Pull，已按需求**移除**；轮询仍在后台运行。

### 相机保存后行为

- **不再** `close()` / `location.replace('gallery.html')`：保存后尝试 **`opener.focus()`**，相机页保持打开，再次从 Gallery 点 Open Camera 会**聚焦同一具名窗口**。

### 其他

- **`gallery-storage.js`**：导出 **`MAX_USER_PHOTOS`**；常量 **`CAMERA_POPUP_WINDOW_NAME`**、**`galleryOpenerNeedsPostMessage`**。
- **`config.local.example.js`**：补充 Supabase 相关占位变量。

---

### 🔄 Update Log（English summary）

**1. Notion / Camera**

- Camera opens in a **named** popup/tab (`window.open` from Gallery) to preserve **`window.opener`** where hosts inject `noopener` on plain `_blank` links.
- **`postMessage`** syncs captures into the **embedded** Gallery’s storage partition when `opener` is the iframe window.
- After save, the **camera tab stays open**; focus returns to Gallery; re-clicking **Open Camera** reuses the same window.

**2. Cloud sync**

- **Supabase** (recommended) or **JSONBin** via **`gallery-cloud-sync.js`**: pull + merge + poll; push on save/upload/delete. Env vars via **`inject-config.js`** / **`DEPLOY.md`**.
- Embedded contexts may block `fetch` to some APIs; **`postMessage`** remains the primary path for same-origin embed + top-level camera.

**3. Root path**

- **`index.html`** still routes `/` → `gallery.html` (Vercel).

**4. Initial version**

- Camera, Gallery, localStorage gallery pipeline; optional cloud config from env (`DEPLOY.md`).

---

## 2026-03-28 — Notion 嵌入与根路径

### Notion / 摄像头（`ea9ea1f`）

- **Gallery**：「Open Camera」改为在新标签页打开（`target="_blank"`），避免在 Notion iframe 内跳转导致无法授权摄像头。
- **Camera**：检测是否处于第三方 iframe；嵌入时显示提示条与 **Open in new tab** 链接；在嵌入内点击 **Start Camera** 时改为打开当前页的新标签（并处理弹窗被拦截时的提示）。

### 部署与首页（`80970ab`）

- 新增 **`index.html`**：根路径 `/` 自动跳转至 `gallery.html`，并保留到 Gallery / Camera 的手动链接，修复 Vercel 部署后访问域名根路径 **404** 的问题。

---

## 2026-03-28 — 初版上线与 Vercel（`02f81ea`）

- **ASCII Camera 页面**：`camera.html`（实时摄像头 ASCII、抓拍写入画廊、样式/分辨率/比例、Flash 倒计时等）。
- **Gallery**：`gallery.html`（JSONBin 轮询、缩略图与灯箱、上传图片并编辑预览后入库、删除确认等）。
- **配置**：`config.local.example.js`；构建脚本 **`scripts/inject-config.js`** 在部署时从环境变量注入 `ASCII_CAMERA_BIN_ID` / `ASCII_CAMERA_API_KEY`（见 **`DEPLOY.md`**）。
- **Vercel**：`vercel.json`、`package.json` 构建流程；`.gitignore` 忽略本地 `config.local.js`。

---

## 使用说明（给读者）

- 将本仓库推送到 GitHub 并连接 Vercel 后，每次 `git push` 会触发重新部署。
- 在 Notion 中建议**只嵌入 Gallery**；需要拍照时通过 **Open Camera** 或相机页提示在新标签页使用摄像头。
