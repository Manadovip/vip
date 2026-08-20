/* ==========================================================================
   sw.js — Service Worker Manado VIP PWA
   Strategi:
   - Shell pages (HTML) : Network-first → fallback ke cache → offline.html
   - Font Google        : Cache-first (bisa berbulan-bulan tidak berubah)
   - Gambar logo/qris   : Cache-first dengan TTL 7 hari
   - CSS/JS ?v=...      : Cache-first (sudah punya hash versi, aman dicache)
   - API (Supabase, drive-proxy) : Network-only (jangan pernah dicache)
   ========================================================================== */

const CACHE_SHELL   = 'mv-shell-v1';
const CACHE_ASSETS  = 'mv-assets-v1';
const CACHE_FONTS   = 'mv-fonts-v1';
const CACHE_IMAGES  = 'mv-images-v1';

// File yang di-precache saat SW pertama kali install
const SHELL_URLS = [
  '/',
  '/index.html',
  '/payment.html',
  '/offline.html'   // halaman fallback offline (dibuat terpisah)
  // FIX: /kontak.html & /syarat-ketentuan.html tidak ada sebagai file terpisah
  // (keduanya sudah jadi modal di dalam index.html), dihapus dari precache
];

// Domain yang TIDAK BOLEH dicache (selalu network-only)
const NETWORK_ONLY_ORIGINS = [
  'supabase.co',
  'functions/v1/drive-proxy',
  'functions/v1/telegram-notify'
];

// ── Helper ────────────────────────────────────────────────────────────────────

function isNetworkOnly(url) {
  return NETWORK_ONLY_ORIGINS.some(o => url.includes(o));
}

function isGoogleFont(url) {
  return url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com');
}

function isVersionedAsset(url) {
  // CSS/JS yang dimuat dengan ?v=... parameter
  return /\.(css|js)(\?v=\w+)?$/.test(url.split('?')[0]) && url.includes('?v=');
}

function isImage(url) {
  return /\.(png|jpg|jpeg|webp|gif|svg|ico)(\?|$)/.test(url);
}

// Caching dengan TTL — hapus entry yang lebih tua dari maxAgeSeconds
async function cacheWithTTL(cacheName, request, response, maxAgeSeconds) {
  const cache = await caches.open(cacheName);
  // Kloning response + tambah header Date supaya bisa cek usia nanti
  const headers = new Headers(response.headers);
  headers.append('sw-cached-at', Date.now().toString());
  const cloned = new Response(await response.clone().arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
  await cache.put(request, cloned);
}

async function getCachedWithTTL(cacheName, request, maxAgeSeconds) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (!cached) return null;
  const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0', 10);
  if (Date.now() - cachedAt > maxAgeSeconds * 1000) {
    await cache.delete(request); // sudah kedaluwarsa
    return null;
  }
  return cached;
}

// ── INSTALL ───────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_SHELL).then(async cache => {
      // Precache shell, abaikan error per-URL supaya install tidak gagal total
      await Promise.allSettled(
        SHELL_URLS.map(url =>
          cache.add(url).catch(err =>
            console.warn('[SW] Gagal precache:', url, err.message)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  const KEEP = [CACHE_SHELL, CACHE_ASSETS, CACHE_FONTS, CACHE_IMAGES];
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !KEEP.includes(k))
          .map(k => {
            console.log('[SW] Hapus cache lama:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // Abaikan request non-GET
  if (request.method !== 'GET') return;

  // ① Network-only: Supabase, drive-proxy → jangan sentuh
  if (isNetworkOnly(url)) {
    return; // biarkan browser handle langsung
  }

  // ② Google Fonts — cache-first, simpan 90 hari
  if (isGoogleFont(url)) {
    event.respondWith(
      getCachedWithTTL(CACHE_FONTS, request, 90 * 86400).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) cacheWithTTL(CACHE_FONTS, request, response.clone(), 90 * 86400);
          return response;
        });
      })
    );
    return;
  }

  // ③ Gambar (logo, qris, dll) — cache-first, simpan 7 hari
  if (isImage(url)) {
    event.respondWith(
      getCachedWithTTL(CACHE_IMAGES, request, 7 * 86400).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) cacheWithTTL(CACHE_IMAGES, request, response.clone(), 7 * 86400);
          return response;
        }).catch(() => caches.match('/offline.html'));
      })
    );
    return;
  }

  // ④ CSS/JS dengan ?v= (sudah versioned) — cache-first langsung
  if (isVersionedAsset(url)) {
    event.respondWith(
      caches.open(CACHE_ASSETS).then(async cache => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // ⑤ Halaman HTML & request lain — network-first, fallback ke cache, lalu offline
  event.respondWith(
    fetch(request)
      .then(response => {
        // Update cache dengan respon terbaru
        if (response.ok) {
          caches.open(CACHE_SHELL).then(cache => cache.put(request, response.clone()));
        }
        return response;
      })
      .catch(async () => {
        // Offline: coba cache dulu
        const cached = await caches.match(request);
        if (cached) return cached;
        // Fallback ke offline page untuk navigasi HTML
        if (request.mode === 'navigate') {
          return caches.match('/offline.html');
        }
        return new Response('Tidak ada koneksi.', { status: 503 });
      })
  );
});

// ── PUSH NOTIFICATION (opsional, sudah siap) ──────────────────────────────────

self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'Manado VIP', body: event.data.text() }; }

  const options = {
    body: data.body || '',
    icon: 'https://layarbiru.xyz/logo.png',
    badge: 'https://layarbiru.xyz/logo.png',
    data: { url: data.url || '/' },
    vibrate: [200, 100, 200]
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Manado VIP', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url === targetUrl && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
