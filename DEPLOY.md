# 通过 Git 部署到 Vercel

## 1. 环境变量（必配）

在 Vercel 项目 **Settings → Environment Variables** 添加（勾选 Production / Preview 按需）：

| Name | Value |
|------|--------|
| `ASCII_CAMERA_BIN_ID` | JSONBin 里该 Bin 的 ID |
| `ASCII_CAMERA_API_KEY` | JSONBin 的 **X-Master-Key**（Master Key） |

保存后 **Redeploy** 一次，构建脚本会把变量写入 `config.local.js`。

> 说明：密钥会出现在前端加载的 `config.local.js` 中，仅适合个人/演示；正式产品请用后端代理。

## 2. Vercel 项目设置

- **Framework Preset**：Other  
- **Build Command**：`npm run build`（与 `vercel.json` 一致即可）  
- **Output Directory**：`.`（当前目录）  
- **Install Command**：`npm install`（可留默认）

## 3. Git 与推送

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

## 4. 访问

部署完成后打开：`https://<你的域名>/gallery.html` 与 `https://<你的域名>/camera.html`。

本地开发仍使用根目录自建的 `config.local.js`（已在 `.gitignore` 中，不会进仓库）。
