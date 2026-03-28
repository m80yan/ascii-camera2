/**
 * Vercel 构建阶段：从环境变量写入根目录 config.local.js（不提交 Git）。
 * 本地开发仍使用你手写的 config.local.js；线上以 Dashboard 中的变量为准。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const binId = process.env.ASCII_CAMERA_BIN_ID || '';
const apiKey = process.env.ASCII_CAMERA_API_KEY || '';

const content =
  '/** 构建生成 — 勿改；本地请编辑根目录 config.local.js */\n' +
  'window.ASCII_CAMERA_BIN_ID = ' +
  JSON.stringify(binId) +
  ';\n' +
  'window.ASCII_CAMERA_API_KEY = ' +
  JSON.stringify(apiKey) +
  ';\n';

fs.writeFileSync(path.join(root, 'config.local.js'), content, 'utf8');

if (!binId || !apiKey) {
  console.warn(
    '[inject-config] 未设置 ASCII_CAMERA_BIN_ID 或 ASCII_CAMERA_API_KEY，线上将无法读写 JSONBin。请在 Vercel → Settings → Environment Variables 中配置。'
  );
} else {
  console.log('[inject-config] 已生成 config.local.js');
}
