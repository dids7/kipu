// sw.js — service worker do Kipu. Guarda o "casco" (HTML/CSS) e, principalmente,
// o CÓDIGO da aplicação (app.js, translations.js) — sem isso, offline o
// navegador carrega a página mas nenhuma lógica roda, e fica preso na tela
// de login "crua". Os DADOS (viagens, documentos etc.) continuam vindo do
// Firestore, que tem seu próprio cache offline (enableIndexedDbPersistence).

const CACHE_NAME = "kipu-shell-v2";
const SHELL_FILES = ["./", "./index.html", "./style.css", "./app.js", "./translations.js", "./firebase-config.js", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estratégia: tenta a rede primeiro (dados/código sempre atualizados) e, se
// der certo, atualiza o cache com a resposta mais nova — assim o cache nunca
// fica parado na versão da primeira instalação. Se estiver offline, cai pro
// que tiver em cache.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
