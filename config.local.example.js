/**
 * 可选云端同步：复制为 `config.local.js` 并填写其一：
 * - 推荐 Supabase：ASCII_CAMERA_SUPABASE_URL + ASCII_CAMERA_SUPABASE_ANON_KEY（见 DEPLOY.md 建表与 RLS）
 * - 或 JSONBin：ASCII_CAMERA_BIN_ID + ASCII_CAMERA_API_KEY（免费层易「Requests exhausted」）
 * 亦可仅在 Vercel 配环境变量后执行 `npm run build` 生成 `config.local.js`。
 */
window.ASCII_CAMERA_SUPABASE_URL = '';
window.ASCII_CAMERA_SUPABASE_ANON_KEY = '';
window.ASCII_CAMERA_SUPABASE_TABLE = 'ascii_gallery_sync';
window.ASCII_CAMERA_SUPABASE_ROW_ID = 'default';
window.ASCII_CAMERA_BIN_ID = '';
window.ASCII_CAMERA_API_KEY = '';
window.ASCII_CAMERA_JSONBIN_AUTH = 'master';
