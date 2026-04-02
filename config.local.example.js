/**
 * 可选云端同步：复制本文件为 `config.local.js` 并填写其一（勿提交到 Git）：
 * - 推荐 Supabase：ASCII_CAMERA_SUPABASE_URL + ASCII_CAMERA_SUPABASE_ANON_KEY（见 DEPLOY.md 建表与 RLS）
 * - 或 JSONBin：ASCII_CAMERA_BIN_ID + ASCII_CAMERA_API_KEY（免费层易「Requests exhausted」）
 * 亦可仅在 Vercel 配环境变量后执行 `npm run build` 生成 `config.local.js`。
 * 本地用 file:// 打开 gallery.html 时，必须在本机存在已填写 URL/key 的 config.local.js，否则会提示「本地云端未填写」。
 */
window.ASCII_CAMERA_SUPABASE_URL = '';
window.ASCII_CAMERA_SUPABASE_ANON_KEY = '';
window.ASCII_CAMERA_SUPABASE_TABLE = 'ascii_gallery_sync';
window.ASCII_CAMERA_SUPABASE_ROW_ID = 'default';
window.ASCII_CAMERA_BIN_ID = '';
window.ASCII_CAMERA_API_KEY = '';
window.ASCII_CAMERA_JSONBIN_AUTH = 'master';
