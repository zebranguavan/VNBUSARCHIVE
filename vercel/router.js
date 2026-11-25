// Router duy nhất cho Vercel: nhận request đã được vercel.json rewrite về /api/index?__route=<đường dẫn gốc>,
// tìm file tương ứng trong functions/ (cùng quy tắc đặt tên với Cloudflare Pages) rồi gọi onRequest*/(context).
import { installShims } from './html-rewriter.js';
import { createContext } from './cf-compat.js';
import { routes } from './routes.js';

installShims();

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const jsonResponse = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// Khớp đường dẫn với bảng route. Phân đoạn: "abc" (cố định), ":id" (một đoạn), "*path" (phần còn lại, có thể rỗng).
export function matchRoute(pathname) {
    const parts = pathname.split('/').filter(Boolean).map(safeDecode);
    for (const route of routes) {
        const params = {};
        let ok = true;
        let i = 0;
        for (const seg of route.segments) {
            if (seg[0] === '*') { params[seg.slice(1)] = parts.slice(i); i = parts.length; break; }
            if (i >= parts.length) { ok = false; break; }
            if (seg[0] === ':') params[seg.slice(1)] = parts[i];
            else if (seg !== parts[i]) { ok = false; break; }
            i++;
        }
        if (ok && i === parts.length) return { route, params };
    }
    return null;
}

function pickHandler(mod, method) {
    const m = method.toUpperCase();
    const named = mod['onRequest' + m[0] + m.slice(1).toLowerCase()];
    if (named) return named;
    if (m === 'HEAD' && mod.onRequestGet) return mod.onRequestGet;
    return mod.onRequest || null;
}

// Dựng request chuyển cho handler: bỏ tham số __route và đặt lại CF-Connecting-IP.
// Trên Vercel không có Cloudflare phía trước nên client có thể TỰ GỬI header CF-Connecting-IP để giả IP.
// Vì vậy luôn ghi đè nó bằng IP thật do Vercel cung cấp (x-real-ip / x-forwarded-for).
export function buildForwardedRequest(request) {
    const incoming = new URL(request.url);
    const route = incoming.searchParams.get('__route');
    incoming.searchParams.delete('__route');

    let pathname = incoming.pathname;
    if (route !== null) {
        if (!route.startsWith('/') || route.startsWith('//')) return null;
        pathname = route;
    }

    const headers = new Headers(request.headers);
    const trusted = (headers.get('x-real-ip') || headers.get('x-vercel-forwarded-for')
        || (headers.get('x-forwarded-for') || '').split(',')[0] || '').trim();
    if (trusted) headers.set('cf-connecting-ip', trusted);
    else headers.delete('cf-connecting-ip');

    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
        init.duplex = 'half';
    }
    const search = incoming.search;
    return {
        pathname,
        origin: incoming.origin,
        request: new Request(incoming.origin + encodeURI(pathname) + search, init),
    };
}

export async function handle(request) {
    try {
        const fwd = buildForwardedRequest(request);
        if (!fwd) return jsonResponse(404, { error: 'Not Found' });

        const matched = matchRoute(fwd.pathname);
        if (!matched) return jsonResponse(404, { error: 'Not Found' });

        const mod = await matched.route.load();
        const handler = pickHandler(mod, request.method);
        if (!handler) return jsonResponse(405, { error: 'Method Not Allowed' });

        const context = createContext({ request: fwd.request, params: matched.params, origin: fwd.origin });
        const response = await handler(context);
        if (!(response instanceof Response)) {
            return jsonResponse(500, { error: 'Handler did not return a Response' });
        }
        if (request.method === 'HEAD') {
            return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        return response;
    } catch (err) {
        console.error('[vercel/router] Lỗi không xử lý được:', err && err.stack ? err.stack : err);
        return jsonResponse(500, { error: 'Internal Server Error' });
    }
}
