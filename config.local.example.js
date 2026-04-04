/**
 * Optional cloud sync: copy this file to `config.local.js` and fill in one backend (do not commit secrets):
 * - Supabase (recommended): ASCII_CAMERA_SUPABASE_URL + ASCII_CAMERA_SUPABASE_ANON_KEY (see DEPLOY.md for table + RLS)
 * - Or JSONBin: ASCII_CAMERA_BIN_ID + ASCII_CAMERA_API_KEY (free tier often hits “Requests exhausted”)
 * You can also set env vars on Vercel only and run `npm run build` to emit `config.local.js`.
 * For file:// gallery.html, you need a filled config.local.js locally or the app shows a “cloud not configured” banner.
 */
window.ASCII_CAMERA_SUPABASE_URL = '';
window.ASCII_CAMERA_SUPABASE_ANON_KEY = '';
window.ASCII_CAMERA_SUPABASE_TABLE = 'ascii_gallery_sync';
window.ASCII_CAMERA_SUPABASE_ROW_ID = 'default';
window.ASCII_CAMERA_SUPABASE_LIKES_TABLE = 'ascii_photo_likes';
window.ASCII_CAMERA_BIN_ID = '';
window.ASCII_CAMERA_API_KEY = '';
window.ASCII_CAMERA_JSONBIN_AUTH = 'master';
