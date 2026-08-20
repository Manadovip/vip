/* ==========================================================================
   FILE 1 / 3: core.js
   Berisi: konfigurasi (API key, Supabase, harga), fungsi bantu (cookie,
   format rupiah, cek folder gratis/berbayar, dll), sistem login pengunjung,
   dan modal profil.
   PENTING: file ini harus dimuat PERTAMA, sebelum admin.js dan app.js,
   karena keduanya memakai konstanta & fungsi yang didefinisikan di sini.
   ========================================================================== */

// Daftar sumber Google Drive. Boleh 1, boleh lebih — semua folder di dalamnya
// akan digabung jadi satu daftar di halaman utama. Tiap sumber punya API key
// sendiri (biasanya karena beda akun/project Google, atau supaya kuota API-nya
// tidak digabung jadi satu). Folder di tiap sumber wajib di-share "Anyone with
// the link" seperti biasa.
// PENTING: API key ASLI tidak lagi ditaruh di sini (supaya tidak kelihatan di
// browser pengunjung) — sekarang disimpan di server, dalam file drive-proxy.php.
// Di sini cuma ada Folder ID (memang publik) + kode "source" ('a'/'b') yang
// dipetakan ke API key yang benar oleh drive-proxy.php.
// Untuk nambah sumber lagi: tambah API key baru di drive-proxy.php dengan kode
// source baru (mis. 'c'), lalu copy satu blok { id, source, label } di bawah.
const DRIVE_SOURCES = [
  { id: "1Zz47e3-ewXqt1y3qvEgBQWnug1LLt2fA", source: "a", label: "Koleksi VIP 2" },
  { id: "1VizdRT_3gIRqGtyn8PAGfm6kH7ZPLK9E", source: "b", label: "Koleksi VIP" }
];
// URL proxy yang menyimpan API key Google Drive asli di server (lihat
// drive-proxy.php). Semua pengambilan daftar folder/video lewat sini,
// bukan langsung ke googleapis.com dari browser.
const DRIVE_PROXY_URL = "https://dwahqcqbytpczvgbzunm.supabase.co/functions/v1/drive-proxy";
// Label ini muncul sebagai judul halaman utama & label "pulang" di breadcrumb.
// Ganti teksnya di sini kapan saja tanpa perlu cari-cari di tempat lain.
const HOME_LABEL = "Koleksi VIP";
// ID khusus (bukan ID folder Drive asli) yang menandai "halaman utama" —
// tempat folder dari semua DRIVE_SOURCES digabung jadi satu daftar.
const HOME_ID = '__HOME__';
const AUTO_REFRESH_SECONDS = 0;

// Sumber yang datanya sudah lengkap diisi (bukan placeholder "GANTI...").
// Sumber yang belum diisi otomatis dilewati saat memuat folder, jadi kamu
// bisa nambah baris di DRIVE_SOURCES duluan lalu isi ID/source-nya belakangan
// tanpa bikin halaman utama error.
function validDriveSources(){
  return DRIVE_SOURCES.filter(s =>
    s.id && s.source &&
    !String(s.id).startsWith('GANTI') &&
    !String(s.source).startsWith('GANTI')
  );
}

const SUPABASE_URL = "https://dwahqcqbytpczvgbzunm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_jQ7V9lI2DcT3oSrpj0XpGw_6r7YwPHF";
const PROOF_BUCKET = 'payment-proofs';
const HEARTBEAT_SECONDS = 15;
const ONLINE_TIMEOUT_SECONDS = 60;
// PENTING: hash password admin TIDAK lagi disimpan di sini.
// Verifikasi password sekarang dilakukan di server (Supabase RPC),
// supaya orang yang buka "View Source" tidak bisa lihat/pakai hash-nya
// untuk memalsukan sesi admin. Lihat file admin-security-fix.sql.
const ADMIN_SESSION_HOURS = 2;

let sb = null;
if(!SUPABASE_URL.startsWith('GANTI') && !SUPABASE_ANON_KEY.startsWith('GANTI') && window.supabase){
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
function dbReady(){ return sb !== null; }

const PAYMENT_ENABLED = true;
const DEFAULT_PRICE = 15000;
const ALL_ACCESS_ENABLED = true;
const ALL_ACCESS_DEFAULT_PRICE = 100000; // fallback jika admin belum pernah mengubah harga ini
const ALL_ACCESS_ID = '__ALL_ACCESS__';
const ALL_ACCESS_NAME = 'Akses Semua Folder';
const FOLDER_PRICES = {

};
const FREE_FOLDER_IDS = [

];
const FACEBOOK_USERNAME = 'firaafriliaaaa';
const QRIS_IMAGE_URL = 'https://layarbiru.xyz/qris.jpg';
const QRIS_ALL_ACCESS_IMAGE_URL = 'https://layarbiru.xyz/qris-all.png';
const BANK_TRANSFER_INFO = 'Scan QR di atas menggunakan aplikasi m-banking atau e-wallet kamu untuk membayar.';

// Notifikasi Telegram sekarang lewat proxy server-side (telegram-notify-proxy.php).
// Token bot TIDAK ADA di client-side lagi — kalau URL proxy-nya beda domain,
// ganti path di bawah jadi URL lengkap, misal 'https://situskamu.com/telegram-notify-proxy.php'.
const TELEGRAM_PROXY_URL = 'https://dwahqcqbytpczvgbzunm.supabase.co/functions/v1/telegram-notify';

// Kirim notifikasi ke Telegram setiap ada bukti transfer baru masuk,
// lengkap dengan foto buktinya, supaya admin bisa langsung cek & approve
// dari HP tanpa harus buka dashboard terus-menerus.
async function notifyTelegramNewPaymentRequest(entry){
  const isAllAccess = entry.folderId === ALL_ACCESS_ID;
  try{
    await fetch(TELEGRAM_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'new_payment',
        id: entry.id,
        name: entry.name,
        folderName: entry.folderName,
        method: entry.method,
        price: entry.price,
        proofUrl: entry.proofUrl,
        isAllAccess
      })
    });
  }catch(e){
    // Gagal kirim notifikasi Telegram tidak boleh mengganggu alur pembayaran utama.
  }
}

// Kirim notifikasi Telegram saat pengguna baru masuk / pertama kali online.
// Dipanggil tepat setelah login berhasil (setelah setCookie & showUserBadge).
// Tidak mengganggu alur login walau pengiriman gagal (try-catch di dalam).
async function notifyTelegramUserOnline(name){
  if(!name || !name.trim()) return;

  // Ambil daftar siapa saja yang sedang online saat ini dari Supabase,
  // lalu sertakan di notif supaya admin langsung tahu situasinya.
  let onlineNames = [];
  try{
    const players = await fetchActivePlayers();
    if(players && typeof players === 'object'){
      const names = Object.values(players)
        .map(p => p.name ? p.name.trim() : null)
        .filter(n => n && n !== '.');
      onlineNames = [...new Set(names)]; // hapus duplikat (1 orang buka 2 tab)
    }
  }catch(e){ /* gagal ambil data online tidak masalah */ }

  try{
    await fetch(TELEGRAM_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'user_online',
        name: name.trim(),
        onlineNames
      })
    });
  }catch(e){
    // Gagal kirim notifikasi tidak boleh mengganggu proses login.
  }
}

