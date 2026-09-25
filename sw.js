// sw.js — service worker do Kipu. Guarda o "casco" (HTML/CSS) e, principalmente,
// o CÓDIGO da aplicação (app.js, translations.js) — sem isso, offline o
// navegador carrega a página mas nenhuma lógica roda, e fica preso na tela
// de login "crua". Os DADOS (viagens, documentos etc.) continuam vindo do
// Firestore, que tem seu próprio cache offline (enableIndexedDbPersistence).

const CACHE_NAME = "kipu-shell-v4"; // v4 (QA #9, 25/set/2026): troca de versão apaga o cache antigo, que podia ter fotos de documentos
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

// Só entra no cache o que é CÓDIGO do app (QA #9, 25/set/2026): os arquivos
// do próprio site, as bibliotecas de CDN (SDK do Firebase, heic2any) e as fontes.
// Antes, tudo que passava pelo navegador era guardado — inclusive fotos de
// RG/passaporte vindas do Storage, que continuavam no aparelho mesmo depois
// de excluídas ou vencidas. Dados e arquivos da viagem ficam de fora: o
// Firestore já tem o cache offline próprio dele.
const CACHEABLE_HOSTS = ["www.gstatic.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];
function isCacheable(request) {
  const url = new URL(request.url);
  if (url.origin === self.location.origin) return true;
  return CACHEABLE_HOSTS.includes(url.hostname);
}

// Estratégia: tenta a rede primeiro (código sempre atualizado) e, se der
// certo, atualiza o cache com a resposta nova. Offline, cai pro cache.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (!isCacheable(event.request)) return; // navegador trata normalmente, sem guardar nada
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        // Só guarda resposta de sucesso — nunca um erro (404/500) por cima
        // de uma versão boa que já estava no cache.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: event.request.mode === "navigate" }))
  );
});
