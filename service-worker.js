// (★) GitHub Pagesのリポジトリ名 (例: '/my-repo')
// もし "username.github.io" のようなユーザールートで使うなら、空文字 '' にしてください
const REPO_PATH = '/manual-search'; 

// (★) キャッシュのバージョン (ここを更新するとキャッシュが新しくなる)
const CACHE_NAME = 'your-app-cache-v1';

// (★) アプリ本体として初回にキャッシュするファイル
// REPO_PATH を先頭につけて、GitHub Pages のパスに合わせます
const urlsToCache = [
  REPO_PATH + '/',
  REPO_PATH + '/index.html',
  REPO_PATH + '/manifest.json',
  REPO_PATH + '/icon-192.png',
  REPO_PATH + '/icon-512.png'
  // (もしCSSやJSを分けていたら、それもここに追加)
  // REPO_PATH + '/style.css',
];

// --- 1. インストール処理 ---
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .catch(err => {
        console.error('Failed to cache files during install:', err);
        console.log('Files to cache:', urlsToCache); // (★) デバッグ用にログを追加
      })
  );
});

// --- 2. リクエスト処理 (キャッシュ優先) ---
self.addEventListener('fetch', event => {
  
  // (★) 最重要: GASへのAPIリクエストは絶対にキャッシュしない
  if (event.request.url.startsWith('https://script.google.com/')) {
    // ネットワークリクエストをそのまま実行
    return fetch(event.request); 
  }

  // それ以外のリクエスト (index.html など) はキャッシュを優先して返す
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // キャッシュがあれば、それを返す
        if (response) {
          return response;
        }
        // キャッシュがなければ、ネットワークから取得
        return fetch(event.request);
      })
  );
});

// --- 3. 古いキャッシュの削除 ---
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
