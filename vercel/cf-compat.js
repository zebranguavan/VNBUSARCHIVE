// Dựng lại đối tượng `context` của Cloudflare Pages Functions để code trong functions/ chạy nguyên bản trên Vercel:
//   { request, env, params, data, next, waitUntil }
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';

// Thư mục public/ (nơi build-core.js xuất index.html). Thử theo vị trí file này, rồi theo cwd.
const PUBLIC_DIRS = [
    fileURLToPath(new URL('../public', import.meta.url)),
    path.join(process.cwd(), 'public'),
];

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
};

async function readPublicFile(pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return null; }
    if (rel.endsWith('/')) rel += 'index.html';
    rel = path.posix.normalize(rel).replace(/^\/+/, '');
    if (!rel || rel.startsWith('..')) return null;
    for (const dir of PUBLIC_DIRS) {
        try {
            const abs = path.join(dir, rel);
            if (!abs.startsWith(dir + path.sep)) continue;
            return { body: await fs.readFile(abs), ext: path.extname(abs).toLowerCase() };
        } catch { /* thử thư mục kế tiếp */ }
    }
    return null;
}

// Thay cho binding env.ASSETS của Cloudflare Pages: đọc file tĩnh trong public/.
// Nếu không có trong bundle thì tải từ chính domain (không dùng cho /api để tránh vòng lặp).
function createAssets(origin) {
    return {
        async fetch(input) {
            const req = input instanceof Request ? input : new Request(input);
            const { pathname } = new URL(req.url);
            const file = await readPublicFile(pathname);
            if (file) {
                return new Response(file.body, {
                    status: 200,
                    headers: {
                        'content-type': MIME[file.ext] || 'application/octet-stream',
                        'cache-control': 'no-cache',
                    },
                });
            }
            if (pathname.startsWith('/api/')) return new Response('Not Found', { status: 404 });
            return fetch(new URL(pathname, origin));
        },
    };
}

function safeWaitUntil(promise) {
    const p = Promise.resolve(promise).catch(() => {});
    try { vercelWaitUntil(p); } catch { /* ngoài môi trường Vercel: bỏ qua */ }
}

export function createContext({ request, params, origin }) {
    return {
        request,
        env: { ...process.env, ASSETS: createAssets(origin) },
        params,
        data: {},
        waitUntil: safeWaitUntil,
        passThroughOnException() {},
        next: async () => new Response('Not Found', { status: 404 }),
    };
}