function setCookie(name, value, hours){
  const d = new Date();
  d.setTime(d.getTime() + hours * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/`;
}
function getCookie(name){
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function getSessionId(){
  // Pakai localStorage (bukan sessionStorage) supaya session_id tetap sama
  // walau tab di-reload atau dibuka ulang di HP yang sama. Ini mencegah
  // satu pengunjung yang sama terhitung sebagai 2 "player online" berbeda
  // di dashboard admin saat browser mem-reset sessionStorage.
  let sid = localStorage.getItem('sessionId');
  if(!sid){
    sid = 'p_' + Math.random().toString(36).slice(2) + Date.now();
    localStorage.setItem('sessionId', sid);
  }
  return sid;
}

async function sendHeartbeat(name){
  if(!dbReady()) return;
  try{
    const { error } = await sb.from('active_players').upsert({
      session_id: getSessionId(),
      name,
      last_seen: new Date().toISOString()
    }, { onConflict: 'session_id' });
    if(error){
      console.warn('[sendHeartbeat] Supabase error:', error.message,
        '— Cek RLS policy INSERT/UPDATE untuk tabel active_players.');
    }
  }catch(e){
    console.warn('[sendHeartbeat] Exception:', e);
  }
}

async function fetchActivePlayers(){
  if(!dbReady()) return null;
  try{
    // Filter langsung di server: hanya ambil row yang last_seen-nya masih dalam
    // batas ONLINE_TIMEOUT_SECONDS, bukan filter manual di sisi client.
    // Ini mencegah bug di mana query berhasil tapi semua row sudah expired
    // sehingga hasilnya selalu kosong.
    const cutoff = new Date(Date.now() - ONLINE_TIMEOUT_SECONDS * 1000).toISOString();
    const { data, error } = await sb
      .from('active_players')
      .select('*')
      .gte('last_seen', cutoff);
    if(error){
      console.warn('[fetchActivePlayers] Supabase error:', error.message,
        '— Kemungkinan RLS belum diset. Jalankan SQL policy di Supabase.');
      return {};
    }
    const obj = {};
    (data || []).forEach(row => {
      obj[row.session_id] = { name: row.name, lastSeen: new Date(row.last_seen).getTime() };
    });
    return obj;
  }catch(e){
    console.warn('[fetchActivePlayers] Exception:', e);
    return {};
  }
}

let heartbeatInterval = null;
let heartbeatName = null;
function startHeartbeat(name){
  heartbeatName = name;
  sendHeartbeat(name);
  if(heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => sendHeartbeat(name), HEARTBEAT_SECONDS * 1000);
}

// Kalau tab disembunyikan (ganti aplikasi, kunci layar, minimize), hentikan
// heartbeat supaya status "online" berhenti diperbarui dan otomatis dianggap
// offline setelah ONLINE_TIMEOUT_SECONDS — bukannya nyangkut online terus
// padahal orangnya sudah tidak sedang melihat halaman ini.
document.addEventListener('visibilitychange', () => {
  if(!heartbeatName) return;
  if(document.visibilityState === 'hidden'){
    if(heartbeatInterval){ clearInterval(heartbeatInterval); heartbeatInterval = null; }
  } else if(document.visibilityState === 'visible'){
    sendHeartbeat(heartbeatName);
    if(heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => sendHeartbeat(heartbeatName), HEARTBEAT_SECONDS * 1000);
  }
});

// Kalau tab benar-benar ditutup / dinavigasi keluar, langsung hapus baris
// presence-nya dari database (bukan cuma menunggu timeout 45 detik), supaya
// status di dashboard admin lebih instan & akurat. Pakai fetch REST manual
// dengan keepalive supaya requestnya tidak dibatalkan browser saat halaman
// sedang ditutup (client supabase-js biasa tidak menjamin ini selesai terkirim).
function removeActivePlayerBeacon(){
  if(!dbReady()) return;
  try{
    const url = `${SUPABASE_URL}/rest/v1/active_players?session_id=eq.${encodeURIComponent(getSessionId())}`;
    fetch(url, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      keepalive: true
    });
  }catch(e){}
}
window.addEventListener('pagehide', removeActivePlayerBeacon);

async function fetchPaymentRequests(){
  if(!dbReady()) return null;
  try{
    const { data, error } = await sb.from('payment_requests').select('*');
    if(error) return {};
    const obj = {};
    (data || []).forEach(row => {
      obj[row.key] = {
        name: row.name,
        folderId: row.folder_id,
        folderName: row.folder_name,
        price: row.price,
        status: row.status,
        proofUrl: row.proof_url || null,
        method: row.method || null,
        requestedAt: new Date(row.requested_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
        expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null
      };
    });
    return obj;
  }catch(e){ return {}; }
}

async function upsertPaymentRequest(key, entry){
  if(!dbReady()) return null;
  try{
    const { data, error } = await sb.from('payment_requests').upsert({
      key,
      name: entry.name,
      folder_id: entry.folderId,
      folder_name: entry.folderName,
      price: entry.price,
      status: entry.status,
      proof_url: entry.proofUrl || null,
      requested_at: new Date(entry.requestedAt).toISOString(),
      updated_at: new Date(entry.updatedAt).toISOString(),
      expires_at: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null
    }, { onConflict: 'key' }).select('id').maybeSingle(); // FIX: maybeSingle() tidak error bila 0/>1 row
    if(error) return null;
    return data ? data.id : null; // dipakai sebagai referensi tombol approve/reject di Telegram
  }catch(e){ return null; }
}

async function setPaymentRequestStatus(key, status, expiresAt = undefined){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_set_payment_status', {
      input_token: token,
      input_key: key,
      input_status: status,
      input_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      input_clear_expiry: expiresAt === null
    });
    return !error && data === true;
  }catch(e){ return false; }
}

async function deletePaymentRequest(key){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_delete_payment_request', {
      input_token: token,
      input_key: key
    });
    return !error && data === true;
  }catch(e){ return false; }
}

async function deleteAllPaymentRequests(){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_delete_all_payment_requests', {
      input_token: token
    });
    if(error || data === null || data < 0) return false;
    return data;
  }catch(e){ return false; }
}

async function uploadProofImage(file, requestKeySlug){
  if(!dbReady() || !file) return null;
  try{
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${requestKeySlug}-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from(PROOF_BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false
    });
    if(error) return null;
    const { data } = sb.storage.from(PROOF_BUCKET).getPublicUrl(path);
    return data ? data.publicUrl : null;
  }catch(e){ return null; }
}

let discountPercentCache = null;
let _discountCachePromise = null;

async function fetchDiscountPercent(){
  if(!dbReady()) return 0;
  try{
    const { data, error } = await sb.from('app_settings').select('value').eq('key', 'discount_percent').maybeSingle();
    if(error || !data) return 0;
    const n = parseFloat(data.value);
    return isNaN(n) ? 0 : n;
  }catch(e){ return 0; }
}

async function ensureDiscountCache(){
  if(discountPercentCache !== null) return discountPercentCache;
  if(!_discountCachePromise) _discountCachePromise = fetchDiscountPercent();
  discountPercentCache = await _discountCachePromise;
  return discountPercentCache;
}

async function saveDiscountPercent(percent){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_set_app_setting', {
      input_token: token, input_key: 'discount_percent', input_value: String(percent)
    });
    if(!error && data === true) discountPercentCache = percent;
    return !error && data === true;
  }catch(e){ return false; }
}

// Diskon dianggap aktif kalau persennya > 0. Berlaku terus sampai admin
// mengubahnya lagi (tidak ada batas waktu / countdown).
function isDiscountActive(){
  const pct = discountPercentCache || 0;
  return pct > 0;
}

function applyDiscount(price){
  if(!isDiscountActive()) return price;
  const pct = discountPercentCache || 0;
  const discounted = Math.round(price * (1 - pct / 100));
  return discounted < 0 ? 0 : discounted;
}

// ====== "Perbarui Cache CSS/JS": bump versi aset supaya index.html (lewat
// bootstrap script di <head>) otomatis mengambil style.css/core.js/admin.js/
// app.js versi terbaru di kunjungan berikutnya, tanpa perlu admin mengubah
// "?v=..." manual di file HTML. Disimpan di app_settings key 'asset_version'.
async function fetchAssetVersion(){
  if(!dbReady()) return null;
  try{
    const { data, error } = await sb.from('app_settings').select('value').eq('key', 'asset_version').maybeSingle();
    if(error || !data) return null;
    return data.value;
  }catch(e){ return null; }
}

async function saveAssetVersion(v){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_set_app_setting', {
      input_token: token, input_key: 'asset_version', input_value: String(v)
    });
    return !error && data === true;
  }catch(e){ return false; }
}

// ====== "Hapus Cache" admin: paksa semua pengunjung logout & login ulang ======
// Disimpan sebagai timestamp (ms) di tabel app_settings (key 'force_logout_after').
// Setiap pengunjung menyimpan kapan dia login terakhir kali (cookie 'visitorLoginAt').
// Kalau force_logout_after lebih baru daripada visitorLoginAt milik pengunjung,
// berarti admin menekan "Hapus Cache" SETELAH pengunjung itu login -> paksa logout.
let forceLogoutAfterCache = null;

async function fetchForceLogoutAfter(){
  if(!dbReady()) return 0;
  try{
    const { data, error } = await sb.from('app_settings').select('value').eq('key', 'force_logout_after').maybeSingle();
    if(error || !data) return 0;
    const n = parseInt(data.value, 10);
    return isNaN(n) ? 0 : n;
  }catch(e){ return 0; }
}

async function saveForceLogoutAfter(ts){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_set_app_setting', {
      input_token: token, input_key: 'force_logout_after', input_value: String(ts)
    });
    if(!error && data === true) forceLogoutAfterCache = ts;
    return !error && data === true;
  }catch(e){ return false; }
}

// Dipanggil saat halaman dibuka & secara berkala selama pengunjung online,
// supaya kalau admin menekan "Hapus Cache" ketika pengunjung sedang aktif,
// dia langsung ter-logout tanpa perlu reload manual.
async function checkForceLogoutAndApply(){
  const currentName = getCookie('visitorName');
  if(!currentName || !dbReady()) return false;
  const forceAfter = await fetchForceLogoutAfter();
  if(!forceAfter) return false;
  // Kalau tidak ada catatan waktu login (cookie lama dari sebelum fitur ini ada),
  // anggap login-nya "sangat lama" supaya tetap ikut ter-reset juga.
  const loginAt = parseInt(getCookie('visitorLoginAt') || '0', 10);
  if(loginAt < forceAfter){
    await logoutVisitor();
    return true;
  }
  return false;
}

let forceLogoutWatchInterval = null;
function startForceLogoutWatch(){
  if(forceLogoutWatchInterval) clearInterval(forceLogoutWatchInterval);
  checkForceLogoutAndApply();
  forceLogoutWatchInterval = setInterval(checkForceLogoutAndApply, HEARTBEAT_SECONDS * 1000);
}

let folderPriceCache = null;
let _folderPriceCachePromise = null;

async function fetchFolderPrices(){
  if(!dbReady()) return {};
  try{
    const { data, error } = await sb.from('folder_prices').select('*');
    if(error) return {};
    const obj = {};
    (data || []).forEach(row => { obj[row.folder_id] = row.price; });
    return obj;
  }catch(e){ return {}; }
}

async function ensureFolderPriceCache(){
  if(folderPriceCache !== null) return folderPriceCache;
  if(!_folderPriceCachePromise) _folderPriceCachePromise = fetchFolderPrices();
  folderPriceCache = await _folderPriceCachePromise;
  return folderPriceCache;
}

async function saveFolderPrice(folderId, folderName, price){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_save_folder_price', {
      input_token: token,
      input_folder_id: folderId,
      input_folder_name: folderName,
      input_price: price
    });
    if(!error && data === true && folderPriceCache) folderPriceCache[folderId] = price;
    return !error && data === true;
  }catch(e){ return false; }
}

function requestKey(name, folderId){
  return `${name.trim().toLowerCase()}__${folderId}`;
}

// ===== Sistem Pemberitahuan (dikirim admin, muncul di lonceng semua pengguna) =====

async function fetchNotifications(){
  if(!dbReady()) return null;
  try{
    const { data, error } = await sb.from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if(error) return null;
    return data || [];
  }catch(e){ return null; }
}

async function sendNotificationDb(title, message){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_send_notification', {
      input_token: token, input_title: title, input_message: message
    });
    return !error && data === true;
  }catch(e){ return false; }
}

async function deleteNotificationDb(id){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_delete_notification', {
      input_token: token, input_id: id
    });
    return !error && data === true;
  }catch(e){ return false; }
}

// ===== Sistem Testimoni (diisi langsung oleh pengunjung, tampil ke semua orang) =====

async function fetchTestimonials(){
  if(!dbReady()) return null;
  try{
    const { data, error } = await sb.from('testimonials')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if(error) return null;
    return data || [];
  }catch(e){ return null; }
}

async function sendTestimonialDb(name, message){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('testimonials').insert({ name, message });
    return !error;
  }catch(e){ return false; }
}

async function deleteTestimonialDb(id){
  if(!dbReady()) return false;
  try{
    const token = getCookie('adminSession');
    if(!token) return false;
    const { data, error } = await sb.rpc('admin_delete_testimonial', {
      input_token: token, input_id: id
    });
    return !error && data === true;
  }catch(e){ return false; }
}

// ID pemberitahuan terakhir yang sudah dilihat pengguna ini, disimpan per browser
// supaya badge "belum dibaca" tetap akurat walau halaman di-refresh.
function getLastSeenNotifId(){
  return parseInt(localStorage.getItem('notifLastSeenId') || '0', 10);
}
function setLastSeenNotifId(id){
  localStorage.setItem('notifLastSeenId', String(id));
}

async function sha256Hex(text){
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function basePrice(folderId){
  // Kalau admin sudah pernah mengubah harga folder ini lewat dashboard,
  // dan cache-nya sudah termuat, pakai harga itu. Kalau belum termuat,
  // pakai fallback (FOLDER_PRICES / DEFAULT_PRICE) sambil cache dimuat
  // di latar belakang oleh ensureFolderPriceCache().
  if(folderPriceCache && folderPriceCache.hasOwnProperty(folderId)){
    return folderPriceCache[folderId];
  }
  if(folderId === ALL_ACCESS_ID) return ALL_ACCESS_DEFAULT_PRICE;
  return FOLDER_PRICES.hasOwnProperty(folderId) ? FOLDER_PRICES[folderId] : DEFAULT_PRICE;
}

function folderPrice(folderId){
  // Harga dasar (dari admin / fallback), lalu dipotong otomatis oleh
  // diskon global kalau admin sudah mengatur diskon di dashboard.
  // Pengecualian: paket "Akses Semua Folder" tidak pernah kena diskon.
  const price = basePrice(folderId);
  if(price === 0) return 0; // folder gratis tetap gratis, tidak perlu "didiskon"
  if(folderId === ALL_ACCESS_ID) return price;
  return applyDiscount(price);
}

function isFolderFree(folderId){
  return !PAYMENT_ENABLED || !dbReady() || FREE_FOLDER_IDS.includes(folderId) || folderPrice(folderId) === 0;
}

// Paket "Akses Semua Folder" cuma membuka folder yang SUDAH ADA pada saat
// pembelian disetujui. Folder yang dibuat SETELAH itu (folder baru) tidak
// otomatis ikut terbuka — tetap perlu dibayar terpisah per folder.
function isFolderCoveredByAllAccess(folder, allAccessEntry){
  if(!allAccessEntry || !isAccessValid(allAccessEntry)) return false;
  if(!folder || !folder.createdTime) return true;
  const approvedAt = allAccessEntry.updatedAt || allAccessEntry.requestedAt;
  return new Date(folder.createdTime).getTime() <= approvedAt;
}

// Cek apakah pengunjung (berdasarkan nama di cookie) sudah punya paket
// "bayar sekali buka semua folder" yang sudah disetujui admin.
async function hasAllAccess(){
  if(!ALL_ACCESS_ENABLED || !dbReady()) return false;
  const name = getCookie('visitorName');
  if(!name) return false;
  const requests = await fetchPaymentRequests();
  if(!requests) return false;
  const key = requestKey(name, ALL_ACCESS_ID);
  const entry = requests[key];
  return isAccessValid(entry);
}

function formatRupiah(n){
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

// Cek apakah akses sudah kadaluarsa berdasarkan expires_at.
// null/undefined = akses permanen, tidak pernah expired.
function isAccessExpired(entry){
  if(!entry || !entry.expiresAt) return false;
  return Date.now() > entry.expiresAt;
}

// Akses valid = sudah approved DAN belum kadaluarsa.
function isAccessValid(entry){
  return !!(entry && entry.status === 'approved' && !isAccessExpired(entry));
}

// Format tanggal kadaluarsa ke string pendek "DD Mon YYYY".
function formatExpiryDate(ts){
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}


// Wajib dipakai untuk SEMUA data yang berasal dari DB / input pengguna.
function escapeHtml(str){
  if(str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Menghasilkan potongan HTML harga yang otomatis menampilkan harga normal
// dicoret + harga setelah diskon + badge persen, kalau admin sedang
// mengaktifkan diskon global. Paket "Akses Semua Folder" tidak pernah
// didiskon, jadi selalu tampil harga normal saja.
function priceHtml(folderId){
  const base = basePrice(folderId);
  if(base === 0) return 'Gratis';
  const isAllAccess = folderId === ALL_ACCESS_ID;
  if(!isAllAccess && isDiscountActive()){
    const discounted = applyDiscount(base);
    const pct = discountPercentCache || 0;
    return `<span class="price-wrap"><span class="price-original">${formatRupiah(base)}</span><span class="price-discounted">${formatRupiah(discounted)}</span><span class="discount-badge">-${pct}%</span></span>`;
  }
  return `<span class="price-plain">${formatRupiah(base)}</span>`;
}

const gateOverlay = document.getElementById('gateOverlay');
const gateNameInput = document.getElementById('gateNameInput');
const gatePasswordInput = document.getElementById('gatePasswordInput');
const gateError = document.getElementById('gateError');
const gateSubmitBtn = document.getElementById('gateSubmitBtn');

const notifBellBtn = document.getElementById('notifBellBtn');
const notifBadge = document.getElementById('notifBadge');
const notifModal = document.getElementById('notifModal');
const notifCloseBtn = document.getElementById('notifCloseBtn');
const notifList = document.getElementById('notifList');
let notifPollInterval = null;
let vipBadgePollInterval = null;

const testiBtn = document.getElementById('testiBtn');
const testiModal = document.getElementById('testiModal');
const testiCloseBtn = document.getElementById('testiCloseBtn');
const testiList = document.getElementById('testiList');
const testiMessageInput = document.getElementById('testiMessageInput');
const testiError = document.getElementById('testiError');
const testiSubmitBtn = document.getElementById('testiSubmitBtn');



const profileCornerBtn = document.getElementById('profileCornerBtn');
const profileModal = document.getElementById('profileModal');
const profileNameText = document.getElementById('profileNameText');
const profileAvatar = document.getElementById('profileAvatar');
const cornerAvatarText = document.getElementById('cornerAvatarText');
const profileLogoutBtn = document.getElementById('profileLogoutBtn');
const profileCloseBtn = document.getElementById('profileCloseBtn');
const profilePaymentsList = document.getElementById('profilePaymentsList');
let profilePaymentsPollInterval = null;

const profileSecurityInfo = document.getElementById('profileSecurityInfo');
const profileSecurityForm = document.getElementById('profileSecurityForm');
const profileOldPasswordInput = document.getElementById('profileOldPasswordInput');
const profileNewPasswordInput = document.getElementById('profileNewPasswordInput');
const profileNewPasswordConfirm = document.getElementById('profileNewPasswordConfirm');
const profileSecurityError = document.getElementById('profileSecurityError');
const profileSecuritySubmitBtn = document.getElementById('profileSecuritySubmitBtn');
let profileHasPasswordCache = false;

// Warna avatar konsisten per nama, jadi tiap pengunjung punya "warna" sendiri
// yang tidak berubah-ubah tiap kali dia login lagi.
const AVATAR_COLORS = ['#FFB800', '#5fbf8e', '#6ea8e8', '#e07bb0', '#CC9200', '#7ad1c9', '#e08a5f', '#a08de8'];
function avatarColorFor(name){
  let hash = 0;
  for(let i = 0; i < name.length; i++){ hash = (hash * 31 + name.charCodeAt(i)) >>> 0; }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
function avatarInitial(name){
  const trimmed = (name || '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

// Tampilkan/sembunyikan lencana "VIP" di samping nama pengguna (modal profil)
// dan di avatar pojok kanan atas, tergantung apakah dia sudah punya paket
// "Akses Semua Folder" yang sudah disetujui admin.
async function updateVipBadge(){
  const profileVipBadge = document.getElementById('profileVipBadge');
  const cornerVipBadge = document.getElementById('cornerVipBadge');
  if(!profileVipBadge && !cornerVipBadge) return;
  const isVip = await hasAllAccess();
  if(profileVipBadge) profileVipBadge.style.display = isVip ? 'inline-flex' : 'none';
  if(cornerVipBadge) cornerVipBadge.style.display = isVip ? 'flex' : 'none';
}

function showUserBadge(name){
  profileNameText.textContent = name;
  // Tombol topbar: hanya Testimoni yang tetap di topbar
  // Profil & Notifikasi sudah dipindah ke bottom nav
  profileCornerBtn.style.display = 'none';
  if(notifBellBtn) notifBellBtn.style.display = 'none';
  if(testiBtn) testiBtn.style.display = 'flex';

  const initial = avatarInitial(name);
  const color = avatarColorFor(name.trim().toLowerCase());
  cornerAvatarText.textContent = initial;
  cornerAvatarText.style.background = color;
  profileAvatar.style.background = color;
  const profileAvatarInitial = document.getElementById('profileAvatarInitial');
  if(profileAvatarInitial) profileAvatarInitial.textContent = initial;

  // Tampilkan bottom navigation bar
  const bottomNav = document.getElementById('bottomNav');
  const bnAvatar = document.getElementById('bnAvatar');
  if(bottomNav){ bottomNav.classList.add('visible'); document.body.classList.add('has-bottom-nav'); }
  if(bnAvatar){ bnAvatar.style.background = color; }

  refreshNotifBadge();
  updateVipBadge();
  if(notifPollInterval) clearInterval(notifPollInterval);
  notifPollInterval = setInterval(refreshNotifBadge, 20000);
  if(vipBadgePollInterval) clearInterval(vipBadgePollInterval);
  vipBadgePollInterval = setInterval(updateVipBadge, 20000);
}

function hideUserBadge(){
  profileCornerBtn.style.display = 'none';
  profileModal.classList.remove('active');
  if(notifBellBtn) notifBellBtn.style.display = 'none';
  if(notifModal) notifModal.classList.remove('active');
  if(testiBtn) testiBtn.style.display = 'none';
  if(testiModal) testiModal.classList.remove('active');
  if(notifPollInterval){ clearInterval(notifPollInterval); notifPollInterval = null; }
  if(vipBadgePollInterval){ clearInterval(vipBadgePollInterval); vipBadgePollInterval = null; }

  // Sembunyikan bottom navigation bar
  const bottomNav = document.getElementById('bottomNav');
  if(bottomNav){ bottomNav.classList.remove('visible'); document.body.classList.remove('has-bottom-nav'); }
  // Sembunyikan inline sections
  ['profilSection','notifikasiSection','historySection'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.style.display = 'none';
  });
}

// Cek pemberitahuan baru & perbarui titik merah di ikon lonceng.
async function refreshNotifBadge(){
  if(!notifBadge) return;
  const list = await fetchNotifications();
  const bnNotifBadge = document.getElementById('bnNotifDot');
  if(!list || !list.length){
    notifBadge.style.display = 'none';
    if(bnNotifBadge) bnNotifBadge.style.display = 'none'; // Fix: sembunyikan badge bottom nav juga
    return;
  }
  const lastSeen = getLastSeenNotifId();
  const unreadCount = list.filter(n => n.id > lastSeen).length;
  const countStr = unreadCount > 9 ? '9+' : String(unreadCount);
  if(unreadCount > 0){
    notifBadge.textContent = countStr;
    notifBadge.style.display = 'flex';
    if(bnNotifBadge){ bnNotifBadge.textContent = countStr; bnNotifBadge.style.display = 'inline-block'; }
  } else {
    notifBadge.style.display = 'none';
    if(bnNotifBadge) bnNotifBadge.style.display = 'none';
  }
}

// Format waktu singkat untuk pemberitahuan (mis. "5 menit lalu", "2 jam lalu").
function notifTimeAgo(isoString){
  const ts = new Date(isoString).getTime();
  const s = Math.floor((Date.now() - ts) / 1000);
  if(s < 5) return 'baru saja';
  if(s < 60) return `${s} detik lalu`;
  const m = Math.floor(s / 60);
  if(m < 60) return `${m} menit lalu`;
  const h = Math.floor(m / 60);
  if(h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24);
  if(d < 7) return `${d} hari lalu`;
  // Lebih dari seminggu -> tampilkan tanggal & jam pastinya, bukan "X hari lalu".
  const dt = new Date(ts);
  const tgl = dt.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  const jam = dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return `${tgl}, ${jam}`;
}

async function renderNotifList(){
  if(!notifList) return;
  notifList.innerHTML = `<div class="profile-payments-empty">Memuat...</div>`;
  const list = await fetchNotifications();
  if(!list){
    notifList.innerHTML = `<div class="profile-payments-empty">Gagal memuat pemberitahuan.</div>`;
    return;
  }
  if(!list.length){
    notifList.innerHTML = `<div class="profile-payments-empty">Belum ada pemberitahuan.</div>`;
    return;
  }
  notifList.innerHTML = list.map(n => `
    <div class="profile-payment-item">
      <div class="profile-payment-item-top">
        <span class="ppn-name">${escapeHtml(n.title)}</span>
      </div>
      <div class="notif-message">${escapeHtml(n.message)}</div>
      <span class="ppn-price">${notifTimeAgo(n.created_at)}</span>
    </div>
  `).join('');
  // Tandai semua sudah dibaca (id terbesar) begitu daftar dibuka.
  const maxId = Math.max(...list.map(n => n.id));
  setLastSeenNotifId(maxId);
  if(notifBadge) notifBadge.style.display = 'none';
  const bnNotifBadgeRead = document.getElementById('bnNotifDot');
  if(bnNotifBadgeRead) bnNotifBadgeRead.style.display = 'none';
}

if(notifBellBtn){
  notifBellBtn.addEventListener('click', () => {
    notifModal.classList.add('active');
    renderNotifList();
  });
}
if(notifCloseBtn){
  notifCloseBtn.addEventListener('click', () => notifModal.classList.remove('active'));
}
if(notifModal){
  notifModal.addEventListener('click', (e) => {
    if(e.target === notifModal) notifModal.classList.remove('active');
  });
}

// Sensor nama pengguna sebelum ditampilkan di daftar testimoni publik
function maskName(name){
  const trimmed = (name || '').trim();
  if(!trimmed) return 'Pengguna';
  return trimmed.split(/\s+/).map(word => {
    if(word.length <= 2) return word.charAt(0) + '*'.repeat(Math.max(word.length - 1, 1));
    return word.slice(0, 2) + '*'.repeat(word.length - 2);
  }).join(' ');
}

async function renderTestiList(){
  if(!testiList) return;
  testiList.innerHTML = `<div class="profile-payments-empty">Memuat...</div>`;
  const list = await fetchTestimonials();
  if(!list){
    testiList.innerHTML = `<div class="profile-payments-empty">Gagal memuat testimoni.</div>`;
    return;
  }
  if(!list.length){
    testiList.innerHTML = `<div class="profile-payments-empty">Belum ada testimoni. Jadilah yang pertama!</div>`;
    return;
  }
  testiList.innerHTML = list.map(t => `
    <div class="profile-payment-item">
      <div class="profile-payment-item-top">
        <span class="ppn-name">${escapeHtml(maskName(t.name))}</span>
      </div>
      <div class="notif-message">${escapeHtml(t.message)}</div>
      <span class="ppn-price">${notifTimeAgo(t.created_at)}</span>
    </div>
  `).join('');
}

if(testiBtn){
  testiBtn.addEventListener('click', () => {
    testiModal.classList.add('active');
    if(testiError) testiError.textContent = '';
    renderTestiList();
  });
}
if(testiCloseBtn){
  testiCloseBtn.addEventListener('click', () => testiModal.classList.remove('active'));
}
if(testiModal){
  testiModal.addEventListener('click', (e) => {
    if(e.target === testiModal) testiModal.classList.remove('active');
  });
}
if(testiSubmitBtn){
  testiSubmitBtn.addEventListener('click', async () => {
    const message = testiMessageInput.value.trim();
    testiError.textContent = '';
    if(!message){
      testiError.textContent = 'Tulis dulu testimoni kamu.';
      return;
    }
    const name = getCookie('visitorName');
    if(!name){
      testiError.textContent = 'Kamu harus masuk dulu untuk mengirim testimoni.';
      return;
    }
    testiSubmitBtn.disabled = true;
    testiSubmitBtn.textContent = 'Mengirim...';
    const ok = await sendTestimonialDb(name.trim(), message);
    testiSubmitBtn.disabled = false;
    testiSubmitBtn.textContent = 'Kirim Testimoni';
    if(ok){
      testiMessageInput.value = '';
      renderTestiList();
    } else {
      testiError.textContent = 'Gagal mengirim testimoni. Coba lagi.';
    }
  });
}

// Label & kelas badge status untuk ditampilkan ke pengunjung sendiri
// (bahasa lebih ramah dibanding status mentah 'pending'/'approved'/'rejected').
function paymentStatusBadge(status){
  if(status === 'approved') return { text: 'Disetujui ✓', cls: 'approved' };
  if(status === 'rejected') return { text: 'Ditolak', cls: 'rejected' };
  return { text: 'Sedang di proses...', cls: 'pending' };
}

// Tampilkan daftar pembayaran milik pengunjung yang sedang login, supaya dia
// bisa cek sendiri statusnya tanpa harus tanya admin lewat Messenger dulu.
async function renderProfilePayments(){
  updateVipBadge();
  const name = getCookie('visitorName');
  if(!profilePaymentsList) return;
  if(!name || !dbReady()){
    profilePaymentsList.innerHTML = `<div class="profile-payments-empty">Belum ada data pembayaran.</div>`;
    return;
  }
  const requests = await fetchPaymentRequests();
  if(!requests){
    profilePaymentsList.innerHTML = `<div class="profile-payments-empty">Gagal memuat status pembayaran.</div>`;
    return;
  }
  const mine = Object.values(requests)
    .filter(r => r && r.name === name)
    .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));

  if(!mine.length){
    profilePaymentsList.innerHTML = `<div class="profile-payments-empty">Belum ada pembayaran yang diajukan.</div>`;
    return;
  }

  profilePaymentsList.innerHTML = mine.map(r => {
    const badge = paymentStatusBadge(r.status);
    return `
      <div class="profile-payment-item">
        <div class="profile-payment-item-top">
          <span class="ppn-name">${escapeHtml(r.folderName)}</span>
          <span class="profile-payment-badge ${badge.cls}">${badge.text}</span>
        </div>
        <span class="ppn-price">${formatRupiah(r.price)} · ${timeAgo(r.requestedAt)}</span>
      </div>
    `;
  }).join('');
}

// Cek & tampilkan status password akun pengunjung ini di tab Profil,
// supaya dia bisa BUAT password (kalau belum punya) atau UBAH password
// (kalau sudah pernah dibuat) tanpa perlu diminta password di gerbang login
// sebelum dia benar-benar mengaktifkannya sendiri.
async function renderProfileSecurity(){
  const name = getCookie('visitorName');
  if(!profileSecurityInfo) return;
  profileSecurityError.textContent = '';
  if(!name || !dbReady()){
    profileSecurityInfo.textContent = 'Supabase belum dikonfigurasi.';
    profileSecurityForm.style.display = 'none';
    return;
  }
  let hasPassword = false;
  try{
    const { data, error } = await sb.rpc('visitor_check_password', { input_username: name });
    if(!error) hasPassword = !!data;
  }catch(e){ hasPassword = false; }

  profileHasPasswordCache = hasPassword;
  profileOldPasswordInput.value = '';
  profileNewPasswordInput.value = '';
  profileNewPasswordConfirm.value = '';

  if(hasPassword){
    profileSecurityInfo.textContent = 'Password sudah diatur untuk akun ini. Kamu bisa menggantinya di bawah.';
    profileOldPasswordInput.style.display = 'block';
    profileSecuritySubmitBtn.textContent = 'Ubah Password';
  } else {
    profileSecurityInfo.textContent = 'Kamu belum membuat password. Buat sekarang supaya username ini tidak bisa dipakai orang lain.';
    profileOldPasswordInput.style.display = 'none';
    profileSecuritySubmitBtn.textContent = 'Buat Password';
  }
  profileSecurityForm.style.display = 'flex';
}

profileSecuritySubmitBtn.addEventListener('click', async () => {
  const name = getCookie('visitorName');
  if(!name || !dbReady()) return;

  const oldPassword = profileOldPasswordInput.value;
  const newPassword = profileNewPasswordInput.value;
  const confirmPassword = profileNewPasswordConfirm.value;

  if(profileHasPasswordCache && !oldPassword){
    profileSecurityError.textContent = 'Masukkan password lama kamu.';
    return;
  }
  if(newPassword.length < 4){
    profileSecurityError.textContent = 'Password baru minimal 4 karakter.';
    return;
  }
  if(newPassword !== confirmPassword){
    profileSecurityError.textContent = 'Konfirmasi password baru tidak sama.';
    return;
  }

  profileSecurityError.textContent = '';
  profileSecuritySubmitBtn.disabled = true;
  profileSecuritySubmitBtn.textContent = 'Menyimpan...';

  const newHash = await sha256Hex(newPassword);
  const oldHash = profileHasPasswordCache ? await sha256Hex(oldPassword) : null;

  let result = null;
  try{
    const { data, error } = await sb.rpc('visitor_set_password', {
      input_username: name,
      input_new_password_hash: newHash,
      input_old_password_hash: oldHash
    });
    if(!error) result = data;
  }catch(e){ result = null; }

  profileSecuritySubmitBtn.disabled = false;

  if(result === 'ok'){
    profileSecurityError.className = 'gate-error';
    profileSecurityError.style.color = '#5fbf8e';
    profileSecurityError.textContent = profileHasPasswordCache ? 'Password berhasil diganti ✓' : 'Password berhasil dibuat ✓';
    renderProfileSecurity();
  } else if(result === 'wrong_password'){
    profileSecurityError.style.color = '';
    profileSecurityError.textContent = 'Password lama salah.';
    profileSecuritySubmitBtn.textContent = 'Ubah Password';
  } else {
    profileSecurityError.style.color = '';
    profileSecurityError.textContent = 'Gagal menyimpan password. Coba lagi.';
    profileSecuritySubmitBtn.textContent = profileHasPasswordCache ? 'Ubah Password' : 'Buat Password';
  }
});

profileCornerBtn.addEventListener('click', () => {
  document.getElementById('profilSection').style.display = 'block';
  renderProfileSecurity();
});
profileCloseBtn.addEventListener('click', () => {
  if(profilePaymentsPollInterval){ clearInterval(profilePaymentsPollInterval); profilePaymentsPollInterval = null; }
});
profileLogoutBtn.addEventListener('click', () => {
  var profilSection = document.getElementById('profilSection');
  if(profilSection) profilSection.style.display = 'none';
  if(profilePaymentsPollInterval){ clearInterval(profilePaymentsPollInterval); profilePaymentsPollInterval = null; }
  logoutVisitor();
});

async function logoutVisitor(){
  if(heartbeatInterval){ clearInterval(heartbeatInterval); heartbeatInterval = null; }
  heartbeatName = null;
  if(forceLogoutWatchInterval){ clearInterval(forceLogoutWatchInterval); forceLogoutWatchInterval = null; }

  if(dbReady()){
    try{ await sb.from('active_players').delete().eq('session_id', getSessionId()); }catch(e){}
  }
  setCookie('visitorName', '', -1);
  setCookie('visitorLoginAt', '', -1);
  localStorage.removeItem('sessionId');
  hideUserBadge();
  path = [{ id: HOME_ID, name: HOME_LABEL }];
  foldersSection.style.display = 'none';
  videosSection.style.display = 'none';
  gateNameInput.value = '';
  gatePasswordInput.value = '';
  gateError.textContent = '';
  resetGateToNameStep();
  gateOverlay.style.display = 'flex';
  setTimeout(() => gateNameInput.focus(), 50);
}

const gateSubtitle = document.getElementById('gateSubtitle');
let gateAwaitingPassword = false; // true kalau sudah tahu akun ini butuh password, tinggal tunggu input password-nya

function resetGateToNameStep(){
  gateAwaitingPassword = false;
  gatePasswordInput.style.display = 'none';
  gatePasswordInput.value = '';
  gateNameInput.disabled = false;
  gateSubtitle.textContent = 'Masukkan nama kamu untuk melanjutkan.';
  gateSubmitBtn.textContent = 'Masuk';
}

async function submitName(){
  const name = gateNameInput.value.trim();

  if(!name){
    gateError.textContent = 'Nama tidak boleh kosong.';
    return;
  }
  if(name.toLowerCase() === 'admin'){
    gateError.textContent = '';
    gateOverlay.style.display = 'none';
    adminPwInput.value = '';
    adminPwError.textContent = '';
    adminPwModal.classList.add('active');
    setTimeout(() => adminPwInput.focus(), 50);
    return;
  }

  // TAHAP 1: baru masukkan nama, belum tahu apakah akun ini punya password.
  if(!gateAwaitingPassword){
    if(!dbReady()){
      // Tanpa Supabase, tidak ada cara cek password -> langsung masuk seperti dulu.
      setCookie('visitorName', name, 24 * 400);
      setCookie('visitorLoginAt', String(Date.now()), 24 * 400);
      gateOverlay.style.display = 'none';
      showUserBadge(name);
      startHeartbeat(name);
      startForceLogoutWatch();
      await sendHeartbeat(name); // pastikan data online tersimpan dulu sebelum kirim notif
      notifyTelegramUserOnline(name);
      loadCurrentFolder();
      return;
    }

    gateError.textContent = '';
    gateSubmitBtn.disabled = true;
    gateSubmitBtn.textContent = 'Memeriksa...';
    let hasPassword = false;
    try{
      const { data, error } = await sb.rpc('visitor_check_password', { input_username: name });
      if(!error) hasPassword = !!data;
    }catch(e){ hasPassword = false; }
    gateSubmitBtn.disabled = false;

    if(hasPassword){
      // Akun ini sudah pernah dibuatkan password lewat tab Profil -> minta sekarang.
      gateAwaitingPassword = true;
      gateNameInput.disabled = true;
      gatePasswordInput.style.display = 'block';
      gateSubtitle.textContent = `Akun "${name}" punya password. Masukkan untuk masuk.`;
      gateSubmitBtn.textContent = 'Masuk';
      setTimeout(() => gatePasswordInput.focus(), 50);
    } else {
      // Belum pernah bikin password -> langsung masuk seperti biasa.
      gateSubmitBtn.textContent = 'Masuk';
      setCookie('visitorName', name, 24 * 400);
      setCookie('visitorLoginAt', String(Date.now()), 24 * 400);
      gateOverlay.style.display = 'none';
      showUserBadge(name);
      startHeartbeat(name);
      startForceLogoutWatch();
      await sendHeartbeat(name); // pastikan data online tersimpan dulu sebelum kirim notif
      notifyTelegramUserOnline(name);
      loadCurrentFolder();
    }
    return;
  }

  // TAHAP 2: akun ini butuh password, verifikasi sekarang.
  const password = gatePasswordInput.value;
  if(!password){
    gateError.textContent = 'Password tidak boleh kosong.';
    return;
  }
  gateError.textContent = '';
  gateSubmitBtn.disabled = true;
  gateSubmitBtn.textContent = 'Memeriksa...';
  const passwordHash = await sha256Hex(password);
  let result = null;
  try{
    const { data, error } = await sb.rpc('visitor_verify_password', {
      input_username: name,
      input_password_hash: passwordHash
    });
    if(!error) result = data;
  }catch(e){ result = null; }
  gateSubmitBtn.disabled = false;
  gateSubmitBtn.textContent = 'Masuk';

  if(result === 'ok'){
    setCookie('visitorName', name, 24 * 400); // ~400 hari, batas maksimum browser modern
    setCookie('visitorLoginAt', String(Date.now()), 24 * 400);
    resetGateToNameStep();
    gateOverlay.style.display = 'none';
    showUserBadge(name);
    startHeartbeat(name);
    startForceLogoutWatch();
    await sendHeartbeat(name); // pastikan data online tersimpan dulu sebelum kirim notif
    notifyTelegramUserOnline(name);
    loadCurrentFolder();
  } else if(result === 'wrong_password'){
    gateError.textContent = 'Password salah, coba lagi.';
    gatePasswordInput.value = '';
    gatePasswordInput.focus();
  } else {
    gateError.textContent = 'Gagal memeriksa akun. Coba lagi.';
  }
}
gateSubmitBtn.addEventListener('click', submitName);
gateNameInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') submitName(); });
gatePasswordInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') submitName(); });

const existingVisitorName = getCookie('visitorName');
if(existingVisitorName){
  // Perpanjang lagi masa berlaku cookie setiap kali user buka halaman,
  // supaya selama user masih aktif kembali, login tidak akan pernah expired.
  setCookie('visitorName', existingVisitorName, 24 * 400);
  setCookie('visitorLoginAt', getCookie('visitorLoginAt') || '0', 24 * 400);
  gateOverlay.style.display = 'none';
  showUserBadge(existingVisitorName);
  // Cek kalau admin sudah menekan "Hapus Cache" sejak sesi login ini dibuat.
  startForceLogoutWatch();
} else {
  gateOverlay.style.display = 'flex';
  setTimeout(() => gateNameInput.focus(), 50);
}

// ===== HISTORY MODAL (Bottom Nav Tab) — tetap ada untuk keperluan lain =====
async function renderHistoryModal(){
  const listEl = document.getElementById('historyPaymentsList');
  if(!listEl) return;
  await renderHistoryInto(listEl);
}

// Render history ke element manapun (modal atau inline section)
async function renderHistoryInto(listEl){
  listEl.innerHTML = `<div class="profile-payments-empty">Memuat...</div>`;
  const name = getCookie('visitorName');
  if(!name || !dbReady()){
    listEl.innerHTML = `<div class="profile-payments-empty">Belum ada data pembayaran.</div>`;
    return;
  }
  const requests = await fetchPaymentRequests();
  if(!requests){
    listEl.innerHTML = `<div class="profile-payments-empty">Gagal memuat riwayat.</div>`;
    return;
  }
  const mine = Object.values(requests)
    .filter(function(r){ return r && r.name === name; })
    .sort(function(a,b){ return (b.requestedAt||0) - (a.requestedAt||0); });
  if(!mine.length){
    listEl.innerHTML = `<div class="profile-payments-empty">Belum ada pembayaran yang diajukan.</div>`;
    return;
  }
  listEl.innerHTML = mine.map(function(r){
    const badge = paymentStatusBadge(r.status);
    // Info durasi akses — hanya tampil kalau sudah approved
    let expiryHtml = '';
    if(r.status === 'approved'){
      if(r.expiresAt){
        const expired = Date.now() > r.expiresAt;
        const sisaHari = Math.ceil((r.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
        const tglExpiry = new Date(r.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        if(expired){
          expiryHtml = `<span class="ppn-expiry expired">⏰ Kadaluarsa ${tglExpiry}</span>`;
        } else if(sisaHari <= 7){
          expiryHtml = `<span class="ppn-expiry expiring-soon">⚠️ Sisa ${sisaHari} hari · s/d ${tglExpiry}</span>`;
        } else {
          expiryHtml = `<span class="ppn-expiry active">✓ Aktif s/d ${tglExpiry}</span>`;
        }
      } else {
        expiryHtml = `<span class="ppn-expiry permanent">♾️ Permanen</span>`;
      }
    }
    return `
      <div class="profile-payment-item">
        <div class="profile-payment-item-top">
          <span class="ppn-name">${escapeHtml(r.folderName)}</span>
          <span class="profile-payment-badge ${badge.cls}">${badge.text}</span>
        </div>
        <span class="ppn-price">${formatRupiah(r.price)} · ${timeAgo(r.requestedAt)}</span>
        ${expiryHtml}
      </div>
    `;
  }).join('');
}

// Render notif ke element manapun (modal atau inline section)
async function renderNotifInto(listEl){
  listEl.innerHTML = `<div class="profile-payments-empty">Memuat...</div>`;
  const list = await fetchNotifications();
  if(!list){
    listEl.innerHTML = `<div class="profile-payments-empty">Gagal memuat pemberitahuan.</div>`;
    return;
  }
  if(!list.length){
    listEl.innerHTML = `<div class="profile-payments-empty">Belum ada pemberitahuan.</div>`;
    return;
  }
  listEl.innerHTML = list.map(n => `
    <div class="notif-item">
      <div class="notif-item-icon">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      </div>
      <div class="notif-item-body">
        <div class="notif-item-title">${escapeHtml(n.title)}</div>
        <div class="notif-item-msg">${escapeHtml(n.message)}</div>
        <div class="notif-item-time">${notifTimeAgo(n.created_at)}</div>
      </div>
    </div>
  `).join('');
  const maxId = Math.max(...list.map(n => n.id));
  setLastSeenNotifId(maxId);
  if(notifBadge) notifBadge.style.display = 'none';
  const bnBadge = document.getElementById('bnNotifDot');
  if(bnBadge) bnBadge.style.display = 'none';
}

// Tutup historyModal saat klik di luar atau tombol close
(function(){
  var historyModal  = document.getElementById('historyModal');
  var historyCloseBtn = document.getElementById('historyCloseBtn');
  if(historyCloseBtn) historyCloseBtn.addEventListener('click', function(){ historyModal.classList.remove('active'); });
  if(historyModal)    historyModal.addEventListener('click', function(e){ if(e.target === historyModal) historyModal.classList.remove('active'); });
})();

// ===== BOTTOM NAVIGATION WIRING =====
(function(){
  var MAIN_SECTIONS = ['foldersSection','videosSection','notifikasiSection','historySection','profilSection'];

  // Tab aktif saat ini: 'dashboard' | 'notifikasi' | 'history' | 'profil'
  var currentTab = 'dashboard';

  function showSection(id){
    MAIN_SECTIONS.forEach(function(s){
      var el = document.getElementById(s);
      if(el) el.style.display = 'none';
    });
    var target = document.getElementById(id);
    if(target) target.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setBottomActive(id){
    document.querySelectorAll('.bottom-nav-item').forEach(function(btn){ btn.classList.remove('active'); });
    var el = document.getElementById(id);
    if(el) el.classList.add('active');
  }

  // Pindah ke tab dashboard tanpa push history (dipakai saat popstate)
  function goToDashboardSilent(){
    currentTab = 'dashboard';
    setBottomActive('bnDashboard');
    ['notifikasiSection','historySection','profilSection'].forEach(function(s){
      var el = document.getElementById(s);
      if(el) el.style.display = 'none';
    });
    // Tampilkan kembali section folder/video yang relevan
    var foldersEl = document.getElementById('foldersSection');
    var videosEl  = document.getElementById('videosSection');
    if(foldersEl && foldersEl.innerHTML.trim() !== '') foldersEl.style.display = 'block';
    else if(videosEl) videosEl.style.display = 'block';
  }

  // Saat tombol back ditekan dan state menunjuk ke tab non-dashboard,
  // kembali ke dashboard tanpa benar-benar menavigasi keluar.
  window.addEventListener('popstate', function(e){
    if(e.state && e.state._bnTab && e.state._bnTab !== 'dashboard'){
      // popstate ini dari tab non-dashboard — cukup kembali ke dashboard
      goToDashboardSilent();
    }
    // Jika state tidak punya _bnTab, biarkan handler popstate di app.js
    // yang menangani navigasi folder seperti biasa.
  });

  var bnDashboard  = document.getElementById('bnDashboard');
  var bnNotifikasi = document.getElementById('bnNotifikasi');
  var bnHistory    = document.getElementById('bnHistory');
  var bnProfil     = document.getElementById('bnProfil');

  // Dashboard — kembali ke folder utama
  if(bnDashboard){
    bnDashboard.addEventListener('click', function(){
      currentTab = 'dashboard';
      setBottomActive('bnDashboard');
      var brandBtn = document.getElementById('brandHomeBtn');
      if(brandBtn) brandBtn.click();
      // Sembunyikan section inline kalau sedang terbuka
      ['notifikasiSection','historySection','profilSection'].forEach(function(s){
        var el = document.getElementById(s);
        if(el) el.style.display = 'none';
      });
    });
  }

  // Notifikasi — tampil inline di main
  if(bnNotifikasi){
    bnNotifikasi.addEventListener('click', function(){
      if(currentTab !== 'notifikasi'){
        history.pushState({ _bnTab: 'notifikasi' }, '');
        currentTab = 'notifikasi';
      }
      setBottomActive('bnNotifikasi');
      showSection('notifikasiSection');
      var inlineList = document.getElementById('inlineNotifList');
      if(inlineList) renderNotifInto(inlineList);
    });
  }

  // History — tampil inline di main
  if(bnHistory){
    bnHistory.addEventListener('click', function(){
      if(currentTab !== 'history'){
        history.pushState({ _bnTab: 'history' }, '');
        currentTab = 'history';
      }
      setBottomActive('bnHistory');
      showSection('historySection');
      var inlineList = document.getElementById('inlineHistoryList');
      if(inlineList) renderHistoryInto(inlineList);
    });
  }

  // Profil — tampil inline di main
  if(bnProfil){
    bnProfil.addEventListener('click', function(){
      if(currentTab !== 'profil'){
        history.pushState({ _bnTab: 'profil' }, '');
        currentTab = 'profil';
      }
      setBottomActive('bnProfil');
      showSection('profilSection');
      renderProfileSecurity();
    });
  }
})();
/* ==========================================================================
   FILE 2 / 3: admin.js
   Berisi: dashboard admin (player online, permintaan pembayaran, atur
   harga & diskon), login admin, dan beberapa fungsi bantu terkait folder.
   PENTING: file ini harus dimuat SETELAH core.js dan SEBELUM app.js.
   ========================================================================== */

function requestFolderAccess(folder){
  path = [...path, { id: folder.id, name: folder.name, createdTime: folder.createdTime, source: folder.source }];
  loadCurrentFolder();
}

const adminPwModal = document.getElementById('adminPwModal');
const adminPwInput = document.getElementById('adminPwInput');
const adminPwError = document.getElementById('adminPwError');
const adminPwSubmitBtn = document.getElementById('adminPwSubmitBtn');
const adminDashboard = document.getElementById('adminDashboard');
const adminPlayerList = document.getElementById('adminPlayerList');
const adminStatusText = document.getElementById('adminStatusText');
const adminLogoutBtn = document.getElementById('adminLogoutBtn');
const adminRequestsList = document.getElementById('adminRequestsList');
const adminRequestsStatusText = document.getElementById('adminRequestsStatusText');
const statOnlineNum = document.getElementById('statOnlineNum');
const statPendingNum = document.getElementById('statPendingNum');
const statPendingChip = document.getElementById('statPendingChip');
const reqSubtabs = document.getElementById('reqSubtabs');
const reqPendingBadge = document.getElementById('reqPendingBadge');
const reqSearchInput = document.getElementById('reqSearchInput');
let reqFilter = 'pending';
let reqSearchTerm = '';
let adminPollInterval = null;

function timeAgo(ts){
  const s = Math.floor((Date.now() - ts) / 1000);
  if(s < 5) return 'baru saja';
  if(s < 60) return `${s} detik lalu`;
  const m = Math.floor(s / 60);
  if(m < 60) return `${m} menit lalu`;
  const h = Math.floor(m / 60);
  if(h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24);
  if(d < 7) return `${d} hari lalu`;
  // Lebih dari seminggu -> tampilkan tanggal & jam pastinya, bukan "X hari lalu".
  const dt = new Date(ts);
  const tgl = dt.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  const jam = dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return `${tgl}, ${jam}`;
}

let onlinePlayersCache = [];

function folderOptionsHtml(){
  let opts = '<option value="">Pilih folder untuk dibuka...</option>';
  if(ALL_ACCESS_ENABLED){
    opts += `<option value="${ALL_ACCESS_ID}">🔓 ${ALL_ACCESS_NAME}</option>`;
  }
  (allDriveFoldersCache || []).forEach(f => {
    opts += `<option value="${f.id}">${f.name}</option>`;
  });
  return opts;
}

async function renderAdminDashboard(){
  const data = await fetchActivePlayers();
  if(data === null){
    adminStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminPlayerList.innerHTML = '';
    return;
  }
  // fetchActivePlayers sudah memfilter berdasarkan last_seen >= cutoff di server,
  // jadi semua entry di sini dijamin masih aktif — tidak perlu filter ulang di client.
  // Dedupe berdasarkan nama: kalau ada beberapa session_id untuk nama yang sama
  // (misalnya karena localStorage sempat ke-reset di HP pengunjung), cuma
  // tampilkan satu entri per nama, yaitu yang lastSeen-nya paling baru.
  const latestByName = new Map();
  let online = Object.values(data);
  online.forEach(p => {
    const existing = latestByName.get(p.name);
    if(!existing || p.lastSeen > existing.lastSeen){
      latestByName.set(p.name, p);
    }
  });
  online = Array.from(latestByName.values());
  online.sort((a, b) => b.lastSeen - a.lastSeen);
  onlinePlayersCache = online;
  adminStatusText.textContent = `${online.length} player sedang online`;
  if(statOnlineNum) statOnlineNum.textContent = online.length;
  if(!online.length){
    adminPlayerList.innerHTML = `<div style="color:var(--text-dim); font-size:13px;">Belum ada player online.</div>`;
    return;
  }
  // Folder mungkin belum pernah dimuat kalau admin belum buka bagian "Harga Akses".
  if(allDriveFoldersCache === null){
    allDriveFoldersCache = await fetchAllDriveFoldersRecursive(validDriveSources());
  }
  const optionsHtml = folderOptionsHtml();
  adminPlayerList.innerHTML = online.map((p, i) => `
    <div class="player-item">
      <div class="player-item-top">
        <span class="pname"><span class="pdot"></span>${escapeHtml(p.name)}</span>
        <span class="ptime">${timeAgo(p.lastSeen)}</span>
      </div>
      <div class="player-grant-row">
        <select class="player-folder-select" data-idx="${i}">${optionsHtml}</select>
        <select class="player-duration-select duration-select" data-idx="${i}">
          ${DURATION_OPTIONS.map(o => `<option value="${o.days}"${o.days===30?' selected':''}>${o.label}</option>`).join('')}
        </select>
        <button class="player-grant-btn" data-action="grant-access" data-idx="${i}">Buka Akses</button>
      </div>
    </div>
  `).join('');
}

// Admin membuka akses folder tertentu untuk pengunjung yang sedang online,
// tanpa perlu pengunjung mengirim bukti transfer sama sekali.
async function grantFolderAccess(player, folderId, btn, durationDays = 0){
  const isAllAccess = folderId === ALL_ACCESS_ID;
  const folderName = isAllAccess
    ? ALL_ACCESS_NAME
    : ((allDriveFoldersCache || []).find(f => f.id === folderId)?.name || 'Folder');
  const durationLabel = DURATION_OPTIONS.find(o => o.days === durationDays)?.label || 'Permanen';
  if(!confirm(`Buka akses "${folderName}" untuk ${player.name} (${durationLabel}), tanpa bukti transfer?`)) return;

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Membuka...';

  const expiresAt = computeExpiresAt(durationDays);
  const key = requestKey(player.name, folderId);
  const token = getCookie('adminSession');
  let ok = false;
  if(token && dbReady()){
    try{
      const { data, error } = await sb.rpc('admin_grant_access', {
        input_token: token,
        input_key: key,
        input_name: player.name,
        input_folder_id: folderId,
        input_folder_name: folderName,
        input_price: folderPrice(folderId),
        input_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null
      });
      ok = !error && data !== null;
    }catch(e){ ok = false; }
  }

  btn.disabled = false;
  btn.textContent = originalLabel;

  if(ok){
    adminRequestsStatusText.textContent = `Akses "${folderName}" untuk ${player.name} berhasil dibuka ✓`;
    renderAdminRequests();
  } else {
    alert('Gagal membuka akses. Coba lagi.');
  }
}

adminPlayerList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="grant-access"]');
  if(!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  const player = onlinePlayersCache[idx];
  if(!player) return;
  const row = btn.closest('.player-item');
  const select = row.querySelector('.player-folder-select');
  const folderId = select.value;
  if(!folderId){ select.focus(); return; }
  const durationSel = row.querySelector('.player-duration-select');
  const days = durationSel ? parseInt(durationSel.value, 10) : 0;
  grantFolderAccess(player, folderId, btn, days);
});

/* ====== ADMIN: PERMINTAAN PEMBAYARAN ====== */
async function renderAdminRequests(){
  const data = await fetchPaymentRequests();
  if(data === null){
    adminRequestsStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminRequestsList.innerHTML = '';
    return;
  }
  const entries = Object.entries(data).map(([key, v]) => ({ key, ...v }));
  const term = (reqSearchTerm || '').trim().toLowerCase();
  const matchesTerm = e => !term || (e.name||'').toLowerCase().includes(term) || (e.folderName||'').toLowerCase().includes(term);

  const pendingAll = entries.filter(e => e.status === 'pending').sort((a,b) => b.requestedAt - a.requestedAt);
  const historyAll = entries.filter(e => e.status !== 'pending').sort((a,b) => (b.updatedAt||b.requestedAt) - (a.updatedAt||a.requestedAt));

  // Update badge/chip global (selalu berdasarkan jumlah pending sesungguhnya, bukan hasil filter pencarian)
  updateAdminTabBadge('requests', pendingAll.length);
  if(reqPendingBadge){
    if(pendingAll.length > 0){
      reqPendingBadge.style.display = 'inline-flex';
      reqPendingBadge.textContent = pendingAll.length;
    } else {
      reqPendingBadge.style.display = 'none';
    }
  }
  if(statPendingNum) statPendingNum.textContent = pendingAll.length;
  if(statPendingChip) statPendingChip.classList.toggle('zero', pendingAll.length === 0);

  const pending = pendingAll.filter(matchesTerm);
  const history = historyAll.filter(matchesTerm).slice(0, 30);
  const ordered = reqFilter === 'pending' ? pending : history;

  if(reqFilter === 'pending'){
    adminRequestsStatusText.textContent = term
      ? `${pending.length} dari ${pendingAll.length} permintaan pending cocok dengan "${term}"`
      : `${pendingAll.length} permintaan menunggu konfirmasi`;
  } else {
    adminRequestsStatusText.textContent = term
      ? `Menampilkan ${history.length} riwayat cocok dengan "${term}"`
      : `Menampilkan ${history.length} riwayat terakhir`;
  }

  if(!ordered.length){
    const emptyMsg = reqFilter === 'pending'
      ? (term ? 'Tidak ada permintaan pending yang cocok.' : 'Belum ada permintaan pembayaran.')
      : (term ? 'Tidak ada riwayat yang cocok.' : 'Belum ada riwayat.');
    adminRequestsList.innerHTML = `<div class="req-empty">${emptyMsg}</div>`;
    return;
  }

  adminRequestsList.innerHTML = ordered.map(e => {
    const safeProofUrl = e.proofUrl && e.proofUrl.startsWith('https://') ? e.proofUrl : null;
    const proofHtml = safeProofUrl
      ? `<a href="${escapeHtml(safeProofUrl)}" target="_blank" rel="noopener" class="rproof"><img src="${escapeHtml(safeProofUrl)}" alt="Bukti transfer" loading="lazy"></a>`
      : `<div class="rproof rproof-missing">Tanpa foto</div>`;

    if(e.status === 'pending'){
      const planDays = getPlanDefaultDays(e.method);
      const planBadge = e.method
        ? `<span class="plan-badge-admin">${e.method.includes('1 Bulan') ? '📅 1 Bulan' : e.method.includes('Permanen') ? '♾️ Permanen' : escapeHtml(e.method)}</span>`
        : '';
      const actionsHtml = `<div class="ractions ractions-pending">
            ${planBadge}
            ${durationSelectHtml('dur-' + escapeHtml(e.key), planDays)}
            <button class="rbtn approve" data-action="approve" data-key="${escapeHtml(e.key)}">✓ Setujui</button>
            <button class="rbtn reject" data-action="reject" data-key="${escapeHtml(e.key)}">✕ Tolak</button>
            <button class="rbtn delete icon-only" data-action="delete" data-key="${escapeHtml(e.key)}" title="Hapus" aria-label="Hapus">🗑</button>
           </div>`;
      return `
        <div class="request-item pending">
          <div class="req-top">
            ${proofHtml}
            <div class="rinfo">
              <div class="rname-row">
                <span class="rname">${escapeHtml(e.name)}</span>
                <span class="ramount">${formatRupiah(e.price)}</span>
              </div>
              <div class="rfolder">${escapeHtml(e.folderName)}${e.method ? ` · <span style="color:var(--amber);">${escapeHtml(e.method)}</span>` : ''}</div>
              <div class="rtime">${timeAgo(e.requestedAt)}</div>
            </div>
          </div>
          ${actionsHtml}
        </div>`;
    }

    const badgeHtml = e.status === 'approved'
      ? `<span class="rbadge approved">Disetujui</span>`
      : `<span class="rbadge rejected">Ditolak</span>`;
    return `
      <div class="request-item history ${e.status}">
        ${proofHtml}
        <div class="rinfo">
          <div class="rname">${escapeHtml(e.name)}</div>
          <div class="rfolder">${escapeHtml(e.folderName)} · ${formatRupiah(e.price)}${e.method ? ` · ${escapeHtml(e.method)}` : ''}</div>
          <div class="rtime">${timeAgo(e.updatedAt || e.requestedAt)}</div>
          ${e.expiresAt
            ? `<div class="rexpiry ${Date.now() > e.expiresAt ? 'expired' : 'active'}">
                ⏰ ${Date.now() > e.expiresAt ? 'Kadaluarsa' : 'Aktif s/d'}: ${new Date(e.expiresAt).toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})}
               </div>`
            : `<div class="rexpiry permanent">Permanen</div>`
          }
        </div>
        <div class="ractions">
          ${badgeHtml}
          <button class="rbtn delete icon-only" data-action="delete" data-key="${escapeHtml(e.key)}" title="Hapus riwayat" aria-label="Hapus riwayat">🗑</button>
        </div>
      </div>`;
  }).join('');
}

if(reqSubtabs){
  reqSubtabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.req-subtab-btn');
    if(!btn) return;
    reqFilter = btn.dataset.filter;
    reqSubtabs.querySelectorAll('.req-subtab-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderAdminRequests();
  });
}
if(reqSearchInput){
  reqSearchInput.addEventListener('input', () => {
    reqSearchTerm = reqSearchInput.value;
    renderAdminRequests();
  });
}

// ===== AKSES BERBATAS WAKTU =====
const DURATION_OPTIONS = [
  { days: 0,  label: 'Permanen' },
  { days: 7,  label: '7 hari'   },
  { days: 30, label: '30 hari'  },
  { days: 60, label: '60 hari'  },
  { days: 90, label: '90 hari'  },
];
function durationSelectHtml(name, defaultDays = 0){
  return `<select class="duration-select" name="${name}">
    ${DURATION_OPTIONS.map(o =>
      `<option value="${o.days}"${o.days === defaultDays ? ' selected' : ''}>${o.label}</option>`
    ).join('')}
  </select>`;
}
function computeExpiresAt(days){
  if(!days || days <= 0) return null;
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

// Baca plan default dari label method (misal "QRIS · 1 Bulan" → 30 hari)
function getPlanDefaultDays(method){
  if(!method) return 0;
  if(method.includes('1 Bulan')) return 30;
  if(method.includes('Permanen')) return 0;
  return 0;
}

async function updateRequestStatus(key, status, expiresAt = null){
  await setPaymentRequestStatus(key, status, expiresAt);
  renderAdminRequests();
}

async function removeRequest(key){
  if(!confirm('Hapus riwayat permintaan pembayaran ini? Tindakan ini tidak bisa dibatalkan.')) return;
  const ok = await deletePaymentRequest(key);
  if(!ok){
    alert('Gagal menghapus. Kemungkinan besar policy "delete" untuk tabel payment_requests belum diaktifkan di Supabase. Lihat catatan di bagian atas script.js untuk SQL perbaikannya.');
    return;
  }
  renderAdminRequests();
}

async function removeAllRequests(){
  if(!confirm('Hapus SEMUA riwayat permintaan pembayaran (termasuk yang masih pending)? Tindakan ini tidak bisa dibatalkan.')) return;
  const result = await deleteAllPaymentRequests();
  if(result === false){
    alert('Gagal menghapus. Kemungkinan besar policy "delete" untuk tabel payment_requests belum diaktifkan di Supabase. Lihat catatan di bagian atas script.js untuk SQL perbaikannya.');
    return;
  }
  renderAdminRequests();
}

adminRequestsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.rbtn');
  if(!btn) return;
  const key = btn.dataset.key;
  const action = btn.dataset.action;
  if(action === 'delete'){
    removeRequest(key);
  } else if(action === 'approve'){
    const row = btn.closest('.request-item');
    const sel = row ? row.querySelector('.duration-select') : null;
    const days = sel ? parseInt(sel.value, 10) : 0;
    updateRequestStatus(key, 'approved', computeExpiresAt(days));
  } else if(action === 'reject'){
    updateRequestStatus(key, 'rejected', null);
  }
});

const adminRequestsDeleteAllBtn = document.getElementById('adminRequestsDeleteAllBtn');
if(adminRequestsDeleteAllBtn){
  adminRequestsDeleteAllBtn.addEventListener('click', removeAllRequests);
}

const adminPricesRefreshBtn = document.getElementById('adminPricesRefreshBtn');
adminPricesRefreshBtn.addEventListener('click', () => renderAdminPrices(true));

const adminPricesList = document.getElementById('adminPricesList');
const adminPricesStatusText = document.getElementById('adminPricesStatusText');
const adminAllAccessPriceWrap = document.getElementById('adminAllAccessPriceWrap');

const adminDiscountWrap = document.getElementById('adminDiscountWrap');

function renderAdminDiscount(){
  if(!adminDiscountWrap) return;
  const pct = discountPercentCache || 0;
  const statusHtml = pct > 0
    ? `<span class="pfree">Diskon ${pct}% sedang aktif untuk semua folder berbayar (berlaku terus sampai diubah manual).</span>`
    : '';
  adminDiscountWrap.innerHTML = `
    <div class="price-item all-access-item" data-action-wrap="discount">
      <div class="pname">Diskon Semua Harga <span class="pfree">(otomatis potong harga tiap folder, tidak berlaku untuk "Akses Semua Folder")</span></div>
      <div class="pinput-row">
        <input type="number" class="pinput" id="adminDiscountInput" min="0" max="100" step="1" value="${pct}">
        <span class="pprefix">%</span>
        <button class="pbtn" id="adminDiscountSaveBtn">Simpan</button>
      </div>
      <span class="psaved" id="adminDiscountSaved" style="display:none;">Tersimpan ✓</span>
      ${statusHtml ? `<div style="margin-top:8px;">${statusHtml}</div>` : ''}
    </div>`;
  const saveBtn = document.getElementById('adminDiscountSaveBtn');
  const input = document.getElementById('adminDiscountInput');
  if(saveBtn){
    saveBtn.addEventListener('click', async () => {
      const value = parseFloat(input.value);
      if(isNaN(value) || value < 0 || value > 100){
        input.focus();
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Menyimpan...';
      const ok = await saveDiscountPercent(value);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Simpan';
      if(ok){
        adminPricesStatusText.textContent = value > 0
          ? `Diskon ${value}% tersimpan dan langsung diterapkan ke semua harga ✓`
          : 'Diskon dinonaktifkan ✓';
        renderAdminPrices(false);
        renderAdminDiscount();
      } else {
        adminPricesStatusText.textContent = 'Gagal menyimpan diskon. Coba lagi.';
      }
    });
  }
}

function renderAdminAllAccessPrice(){
  if(!adminAllAccessPriceWrap) return;
  const original = basePrice(ALL_ACCESS_ID);
  adminAllAccessPriceWrap.innerHTML = `
    <div class="price-item all-access-item" data-folder-id="${ALL_ACCESS_ID}" data-folder-name="${ALL_ACCESS_NAME}">
      <div class="pname">${ALL_ACCESS_NAME} <span class="pfree">(bayar sekali, buka semua folder berbayar &middot; tidak terkena diskon)</span></div>
      <div class="pinput-row">
        <span class="pprefix">Rp</span>
        <input type="number" class="pinput" min="0" step="1000" value="${original}">
        <button class="pbtn" data-action="save-price">Simpan</button>
      </div>
      <span class="psaved" style="display:none;">Tersimpan ✓</span>
    </div>`;
}

if(adminAllAccessPriceWrap){
  adminAllAccessPriceWrap.addEventListener('click', async (e) => {
    const btn = e.target.closest('.pbtn[data-action="save-price"]');
    if(!btn) return;
    const item = btn.closest('.price-item');
    const folderId = item.dataset.folderId;
    const folderName = item.dataset.folderName;
    const input = item.querySelector('.pinput');
    const price = parseInt(input.value, 10);
    if(isNaN(price) || price < 0){
      input.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Menyimpan...';
    const ok = await saveFolderPrice(folderId, folderName, price);
    if(ok){
      btn.textContent = 'Simpan';
      btn.disabled = false;
      adminPricesStatusText.textContent = 'Harga akses semua folder tersimpan ✓';
    } else {
      btn.disabled = false;
      btn.textContent = 'Simpan';
      adminPricesStatusText.textContent = 'Gagal menyimpan harga. Coba lagi.';
    }
  });
}

// roots: array of { id, source } — biasanya langsung DRIVE_SOURCES (bisa lebih
// dari satu sumber). Tiap subfolder yang ditemukan mewarisi kode source dari
// induknya, jadi hasilnya tetap query lewat proxy yang benar sampai ke folder
// paling dalam. Lewat drive-proxy.php (bukan langsung googleapis.com) supaya
// API key Google Drive tidak pernah kelihatan di dashboard admin.
async function fetchAllDriveFoldersRecursive(roots){
  const result = [];
  const queue = roots.map(r => ({ id: r.id, source: r.source }));
  const seen = new Set();
  while(queue.length){
    const { id: parentId, source } = queue.shift();
    if(seen.has(parentId)) continue;
    seen.add(parentId);
    const url = `${DRIVE_PROXY_URL}?source=${encodeURIComponent(source)}&parentId=${encodeURIComponent(parentId)}&mode=folders`;
    try{
      const res = await fetch(url);
      const data = await res.json();
      const folders = data.files || [];
      folders.forEach(f => {
        result.push({ ...f, source });
        queue.push({ id: f.id, source });
      });
    }catch(e){  }
  }
  return result;
}

let allDriveFoldersCache = null;

async function renderAdminPrices(forceReload){
  if(!dbReady()){
    adminPricesStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminPricesList.innerHTML = '';
    return;
  }
  if(forceReload || allDriveFoldersCache === null){
    adminPricesStatusText.textContent = 'Memuat daftar folder dari Google Drive...';
    adminPricesList.innerHTML = '';
    allDriveFoldersCache = await fetchAllDriveFoldersRecursive(validDriveSources());
  }
  await Promise.all([ensureFolderPriceCache(), ensureDiscountCache()]);
  renderAdminDiscount();
  renderAdminAllAccessPrice();

  if(!allDriveFoldersCache.length){
    adminPricesStatusText.textContent = 'Tidak ada folder ditemukan di Google Drive.';
    adminPricesList.innerHTML = '';
    return;
  }

  const pct = discountPercentCache || 0;
  const discountLive = isDiscountActive();
  adminPricesStatusText.textContent = discountLive
    ? `${allDriveFoldersCache.length} folder ditemukan. Diskon ${pct}% sedang aktif, harga di bawah sudah termasuk potongan. Set harga ke 0 untuk membuat folder gratis.`
    : `${allDriveFoldersCache.length} folder ditemukan. Set harga ke 0 untuk membuat folder gratis. Ubah harga lalu tekan Simpan.`;
  adminPricesList.innerHTML = allDriveFoldersCache.map(f => {
    const original = basePrice(f.id);
    const price = folderPrice(f.id);
    const hardcodedFree = FREE_FOLDER_IDS.includes(f.id);
    const isFreeNow = hardcodedFree || original === 0;
    const discountBadge = (discountLive && !isFreeNow)
      ? ` <span class="pfree">(harga asli ${formatRupiah(original)}, setelah diskon ${formatRupiah(price)})</span>`
      : '';
    return `
      <div class="price-item" data-folder-id="${f.id}" data-folder-name="${f.name.replace(/"/g,'&quot;')}">
        <div class="pname" title="${f.name}">${f.name}${isFreeNow ? ' <span class="pfree">(gratis)</span>' : discountBadge}</div>
        <div class="pinput-row">
          <span class="pprefix">Rp</span>
          <input type="number" class="pinput" min="0" step="1000" value="${original}" ${hardcodedFree ? 'disabled' : ''}>
          <button class="pbtn" data-action="save-price" ${hardcodedFree ? 'disabled' : ''}>Simpan</button>
        </div>
        <span class="psaved" style="display:none;">Tersimpan ✓</span>
      </div>`;
  }).join('');
}

adminPricesList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pbtn[data-action="save-price"]');
  if(!btn) return;
  const item = btn.closest('.price-item');
  const folderId = item.dataset.folderId;
  const folderName = item.dataset.folderName;
  const input = item.querySelector('.pinput');
  const price = parseInt(input.value, 10);
  if(isNaN(price) || price < 0){
    input.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  const ok = await saveFolderPrice(folderId, folderName, price);
  if(ok){
    adminPricesStatusText.textContent = 'Tersimpan ✓';
    renderAdminPrices(false);
  } else {
    btn.disabled = false;
    btn.textContent = 'Simpan';
    adminPricesStatusText.textContent = 'Gagal menyimpan harga. Coba lagi.';
  }
});

function openAdminDashboard(){
  adminPwModal.classList.remove('active');
  gateOverlay.style.display = 'none';
  adminDashboard.style.display = 'flex';
  initAdminTabsOnce();
  renderAdminDashboard();
  renderAdminRequests();
  renderAdminPrices();
  renderAdminNotifications();
  renderAdminTestimonials();
  renderAssetVersionStatus();
  if(adminPollInterval) clearInterval(adminPollInterval);
  adminPollInterval = setInterval(() => { renderAdminDashboard(); renderAdminRequests(); }, 5000);
}

// ===== Tab Notifikasi: kirim pemberitahuan baru & kelola riwayat =====
const adminNotifTitleInput = document.getElementById('adminNotifTitleInput');
const adminNotifMessageInput = document.getElementById('adminNotifMessageInput');
const adminNotifError = document.getElementById('adminNotifError');
const adminNotifSendBtn = document.getElementById('adminNotifSendBtn');
const adminNotifStatusText = document.getElementById('adminNotifStatusText');
const adminNotifList = document.getElementById('adminNotifList');
const adminNotifRefreshBtn = document.getElementById('adminNotifRefreshBtn');

async function renderAdminNotifications(){
  if(!dbReady()){
    adminNotifStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminNotifList.innerHTML = '';
    return;
  }
  adminNotifStatusText.textContent = 'Memuat...';
  const list = await fetchNotifications();
  if(!list){
    adminNotifStatusText.textContent = 'Gagal memuat riwayat pemberitahuan.';
    adminNotifList.innerHTML = '';
    return;
  }
  if(!list.length){
    adminNotifStatusText.textContent = 'Belum ada pemberitahuan yang dikirim.';
    adminNotifList.innerHTML = '';
    return;
  }
  adminNotifStatusText.textContent = `${list.length} pemberitahuan terkirim.`;
  adminNotifList.innerHTML = list.map(n => `
    <div class="player-item" data-notif-id="${n.id}">
      <div class="player-item-top">
        <span class="pname">${escapeHtml(n.title)}</span>
        <button class="pbtn-refresh pbtn-danger notif-delete-btn" data-notif-id="${n.id}" title="Hapus pemberitahuan ini">Hapus</button>
      </div>
      <div class="notif-message" style="margin:6px 0;">${escapeHtml(n.message)}</div>
      <span style="color:var(--text-dim); font-size:11px;">${timeAgo(new Date(n.created_at).getTime())}</span>
    </div>
  `).join('');
}

adminNotifSendBtn.addEventListener('click', async () => {
  const title = adminNotifTitleInput.value.trim();
  const message = adminNotifMessageInput.value.trim();
  adminNotifError.textContent = '';
  if(!title || !message){
    adminNotifError.textContent = 'Judul dan isi pesan tidak boleh kosong.';
    return;
  }
  adminNotifSendBtn.disabled = true;
  adminNotifSendBtn.textContent = 'Mengirim...';
  const ok = await sendNotificationDb(title, message);
  adminNotifSendBtn.disabled = false;
  adminNotifSendBtn.textContent = 'Kirim Pemberitahuan';
  if(ok){
    adminNotifTitleInput.value = '';
    adminNotifMessageInput.value = '';
    renderAdminNotifications();
  } else {
    adminNotifError.textContent = 'Gagal mengirim pemberitahuan. Coba lagi.';
  }
});

adminNotifRefreshBtn.addEventListener('click', () => renderAdminNotifications());

adminNotifList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.notif-delete-btn');
  if(!btn) return;
  const id = btn.dataset.notifId;
  if(!confirm('Hapus pemberitahuan ini? Pengguna yang belum sempat membaca tidak akan melihatnya lagi.')) return;
  btn.disabled = true;
  btn.textContent = 'Menghapus...';
  const ok = await deleteNotificationDb(id);
  if(ok){
    renderAdminNotifications();
  } else {
    btn.disabled = false;
    btn.textContent = 'Hapus';
  }
});

// ===== Tab Testimoni: moderasi testimoni yang dikirim pengguna =====
const adminTestiStatusText = document.getElementById('adminTestiStatusText');
const adminTestiList = document.getElementById('adminTestiList');
const adminTestiRefreshBtn = document.getElementById('adminTestiRefreshBtn');

async function renderAdminTestimonials(){
  if(!adminTestiList) return;
  if(!dbReady()){
    adminTestiStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminTestiList.innerHTML = '';
    return;
  }
  adminTestiStatusText.textContent = 'Memuat...';
  const list = await fetchTestimonials();
  if(!list){
    adminTestiStatusText.textContent = 'Gagal memuat testimoni.';
    adminTestiList.innerHTML = '';
    return;
  }
  if(!list.length){
    adminTestiStatusText.textContent = 'Belum ada testimoni dari pengguna.';
    adminTestiList.innerHTML = '';
    return;
  }
  adminTestiStatusText.textContent = `${list.length} testimoni.`;
  adminTestiList.innerHTML = list.map(t => `
    <div class="player-item" data-testi-id="${t.id}">
      <div class="player-item-top">
        <span class="pname">${escapeHtml(t.name)}</span>
        <button class="pbtn-refresh pbtn-danger testi-delete-btn" data-testi-id="${t.id}" title="Hapus testimoni ini">Hapus</button>
      </div>
      <div class="notif-message" style="margin:6px 0;">${escapeHtml(t.message)}</div>
      <span style="color:var(--text-dim); font-size:11px;">${timeAgo(new Date(t.created_at).getTime())}</span>
    </div>
  `).join('');
}

if(adminTestiRefreshBtn) adminTestiRefreshBtn.addEventListener('click', () => renderAdminTestimonials());

if(adminTestiList){
  adminTestiList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.testi-delete-btn');
    if(!btn) return;
    const id = btn.dataset.testiId;
    if(!confirm('Hapus testimoni ini secara permanen?')) return;
    btn.disabled = true;
    btn.textContent = 'Menghapus...';
    const ok = await deleteTestimonialDb(id);
    if(ok){
      renderAdminTestimonials();
    } else {
      btn.disabled = false;
      btn.textContent = 'Hapus';
    }
  });
}

// Navigasi tab dashboard admin, supaya tiap bagian (Player Online,
// Pembayaran, Harga) tidak perlu di-scroll semua sekaligus.
let adminTabsInitialized = false;
function switchAdminTab(tabName){
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.admin-tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === 'adminTab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
  });
  setCookie('adminLastTab', tabName, ADMIN_SESSION_HOURS);
}
function initAdminTabsOnce(){
  if(adminTabsInitialized) return;
  adminTabsInitialized = true;
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchAdminTab(btn.dataset.tab));
  });
  const lastTab = getCookie('adminLastTab') || 'players';
  switchAdminTab(lastTab);
}

// Tampilkan angka kecil di tab (mis. jumlah permintaan pembayaran yang
// masih pending) supaya admin langsung tahu tanpa harus buka tabnya dulu.
function updateAdminTabBadge(tabName, count){
  const btn = document.querySelector(`.admin-tab-btn[data-tab="${tabName}"]`);
  if(!btn) return;
  let badge = btn.querySelector('.tab-count-badge');
  if(count > 0){
    if(!badge){
      badge = document.createElement('span');
      badge.className = 'tab-count-badge';
      btn.appendChild(badge);
    }
    badge.textContent = count;
  } else if(badge){
    badge.remove();
  }
}

// Login admin sekarang divalidasi di server lewat Supabase RPC (admin_login).
// Server yang menyimpan hash password asli (di tabel admin_config yang
// tidak bisa dibaca oleh anon key) dan yang membuat token sesi acak.
// Client tidak pernah tahu hash aslinya, jadi tidak bisa dipalsukan lagi
// hanya dengan baca source code.
async function submitAdminPassword(){
  if(!dbReady()){
    adminPwError.textContent = 'Supabase belum dikonfigurasi.';
    return;
  }
  adminPwSubmitBtn.disabled = true;
  adminPwSubmitBtn.textContent = 'Memeriksa...';
  const enteredHash = await sha256Hex(adminPwInput.value);
  let token = null;
  try{
    const { data, error } = await sb.rpc('admin_login', { input_password_hash: enteredHash });
    if(!error) token = data;
  }catch(e){ token = null; }
  adminPwSubmitBtn.disabled = false;
  adminPwSubmitBtn.textContent = 'Masuk';
  if(token){
    setCookie('adminSession', token, ADMIN_SESSION_HOURS);
    openAdminDashboard();
  } else {
    adminPwError.textContent = 'Password salah, coba lagi.';
    adminPwInput.value = '';
    adminPwInput.focus();
  }
}
adminPwSubmitBtn.addEventListener('click', submitAdminPassword);
adminPwInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') submitAdminPassword(); });
adminPwModal.addEventListener('click', (e) => { if(e.target === adminPwModal) { adminPwModal.classList.remove('active'); gateOverlay.style.display = 'flex'; } });

async function adminLogout(){
  if(adminPollInterval) clearInterval(adminPollInterval);
  const token = getCookie('adminSession');
  setCookie('adminSession', '', -1);
  if(token && dbReady()){
    try{ await sb.rpc('admin_logout', { input_token: token }); }catch(e){}
  }
  adminDashboard.style.display = 'none';
  gateOverlay.style.display = 'flex';
  gateNameInput.value = '';
  setTimeout(() => gateNameInput.focus(), 50);
}
adminLogoutBtn.addEventListener('click', adminLogout);
const adminHeaderLogoutBtn = document.getElementById('adminHeaderLogoutBtn');
if(adminHeaderLogoutBtn) adminHeaderLogoutBtn.addEventListener('click', adminLogout);

// ===== Tab Cache: perbarui versi CSS/JS supaya browser pengguna ambil yang terbaru =====
const adminRefreshAssetsBtn = document.getElementById('adminRefreshAssetsBtn');
const adminAssetVersionStatusText = document.getElementById('adminAssetVersionStatusText');
const adminAssetVersionError = document.getElementById('adminAssetVersionError');

async function renderAssetVersionStatus(){
  if(!adminAssetVersionStatusText) return;
  if(!dbReady()){
    adminAssetVersionStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    return;
  }
  const v = await fetchAssetVersion();
  adminAssetVersionStatusText.textContent = v
    ? `Versi cache saat ini: ${v}.`
    : 'Belum pernah diperbarui — situs masih pakai versi bawaan.';
}

if(adminRefreshAssetsBtn){
  adminRefreshAssetsBtn.addEventListener('click', async () => {
    if(!dbReady()){
      adminAssetVersionError.textContent = 'Supabase belum dikonfigurasi.';
      return;
    }
    adminAssetVersionError.textContent = '';
    adminRefreshAssetsBtn.disabled = true;
    adminRefreshAssetsBtn.textContent = 'Memperbarui...';

    const newVersion = Date.now();
    const ok = await saveAssetVersion(newVersion);

    adminRefreshAssetsBtn.disabled = false;
    adminRefreshAssetsBtn.textContent = '🔄 Perbarui Cache Sekarang';

    if(ok){
      adminAssetVersionStatusText.textContent = `Versi cache berhasil diperbarui ✓ (${newVersion})`;
    } else {
      adminAssetVersionError.textContent = 'Gagal memperbarui versi cache. Coba lagi.';
    }
  });
}



// Kalau ada sesi admin yang masih berlaku (cookie belum expired, maks 2 jam),
// langsung buka dashboard tanpa minta password lagi.
// Token sesi divalidasi lewat RPC admin_check_session di server, bukan
// dengan dibandingkan ke konstanta publik seperti sebelumnya.
async function restoreAdminSessionIfValid(){
  const existingAdminSession = getCookie('adminSession');
  if(!existingAdminSession || !dbReady()) return;
  try{
    const { data, error } = await sb.rpc('admin_check_session', { input_token: existingAdminSession });
    if(!error && data === true){
      openAdminDashboard();
    } else {
      setCookie('adminSession', '', -1);
    }
  }catch(e){
    setCookie('adminSession', '', -1);
  }
}
restoreAdminSessionIfValid();
/* ==========================================================================
   FILE 3 / 3: app.js
   Berisi: modal pembayaran, tampilan daftar folder & video, pemutar video
   fullscreen, breadcrumb, dan proses utama memuat folder (loadCurrentFolder)
   yang dijalankan begitu halaman dibuka.
   PENTING: file ini harus dimuat TERAKHIR, setelah core.js dan admin.js.
   ========================================================================== */

/* ====== REDIRECT KE HALAMAN PEMBAYARAN ====== */
// Fungsi ini menggantikan modal pembayaran lama.
// Semua tombol bayar di mana pun di halaman ini akan memanggil openPaymentModal()
// dan user diarahkan ke /payment.html dengan context yang dibutuhkan.

const grid = document.getElementById('grid');
const folderPaymentNotice = document.getElementById('folderPaymentNotice');
const folderPaymentNoticeText = document.getElementById('folderPaymentNoticeText');
const foldersEl = document.getElementById('folders');
const foldersSection = document.getElementById('foldersSection');
const allAccessNotice = document.getElementById('allAccessNotice');
const allAccessNoticeText = document.getElementById('allAccessNoticeText');
const videosSection = document.getElementById('videosSection');
const statusText = document.getElementById('statusText');
const breadcrumbEl = document.getElementById('breadcrumb');
const pageTitle = document.getElementById('pageTitle');
const brandHomeBtn = document.getElementById('brandHomeBtn');
const backToFoldersBtn = document.getElementById('backToFoldersBtn');

function goToFolderHome(){
  path = [{ id: HOME_ID, name: HOME_LABEL }];
  loadCurrentFolder();
}
brandHomeBtn.addEventListener('click', goToFolderHome);
backToFoldersBtn.addEventListener('click', goToFolderHome);

const fullscreenModal = document.getElementById('fullscreenModal');
const modalIframe = document.getElementById('modalIframe');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalContent = document.getElementById('modalContent');
const modalLoading = document.getElementById('modalLoading');
const modalPlayerWrap = document.getElementById('modalPlayerWrap');
const modalVideo = document.getElementById('modalVideo');
const videoCenterPlay = document.getElementById('videoCenterPlay');
const videoControls = document.getElementById('videoControls');
const videoProgress = document.getElementById('videoProgress');
const videoProgressFill = document.getElementById('videoProgressFill');
const btnPlayPause = document.getElementById('btnPlayPause');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const btnSkipBack = document.getElementById('btnSkipBack');
const btnSkipForward = document.getElementById('btnSkipForward');
const btnFullscreen = document.getElementById('btnFullscreen');
const videoTimeEl = document.getElementById('videoTime');

let path = [{ id: HOME_ID, name: HOME_LABEL }];

// ---- Integrasi tombol "kembali" perangkat/browser -------------------------
// Sebelumnya buka folder tidak pernah menambah entri riwayat browser, jadi
// tombol back di HP langsung keluar dari web. Sekarang tiap kali `path`
// benar-benar berubah (bukan sekadar refresh otomatis di path yang sama),
// kita simpan sebagai entri history baru. Saat tombol back ditekan, event
// "popstate" menangkap itu dan mengembalikan `path` ke level sebelumnya
// alih-alih menutup halaman.
let lastHistoryPathKey = null;
let suppressHistoryPush = false;

function currentPathKey(){
  return path.map(p => p.id).join('>');
}

function syncHistoryState(){
  const key = currentPathKey();
  if(suppressHistoryPush){
    suppressHistoryPush = false;
    lastHistoryPathKey = key;
    return;
  }
  if(key === lastHistoryPathKey) return; // path sama (mis. auto-refresh), tidak perlu entri baru
  const state = { path: path.map(p => ({ id: p.id, name: p.name, createdTime: p.createdTime, source: p.source })) };
  if(lastHistoryPathKey === null){
    history.replaceState(state, '');
  } else {
    history.pushState(state, '');
  }
  lastHistoryPathKey = key;
}

window.addEventListener('popstate', (e) => {
  suppressHistoryPush = true;
  path = (e.state && e.state.path && e.state.path.length) ? e.state.path : [{ id: HOME_ID, name: HOME_LABEL }];
  loadCurrentFolder();
});

function formatDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' });
}

function folderIcon(){
  return `VIP`;
}

function renderBreadcrumb(){
  breadcrumbEl.innerHTML = '';
  backToFoldersBtn.classList.toggle('visible', path.length > 1);
  if(path.length > 1){
    breadcrumbEl.classList.add('visible');
    path.slice(0, -1).forEach((p, i) => {
      if(i > 0){
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '/';
        breadcrumbEl.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.textContent = p.name;
      btn.onclick = () => {
        path = path.slice(0, i + 1);
        loadCurrentFolder();
      };
      breadcrumbEl.appendChild(btn);
    });
  } else {
    breadcrumbEl.classList.remove('visible');
  }
  pageTitle.textContent = path[path.length - 1].name;
}

async function renderFolders(folders){
  if(!folders.length){
    foldersSection.style.display = 'none';
    return;
  }
  foldersSection.style.display = 'block';
  foldersEl.innerHTML = '';

  // Ambil status pembayaran sekali saja untuk semua folder di halaman ini,
  // supaya tiap kartu bisa menampilkan "Sudah dibayar" / harga / gratis.
  const name = getCookie('visitorName') || '';
  const requests = await fetchPaymentRequests();
  const allAccessEntry = requests ? requests[requestKey(name, ALL_ACCESS_ID)] : null;
  const unlockedByAllAccess = ALL_ACCESS_ENABLED && isAccessValid(allAccessEntry); // FIX: cek expiry juga

  const paidFolderCount = folders.filter(f => !isFolderFree(f.id)).length;
  if(ALL_ACCESS_ENABLED && paidFolderCount > 0 && !unlockedByAllAccess){
    await Promise.all([ensureFolderPriceCache(), ensureDiscountCache()]);
    const allAccessPrice = folderPrice(ALL_ACCESS_ID);
    const isPending = !!(allAccessEntry && allAccessEntry.status === 'pending');
    const btnLabel = isPending ? '⏳ Sedang di proses...' : 'Bayar Sekarang';
    const btnClass = isPending ? 'notice-pay-btn pending' : 'notice-pay-btn';
    const permanentPrice = allAccessPrice * 2;
    const fmtRp = n => 'Rp' + Number(n).toLocaleString('id-ID');
    allAccessNoticeText.innerHTML = `<span class="notice-inner">
        <span class="notice-description">Buka <strong>semua ${paidFolderCount} folder</strong> berbayar sekaligus &mdash; pilih paket:</span>
        <span class="notice-plan-chips">
          <span class="notice-plan-chip">
            <span class="notice-plan-chip-label">🗓️ 1 Bulan</span>
            <span class="notice-plan-chip-price">${fmtRp(allAccessPrice)}</span>
            <span class="notice-plan-chip-desc">Akses 30 hari penuh</span>
          </span>
          <span class="notice-plan-chip notice-plan-chip-perm">
            <span class="notice-plan-chip-label">♾️ Permanen <span class="notice-plan-chip-perm-badge">TERBAIK</span></span>
            <span class="notice-plan-chip-price">${fmtRp(permanentPrice)}</span>
            <span class="notice-plan-chip-desc">Bayar sekali, selamanya</span>
          </span>
        </span>
        <button class="${btnClass}" id="allAccessPayBtn">${btnLabel}</button>
      </span>`;
    allAccessNotice.style.display = 'block';
    const allAccessPayBtn = document.getElementById('allAccessPayBtn');
    if(allAccessPayBtn){
      allAccessPayBtn.addEventListener('click', () => {
        openPaymentModal({ folderId: ALL_ACCESS_ID, folderName: ALL_ACCESS_NAME, price: allAccessPrice });
      });
    }
  } else {
    allAccessNotice.style.display = 'none';
  }

  // Hitung berapa kali tiap folder sudah "terjual" (permintaan berstatus
  // approved). Pembeli paket "Akses Semua Folder" dihitung sebagai pembeli
  // folder ini juga HANYA kalau folder ini sudah ada saat mereka membeli
  // (folder yang dibuat setelahnya tidak otomatis ikut, jadi tidak dihitung).
  const allApprovedList = requests ? Object.values(requests).filter(r => r.status === 'approved') : [];
  const allAccessApprovedEntries = allApprovedList.filter(r => r.folderId === ALL_ACCESS_ID);
  function soldCountFor(folder){
    const direct = allApprovedList.filter(r => r.folderId === folder.id).length;
    const coveredAllAccess = allAccessApprovedEntries.filter(e => isFolderCoveredByAllAccess(folder, e)).length;
    return direct + coveredAllAccess;
  }

  folders.forEach(f => {
    const card = document.createElement('button');
    card.className = 'folder-card';

    let tagHtml = 'Ketuk untuk buka';
    let tagClass = 'tag';
    let priceRowHtml = '';
    const free = isFolderFree(f.id);
    const coveredByAllAccess = isFolderCoveredByAllAccess(f, allAccessEntry);
    if(free){
      tagHtml = '🆓 Gratis';
      tagClass = 'tag free';
    } else if(coveredByAllAccess){
      tagHtml = '✅Dibayar';
      tagClass = 'tag paid';
      if(allAccessEntry && allAccessEntry.expiresAt){
        const daysLeft = Math.ceil((allAccessEntry.expiresAt - Date.now()) / 86400000);
        const daysStr  = daysLeft > 1 ? `${daysLeft} Hari Lagi`
                       : daysLeft === 1 ? 'Besok Habis'
                       : 'Habis Hari Ini';
        priceRowHtml = `<span class="expiry-label">${daysStr} • Exp. ${formatExpiryDate(allAccessEntry.expiresAt)}</span>`;
      }
    } else {
      const key = requestKey(name, f.id);
      const entry = requests ? requests[key] : null;
      if(isAccessValid(entry)){
        tagHtml = '✅Dibayar';
        tagClass = 'tag paid';
        if(entry.expiresAt){
          const daysLeft = Math.ceil((entry.expiresAt - Date.now()) / 86400000);
          const daysStr  = daysLeft > 1 ? `${daysLeft} Hari Lagi`
                         : daysLeft === 1 ? 'Besok Habis'
                         : 'Habis Hari Ini';
          priceRowHtml = `<span class="expiry-label">${daysStr} • Exp. ${formatExpiryDate(entry.expiresAt)}</span>`;
        }
      } else if(isAccessExpired(entry)){
        tagHtml = '⏰ Akses Habis';
        tagClass = 'tag expired';
        priceRowHtml = `<span class="price-row">${priceHtml(f.id)}</span>`;
      } else if(entry && entry.status === 'pending'){
        tagHtml = '⏳ Menunggu konfirmasi';
        tagClass = 'tag pending';
        priceRowHtml = `<span class="price-row">${priceHtml(f.id)}</span>`;
      } else {
        tagHtml = '🔒 Berbayar';
        tagClass = 'tag locked';
        priceRowHtml = `<span class="price-row">${priceHtml(f.id)}</span>`;
      }
    }

    const soldHtml = !free
      ? `<span class="sold-badge">🛒 Terjual ${soldCountFor(f)}</span>`
      : '';
    const newBadgeHtml = isFolderNew(f) ? `<span class="new-badge">Baru</span>` : '';

    card.innerHTML = `
      ${newBadgeHtml}
      <span class="icon">${folderIcon()}</span>
      <span class="info">
        <span class="name">${escapeHtml(f.name)}</span>
        <span class="${tagClass}">${tagHtml}</span>
        ${priceRowHtml}
        ${soldHtml}
      </span>
    `;
    card.onclick = () => {
      requestFolderAccess(f);
    };
    foldersEl.appendChild(card);
  });
}

// Pemutar video pakai elemen <video> custom (bukan iframe Drive), dengan
// kontrol minimalis buatan sendiri: mundur/maju 10 detik, play/pause,
// fullscreen — tanpa judul, tanpa tombol volume/CC/kecepatan/setting
// bawaan Google. Videonya di-stream lewat drive-proxy.php (mode=stream)
// supaya API key Google Drive tetap tidak pernah terlihat di browser,
// walau dengan cara ini video jadi bisa didownload orang yang cukup paham
// DevTools (trade-off yang sudah disepakati demi kontrol tampilan penuh).
function formatVideoTime(sec){
  if(!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updatePlayIcon(){
  const playing = !modalVideo.paused && !modalVideo.ended;
  iconPlay.style.display = playing ? 'none' : 'block';
  iconPause.style.display = playing ? 'block' : 'none';
  videoCenterPlay.classList.toggle('visible', !playing);
}

function updateProgressUI(){
  const dur = modalVideo.duration || 0;
  const cur = modalVideo.currentTime || 0;
  videoProgressFill.style.width = dur ? `${(cur / dur) * 100}%` : '0%';
  videoTimeEl.textContent = `${formatVideoTime(cur)} / ${formatVideoTime(dur)}`;
}

function seekFromClientX(clientX){
  const rect = videoProgress.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  if(isFinite(modalVideo.duration)){
    modalVideo.currentTime = ratio * modalVideo.duration;
    updateProgressUI();
  }
}

let seeking = false;
videoProgress.addEventListener('pointerdown', (e) => {
  seeking = true;
  seekFromClientX(e.clientX);
});
window.addEventListener('pointermove', (e) => {
  if(seeking) seekFromClientX(e.clientX);
});
window.addEventListener('pointerup', () => { seeking = false; });

btnPlayPause.addEventListener('click', () => {
  if(modalVideo.paused) modalVideo.play().catch(() => {});
  else modalVideo.pause();
});
videoCenterPlay.addEventListener('click', () => {
  modalVideo.play().catch(() => {});
});
modalVideo.addEventListener('click', () => {
  if(modalVideo.paused) modalVideo.play().catch(() => {});
  else modalVideo.pause();
});
btnSkipBack.addEventListener('click', () => {
  modalVideo.currentTime = Math.max(0, modalVideo.currentTime - 10);
});
btnSkipForward.addEventListener('click', () => {
  modalVideo.currentTime = Math.min(modalVideo.duration || Infinity, modalVideo.currentTime + 10);
});
modalVideo.addEventListener('play', updatePlayIcon);
modalVideo.addEventListener('pause', updatePlayIcon);
modalVideo.addEventListener('timeupdate', updateProgressUI);
modalVideo.addEventListener('loadedmetadata', updateProgressUI);
modalVideo.addEventListener('waiting', () => modalLoading.classList.remove('hidden'));
modalVideo.addEventListener('playing', () => modalLoading.classList.add('hidden'));
modalVideo.addEventListener('canplay', () => modalLoading.classList.add('hidden'));
modalVideo.addEventListener('error', () => fallbackToDriveIframe());

btnFullscreen.addEventListener('click', () => {
  if(document.fullscreenElement || document.webkitFullscreenElement){
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if(modalPlayerWrap.requestFullscreen){
    modalPlayerWrap.requestFullscreen().catch(() => {});
  } else if(modalPlayerWrap.webkitRequestFullscreen){
    modalPlayerWrap.webkitRequestFullscreen();
  } else if(modalVideo.webkitEnterFullscreen){
    modalVideo.webkitEnterFullscreen(); // fallback khusus iOS Safari
  }
});

function fallbackToDriveIframe(){
  // Kalau streaming custom gagal (misal proxy lagi bermasalah), video tetap
  // bisa ditonton lewat iframe preview Drive biasa sebagai jaring pengaman.
  modalVideo.style.display = 'none';
  videoControls.style.display = 'none';
  videoCenterPlay.style.display = 'none';
  modalIframe.style.display = 'block';
  modalLoading.classList.remove('hidden');
  modalIframe.onload = () => modalLoading.classList.add('hidden');
  modalIframe.src = modalIframe.dataset.fallbackSrc || '';
}

function openVideoFullscreen(fileId, fileName, source) {
  fullscreenModal.classList.add('active');
  document.body.style.overflow = 'hidden';

  // Reset ke tampilan player custom (kalau sebelumnya sempat fallback ke iframe)
  modalVideo.style.display = 'block';
  videoControls.style.display = 'block';
  videoCenterPlay.style.display = 'flex';
  modalIframe.style.display = 'none';
  modalIframe.src = '';

  modalLoading.classList.remove('hidden');
  videoProgressFill.style.width = '0%';
  videoTimeEl.textContent = '0:00 / 0:00';
  updatePlayIcon();

  modalIframe.dataset.fallbackSrc = `https://drive.google.com/file/d/${fileId}/preview`;
  modalVideo.src = `${DRIVE_PROXY_URL}?mode=stream&source=${encodeURIComponent(source)}&fileId=${encodeURIComponent(fileId)}&name=${encodeURIComponent(getCookie('visitorName') || '')}`;
  modalVideo.load();
  modalVideo.play().catch(() => { /* autoplay diblokir, tinggal tekan play manual */ });
}

