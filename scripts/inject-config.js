/**
 * Vercel 构建阶段：写入 `config.local.js`。
 * 云端同步（二选一，优先 Supabase）：
 * - ASCII_CAMERA_SUPABASE_URL + ASCII_CAMERA_SUPABASE_ANON_KEY（推荐）
 * - 或 ASCII_CAMERA_BIN_ID + ASCII_CAMERA_API_KEY（JSONBin，易额度用尽）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const binId = process.env.ASCII_CAMERA_BIN_ID || '';
const apiKey = process.env.ASCII_CAMERA_API_KEY || '';
const supabaseUrl = process.env.ASCII_CAMERA_SUPABASE_URL || '';
const supabaseAnon = process.env.ASCII_CAMERA_SUPABASE_ANON_KEY || '';
const supabaseTable = process.env.ASCII_CAMERA_SUPABASE_TABLE || 'ascii_gallery_sync';
const supabaseRowId = process.env.ASCII_CAMERA_SUPABASE_ROW_ID || 'default';
const supabasePhotosTable = process.env.ASCII_CAMERA_SUPABASE_PHOTOS_TABLE || 'ascii_photos';
const supabaseLikesTable = process.env.ASCII_CAMERA_SUPABASE_LIKES_TABLE || 'ascii_photo_likes';

const content =
  '/** Generated at build — see DEPLOY.md */\n' +
  'window.ASCII_CAMERA_SUPABASE_URL = ' +
  JSON.stringify(supabaseUrl) +
  ';\n' +
  'window.ASCII_CAMERA_SUPABASE_ANON_KEY = ' +
  JSON.stringify(supabaseAnon) +
  ';\n' +
  'window.ASCII_CAMERA_SUPABASE_TABLE = ' +
  JSON.stringify(supabaseTable) +
  ';\n' +
  'window.ASCII_CAMERA_SUPABASE_ROW_ID = ' +
  JSON.stringify(supabaseRowId) +
  ';\n' +
  'window.ASCII_CAMERA_SUPABASE_PHOTOS_TABLE = ' +
  JSON.stringify(supabasePhotosTable) +
  ';\n' +
  'window.ASCII_CAMERA_SUPABASE_LIKES_TABLE = ' +
  JSON.stringify(supabaseLikesTable) +
  ';\n' +
  'window.ASCII_CAMERA_BIN_ID = ' +
  JSON.stringify(binId) +
  ';\n' +
  'window.ASCII_CAMERA_API_KEY = ' +
  JSON.stringify(apiKey) +
  ';\n' +
  'window.ASCII_CAMERA_JSONBIN_AUTH = "master";\n';

fs.writeFileSync(path.join(root, 'config.local.js'), content, 'utf8');

var mode = 'off';
if (supabaseUrl && supabaseAnon) mode = 'supabase';
else if (binId && apiKey) mode = 'jsonbin';
console.log('[inject-config] wrote config.local.js (cloud: ' + mode + ')');
