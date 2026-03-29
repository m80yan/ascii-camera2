/**
 * Vercel 构建阶段：写入占位 `config.local.js`（画廊/相机已改为 localStorage，不依赖云端 Bin）。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const content =
  '/** 构建生成 — 画廊与相机使用浏览器 localStorage，以下变量可忽略 */\n' +
  'window.ASCII_CAMERA_BIN_ID = "";\n' +
  'window.ASCII_CAMERA_API_KEY = "";\n' +
  'window.ASCII_CAMERA_JSONBIN_AUTH = "master";\n';

fs.writeFileSync(path.join(root, 'config.local.js'), content, 'utf8');
console.log('[inject-config] 已生成 config.local.js');
