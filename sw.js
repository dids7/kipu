// sw.js — service worker mínimo, só para o Kipu ser considerado "instalável"
// pelo navegador. Não faz cache agressivo — o app depende do Firestore
// online para os dados reais; isso aqui só habilita o prompt de instalação.

const CACHE_NAME = "kipu-shell-v1";
const SHELL_FILES = ["./", "./index.html", "./style.css", "./manifest.json"];

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

// Estratégia simples: tenta a rede primeiro (dados sempre atualizados);
// se estiver offline, cai pro que tiver em cache (só o "casco" do app).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