function closeFullscreenModal() {
  if(document.fullscreenElement || document.webkitFullscreenElement){
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
  fullscreenModal.classList.remove('active');

  modalVideo.pause();
  modalVideo.removeAttribute('src');
  modalVideo.load();

  modalIframe.onload = null;
  modalIframe.src = '';

  document.body.style.overflow = '';
}

/* ====== HALAMAN PEMBAYARAN ====== */
// Menggantikan modal lama — redirect user ke /payment.html
// dengan semua context yang dibutuhkan disimpan di sessionStorage.
function openPaymentModal(lockInfo){
  const price = lockInfo.price !== undefined ? lockInfo.price : folderPrice(lockInfo.folderId);
  // Simpan context di sessionStorage supaya URL tetap bersih
  sessionStorage.setItem('mvip_payment_ctx', JSON.stringify({
    folderId:   lockInfo.folderId,
    folderName: lockInfo.folderName,
    price:      price
  }));
  window.location.href = '/payment.html';
}

function renderVideos(files, lockInfo){
  if(!files.length){
    videosSection.style.display = 'block';
    folderPaymentNotice.style.display = 'none';
    grid.innerHTML = `<div class="empty">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M21 8l-4 3 4 3z"/></svg>
      Belum ada video di folder ini.
    </div>`;
    return;
  }
  const locked = !!(lockInfo && lockInfo.locked);
  videosSection.style.display = 'block';
  if(locked){
    const isPending = !!(lockInfo && lockInfo.isPending);
    const btnLabel = isPending ? '⏳ Sedang di proses...' : 'Bayar Sekarang';
    const btnClass = isPending ? 'notice-pay-btn pending' : 'notice-pay-btn';
    const basePrice = folderPrice(lockInfo.folderId);
    const fmtRp = n => 'Rp' + Number(n).toLocaleString('id-ID');
    const permanentFolderPrice = basePrice * 2;
    folderPaymentNoticeText.innerHTML = `<span class="notice-inner">
        <span class="notice-description">Buka <strong>semua ${files.length} video</strong> di folder ini &mdash; pilih paket:</span>
        <span class="notice-plan-chips">
          <span class="notice-plan-chip">
            <span class="notice-plan-chip-label">\uD83D\uDDD3\uFE0F 1 Bulan</span>
            <span class="notice-plan-chip-price">${fmtRp(basePrice)}</span>
            <span class="notice-plan-chip-desc">Akses 30 hari penuh</span>
          </span>
          <span class="notice-plan-chip notice-plan-chip-perm">
            <span class="notice-plan-chip-label">\u267E\uFE0F Permanen <span class="notice-plan-chip-perm-badge">TERBAIK</span></span>
            <span class="notice-plan-chip-price">${fmtRp(permanentFolderPrice)}</span>
            <span class="notice-plan-chip-desc">Bayar sekali, selamanya</span>
          </span>
        </span>
        <button class="${btnClass}" id="noticePayBtn">${btnLabel}</button>
      </span>`;
    folderPaymentNotice.style.display = 'block';
    const noticePayBtn = document.getElementById('noticePayBtn');
    if(noticePayBtn){
      noticePayBtn.addEventListener('click', () => openPaymentModal(lockInfo));
    }
  } else {
    // Folder sudah dibeli — tampilkan info durasi sisa akses
    const ae = lockInfo && lockInfo.activeEntry;
    if(ae){
      const fmtTgl = ts => new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
      let bannerHtml = '';
      if(ae.expiresAt){
        const expired = Date.now() > ae.expiresAt;
        const sisaHari = Math.ceil((ae.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
        const tglExpiry = fmtTgl(ae.expiresAt);
        if(expired){
          bannerHtml = `<div class="access-active-banner expired"><span class="aab-icon">⏰</span><span class="aab-text">Akses kadaluarsa sejak <strong>${tglExpiry}</strong></span></div>`;
        } else if(sisaHari <= 7){
          bannerHtml = `<div class="access-active-banner expiring"><span class="aab-icon">⚠️</span><span class="aab-text">Akses aktif · <strong>sisa ${sisaHari} hari</strong> (s/d ${tglExpiry})</span></div>`;
        } else {
          bannerHtml = `<div class="access-active-banner active"><span class="aab-icon">✓</span><span class="aab-text">Akses aktif s/d <strong>${tglExpiry}</strong></span></div>`;
        }
      } else {
        bannerHtml = `<div class="access-active-banner permanent"><span class="aab-icon">♾️</span><span class="aab-text">Akses <strong>Permanen</strong> — tidak ada batas waktu</span></div>`;
      }
      folderPaymentNoticeText.innerHTML = bannerHtml;
      folderPaymentNotice.style.display = 'block';
    } else {
      folderPaymentNotice.style.display = 'none';
    }
  }
  grid.innerHTML = '';
  files.forEach(f => {
    const card = document.createElement('div');
    card.className = locked ? 'card locked' : 'card';
    const thumb = f.hasThumbnail && f.thumbnailLink
      ? f.thumbnailLink.replace(/=s\d+$/, '=s640')
      : '';
    card.innerHTML = `
      <div class="frame" data-file-id="${f.id}">
        ${thumb
          ? `<img src="${thumb}" alt="${escapeHtml(f.name)}" loading="lazy">`
          : `<div class="noThumb"></div>`}
        <button class="playBtn" aria-label="${locked ? 'Buka akses' : 'Putar video'}">
          ${locked
            ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`
            : `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`}
        </button>
      </div>
    `;
    const playBtn = card.querySelector('.playBtn');

    const handleOpen = (e) => {
      if(e) e.stopPropagation();
      if(locked){
        openPaymentModal(lockInfo);
      } else {
        openVideoFullscreen(f.id, f.name, f.source);
      }
    };

    playBtn.addEventListener('click', handleOpen);
    card.addEventListener('click', handleOpen);

    grid.appendChild(card);
  });
}

function isOnDashboardTab(){
  // Cek apakah bottom nav sedang aktif di Dashboard.
  // Dipakai sebagai guard supaya loadCurrentFolder() tidak menimpa
  // tampilan Profil/Notifikasi/History saat async-nya baru selesai.
  const activeBtn = document.querySelector('.bottom-nav-item.active');
  return !activeBtn || activeBtn.id === 'bnDashboard';
}

function showSkeletons(){
  // Guard: jangan tampilkan skeleton kalau user sedang di tab non-dashboard
  if(!isOnDashboardTab()) return;
  foldersSection.style.display = 'none';
  videosSection.style.display = 'block';
  folderPaymentNotice.style.display = 'none';
  grid.innerHTML = '';
  for(let i=0;i<6;i++){
    const s = document.createElement('div');
    s.className = 'skeleton';
    grid.appendChild(s);
  }
}

// Ambil daftar folder+video langsung di dalam satu folder Drive, pakai
// API key sumber yang bersangkutan. Dipakai baik untuk folder biasa
// maupun untuk tiap sumber di halaman utama (HOME_ID).
// Dikasih batas waktu (timeout) supaya kalau satu request menggantung
// (misalnya kena blokir jaringan/CORS yang diam saja, bukan dikasih error),
// halaman tidak nyangkut selamanya di "Memuat..." — otomatis dianggap
// gagal setelah beberapa detik dan tampil pesan error yang jelas.
//
// Lewat drive-proxy.php (bukan langsung ke googleapis.com) supaya API key
// Google Drive tidak pernah kelihatan di browser pengunjung.
async function fetchDriveChildren(parentId, source, timeoutMs = 10000){
  const url = `${DRIVE_PROXY_URL}?source=${encodeURIComponent(source)}&parentId=${encodeURIComponent(parentId)}&mode=all`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return await res.json();
  }catch(e){
    if(e.name === 'AbortError'){
      return { error: { message: 'Waktu tunggu habis, server tidak merespons.' } };
    }
    return { error: { message: 'Gagal terhubung ke server (cek koneksi internet).' } };
  }finally{
    clearTimeout(timer);
  }
}

// Folder yang baru saja ditambahin video otomatis "naik" ke urutan paling
// atas daftar folder. Caranya: tanya ke tiap folder, "video terbarumu
// diupload kapan?" (mode=latest, cukup 1 hasil, jadi ringan), lalu urutkan
// folder dari yang video-nya paling baru. Folder tanpa video sama sekali
// otomatis turun ke bawah.
async function fetchLatestVideoTime(folderId, source){
  try{
    const url = `${DRIVE_PROXY_URL}?source=${encodeURIComponent(source)}&parentId=${encodeURIComponent(folderId)}&mode=latest`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    const f = data.files && data.files[0];
    return f && f.createdTime ? new Date(f.createdTime).getTime() : 0;
  }catch(e){
    return 0;
  }
}

async function sortFoldersByLatestVideo(folders){
  const times = await Promise.all(folders.map(f => fetchLatestVideoTime(f.id, f.source)));
  folders.forEach((f, i) => {
    f._latestVideoTime = times[i];
    // Badge "Baru" muncul kalau ADA VIDEO BARU di dalam folder ini, ATAU
    // folder itu sendiri baru dibuat (misal folder baru tapi belum sempat
    // diisi video) — dua-duanya dianggap "ada yang baru" di folder ini.
    const folderCreatedTime = f.createdTime ? new Date(f.createdTime).getTime() : 0;
    f._newBadgeTime = Math.max(f._latestVideoTime, folderCreatedTime);
  });
  folders.sort((a, b) => b._latestVideoTime - a._latestVideoTime);
}

const NEW_BADGE_WINDOW_MS = 24 * 60 * 60 * 1000; // badge "Baru" bertahan 1 hari
function isFolderNew(folder){
  if(!folder._newBadgeTime) return false;
  return (Date.now() - folder._newBadgeTime) < NEW_BADGE_WINDOW_MS;
}

async function loadCurrentFolder(){
  syncHistoryState();
  const current = path[path.length - 1];
  const currentId = current.id;
  renderBreadcrumb();

  const activeSources = validDriveSources();
  if(!activeSources.length){
    grid.innerHTML = `<div class="error">
      Konfigurasi belum diisi.
      <code>Buka file core.js, isi id & source di DRIVE_SOURCES bagian atas.</code>
    </div>`;
    statusText.textContent = 'Butuh konfigurasi';
    foldersSection.style.display = 'none';
    return;
  }

  showSkeletons();
  statusText.textContent = 'Memuat...';

  try{
    await Promise.all([ensureFolderPriceCache(), ensureDiscountCache()]);

    let allFiles = [];
    let failedSources = [];

    if(currentId === HOME_ID){
      // Halaman utama: ambil isi folder tiap sumber lalu gabung jadi satu
      // daftar. Tiap file/folder yang didapat ditandai kode sumbernya
      // supaya kalau nanti dibuka lebih dalam, tetap pakai proxy yang benar.
      const results = await Promise.all(
        activeSources.map(src => fetchDriveChildren(src.id, src.source).catch(() => ({ error: { message: 'Gagal terhubung' } })))
      );
      results.forEach((data, i) => {
        const src = activeSources[i];
        if(data.error){
          failedSources.push(`${src.label || src.id}: ${data.error.message}`);
          return;
        }
        (data.files || []).forEach(f => allFiles.push({ ...f, source: src.source }));
      });

      if(!allFiles.length && failedSources.length){
        grid.innerHTML = `<div class="error">
          Gagal mengambil data dari Google Drive: ${failedSources.join(' | ')}
          <code>Cek lagi: API key aktif untuk Drive API di drive-proxy.php, folder di-share publik ("Anyone with the link"), dan Folder ID benar.</code>
        </div>`;
        statusText.textContent = 'Gagal memuat';
        foldersSection.style.display = 'none';
        return;
      }
    } else {
      // Folder biasa (termasuk subfolder di dalamnya): pakai kode sumber yang
      // sudah "diwariskan" dari folder induknya waktu folder ini dibuka.
      const data = await fetchDriveChildren(currentId, current.source);
      if(data.error){
        grid.innerHTML = `<div class="error">
          Gagal mengambil data dari Google Drive: ${data.error.message}
          <code>Cek lagi: API key aktif untuk Drive API di drive-proxy.php, folder di-share publik ("Anyone with the link"), dan Folder ID benar.</code>
        </div>`;
        statusText.textContent = 'Gagal memuat';
        foldersSection.style.display = 'none';
        return;
      }
      allFiles = (data.files || []).map(f => ({ ...f, source: current.source }));
    }

    const folders = allFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const videos = allFiles.filter(f => f.mimeType && f.mimeType.startsWith('video/'));

    if(folders.length > 0){
      await sortFoldersByLatestVideo(folders);
    }

    // Guard: kalau user sudah pindah ke tab lain saat data sedang dimuat
    // (race condition), batalkan render — jangan timpa Profil/Notifikasi/History.
    if(!isOnDashboardTab()) return;

    await renderFolders(folders);
    if(folders.length > 0){
      videosSection.style.display = 'none';
    } else if(videos.length > 0 && !isFolderFree(currentId)){
      const visitorName = getCookie('visitorName');
      const price = folderPrice(currentId);
      const currentFolderInfo = path[path.length - 1];
      const folderName = currentFolderInfo.name;
      let unlocked = false;
      let isPending = false;
      let requests = null;
      if(visitorName){
        requests = await fetchPaymentRequests();
        if(requests){
          const allAccessEntry = requests[requestKey(visitorName, ALL_ACCESS_ID)];
          const folderEntry = requests[requestKey(visitorName, currentId)];
          // Akses Semua Folder hanya berlaku untuk folder yang sudah ada
          // saat paket itu disetujui — folder baru tetap perlu dibayar sendiri.
          unlocked = ALL_ACCESS_ENABLED && isFolderCoveredByAllAccess(currentFolderInfo, allAccessEntry);
          if(!unlocked) unlocked = isAccessValid(folderEntry); // FIX: cek expiry juga, bukan cuma status
          isPending = !unlocked && (
            !!(allAccessEntry && allAccessEntry.status === 'pending') ||
            !!(folderEntry && folderEntry.status === 'pending')
          );
        }
      }
      // Tentukan entry mana yang memberi akses (all-access atau per-folder),
      // supaya bisa tampilkan info durasi sisa akses di banner video.
      // FIX: pakai `requests` dari fetch pertama, tidak perlu fetch ulang.
      let activeEntry = null;
      if(unlocked && requests){
        const _allAcc = requests[requestKey(visitorName, ALL_ACCESS_ID)];
        const _folderAcc = requests[requestKey(visitorName, currentId)];
        if(_allAcc && isAccessValid(_allAcc) && isFolderCoveredByAllAccess(currentFolderInfo, _allAcc)){
          activeEntry = _allAcc;
        } else if(_folderAcc && isAccessValid(_folderAcc)){
          activeEntry = _folderAcc;
        }
      }
      renderVideos(videos, { locked: !unlocked, folderId: currentId, folderName, price, isPending, activeEntry });
    } else {
      renderVideos(videos);
    }

    const now = new Date().toLocaleTimeString('id-ID');
    const warnSuffix = failedSources.length ? ` · ⚠️ ${failedSources.length} sumber gagal dimuat` : '';
    if(folders.length > 0){
      const visitorName = getCookie('visitorName');
      statusText.textContent = (visitorName
        ? `Halo, ${visitorName} 👋 · ${folders.length} folder tersedia`
        : `${folders.length} folder tersedia`) + warnSuffix;
    } else {
      statusText.textContent = `${videos.length} video - terakhir dicek ${now}${warnSuffix}`;
    }
  }catch(err){
    grid.innerHTML = `<div class="error">Terjadi kesalahan jaringan. Coba refresh halaman.</div>`;
    statusText.textContent = 'Gagal memuat';
    foldersSection.style.display = 'none';
  }
}

modalCloseBtn.addEventListener('click', closeFullscreenModal);

fullscreenModal.addEventListener('click', (e) => {
  if (e.target === fullscreenModal) {
    closeFullscreenModal();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fullscreenModal.classList.contains('active')) {
    closeFullscreenModal();
  }
});

if(existingVisitorName){
  loadCurrentFolder();
  startHeartbeat(existingVisitorName);
}
let autoRefreshInterval = null;
if(AUTO_REFRESH_SECONDS > 0){
  autoRefreshInterval = setInterval(() => {
    if(getCookie('visitorName')){
      loadCurrentFolder();
    } else {
      // User sudah logout, hentikan auto-refresh
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
    }
  }, AUTO_REFRESH_SECONDS * 1000);
}
