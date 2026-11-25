// Điểm vào DUY NHẤT của Vercel Functions.
// Mọi đường dẫn /api/*, /photo/*, /vehicle/*, ... được vercel.json rewrite về đây,
// rồi vercel/router.js chuyển tiếp tới đúng file trong functions/ (giữ nguyên code Cloudflare Pages Functions).
import { handle } from '../vercel/router.js';

export default { fetch: handle };
