# 通过 Git 部署到 Vercel

## 1. 数据说明

- 画廊 **默认展示 4 张内置示例图**（所有访客相同）。
- 用户通过 **上传 / 相机** 保存的内容仅存在于 **该浏览器的 localStorage**，**不同设备、不同浏览器之间不同步**。
- **无需** JSONBin 或其它云端密钥；构建脚本仍会生成空的 `config.local.js` 占位，可忽略。

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
