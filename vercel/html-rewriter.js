// Bản thay thế tối giản cho HTMLRewriter của Cloudflare (không có trên Vercel/Node).
// Hỗ trợ đúng phần API mà các trang SSR trong functions/ đang dùng:
//   new HTMLRewriter().on(selector, { element(e) { e.setAttribute(...); e.setInnerContent(...); } }).transform(response)
import { parse } from 'node-html-parser';

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// node-html-parser tự đổi " thành &quot; nên ở đây chỉ cần escape &.
const escAttr = (s) => String(s).replace(/&/g, '&amp;');
const fmt = (content, opts) => (opts && opts.html ? String(content) : escText(content));

class ElementShim {
    constructor(node) { this._n = node; }
    get tagName() { return String(this._n.rawTagName || '').toLowerCase(); }
    getAttribute(name) { const v = this._n.getAttribute(name); return v === undefined ? null : v; }
    hasAttribute(name) { return this._n.hasAttribute(name); }
    setAttribute(name, value) { this._n.setAttribute(name, escAttr(value)); return this; }
    removeAttribute(name) { this._n.removeAttribute(name); return this; }
    setInnerContent(content, opts) { this._n.set_content(fmt(content, opts)); return this; }
    append(content, opts) { this._n.insertAdjacentHTML('beforeend', fmt(content, opts)); return this; }
    prepend(content, opts) { this._n.insertAdjacentHTML('afterbegin', fmt(content, opts)); return this; }
    before(content, opts) { this._n.insertAdjacentHTML('beforebegin', fmt(content, opts)); return this; }
    after(content, opts) { this._n.insertAdjacentHTML('afterend', fmt(content, opts)); return this; }
    replace(content, opts) { this._n.replaceWith(fmt(content, opts)); return this; }
    remove() { this._n.remove(); return this; }
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export class NodeHTMLRewriter {
    constructor() { this._handlers = []; }

    on(selector, handler) {
        this._handlers.push({ selector, handler });
        return this;
    }

    transform(response) {
        if (NULL_BODY_STATUS.has(response.status)) return response;
        const handlers = this._handlers;
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    const html = await response.text();
                    // comment: true để giữ nguyên các chú thích HTML như HTMLRewriter thật.
                    const root = parse(html, { comment: true });
                    for (const { selector, handler } of handlers) {
                        if (!handler || typeof handler.element !== 'function') continue;
                        for (const node of root.querySelectorAll(selector)) {
                            await handler.element(new ElementShim(node));
                        }
                    }
                    controller.enqueue(new TextEncoder().encode(root.toString()));
                    controller.close();
                } catch (err) {
                    controller.error(err);
                }
            },
        });
        const headers = new Headers(response.headers);
        // Nội dung đã bị thay đổi nên các header này không còn đúng.
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.delete('etag');
        return new Response(stream, { status: response.status, statusText: response.statusText, headers });
    }
}

// Cache "giả" cho caches.default (Cloudflare). Trên Vercel, CDN tự cache theo Cache-Control: s-maxage.
const noopCache = {
    async match() { return undefined; },
    async put() {},
    async delete() { return false; },
};

export function installShims() {
    if (typeof globalThis.HTMLRewriter === 'undefined') globalThis.HTMLRewriter = NodeHTMLRewriter;
    if (typeof globalThis.caches === 'undefined') globalThis.caches = { default: noopCache };
}
