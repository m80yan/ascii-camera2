# Update log · 更新日志

按时间倒序（最新在上）。对应 Git 提交见括号内 hash。

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
