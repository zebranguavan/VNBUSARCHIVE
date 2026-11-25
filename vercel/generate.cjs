// Sinh cấu hình Vercel từ cấu trúc thư mục functions/ và csp.json:
//   - vercel/routes.js : bảng route (giống quy tắc đặt tên file của Cloudflare Pages)
//   - vercel.json      : rewrites + headers (CSP, cache)
// Chạy tự động trong `node build-core.js`; chạy riêng: `npm run vercel:generate`.
const fs = require('fs');
const path = require('path');

function listFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, name.name);
        if (name.isDirectory()) out.push(...listFiles(abs));
        else if (name.isFile() && name.name.endsWith('.js')) out.push(abs);
    }
    return out;
}

// functions/api/admin/action.js -> ['api','admin','action'];  [id] -> ':id';  [[path]] -> '*path'
function toSegments(rel) {
    const noExt = rel.replace(/\.js$/, '');
    let parts = noExt.split('/');
    if (parts[parts.length - 1] === 'index') parts = parts.slice(0, -1);
    if (noExt.endsWith('.xml')) parts = rel.split('/'), parts[parts.length - 1] = parts[parts.length - 1].replace(/\.js$/, '');
    return parts.map((p) => {
        let m = p.match(/^\[\[(.+)\]\]$/);
        if (m) return '*' + m[1];
        m = p.match(/^\[(.+)\]$/);
        if (m) return ':' + m[1];
        return p;
    });
}

// Cụ thể hơn thì khớp trước: cố định -> có tham số -> catch-all.
function specificity(segments) {
    const hasRest = segments.some((s) => s[0] === '*');
    const params = segments.filter((s) => s[0] === ':').length;
    return [hasRest ? 2 : params > 0 ? 1 : 0, -segments.length];
}

function patternOf(segments) {
    return '/' + segments.map((s) => (s[0] === '*' ? ':' + s.slice(1) + '*' : s)).join('/');
}

module.exports = function generate(root) {
    const fnDir = path.join(root, 'functions');
    const files = listFiles(fnDir)
        .map((abs) => path.relative(fnDir, abs).split(path.sep).join('/'))
        .filter((rel) => !path.posix.basename(rel).startsWith('_'))
        .sort();

    const routes = files.map((rel) => ({ rel, segments: toSegments(rel) }));
    routes.sort((a, b) => {
        const sa = specificity(a.segments), sb = specificity(b.segments);
        return sa[0] - sb[0] || sa[1] - sb[1] || a.rel.localeCompare(b.rel);
    });

    // ---- vercel/routes.js
    const lines = routes.map((r) =>
        `    { segments: ${JSON.stringify(r.segments)}, load: () => import(${JSON.stringify('../functions/' + r.rel)}) },`);
    const routesJs = [
        '// TỰ ĐỘNG SINH bởi vercel/generate.cjs từ thư mục functions/ - đừng sửa tay.',
        '// Chạy lại bằng: npm run vercel:generate  (hoặc node build-core.js)',
        'export const routes = [',
        ...lines,
        '];',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'vercel', 'routes.js'), routesJs);

    // ---- vercel.json
    const dest = (src) => `/api/index?__route=${src}`;
    const apiRewrite = { source: '/api/:path*', destination: dest('/api/:path*') };
    const pageRewrites = routes
        .filter((r) => r.segments[0] !== 'api')
        .map((r) => patternOf(r.segments))
        .sort()
        .map((src) => ({ source: src, destination: dest(src) }));

    const cspPath = path.join(root, 'csp.json');
    const headers = [];
    if (fs.existsSync(cspPath)) {
        const csp = JSON.parse(fs.readFileSync(cspPath, 'utf8'));
        const value = Object.entries(csp).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ') + ';';
        headers.push({
            source: '/(.*)',
            headers: [
                { key: 'Content-Security-Policy', value },
                { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
            ],
        });
    }
    const noStore = [
        { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
        { key: 'Pragma', value: 'no-cache' },
        { key: 'Expires', value: '0' },
    ];
    headers.push(
        { source: '/app.:hash([0-9a-f]{12}).js', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
        { source: '/', headers: noStore },
        { source: '/index.html', headers: noStore },
        { source: '/app.js', headers: noStore },
        { source: '/tailwind.css', headers: noStore },
        { source: '/css/:file', headers: noStore },
    );

    const config = {
        $schema: 'https://openapi.vercel.sh/vercel.json',
        framework: null,
        buildCommand: 'npm run build',
        outputDirectory: 'public',
        functions: {
            'api/index.js': { includeFiles: 'public/index.html', maxDuration: 30 },
        },
        rewrites: [
            apiRewrite,
            ...pageRewrites,
            // Thay cho functions/_middleware.js: bundle app.<hash>.js cũ không còn thì dùng /app.js.
            // (Vercel ưu tiên file tĩnh có thật, rewrite này chỉ chạy khi file không tồn tại.)
            { source: '/app.:hash.js', destination: '/app.js' },
            // Thay cho public/_redirects: SPA fallback.
            { source: '/(.*)', destination: '/index.html' },
        ],
        headers,
    };
    fs.writeFileSync(path.join(root, 'vercel.json'), JSON.stringify(config, null, 2) + '\n');
    return { routes: routes.length };
};

if (require.main === module) {
    const r = module.exports(path.join(__dirname, '..'));
    console.log(`Đã tạo vercel/routes.js (${r.routes} route) và vercel.json`);
}
