import { auth, googleProvider, db, storage } from "./firebase-config.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, serverTimestamp, getDocs, getDocsFromServer, getDoc, arrayUnion, increment, runTransaction, FieldPath, arrayRemove, deleteField, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { translations, SUPPORTED_LANGS, DEFAULT_LANG } from "./translations.js";

// Flag simples: só true depois que uma viagem foi de fato aberta.
// Declarada bem no topo pra nunca dar erro de "usar antes de declarar".
let appIsOpen = false;

// Formata uma data no fuso LOCAL do navegador como "YYYY-MM-DD" — em vez de
// Date.toISOString(), que usa UTC. Isso importa de verdade numa viagem em
// outro fuso (ex: Peru, UTC-5): perto da meia-noite local, toISOString()
// pode devolver o dia ANTERIOR, fazendo a aba "Hoje" e as expirações
// calcularem tudo com um dia de atraso. Função declarada (não const) de
// propósito, pra funcionar mesmo se chamada por código que roda antes dela
// no arquivo — declarações de função sobem pro topo do escopo sozinhas.
function localISODate(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ================= SEGURANÇA DE TEXTO (QA #1, 25/set/2026) =================
// Todo texto que veio de um usuário (título, nota, nome, local...) e vai
// entrar num innerHTML PRECISA passar por escapeHtml() — sem isso, alguém
// poderia cadastrar, por exemplo, uma dica com título "<img onerror=...>"
// e esse código rodaria no navegador de todo mundo que abrisse a aba (XSS).
// Com o escape, o texto aparece literalmente na tela, nunca vira código.
// Regra pra código novo: dado de usuário em innerHTML → escapeHtml();
// em textContent não precisa (textContent já é seguro por natureza).
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Só deixa passar link http:// ou https:// — bloqueia "javascript:" e
// outros esquemas perigosos num href/src. Link sem esquema (ex: digitado
// como "www.site.com") ganha "https://" na frente. Devolve "" se inválido.
// Sempre usar junto com escapeHtml() ao montar o atributo.
function safeUrl(url) {
  if (!url) return "";
  let str = String(url).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(str)) str = "https://" + str;
  try {
    const parsed = new URL(str);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") ? parsed.href : "";
  } catch (err) {
    return "";
  }
}

// Grava o papel de UM participante (QA #15, 25/set/2026). E-mail tem ponto
// ("maria@gmail.com"), e no updateDoc um texto como "participantRoles.maria@gmail.com"
// é lido como caminho aninhado (participantRoles → "maria@gmail" → "com") —
// o papel ia parar no lugar errado e nunca valia de verdade. FieldPath trata o
// e-mail inteiro como UMA chave só. `extra` = outros campos simples do mesmo update.
// Falha de ação sem tratamento (QA #5, 25/set/2026): mostra um aviso na tela
// em vez de falhar calada, e manda pro Sentry se ele estiver carregado.
function reportActionError(message, err) {
  console.warn(message, err);
  try { if (window.Sentry && window.Sentry.captureException) window.Sentry.captureException(err); } catch (e) { /* ignora */ }
  showToast(message, "error");
}
// Envolve uma função async pra que qualquer erro vire aviso na tela.
function withErrorToast(fn, message) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      reportActionError(message, err);
    }
  };
}
// Erro numa assinatura em tempo real (onSnapshot) — antes a aba só ficava
// vazia, sem nenhum aviso (QA #5). Um aviso por área por sessão, pra não
// repetir. Agência sem acesso a Mala/Tarefas/Gastos/Histórico é esperado
// (abas escondidas pra esse papel), então nesse caso não avisa.
const snapshotErrorShown = new Set();
function onSnapshotError(area) {
  return (err) => {
    const expected = err && err.code === "permission-denied" && myRole === "agencia"
      && ["Mala", "Tarefas", "Gastos", "Histórico"].includes(area);
    if (expected) return;
    console.warn(`Erro ao carregar ${area}:`, err);
    try { if (window.Sentry && window.Sentry.captureException) window.Sentry.captureException(err); } catch (e) { /* ignora */ }
    if (snapshotErrorShown.has(area)) return;
    snapshotErrorShown.add(area);
    showToast(`Não foi possível carregar ${area} agora. Atualize a página pra tentar de novo.`, "error");
  };
}
// Abre uma viagem tratando erro (ex: acesso cancelado) — mesmo padrão já usado
// nos cards de "Suas Viagens", agora também no Painel da Agência e no
// "entrar por código" (QA #14).
function openTripSafely(tripId) {
  return openTrip(tripId).catch((err) => {
    reportActionError("Não foi possível abrir essa viagem — o acesso pode ter sido cancelado ou removido. Atualize a página.", err);
  });
}

function updateParticipantRole(tripRef, email, role, extra = {}) {
  const args = [new FieldPath("participantRoles", email), role];
  Object.entries(extra).forEach(([key, value]) => args.push(key, value));
  return updateDoc(tripRef, ...args);
}

// ================= PERMISSÕES (papéis) =================
let myRole = "colaborador";

const ROLE_PERMS = {
  admin:       { viewCalendar: 1, editCalendar: 1, viewMala: 1, editMala: "all", viewTarefas: 1, editTarefas: "all", viewDocs: 1, editDocs: 1, viewHistorico: 1, addReminder: 1, addParticipant: true, removeParticipant: true, promote: true, editTrip: true, deleteTrip: true, reset: true },
  colaborador: { viewCalendar: 1, editCalendar: 1, viewMala: 1, editMala: "all", viewTarefas: 1, editTarefas: "all", viewDocs: 1, editDocs: 1, viewHistorico: 1, addReminder: 1, addParticipant: true, removeParticipant: true, promote: false, editTrip: true, deleteTrip: false, reset: false },
  agencia:     { viewCalendar: 1, editCalendar: 1, viewMala: 0, editMala: "none", viewTarefas: 0, editTarefas: "none", viewDocs: 1, editDocs: 1, viewHistorico: 0, addReminder: 0, addParticipant: "beforeTripStart", removeParticipant: false, promote: false, editTrip: false, deleteTrip: false, reset: false },
  convidado:   { viewCalendar: 1, editCalendar: 0, viewMala: 1, editMala: "own", viewTarefas: 1, editTarefas: "toggle", viewDocs: 1, editDocs: 1, viewHistorico: 1, addReminder: 1, addParticipant: false, removeParticipant: false, promote: false, editTrip: false, deleteTrip: false, reset: false }
};
const ROLE_ORDER = ["admin", "colaborador", "agencia", "convidado"];

function myPerms() {
  return ROLE_PERMS[myRole] || ROLE_PERMS.colaborador;
}
function can(action) {
  return !!myPerms()[action];
}
// Fase 4 (18/set/2026): Agência só enxerga (Itinerário/Estadia/Documentos/
// Contatos) o que ela mesma criou — usado tanto pra filtrar a lista quanto
// pra decidir se mostra "nenhum item" (sem isso, sobrariam itens do
// cliente contados como se a Agência devesse vê-los).
function agencyOwnershipVisible(data) {
  return myRole !== "agencia" || data.createdByRole === "agencia";
}
function canAddParticipant() {
  const val = myPerms().addParticipant;
  if (val === true) return true;
  if (val === "beforeTripStart") {
    return currentTripData && localISODate() < currentTripData.startDate;
  }
  return false;
}
function computeMyRole() {
  if (!currentTripData || !currentUser) return "colaborador";
  const roles = currentTripData.participantRoles || {};
  const claimed = roles[currentUser.email] || "colaborador";
  if (claimed === "admin") {
    const admins = currentTripData.adminEmails || [];
    return admins.includes(currentUser.email) ? "admin" : "colaborador";
  }
  return claimed;
}
function roleLabel(role) {
  return t("role." + (role || "colaborador"));
}

function applyRolePermissions() {
  // Abas: Agência enxerga Calendário, Itinerário, Estadia, Documentos e
  // Contatos de Emergência (Fase 4, 18/set/2026 — só o que ela mesma
  // criou nas duas últimas). Mala, Tarefas, Gastos e Histórico continuam
  // fora do alcance da Agência.
  const restrictedTabs = ["mala", "tarefas", "gastos", "historico"];
  document.querySelectorAll(".tab").forEach((btn) => {
    const tabName = btn.dataset.tab;
    const hide = !can("viewCalendar") ? false : (myRole === "agencia" && restrictedTabs.includes(tabName));
    btn.classList.toggle("hidden", hide);
  });

  // Botões de adicionar item, por aba.
  $("addItinerarioToggleBtn")?.classList.toggle("hidden", !can("editCalendar"));
  $("bulkImportSwitch")?.closest(".card")?.classList.toggle("hidden", !can("editCalendar"));
  if (!can("editCalendar")) $("bulkImportForm")?.classList.add("hidden");
  $("addEstadiaToggleBtn")?.classList.toggle("hidden", !can("editCalendar"));
  $("addDocToggleBtn")?.classList.toggle("hidden", myPerms().editDocs !== 1 && myPerms().editDocs !== true);
  $("addExpenseToggleBtn")?.classList.toggle("hidden", myPerms().editDocs !== 1 && myPerms().editDocs !== true);
  $("addEmergencyToggleBtn")?.classList.toggle("hidden", myPerms().editDocs !== 1 && myPerms().editDocs !== true);
  $("addTaskToggleBtn")?.classList.toggle("hidden", myPerms().editTarefas !== "all");
  $("addItemBtn")?.classList.toggle("hidden", myPerms().editMala === "none");
  $("newItemName")?.classList.toggle("hidden", myPerms().editMala === "none");
  $("defaultListTogglePersonal")?.classList.toggle("hidden", myPerms().editMala === "none");
  $("defaultListToggleShared")?.classList.toggle("hidden", myPerms().editMala === "none");

  // Ações administrativas.
  $("resetAppBtn")?.classList.toggle("hidden", !can("reset"));
}

// ================= IDIOMA =================
const LS_LANG_KEY = "kipu_lang";
let currentLang = localStorage.getItem(LS_LANG_KEY) || DEFAULT_LANG;
if (!SUPPORTED_LANGS.includes(currentLang)) currentLang = DEFAULT_LANG;

function t(key) {
  return (translations[currentLang] && translations[currentLang][key])
    || translations[DEFAULT_LANG][key]
    || key;
}

function applyLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = DEFAULT_LANG;
  currentLang = lang;
  localStorage.setItem(LS_LANG_KEY, lang);
  document.documentElement.lang = lang === "pt" ? "pt-BR" : lang;

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.innerHTML = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    el.placeholder = t(key);
  });
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === lang);
  });

  // Re-renderiza listas já carregadas, pra badges/mensagens dinâmicas
  // acompanharem o novo idioma na hora. Só faz sentido (e só é seguro)
  // quando já tem uma viagem aberta — protegido com try/catch pra nunca
  // travar o resto do app se algo aqui falhar.
  if (appIsOpen) {
    try {
      if (typeof renderMalaList === "function") renderMalaList();
      if (typeof renderExpenses === "function") renderExpenses();
    } catch (err) {
      console.warn("Não foi possível re-renderizar listas ao trocar idioma:", err);
    }
  }
}

document.querySelectorAll(".lang-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyLanguage(btn.dataset.lang));
});
applyLanguage(currentLang);

// ================= TEMA (cor do app) =================
const LS_THEME_KEY = "kipu_theme";
const VALID_THEMES = ["default", "forest", "volcanic", "night"];
let currentTheme = localStorage.getItem(LS_THEME_KEY) || "default";
if (!VALID_THEMES.includes(currentTheme)) currentTheme = "default";

function applyTheme(theme) {
  if (!VALID_THEMES.includes(theme)) theme = "default";
  currentTheme = theme;
  localStorage.setItem(LS_THEME_KEY, theme);
  if (theme === "default") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
  document.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
}

document.querySelectorAll(".theme-swatch").forEach((btn) => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
});
applyTheme(currentTheme);

// ================= ORDEM DAS ABAS (personalização por pessoa) =================
// "Hoje" fica sempre fixa em primeiro (ver seção 5.3 da doc) — só as demais
// abas são reordenáveis, uma preferência por pessoa (users/{email}.tabOrder),
// não por aparelho, pra acompanhar quem usa o Kipu em mais de um lugar.
const REORDERABLE_TABS = ["geral", "itinerario", "estadia", "documentos", "mala", "tarefas", "gastos", "emergencia", "historico"];
const TAB_NAV_KEYS = {
  geral: "nav.calendar", itinerario: "nav.itinerary", estadia: "nav.stay",
  documentos: "nav.documents", mala: "nav.packing", tarefas: "nav.tasks",
  gastos: "nav.expenses", emergencia: "nav.emergency", historico: "nav.history"
};
let myTabOrder = [...REORDERABLE_TABS];

function sanitizeTabOrder(arr) {
  if (!Array.isArray(arr)) return [...REORDERABLE_TABS];
  const valid = arr.filter((id) => REORDERABLE_TABS.includes(id));
  // Aba nova que a gente adicionar no futuro entra no fim, sem quebrar quem já customizou.
  const missing = REORDERABLE_TABS.filter((id) => !valid.includes(id));
  return [...valid, ...missing];
}

function applyTabOrderToNav() {
  const nav = $("tabNav");
  if (!nav) return;
  ["hoje", ...myTabOrder].forEach((id) => {
    const btn = nav.querySelector(`.tab[data-tab="${id}"]`);
    if (btn) nav.appendChild(btn);
  });
}

async function saveTabOrder() {
  if (!currentUser) return;
  try {
    await setDoc(doc(db, "users", currentUser.email), { tabOrder: myTabOrder }, { merge: true });
  } catch (err) {
    console.warn("Não foi possível salvar a ordem das abas:", err);
  }
}

function renderTabOrderEditor() {
  const listEl = $("tabOrderList");
  if (!listEl) return;

  listEl.innerHTML = myTabOrder.map((id, idx) => `
    <div class="list-row" data-tab-id="${id}" style="padding:8px 4px;">
      <span class="card-meta" style="color:var(--ink); font-size:13px; display:flex; align-items:center; gap:9px;">
        <span class="tab-order-num">${idx + 1}</span>
        ${t(TAB_NAV_KEYS[id])}
      </span>
      <div style="display:flex; gap:2px;">
        <button class="icon-btn" data-dir="up" ${idx === 0 ? "disabled" : ""} title="↑">↑</button>
        <button class="icon-btn" data-dir="down" ${idx === myTabOrder.length - 1 ? "disabled" : ""} title="↓">↓</button>
      </div>
    </div>`).join("");

  listEl.querySelectorAll("[data-dir]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-tab-id]");
      const id = row.dataset.tabId;
      const idx = myTabOrder.indexOf(id);
      const swapWith = btn.dataset.dir === "up" ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= myTabOrder.length) return;
      [myTabOrder[idx], myTabOrder[swapWith]] = [myTabOrder[swapWith], myTabOrder[idx]];
      saveTabOrder();
      renderTabOrderEditor();
      applyTabOrderToNav();
    });
  });
}


// ================= PWA: instalação =================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

(function setupInstallBanner() {
  // Tudo isso é só pra celular — instalar como app não faz muito sentido no
  // desktop pro caso de uso do Kipu (viagem, uso no bolso).
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!isMobile) return;

  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (isStandalone) return; // já instalado — nem banner nem botão fazem sentido

  const LS_DISMISS_KEY = "kipu_install_dismissed_date";
  const banner = document.getElementById("installBanner");
  const textEl = document.getElementById("installBannerText");
  const actionBtn = document.getElementById("installBannerActionBtn");
  const closeBtn = document.getElementById("installBannerCloseBtn");
  const profileSection = document.getElementById("profileInstallSection");
  const profileBtn = document.getElementById("profileInstallBtn");

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  let deferredPrompt = null;

  // Botão do perfil: sempre visível (enquanto não instalado), é o caminho
  // permanente pra quem fechou o banner e mudou de ideia depois.
  profileSection.classList.remove("hidden");

  function hideInstallUI() {
    banner.classList.add("hidden");
    profileSection.classList.add("hidden");
  }
  // Se a pessoa instalar por qualquer caminho (nosso botão, o menu do
  // navegador, etc.), some com tudo na hora, sem precisar recarregar.
  window.addEventListener("appinstalled", hideInstallUI);

  function wasDismissedToday() {
    return localStorage.getItem(LS_DISMISS_KEY) === localISODate();
  }
  function showBanner() { if (!wasDismissedToday()) banner.classList.remove("hidden"); }
  // Fechar só esconde por hoje — volta a aparecer no dia seguinte, enquanto
  // não for instalado de verdade. O botão do perfil continua disponível o
  // tempo todo, sem esperar o dia seguinte.
  function dismissBanner() {
    banner.classList.add("hidden");
    localStorage.setItem(LS_DISMISS_KEY, localISODate());
  }

  closeBtn.addEventListener("click", dismissBanner);

  if (isIOS) {
    const iosMessage = "📲 Instale o Kipu: toque em Compartilhar e depois em \"Adicionar à Tela de Início\".";
    textEl.textContent = iosMessage;
    actionBtn.textContent = "Entendi";
    actionBtn.addEventListener("click", dismissBanner);
    showBanner();
    profileBtn.addEventListener("click", () => showToast(iosMessage, "info"));
  } else {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      showBanner();
    });
    async function triggerInstall() {
      if (!deferredPrompt) {
        showToast("Pra instalar: abra o menu (⋮) do navegador e procure \"Instalar app\" ou \"Adicionar à tela inicial\".", "info");
        return;
      }
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (choice.outcome === "accepted") hideInstallUI();
      else dismissBanner();
    }
    actionBtn.addEventListener("click", triggerInstall);
    profileBtn.addEventListener("click", triggerInstall);
  }
})();

// ---------- Estado global ----------
let currentUser = null;
let currentTripId = null;
let currentTripData = null;
// Se o e-mail logado for membro de alguma agência, guarda o doc dela aqui
// (id + dados). null = usuário comum, cai na tela normal "Suas Viagens".
let currentAgency = null;
let malaSeg = "shared";
let unsubscribers = [];
let calendarViewDate = null; // Date — mês sendo exibido
let selectedCalDate = null;  // string YYYY-MM-DD selecionada
let allUserTrips = [];       // todas as viagens onde o usuário é participante

// ---------- Helpers de tela ----------
const $ = (id) => document.getElementById(id);
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

// Aviso estilizado (UX #1, 19/set/2026) — substitui showToast() nativo do
// navegador em toda a aplicação. type: "warning" (padrão, validação de
// formulário), "error" (falha real de uma ação) ou "info" (aviso neutro).
function showToast(message, type = "warning") {
  const container = document.getElementById("toastContainer");
  if (!container) { alert(message); return; }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

// Trava o botão E troca o texto por um aviso de "salvando" (UX #3,
// 19/set/2026) — antes disso, nenhuma ação dava sinal nenhum entre o
// clique e o resultado aparecer, o que podia parecer que o app travou
// numa conexão mais lenta.
function setButtonLoading(btn, loading, loadingText = "Salvando...") {
  if (!btn) return;
  if (loading) {
    if (btn.dataset.originalText === undefined) btn.dataset.originalText = btn.textContent;
    btn.textContent = loadingText;
    btn.disabled = true;
  } else {
    btn.disabled = false;
    if (btn.dataset.originalText !== undefined) {
      btn.textContent = btn.dataset.originalText;
      delete btn.dataset.originalText;
    }
  }
}

function confirmDialog(message, okText = "Excluir") {
  return new Promise((resolve) => {
    const overlay = $("confirmModal");
    const okBtn = $("confirmModalOkBtn");
    const cancelBtn = $("confirmModalCancelBtn");
    $("confirmModalMessage").textContent = message;
    okBtn.textContent = okText;
    overlay.classList.remove("hidden");

    function cleanup(result) {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// QA #5: versão com aviso de erro na tela (a lógica está em deleteItemImpl).
function deleteItem(...args) {
  return withErrorToast(deleteItemImpl, "Não foi possível excluir. Tenta de novo em instantes.")(...args);
}
async function deleteItemImpl(subcollection, id, label, area, storagePath) {
  const ok = await confirmDialog(`Excluir "${label}"? Essa ação não pode ser desfeita.`);
  if (!ok) return;
  if (storagePath) {
    await deleteObject(ref(storage, storagePath)).catch(() => {});
  }
  await deleteDoc(doc(db, "trips", currentTripId, subcollection, id));
  logActivity(area, "item excluído", label);
}

function mapLink(address) {
  if (!address || !address.trim()) return "";
  const url = `https://maps.google.com/maps?q=${encodeURIComponent(address.trim())}`;
  return `<a href="${url}" target="_blank" rel="noopener" class="map-link" onclick="event.stopPropagation()">📍 Ver no mapa</a>`;
}

function googleCalendarUrl(it) {
  if (!it.date) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const dateCompact = it.date.replace(/-/g, "");
  let startStr, endStr;

  if (it.time) {
    const [sh, sm] = it.time.split(":").map(Number);
    startStr = `${dateCompact}T${pad(sh)}${pad(sm)}00`;
    let eh = sh + 1, em = sm;
    if (it.endTime) {
      const [ph, pm] = it.endTime.split(":").map(Number);
      eh = ph; em = pm;
    }
    endStr = `${dateCompact}T${pad(eh % 24)}${pad(em)}00`;
  } else {
    const [y, m, d] = it.date.split("-").map(Number);
    const start = new Date(y, m - 1, d);
    const end = new Date(y, m - 1, d + 1);
    const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
    startStr = fmt(start);
    endStr = fmt(end);
  }

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: it.title || "",
    dates: `${startStr}/${endStr}`
  });
  if (it.location) params.set("location", it.location);
  const detailParts = [];
  if (it.value) detailParts.push(`Valor: R$ ${Number(it.value).toFixed(2)}`);
  if (it.responsible) detailParts.push(`Responsável: ${nameFor(it.responsible)}`);
  if (detailParts.length) params.set("details", detailParts.join(" · "));

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function calendarLink(it) {
  const url = googleCalendarUrl(it);
  if (!url) return "";
  return `<a href="${url}" target="_blank" rel="noopener" class="map-link" onclick="event.stopPropagation()">📅 ${t("itinerary.addToCalendar")}</a>`;
}


function fmtDate(d) {
  if (!d) return "";
  const [y, m, day] = String(d).split("-");
  return escapeHtml(`${day}/${m}`); // data vem do banco — escapada por segurança (QA #1)
}

// Soma dias a uma data "YYYY-MM-DD" sem cair em bug de fuso — cria a data
// como meia-noite LOCAL (não UTC), igual ao princípio do localISODate().
function addDaysISO(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return localISODate(d);
}

// Bug reportado 18/set/2026: dava pra escolher data de fim ANTES (ou igual)
// da data de início nos dois formulários de criação de viagem. Trava o
// próprio calendário (min) e corrige o valor se já tiver algo inválido
// selecionado — funciona pra quem usa o seletor visual.
function wireDateRange(startInput, endInput) {
  startInput.addEventListener("change", () => {
    if (!startInput.value) { endInput.removeAttribute("min"); return; }
    // Fim pode ser no mesmo dia do início (viagem de 1 dia — QA #12).
    endInput.min = startInput.value;
    if (endInput.value && endInput.value < startInput.value) {
      endInput.value = startInput.value;
    }
  });
}

// ---------- Log de atividades ----------
async function logActivity(area, action, description) {
  if (!currentTripId || !currentUser) return;
  try {
    await addDoc(collection(db, "trips", currentTripId, "activityLog"), {
      authorEmail: currentUser.email,
      area, action, description,
      timestamp: serverTimestamp()
    });
  } catch (err) {
    console.warn("Não foi possível registrar no histórico:", err);
  }
}

// ---------- Autenticação ----------
$("loginBtn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    showToast("Erro ao entrar. Tenta de novo em instantes.", "error"); console.warn("Erro ao entrar:", err);
  }
});
$("logoutBtn").addEventListener("click", () => signOut(auth));
$("logoutBtn2").addEventListener("click", () => signOut(auth));

const LS_TRIP_KEY = "kipu_last_trip_id";
const LS_TAB_KEY = "kipu_last_tab";

let myDisplayName = null;
let participantNames = {}; // email -> nome

function nameFor(email) {
  if (!email) return "";
  return participantNames[email] || email;
}

async function loadParticipantNames(emails) {
  participantNames = {};
  await Promise.all((emails || []).map(async (email) => {
    try {
      const snap = await getDoc(doc(db, "users", email));
      if (snap.exists() && snap.data().name) participantNames[email] = snap.data().name;
    } catch (err) { /* segue sem nome pra esse e-mail */ }
  }));
}

function showNameModal({ prefill = "", skipText = null, isEdit = false } = {}) {
  return new Promise((resolve) => {
    $("profileNameInput").value = prefill;
    if (skipText) $("profileNameSkipBtn").textContent = skipText;
    $("modalTitleText").textContent = isEdit ? t("profile.editTitle") : t("profile.title");
    $("modalDescText").textContent = isEdit ? t("profile.editDesc") : t("profile.desc");
    $("nameModal").classList.remove("hidden");
    $("profileNameInput").focus();
    renderTabOrderEditor();

    const onSkip = () => { cleanup(); resolve(null); };
    const onSave = async () => {
      const name = $("profileNameInput").value.trim();
      if (name) {
        await setDoc(doc(db, "users", currentUser.email), { name, email: currentUser.email }, { merge: true });
        myDisplayName = name;
      }
      cleanup();
      resolve(name || null);
    };
    const onEnter = (e) => { if (e.key === "Enter") onSave(); };
    function cleanup() {
      $("nameModal").classList.add("hidden");
      $("profileNameSkipBtn").removeEventListener("click", onSkip);
      $("profileNameSaveBtn").removeEventListener("click", onSave);
      $("profileNameInput").removeEventListener("keydown", onEnter);
    }
    $("profileNameSkipBtn").addEventListener("click", onSkip);
    $("profileNameSaveBtn").addEventListener("click", onSave);
    $("profileNameInput").addEventListener("keydown", onEnter);
  });
}

function checkAndPromptProfile() {
  return new Promise(async (resolve) => {
    try {
      const snap = await getDoc(doc(db, "users", currentUser.email));
      if (snap.exists()) {
        const data = snap.data();
        if (data.tabOrder) myTabOrder = sanitizeTabOrder(data.tabOrder);
        applyTabOrderToNav();
        if (data.name) {
          myDisplayName = data.name;
          resolve();
          return;
        }
      }
    } catch (err) {
      console.warn("Não foi possível checar o perfil:", err);
      resolve();
      return;
    }
    await showNameModal({ prefill: "" });
    resolve();
  });
}

$("profileBtn")?.addEventListener("click", async () => {
  await showNameModal({ prefill: myDisplayName || "", skipText: t("common.cancel"), isEdit: true });
  $("userEmailLabel").textContent = myDisplayName || currentUser.email;
  $("userEmailLabel").title = currentUser.email;
});

// Se o link tiver ?code=XXXX (vem do e-mail de convite), pula direto pra
// tela de entrar na viagem com o código já preenchido, em vez de abrir a
// última viagem salva no navegador.
const inviteCodeFromUrl = new URLSearchParams(window.location.search).get("code");

// Consulta se o e-mail logado é membro de alguma agência (Fase 2,
// 18/set/2026). Roda uma vez por login só; se der erro (ex: doc de
// agência ainda não existe pra ninguém), trata como usuário comum —
// nunca trava o login por causa disso.
async function detectAgencyMembership(email) {
  try {
    const snap = await getDocs(query(collection(db, "agencies"), where("memberEmails", "array-contains", email)));
    if (!snap.empty) {
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    }
  } catch (err) {
    console.warn("Não foi possível checar vínculo de agência:", err);
  }
  return null;
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    hide($("loginScreen"));
    checkAndPromptProfile().then(async () => {
      $("userEmailLabel").textContent = myDisplayName || user.email;
      $("userEmailLabel").title = user.email;
      currentAgency = await detectAgencyMembership(user.email);
      if (inviteCodeFromUrl) {
        goToTripPicker();
        $("joinCodeInput").value = inviteCodeFromUrl;
        history.replaceState({}, "", window.location.pathname);
        return;
      }
      const savedTripId = localStorage.getItem(LS_TRIP_KEY);
      if (savedTripId) {
        openTrip(savedTripId).catch(() => {
          localStorage.removeItem(LS_TRIP_KEY);
          goToTripPicker();
        });
      } else {
        goToTripPicker();
      }
    });
  } else {
    show($("loginScreen"));
    hide($("tripPickerScreen"));
    hide($("appScreen"));
    currentAgency = null;
  }
});

// ---------- Seleção / criação de viagem ----------
function goToTripPicker() {
  appIsOpen = false;
  clearSubscriptions();
  currentTripId = null;
  localStorage.removeItem(LS_TRIP_KEY);
  hide($("appScreen"));
  show($("tripPickerScreen"));
  if (currentAgency) {
    hide($("normalTripPickerContent"));
    show($("agencyPanel"));
    $("tripPickerTitle").textContent = currentAgency.name || "Painel da Agência";
    loadAgencyPanel();
  } else {
    hide($("agencyPanel"));
    show($("normalTripPickerContent"));
    $("tripPickerTitle").textContent = t("picker.title");
    loadTripList();
  }
}

// Busca sempre tentando o servidor primeiro (nunca cache desatualizado do
// dispositivo) — só cai pro cache se estiver de fato sem internet. Corrige
// o bug de 19/set/2026: viagem cancelada ainda aparecendo na lista do
// celular por causa de dado antigo guardado localmente.
async function getDocsFreshFirst(q) {
  try {
    return await getDocsFromServer(q);
  } catch (err) {
    // QA (25/set/2026): antes, QUALQUER erro caía pro cache — inclusive
    // "acesso negado", o que escondia problema de regra atrás de dado velho.
    // Agora só usa o cache quando é mesmo falta de conexão.
    const offline = err && (err.code === "unavailable" || (typeof navigator !== "undefined" && navigator.onLine === false));
    if (!offline) throw err;
    console.warn("Sem conexão com o servidor agora, usando cache local:", err);
    return await getDocs(q);
  }
}

// Ordem de "Suas Viagens" (26/set/2026): a viagem criada por último vem
// primeiro. Viagem antiga sem createdAt vai pro fim, pela data de início
// (mais recente primeiro). Sem isso, o Firestore devolvia pela ordem do ID
// interno do documento, que é aleatória.
function compareTripsNewestFirst(a, b) {
  const ta = a.data().createdAt, tb = b.data().createdAt;
  const ma = ta && typeof ta.toMillis === "function" ? ta.toMillis() : null;
  const mb = tb && typeof tb.toMillis === "function" ? tb.toMillis() : null;
  if (ma !== null && mb !== null) return mb - ma;
  if (ma !== null) return -1;
  if (mb !== null) return 1;
  return (b.data().startDate || "").localeCompare(a.data().startDate || "");
}

async function loadTripList() {
  const listEl = $("tripList");
  listEl.innerHTML = "<div class='empty'>Carregando...</div>";
  const q = query(collection(db, "trips"), where("participantEmails", "array-contains", currentUser.email));
  let snap;
  try {
    snap = await getDocsFreshFirst(q);
  } catch (err) {
    console.warn("Não foi possível carregar a lista de viagens:", err);
    listEl.innerHTML = "<div class='empty'>Não foi possível carregar suas viagens agora. Atualize a página pra tentar de novo.</div>";
    return;
  }
  // QA #3 / bug 8.17 (25/set/2026): viagem cancelada pela agência não
  // aparece mais na lista de quem não é da agência (o acesso já era negado
  // pela regra — só o card continuava aparecendo).
  const visibleDocs = snap.docs
    .filter((d) => d.data().agencyCancelled !== true)
    .sort(compareTripsNewestFirst); // mais recente primeiro (26/set/2026)
  if (visibleDocs.length === 0) {
    listEl.innerHTML = `<div class='empty'>${t("empty.noTrips")}</div>`;
    return;
  }
  listEl.innerHTML = "";
  visibleDocs.forEach((d) => {
    const trip = d.data();
    const claimedRole = (trip.participantRoles || {})[currentUser.email] || (trip.participantRoles ? "colaborador" : "admin");
    const isRealAdmin = !trip.participantRoles || (trip.adminEmails || []).includes(currentUser.email);
    const myTripRole = claimedRole === "admin" && !isRealAdmin ? "colaborador" : claimedRole;
    const card = document.createElement("div");
    card.className = "trip-card";
    card.innerHTML = `
      <div class="card-row">
        <div>
          <div class="trip-card-title">${escapeHtml(trip.name)}</div>
          <div class="trip-card-meta">${escapeHtml(trip.destination || "")} · ${fmtDate(trip.startDate)} – ${fmtDate(trip.endDate)}</div>
        </div>
        ${myTripRole === "admin" ? `<button class="icon-btn" data-admin-gear title="Gerenciar viagem" aria-label="Gerenciar viagem" style="flex:0 0 auto;">⚙️</button>` : ""}
      </div>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-admin-gear]")) return;
      openTrip(d.id).catch((err) => {
        console.warn("Não foi possível abrir a viagem:", err);
        showToast("Não foi possível abrir essa viagem — o acesso pode ter sido cancelado ou removido. Atualize a página pra ver a lista certinha.", "error");
        loadTripList();
      });
    });
    const gearBtn = card.querySelector("[data-admin-gear]");
    if (gearBtn) gearBtn.addEventListener("click", (e) => { e.stopPropagation(); openAdminPanel(d.id); });
    listEl.appendChild(card);
  });
}

$("showNewTripFormBtn").addEventListener("click", () => {
  $("newTripForm").classList.toggle("hidden");
});
wireDateRange($("tripStart"), $("tripEnd"));

// Código pra CRIAR viagem — a checagem de verdade agora mora só no
// firestore.rules (nunca vai pro GitHub público, diferente deste
// arquivo). O app não sabe mais qual é o valor certo — só manda o que a
// pessoa digitou e deixa o Firestore aceitar ou recusar. Corrigido em
// 19/set/2026 (achado de segurança #1): antes esse código era comparado
// aqui mesmo, visível pra qualquer um que abrisse o código-fonte, e a
// regra do Firestore nem chegava a checar nada — não era proteção real.

// ================= AGÊNCIAS (Fase 1 — fundação, 17/set/2026) =================
// Planos (ARQ-3, 26/set/2026): a tabela de planos NÃO fica mais escrita no
// código — mora na coleção plans/{planId} do Firestore (label, maxUsers,
// maxActiveTrips, priceBRL; -1 = ilimitado), a mesma que o firestore.rules
// usa pra travar o limite. Mudar um plano = editar o documento no Console,
// e o app e as regras passam a usar o valor novo juntos. (O e-mail master
// também saiu daqui: não era usado no app; nas regras ele fica só na função
// isMaster().)
let currentAgencyPlan = null; // plano da agência logada, lido do Firestore

function normalizePlan(data) {
  const limit = (v) => (typeof v === "number" && v >= 0 ? v : Infinity);
  return {
    label: data.label || "",
    maxUsers: limit(data.maxUsers),
    maxActiveTrips: limit(data.maxActiveTrips),
    priceBRL: data.priceBRL
  };
}

// Lê o plano da agência. Devolve null se não achar (planId errado, sem
// conexão...) — nesse caso o painel avisa e bloqueia "Criar nova viagem",
// em vez de assumir um plano qualquer.
async function loadAgencyPlan(planId) {
  if (!planId) return null;
  try {
    const snap = await getDoc(doc(db, "plans", planId));
    return snap.exists() ? normalizePlan(snap.data()) : null;
  } catch (err) {
    console.warn("Não foi possível carregar o plano da agência:", err);
    return null;
  }
}

// Convite por e-mail — grava um documento na coleção "mail", que a extensão
// "Trigger Email" do Firebase observa e envia sozinha pelo provedor SMTP
// configurado no Console (Gmail por enquanto, Resend depois de ter domínio
// próprio — troca é só na configuração da extensão, não aqui). Se a
// extensão ainda não estiver instalada, esse addDoc só fica parado na
// coleção sem nenhum efeito — nunca trava o resto do fluxo.
function sendInviteEmail(toEmail, tripName, tripId, inviterName) {
  const joinLink = `https://dids7.github.io/kipu/?code=${tripId}`;
  const html = `
    <div style="font-family:'Public Sans',Arial,sans-serif; max-width:480px; margin:0 auto; background:#0f1927; padding:32px 24px; border-radius:16px; color:#f4ede1;">
      <div style="font-size:13px; letter-spacing:0.08em; text-transform:uppercase; color:#d4a750; margin-bottom:6px;">Kipu</div>
      <h1 style="font-size:22px; margin:0 0 16px; color:#f4ede1;">Você foi convidado(a) pra uma viagem! 🎒</h1>
      <p style="font-size:15px; line-height:1.6; margin:0 0 16px;"><strong>${escapeHtml(inviterName)}</strong> te chamou pra <strong>"${escapeHtml(tripName)}"</strong> no Kipu — o app onde a gente organiza tudo junto: itinerário, hospedagem, documentos, mala, gastos e mais, sem precisar ficar mandando mensagem separada pra cada coisa.</p>
      <a href="${joinLink}" style="display:inline-block; background:#d4a750; color:#0f1927; font-weight:700; text-decoration:none; padding:12px 24px; border-radius:8px; margin:8px 0 20px;">Entrar na viagem →</a>
      <p style="font-size:13px; line-height:1.6; color:#a9b4c0; margin:0 0 20px;">Se o botão não funcionar, copie e cole este link no navegador:<br>${joinLink}</p>
      <p style="font-size:12px; color:#6b7684; margin:0;">Você recebeu este e-mail porque foi adicionado(a) como participante desta viagem no Kipu.</p>
    </div>
  `;
  return addDoc(collection(db, "mail"), {
    to: toEmail,
    message: { subject: `${inviterName} te convidou pra "${tripName}" 🎒`, html }
  }).catch(() => {});
}

$("createTripBtn").addEventListener("click", async () => {
  const name = $("tripName").value.trim();
  const destination = $("tripDestination").value.trim();
  const startDate = $("tripStart").value;
  const endDate = $("tripEnd").value;
  const emailsRaw = $("tripParticipants").value.trim();
  const code = $("tripCreationCode").value.trim();
  $("tripCreationCodeError").classList.add("hidden");
  if (!name || !startDate || !endDate || !emailsRaw || !code) {
    showToast("Preencha nome, datas, ao menos um participante e o código de criação.");
    return;
  }
  if (endDate < startDate) { // viagem de 1 dia (fim = início) é permitida — QA #12
    showToast("A data de fim não pode ser antes da data de início.");
    return;
  }
  const participantEmails = emailsRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const myEmail = currentUser.email.toLowerCase();
  if (!participantEmails.includes(myEmail)) {
    participantEmails.push(myEmail);
  }
  const participantRoles = {};
  participantEmails.forEach((e) => { participantRoles[e] = e === myEmail ? "admin" : "colaborador"; });
  let docRef;
  setButtonLoading($("createTripBtn"), true);
  try {
    docRef = await addDoc(collection(db, "trips"), {
      name, destination, startDate, endDate,
      participantEmails,
      participantRoles,
      adminEmails: [myEmail],
      blockedEmails: [],
      defaultJoinRole: "colaborador",
      createdBy: currentUser.email,
      createdAt: serverTimestamp(),
      creationCode: code
    });
  } catch (err) {
    // A regra do Firestore recusou — na prática, quase sempre é o código
    // de criação errado (é a única checagem extra que ela faz aqui).
    $("tripCreationCodeError").classList.remove("hidden");
    setButtonLoading($("createTripBtn"), false);
    return;
  }
  // Log simples de quem criou o quê — não trava a criação da viagem se falhar.
  addDoc(collection(db, "tripCreationLog"), {
    tripId: docRef.id, tripName: name, createdBy: currentUser.email, createdAt: serverTimestamp()
  }).catch(() => {});
  // Convite por e-mail pros demais participantes (não pra mim mesmo).
  participantEmails.filter((e) => e !== myEmail).forEach((e) => {
    sendInviteEmail(e, name, docRef.id, myDisplayName || currentUser.email);
  });
  $("newTripForm").classList.add("hidden");
  $("tripName").value = ""; $("tripDestination").value = "";
  $("tripStart").value = ""; $("tripEnd").value = ""; $("tripParticipants").value = ""; $("tripCreationCode").value = "";
  setButtonLoading($("createTripBtn"), false);
  openTrip(docRef.id);
});

// Igual a logActivity(), mas pra registrar em uma viagem que não é
// necessariamente a que está aberta agora (usado pelo Painel da Agência,
// que mexe em viagens sem "entrar" nelas). Melhor esforço — nunca trava
// a ação principal se o registro falhar.
function logActivityFor(tripId, area, action, description) {
  return addDoc(collection(db, "trips", tripId, "activityLog"), {
    authorEmail: currentUser.email,
    area, action, description,
    timestamp: serverTimestamp()
  }).catch((err) => console.warn("Não foi possível registrar no histórico:", err));
}

// ================= PAINEL DA AGÊNCIA (Fase 2, 18/set/2026) =================

$("showAgencyNewTripFormBtn")?.addEventListener("click", () => {
  $("agencyNewTripForm").classList.toggle("hidden");
});
wireDateRange($("agencyTripStart"), $("agencyTripEnd"));
if ($("editTripStart") && $("editTripEnd")) wireDateRange($("editTripStart"), $("editTripEnd")); // QA #8

// Mantém o contador de viagens ativas coerente com a regra (QA #2, 25/set/2026):
// só existem DUAS formas de uma viagem deixar de ocupar vaga — ela terminar
// (desliga sozinha aqui) ou a agência cancelar (botão "Cancelar"). Não existe
// mais desligar manualmente. Roda toda vez que o Painel da Agência abre, e faz
// duas coisas, cada uma numa transação (grava viagem + contador juntos, ou
// nada — e se dois funcionários abrirem o painel ao mesmo tempo, só um deles
// efetivamente mexe no contador, sem descontar em dobro):
// 1. Viagem encerrada que ainda contava → desliga (-1).
// 2. Viagem não cancelada, ainda não terminada, que estava fora da contagem
//    (resíduo do switch manual antigo) → volta a contar (+1). Pode deixar a
//    agência temporariamente acima do limite; nesse caso ela só não cria
//    viagem nova até alguma terminar ou ser cancelada.
// Devolve quanto o contador mudou no total, pra tela atualizar sem recarregar.
async function syncAgencyTripCounters(agencyId, trips) {
  const today = localISODate();
  let delta = 0;
  for (const trip of trips) {
    const ended = !!(trip.endDate && trip.endDate < today);
    const shouldCount = !trip.agencyCancelled && !ended;
    if (!!trip.countsTowardLimit === shouldCount) continue;
    try {
      const changed = await runTransaction(db, async (tx) => {
        const tripRef = doc(db, "trips", trip.id);
        const fresh = await tx.get(tripRef);
        if (!fresh.exists()) return false;
        const data = fresh.data();
        const freshEnded = !!(data.endDate && data.endDate < today);
        const freshShould = !data.agencyCancelled && !freshEnded;
        if (!!data.countsTowardLimit === freshShould) return false; // outra sessão já ajustou
        tx.update(tripRef, { countsTowardLimit: freshShould });
        tx.update(doc(db, "agencies", agencyId), { activeTripsCount: increment(freshShould ? 1 : -1), lastCounterTripId: trip.id });
        return true;
      });
      if (changed) {
        delta += shouldCount ? 1 : -1;
        logActivityFor(trip.id, "agencia", shouldCount ? "auto-on" : "auto-off",
          shouldCount ? "Contador religado automaticamente (viagem ativa estava fora da contagem)."
                      : "Contador desligado automaticamente (viagem encerrada).");
      }
      trip.countsTowardLimit = shouldCount;
    } catch (err) {
      console.warn("Não foi possível ajustar o contador da viagem:", err);
    }
  }
  return delta;
}

let lastAgencyTrips = []; // cache do último fetch, pra "Ver histórico" não precisar recarregar do banco

// Card compacto: título/meta à esquerda, controles empilhados à direita
// — uma linha só, em vez de duas.
function buildTripCardRight(trip, started) {
  if (trip.agencyCancelled) {
    return `<button class="btn btn-outline btn-small" data-reactivate-trip type="button">Reativar</button>`;
  }
  // Sem switch manual (QA #2): a vaga só abre quando a viagem termina ou é cancelada.
  return !started ? `<button class="btn btn-outline btn-small" data-cancel-trip type="button">Cancelar</button>` : "";
}

function renderAgencyTripCard(trip, container) {
  const agencyId = currentAgency.id;
  const today = localISODate();
  const started = trip.startDate && today >= trip.startDate;
  const card = document.createElement("div");
  card.className = "trip-card";
  let statusBadge = "";
  if (!trip.agencyCancelled && !trip.countsTowardLimit) statusBadge = "⚪ encerrada — não conta no limite";
  card.innerHTML = `
    <div class="card-row">
      <div>
        <div class="trip-card-title">${escapeHtml(trip.name)}</div>
        <div class="trip-card-status" style="visibility:${statusBadge ? "visible" : "hidden"};">${statusBadge || "&nbsp;"}</div>
        <div class="trip-card-meta">${escapeHtml(trip.destination || "")} · ${fmtDate(trip.startDate)} – ${fmtDate(trip.endDate)}</div>
      </div>
      ${buildTripCardRight(trip, started)}
    </div>
  `;
  card.addEventListener("click", (e) => {
    if (e.target.closest("[data-cancel-trip], [data-reactivate-trip]")) return;
    openTripSafely(trip.id);
  });
  const cancelBtn = card.querySelector("[data-cancel-trip]");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog(`Cancelar "${trip.name}"? Ela sai da lista principal (vai pro Histórico) e ninguém fora da agência continua tendo acesso.`, "Cancelar viagem");
      if (!ok) return;
      try {
        // Transação: marca cancelada + libera a vaga juntos (ou nada), e só
        // desconta se a viagem ainda contava de fato no banco.
        const freed = await runTransaction(db, async (tx) => {
          const tripRef = doc(db, "trips", trip.id);
          const fresh = await tx.get(tripRef);
          if (!fresh.exists()) throw new Error("Viagem não encontrada.");
          const data = fresh.data();
          if (data.agencyCancelled) return false; // já cancelada por outra sessão
          const wasCounting = !!data.countsTowardLimit;
          tx.update(tripRef, wasCounting ? { agencyCancelled: true, countsTowardLimit: false } : { agencyCancelled: true });
          if (wasCounting) tx.update(doc(db, "agencies", agencyId), { activeTripsCount: increment(-1), lastCounterTripId: trip.id });
          return wasCounting;
        });
        if (freed) currentAgency.activeTripsCount = Math.max(0, (currentAgency.activeTripsCount || 0) - 1);
        logActivityFor(trip.id, "agencia", "cancel", "Viagem cancelada pela agência — acesso bloqueado pra quem não é da agência.");
        trip.agencyCancelled = true;
        trip.countsTowardLimit = false;
        renderAgencyStatsUI();
        renderAgencyLists();
      } catch (err) {
        showToast("Não foi possível cancelar a viagem. Tenta de novo em instantes.", "error"); console.warn("Não foi possível cancelar a viagem:", err);
      }
    });
  }
  const reactivateBtn = card.querySelector("[data-reactivate-trip]");
  if (reactivateBtn) {
    reactivateBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const alreadyEnded = !!(trip.endDate && trip.endDate < localISODate());
      const ok = await confirmDialog(
        alreadyEnded
          ? `Reativar "${trip.name}"? Ela volta pra lista principal e todo mundo recupera o acesso. Como a viagem já terminou, ela não ocupa vaga no plano.`
          : `Reativar "${trip.name}"? Ela volta pra lista principal, todo mundo recupera o acesso, e ela volta a ocupar 1 vaga de viagem ativa no plano.`,
        "Reativar"
      );
      if (!ok) return;
      // QA #2: reativar volta a contar no limite (senão, cancelar + reativar
      // viraria um jeito de ter viagem ativa sem ocupar vaga). Transação: lê o
      // contador atual da agência, confere a vaga e grava viagem + contador juntos.
      const plan = currentAgencyPlan;
      if (!plan) {
        showToast("Não foi possível carregar o plano da agência. Atualize a página e tente de novo.", "error");
        return;
      }
      try {
        const result = await runTransaction(db, async (tx) => {
          const tripRef = doc(db, "trips", trip.id);
          const agencyRef = doc(db, "agencies", agencyId);
          const freshTrip = await tx.get(tripRef);
          const freshAgency = await tx.get(agencyRef);
          if (!freshTrip.exists() || !freshAgency.exists()) throw new Error("Viagem ou agência não encontrada.");
          const data = freshTrip.data();
          if (!data.agencyCancelled) return "already";
          const ended = !!(data.endDate && data.endDate < localISODate());
          if (ended) {
            tx.update(tripRef, { agencyCancelled: false, countsTowardLimit: false });
            return "ok-no-count";
          }
          const activeNow = freshAgency.data().activeTripsCount || 0;
          if (plan.maxActiveTrips !== Infinity && activeNow >= plan.maxActiveTrips) return "no-slot";
          tx.update(tripRef, { agencyCancelled: false, countsTowardLimit: true });
          tx.update(agencyRef, { activeTripsCount: increment(1), lastCounterTripId: trip.id });
          return "ok-counted";
        });
        if (result === "no-slot") {
          showToast("Sem vaga no plano agora — cancele outra viagem que ainda não começou, espere alguma terminar, ou fale com a gente sobre upgrade.", "warning");
          return;
        }
        if (result === "ok-counted") {
          currentAgency.activeTripsCount = (currentAgency.activeTripsCount || 0) + 1;
          trip.countsTowardLimit = true;
          logActivityFor(trip.id, "agencia", "reactivate", "Viagem reativada pela agência — cancelamento desfeito, voltou a contar no limite.");
        } else if (result === "ok-no-count") {
          trip.countsTowardLimit = false;
          logActivityFor(trip.id, "agencia", "reactivate", "Viagem reativada pela agência — cancelamento desfeito (já encerrada, não conta no limite).");
        }
        trip.agencyCancelled = false;
        renderAgencyStatsUI();
        renderAgencyLists();
      } catch (err) {
        showToast("Não foi possível reativar a viagem. Tenta de novo em instantes.", "error"); console.warn("Não foi possível reativar a viagem:", err);
      }
    });
  }
  container.appendChild(card);
}

// Redesenha as duas listas (principal + histórico) a partir do cache
// (lastAgencyTrips) — sem tocar no Firestore. É isso que faz o botão
// "Ver histórico" abrir/fechar na hora, sem piscar.
function renderAgencyLists() {
  const listEl = $("agencyTripList");
  const historyListEl = $("agencyHistoryList");
  const activeTrips = lastAgencyTrips.filter((tr) => !tr.agencyCancelled).sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
  const cancelledTrips = lastAgencyTrips.filter((tr) => tr.agencyCancelled).sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));

  $("showAgencyHistoryBtn").textContent = `📜 Ver histórico (${cancelledTrips.length})`;

  listEl.innerHTML = activeTrips.length === 0 ? "<div class='empty'>Nenhuma viagem criada ainda.</div>" : "";
  activeTrips.forEach((trip) => renderAgencyTripCard(trip, listEl));

  if (!historyListEl.classList.contains("hidden")) {
    historyListEl.innerHTML = cancelledTrips.length === 0 ? "<div class='empty'>Nenhuma viagem cancelada.</div>" : "";
    cancelledTrips.forEach((trip) => renderAgencyTripCard(trip, historyListEl));
  }

  renderAgencyExtraMetrics(activeTrips);
}

// Métricas "bater o olho" do Dashboard da Agência (Achado de Produto #1,
// 19/set/2026; ajustado em seguida a pedido de Diego — tirou taxa de
// cancelamento e destino mais usado, e pediu o mesmo padrão visual dos
// contadores já existentes em vez de texto solto).
function renderAgencyExtraMetrics(activeTrips) {
  const today = localISODate();
  const ongoing = activeTrips.filter((tr) => tr.startDate <= today && tr.endDate >= today);
  const upcoming7 = activeTrips.filter((tr) => tr.startDate > today && tr.startDate <= addDaysISO(today, 7));
  const nextTrip = activeTrips
    .filter((tr) => tr.startDate > today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];

  $("agencyStatOngoingValue").textContent = ongoing.length;
  $("agencyStatUpcomingValue").textContent = upcoming7.length;

  const nextCard = $("agencyNextTripCard");
  if (nextTrip) {
    nextCard.style.display = "block";
    $("agencyNextTripName").textContent = nextTrip.name;
    $("agencyNextTripDate").textContent = `${nextTrip.destination || ""} · ${fmtDate(nextTrip.startDate)} – ${fmtDate(nextTrip.endDate)}`;
  } else {
    nextCard.style.display = "none";
  }
}

// Atualiza só os cards de contador (usuários/viagens ativas) a partir do
// que já está em currentAgency — sem buscar nada no Firestore.
function renderAgencyStatsUI() {
  const memberCount = (currentAgency.memberEmails || []).length;
  const plan = currentAgencyPlan;
  if (!plan) {
    // Plano não encontrado (planId errado no cadastro, ou sem conexão): não
    // assume nenhum plano — avisa e bloqueia a criação até resolver.
    $("agencyPanelName").textContent = currentAgency.name || "Agência";
    $("agencyPanelPlanName").textContent = "Plano não encontrado";
    $("agencyStatUsersValue").textContent = String(memberCount);
    $("agencyStatTripsValue").textContent = String(currentAgency.activeTripsCount || 0);
    const warnEl = $("agencyPanelLimitWarning");
    warnEl.style.display = "block";
    warnEl.textContent = "Não foi possível carregar o plano da sua agência. Atualize a página; se continuar, fale com a gente.";
    $("agencyCreateTripBtn").disabled = true;
    return;
  }
  const activeCount = currentAgency.activeTripsCount || 0;

  $("agencyPanelName").textContent = currentAgency.name || "Agência";
  $("agencyPanelPlanName").textContent = `Plano ${plan.label}`;
  const maxUsersLabel = plan.maxUsers === Infinity ? "∞" : plan.maxUsers;
  const maxTripsLabel = plan.maxActiveTrips === Infinity ? "∞" : plan.maxActiveTrips;

  const usersBox = $("agencyStatUsersBox");
  $("agencyStatUsersValue").innerHTML = `${memberCount}<span class="agency-stat-max">/${maxUsersLabel}</span>`;
  usersBox.classList.toggle("at-limit", plan.maxUsers !== Infinity && memberCount >= plan.maxUsers);

  const atLimit = plan.maxActiveTrips !== Infinity && activeCount >= plan.maxActiveTrips;
  const tripsBox = $("agencyStatTripsBox");
  $("agencyStatTripsValue").innerHTML = `${activeCount}<span class="agency-stat-max">/${maxTripsLabel}</span>`;
  tripsBox.classList.toggle("at-limit", atLimit);

  const warnEl = $("agencyPanelLimitWarning");
  if (atLimit) {
    warnEl.style.display = "block";
    warnEl.textContent = "Limite de viagens ativas do plano atingido — a vaga abre quando uma viagem terminar ou for cancelada (antes de começar).";
  } else {
    warnEl.style.display = "none";
  }
  $("agencyCreateTripBtn").disabled = atLimit;
}

async function loadAgencyPanel() {
  const agencyId = currentAgency.id;
  // Recarrega o doc da agência (contadores podem ter mudado desde o login).
  try {
    const freshSnap = await getDoc(doc(db, "agencies", agencyId));
    if (freshSnap.exists()) currentAgency = { id: agencyId, ...freshSnap.data() };
  } catch (err) {
    console.warn("Não foi possível atualizar dados da agência:", err);
  }
  currentAgencyPlan = await loadAgencyPlan(currentAgency.planId);
  renderAgencyStatsUI();

  $("agencyTripList").innerHTML = "<div class='empty'>Carregando...</div>";
  const snap = await getDocsFreshFirst(query(collection(db, "trips"), where("agencyId", "==", agencyId)));
  const allTrips = [];
  snap.forEach((d) => allTrips.push({ id: d.id, ...d.data() }));

  const counterDelta = await syncAgencyTripCounters(agencyId, allTrips);
  if (counterDelta !== 0) {
    currentAgency.activeTripsCount = Math.max(0, (currentAgency.activeTripsCount || 0) + counterDelta);
    renderAgencyStatsUI();
  }
  lastAgencyTrips = allTrips;
  renderAgencyLists();
}

$("showAgencyHistoryBtn")?.addEventListener("click", () => {
  $("agencyHistoryList").classList.toggle("hidden");
  renderAgencyLists();
});

$("agencyCreateTripBtn")?.addEventListener("click", async () => {
  const statusEl = $("agencyTripFormStatus");
  statusEl.classList.add("hidden");
  const name = $("agencyTripName").value.trim();
  const destination = $("agencyTripDestination").value.trim();
  const startDate = $("agencyTripStart").value;
  const endDate = $("agencyTripEnd").value;
  const clientEmail = $("agencyTripClientEmail").value.trim().toLowerCase();
  if (!name || !startDate || !endDate || !clientEmail) {
    statusEl.textContent = "Preencha nome, datas e o e-mail do cliente.";
    statusEl.classList.remove("hidden");
    return;
  }
  if (endDate < startDate) { // viagem de 1 dia (fim = início) é permitida — QA #12
    statusEl.textContent = "A data de fim não pode ser antes da data de início.";
    statusEl.classList.remove("hidden");
    return;
  }
  const agencyId = currentAgency.id;
  const myEmail = currentUser.email.toLowerCase();
  const participantEmails = [clientEmail, myEmail];
  const participantRoles = { [clientEmail]: "admin", [myEmail]: "agencia" };
  setButtonLoading($("agencyCreateTripBtn"), true);
  try {
    // QA Rodada C (25/set/2026): viagem + contador gravados JUNTOS numa
    // operação só (writeBatch) — ou grava tudo, ou nada. O ID da viagem é
    // gerado antes, pra agência poder "assinar" no contador qual viagem
    // causou o +1 (lastCounterTripId) — a regra do Firestore confere isso.
    const docRef = doc(collection(db, "trips"));
    const batch = writeBatch(db);
    batch.set(docRef, {
      name, destination, startDate, endDate,
      participantEmails,
      participantRoles,
      adminEmails: [clientEmail],
      blockedEmails: [],
      defaultJoinRole: "colaborador",
      createdBy: clientEmail,
      createdAt: serverTimestamp(),
      agencyId,
      countsTowardLimit: true,
      agencyCancelled: false
    });
    batch.update(doc(db, "agencies", agencyId), {
      activeTripsCount: increment(1),
      totalTripsCreated: increment(1),
      lastCounterTripId: docRef.id
    });
    await batch.commit();
    // Total histórico geral (Painel Master, Fase 5) — melhor esforço, não
    // trava a criação da viagem se o doc stats/global ainda não existir.
    updateDoc(doc(db, "stats", "global"), { totalTripsAllTime: increment(1) }).catch(() => {});
    logActivityFor(docRef.id, "agencia", "create", `Viagem criada pela agência "${currentAgency.name || agencyId}".`);
    sendInviteEmail(clientEmail, name, docRef.id, currentAgency.name || myDisplayName || currentUser.email);
    $("agencyNewTripForm").classList.add("hidden");
    $("agencyTripName").value = ""; $("agencyTripDestination").value = "";
    $("agencyTripStart").value = ""; $("agencyTripEnd").value = ""; $("agencyTripClientEmail").value = "";
    loadAgencyPanel();
  } catch (err) {
    statusEl.textContent = "Erro ao criar viagem. Confira os dados e tente de novo.";
    console.warn("Erro ao criar viagem pela agência:", err);
    statusEl.classList.remove("hidden");
    setButtonLoading($("agencyCreateTripBtn"), false);
  }
});

$("joinCodeBtn").addEventListener("click", async () => {
  const statusEl = $("joinCodeStatus");
  const code = $("joinCodeInput").value.trim();
  statusEl.classList.remove("hidden");
  if (!code) { statusEl.textContent = "Cole o código da viagem primeiro."; return; }

  statusEl.textContent = "Procurando viagem...";
  try {
    const snap = await getDoc(doc(db, "trips", code));
    if (!snap.exists()) { statusEl.textContent = "Código não encontrado. Confira se copiou certinho."; return; }
    const tripData = { id: snap.id, ...snap.data() };

    const myEmail = currentUser.email.toLowerCase();
    if ((tripData.participantEmails || []).map((e) => e.toLowerCase()).includes(myEmail)) {
      statusEl.textContent = `Você já faz parte de "${tripData.name}" — abrindo...`;
      openTripSafely(tripData.id);
      return;
    }
    if ((tripData.blockedEmails || []).map((e) => e.toLowerCase()).includes(myEmail)) {
      statusEl.textContent = "Você foi removido dessa viagem. Peça pra alguém te adicionar de novo manualmente.";
      return;
    }

    statusEl.textContent = `Encontrado: "${tripData.name}". Entrando...`;
    const joinRole = tripData.defaultJoinRole || "colaborador";
    await updateParticipantRole(doc(db, "trips", tripData.id), myEmail, joinRole, {
      participantEmails: arrayUnion(myEmail)
    });
    $("joinCodeInput").value = "";
    openTripSafely(tripData.id);
  } catch (err) {
    statusEl.textContent = "Não foi possível entrar. Confira o código e tente de novo.";
    console.error("Erro ao entrar com código:", err);
  }
});

$("backToTripsBtn").addEventListener("click", goToTripPicker);

// ---------- Abrir viagem ----------
// ================= PAINEL DE ADMIN =================
let adminPanelTripId = null;
let adminPanelTripData = null;

async function openAdminPanel(tripId) {
  const snap = await getDoc(doc(db, "trips", tripId));
  if (!snap.exists()) return;
  adminPanelTripId = tripId;
  adminPanelTripData = { id: tripId, ...snap.data() };
  if (!adminPanelTripData.participantRoles || !adminPanelTripData.adminEmails) {
    const legacyRoles = adminPanelTripData.participantRoles || {};
    (adminPanelTripData.participantEmails || []).forEach((e) => { if (!legacyRoles[e]) legacyRoles[e] = "admin"; });
    adminPanelTripData.participantRoles = legacyRoles;
    adminPanelTripData.adminEmails = adminPanelTripData.adminEmails || adminPanelTripData.participantEmails || [];
    adminPanelTripData.blockedEmails = adminPanelTripData.blockedEmails || [];
    adminPanelTripData.defaultJoinRole = adminPanelTripData.defaultJoinRole || "colaborador";
    try {
      await updateDoc(doc(db, "trips", tripId), {
        participantRoles: legacyRoles,
        adminEmails: adminPanelTripData.adminEmails,
        blockedEmails: adminPanelTripData.blockedEmails,
        defaultJoinRole: adminPanelTripData.defaultJoinRole
      });
    } catch (err) {
      console.warn("Não foi possível migrar papéis dessa viagem agora:", err);
    }
  }
  await loadParticipantNames(adminPanelTripData.participantEmails);
  $("adminPanelTripName").textContent = adminPanelTripData.name;
  $("adminDefaultJoinRole").value = adminPanelTripData.defaultJoinRole || "colaborador";
  renderAdminParticipants();
  $("adminPanelModal").classList.remove("hidden");
}

function renderAdminParticipants() {
  const listEl = $("adminParticipantsList");
  const emails = adminPanelTripData.participantEmails || [];
  const roles = adminPanelTripData.participantRoles || {};
  listEl.innerHTML = "";
  emails.forEach((email) => {
    const isOriginalAdmin = email === adminPanelTripData.createdBy;
    const role = roles[email] || "colaborador";
    const row = document.createElement("div");
    row.className = "list-row";
    row.style.padding = "8px 0";
    row.innerHTML = `
      <span class="card-meta" title="${escapeHtml(email)}">${escapeHtml(nameFor(email))} ${isOriginalAdmin ? "🔒" : ""}</span>
      <div style="display:flex; align-items:center; gap:6px;">
        <select data-role-select ${isOriginalAdmin ? "disabled" : ""} style="width:auto; font-size:11px; padding:5px 7px;">
          <option value="admin" data-i18n="role.admin">Admin</option>
          <option value="colaborador" data-i18n="role.colaborador">Colaborador</option>
          <option value="agencia" data-i18n="role.agencia">Agência</option>
          <option value="convidado" data-i18n="role.convidado">Convidado</option>
        </select>
        ${isOriginalAdmin ? `<button class="item-del" data-transfer title="Transferir titularidade">🔁</button>` : `<button class="item-del" data-remove>✕</button>`}
      </div>
    `;
    const select = row.querySelector("[data-role-select]");
    select.value = role;
    applyLanguageToElement(select);
    select.addEventListener("change", () => onAdminRoleChange(email, select.value, select));
    const removeBtn = row.querySelector("[data-remove]");
    if (removeBtn) removeBtn.addEventListener("click", () => onAdminRemoveParticipant(email));
    const transferBtn = row.querySelector("[data-transfer]");
    if (transferBtn) transferBtn.addEventListener("click", () => onAdminTransferOwnership(email));
    listEl.appendChild(row);
  });
}

function applyLanguageToElement(el) {
  el.querySelectorAll("[data-i18n]").forEach((opt) => { opt.textContent = t(opt.getAttribute("data-i18n")); });
}

// QA #5: versão com aviso de erro na tela (a lógica está em onAdminRoleChangeImpl).
function onAdminRoleChange(...args) {
  return withErrorToast(onAdminRoleChangeImpl, "Não foi possível mudar o papel. Atualize a página e tente de novo.")(...args);
}
async function onAdminRoleChangeImpl(email, newRole, selectEl) {
  if (newRole === "admin") {
    const ok = await new Promise((resolve) => {
      $("promoteConfirmMessage").textContent = `Tem certeza? Isso dá a ${nameFor(email)} o mesmo poder que você tem, incluindo excluir a viagem e resetar dados.`;
      $("promoteConfirmModal").classList.remove("hidden");
      const onYes = () => { cleanup(); resolve(true); };
      const onNo = () => { cleanup(); resolve(false); };
      function cleanup() {
        $("promoteConfirmModal").classList.add("hidden");
        $("promoteConfirmBtn").removeEventListener("click", onYes);
        $("promoteCancelBtn").removeEventListener("click", onNo);
      }
      $("promoteConfirmBtn").addEventListener("click", onYes);
      $("promoteCancelBtn").addEventListener("click", onNo);
    });
    if (!ok) { selectEl.value = adminPanelTripData.participantRoles[email] || "colaborador"; return; }
  }
  adminPanelTripData.participantRoles[email] = newRole;
  const patch = {};
  const currentAdmins = adminPanelTripData.adminEmails || [];
  if (newRole === "admin" && !currentAdmins.includes(email)) {
    adminPanelTripData.adminEmails = [...currentAdmins, email];
    patch.adminEmails = arrayUnion(email);
  } else if (newRole !== "admin" && currentAdmins.includes(email) && email !== adminPanelTripData.createdBy) {
    adminPanelTripData.adminEmails = currentAdmins.filter((e) => e !== email);
    patch.adminEmails = adminPanelTripData.adminEmails;
  }
  await updateParticipantRole(doc(db, "trips", adminPanelTripId), email, newRole, patch);
  logActivity("geral", "papel alterado", `${email} → ${roleLabel(newRole)}`);
  if (adminPanelTripId === currentTripId) {
    currentTripData.participantRoles = adminPanelTripData.participantRoles;
    currentTripData.adminEmails = adminPanelTripData.adminEmails;
    myRole = computeMyRole();
    applyRolePermissions();
  }
}

// QA #5: versão com aviso de erro na tela (a lógica está em onAdminRemoveParticipantImpl).
function onAdminRemoveParticipant(...args) {
  return withErrorToast(onAdminRemoveParticipantImpl, "Não foi possível remover o participante. Atualize a página e tente de novo.")(...args);
}
async function onAdminRemoveParticipantImpl(email) {
  const ok = await confirmDialog(`Remover ${email} da viagem?`);
  if (!ok) return;
  const updated = adminPanelTripData.participantEmails.filter((e) => e !== email);
  const updatedRoles = { ...adminPanelTripData.participantRoles };
  delete updatedRoles[email];
  const updatedAdmins = (adminPanelTripData.adminEmails || []).filter((e) => e !== email);
  const updatedBlocked = [...new Set([...(adminPanelTripData.blockedEmails || []), email])];
  await updateDoc(doc(db, "trips", adminPanelTripId), {
    participantEmails: updated, participantRoles: updatedRoles, adminEmails: updatedAdmins, blockedEmails: updatedBlocked
  });
  adminPanelTripData.participantEmails = updated;
  adminPanelTripData.participantRoles = updatedRoles;
  adminPanelTripData.adminEmails = updatedAdmins;
  adminPanelTripData.blockedEmails = updatedBlocked;
  renderAdminParticipants();
  logActivity("geral", "participante removido", email);
}

// Transferir a titularidade (createdBy) da viagem pra outro participante.
// O dono original nunca pode ser removido da viagem (proteção intencional,
// ver seção 4.1 da documentação) — isso trava quem ajudou a criar uma
// viagem que não é dela (ex: Admin criou pra um amigo entrar depois). Essa
// função move a proteção pra outra pessoa: o novo dono vira Admin (se ainda
// não for) e ganha o 🔒; quem tinha o 🔒 antes passa a poder ser removido
// normalmente, como qualquer outro participante.
function openTransferOwnerModal(currentOwnerEmail) {
  const others = (adminPanelTripData.participantEmails || []).filter((e) => e !== currentOwnerEmail);
  if (others.length === 0) {
    showToast("Adicione outra pessoa na viagem antes de transferir a titularidade.");
    return Promise.resolve(null);
  }
  const select = $("transferOwnerSelect");
  select.innerHTML = others.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(nameFor(e))}</option>`).join("");
  $("transferOwnerMessage").textContent =
    `Escolha quem vai virar o novo dono principal da viagem, no lugar de ${nameFor(currentOwnerEmail)}. ` +
    `Essa pessoa passa a ser Admin (se ainda não for) e ganha a proteção de nunca poder ser removida — ` +
    `${nameFor(currentOwnerEmail)} perde essa proteção e passa a poder ser removido(a) da viagem como qualquer outro participante.`;
  $("transferOwnerModal").classList.remove("hidden");

  return new Promise((resolve) => {
    const onYes = () => { cleanup(); resolve(select.value); };
    const onNo = () => { cleanup(); resolve(null); };
    function cleanup() {
      $("transferOwnerModal").classList.add("hidden");
      $("transferOwnerConfirmBtn").removeEventListener("click", onYes);
      $("transferOwnerCancelBtn").removeEventListener("click", onNo);
    }
    $("transferOwnerConfirmBtn").addEventListener("click", onYes);
    $("transferOwnerCancelBtn").addEventListener("click", onNo);
  });
}

// QA #5: versão com aviso de erro na tela (a lógica está em onAdminTransferOwnershipImpl).
function onAdminTransferOwnership(...args) {
  return withErrorToast(onAdminTransferOwnershipImpl, "Não foi possível transferir a titularidade. Atualize a página e tente de novo.")(...args);
}
async function onAdminTransferOwnershipImpl(currentOwnerEmail) {
  const newOwnerEmail = await openTransferOwnerModal(currentOwnerEmail);
  if (!newOwnerEmail) return;

  const patch = { createdBy: newOwnerEmail };
  const currentAdmins = adminPanelTripData.adminEmails || [];
  const alreadyAdmin = currentAdmins.includes(newOwnerEmail);
  if (!alreadyAdmin) patch.adminEmails = arrayUnion(newOwnerEmail);

  await updateParticipantRole(doc(db, "trips", adminPanelTripId), newOwnerEmail, "admin", patch);

  adminPanelTripData.createdBy = newOwnerEmail;
  adminPanelTripData.participantRoles[newOwnerEmail] = "admin";
  if (!alreadyAdmin) adminPanelTripData.adminEmails = [...currentAdmins, newOwnerEmail];
  renderAdminParticipants();
  logActivity("geral", "titularidade da viagem transferida", `${currentOwnerEmail} → ${newOwnerEmail}`);

  if (adminPanelTripId === currentTripId) {
    currentTripData.createdBy = adminPanelTripData.createdBy;
    currentTripData.participantRoles = adminPanelTripData.participantRoles;
    currentTripData.adminEmails = adminPanelTripData.adminEmails;
    myRole = computeMyRole();
    applyRolePermissions();
  }
}

$("adminAddParticipantBtn").addEventListener("click", async () => {
  const email = $("adminNewEmail").value.trim().toLowerCase();
  const role = $("adminNewRole").value;
  if (!email || !email.includes("@")) { showToast("Digite um e-mail válido."); return; }
  if ((adminPanelTripData.participantEmails || []).includes(email)) { showToast("Esse participante já está na viagem."); return; }
  const updated = [...(adminPanelTripData.participantEmails || []), email];
  const updatedRoles = { ...(adminPanelTripData.participantRoles || {}), [email]: role };
  const updatedBlocked = (adminPanelTripData.blockedEmails || []).filter((e) => e !== email);
  const patch = { participantEmails: updated, participantRoles: updatedRoles, blockedEmails: updatedBlocked };
  if (role === "admin") {
    adminPanelTripData.adminEmails = [...new Set([...(adminPanelTripData.adminEmails || []), email])];
    patch.adminEmails = adminPanelTripData.adminEmails;
  }
  await updateDoc(doc(db, "trips", adminPanelTripId), patch);
  adminPanelTripData.participantEmails = updated;
  adminPanelTripData.participantRoles = updatedRoles;
  adminPanelTripData.blockedEmails = updatedBlocked;
  await loadParticipantNames(adminPanelTripData.participantEmails);
  renderAdminParticipants();
  logActivity("geral", "participante adicionado", `${email} (${roleLabel(role)})`);
  $("adminNewEmail").value = "";
});

$("adminDefaultJoinRole").addEventListener("change", async () => {
  const role = $("adminDefaultJoinRole").value;
  await updateDoc(doc(db, "trips", adminPanelTripId), { defaultJoinRole: role });
  adminPanelTripData.defaultJoinRole = role;
  if (adminPanelTripId === currentTripId) currentTripData.defaultJoinRole = role;
});

$("adminPanelCloseBtn").addEventListener("click", () => {
  $("adminPanelModal").classList.add("hidden");
  loadTripList();
});

async function openTrip(tripId) {
  currentTripId = tripId;
  currentTripData = null;
  const snap = await getDocs(query(collection(db, "trips"), where("__name__", "==", tripId)));
  snap.forEach((d) => { currentTripData = d.data(); });

  if (!currentTripData) {
    throw new Error("Viagem não encontrada ou sem acesso.");
  }
  appIsOpen = true;

  // Migração: viagens criadas antes do sistema de papéis não têm
  // participantRoles ainda. Também cobre o caso de viagens que já tinham
  // sido migradas ANTES do campo travado adminEmails existir — nesse
  // caso participantRoles já existe, mas adminEmails ainda não, e sem
  // ele ninguém consegue mais ações de Admin de verdade.
  if (!currentTripData.participantRoles || !currentTripData.adminEmails) {
    const legacyRoles = currentTripData.participantRoles || {};
    (currentTripData.participantEmails || []).forEach((e) => { if (!legacyRoles[e]) legacyRoles[e] = "admin"; });
    const patch = {
      participantRoles: legacyRoles,
      adminEmails: currentTripData.adminEmails || currentTripData.participantEmails || [],
      blockedEmails: currentTripData.blockedEmails || [],
      defaultJoinRole: currentTripData.defaultJoinRole || "colaborador"
    };
    try {
      await updateDoc(doc(db, "trips", tripId), patch);
      currentTripData = { ...currentTripData, ...patch };
    } catch (err) {
      console.warn("Não foi possível migrar papéis dessa viagem agora:", err);
      currentTripData = { ...currentTripData, ...patch };
    }
  }
  myRole = computeMyRole();
  applyRolePermissions();

  localStorage.setItem(LS_TRIP_KEY, tripId);

  // Carrega todas as viagens do usuário, pra o calendário saber qual viagem
  // cobre cada data (pode ser esta ou outra, ex: Peru dia 4-12, Miami dia 22-26)
  const allSnap = await getDocs(query(collection(db, "trips"), where("participantEmails", "array-contains", currentUser.email)));
  allUserTrips = [];
  allSnap.forEach((d) => { if (d.data().agencyCancelled !== true) allUserTrips.push({ id: d.id, ...d.data() }); }); // canceladas ficam fora do calendário também (QA #3)

  await loadParticipantNames(currentTripData.participantEmails);

  hide($("tripPickerScreen"));
  show($("appScreen"));
  $("currentTripTitle").textContent = currentTripData.name;
  renderCountdown();
  renderHojeTab();
  fetchWeatherIfNeeded();
  initBulkImportToggle();
  populateResponsibleSelects();

  subscribeItinerario();
  subscribeDicas();
  subscribeEstadia();
  subscribeDocumentos();
  subscribeMala();
  subscribeTarefas();
  subscribeGastos();
  subscribeEmergencia();
  subscribeHistorico();
  subscribeReminders();
  autoFetchRates();

  calendarViewDate = new Date();
  selectedCalDate = null;
  hide($("dateTripInfoCard"));
  show($("dateEmptyState"));
  hide($("reminderEditor"));
  renderCalendar();

  // Sempre que o app É ABERTO numa viagem (login, seleção de viagem, ou volta
  // do fundo depois de muito tempo — o que dispara loadTrip de novo), cai na
  // aba "Hoje". Trocar de aba durante a sessão continua funcionando normal;
  // só a ENTRADA na viagem é fixa em "Hoje", não lembra a última aba usada.
  const tabBtn = document.querySelector('.tab[data-tab="hoje"]');
  if (tabBtn) tabBtn.click();
}

function clearSubscriptions() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
}

function findTripForDate(iso) {
  if (!currentTripData) return null;
  const inRange = iso >= currentTripData.startDate && iso <= currentTripData.endDate;
  return inRange ? { id: currentTripId, ...currentTripData } : null;
}

let currentDateTrip = null;

function updateDateTripInfo(iso) {
  const trip = findTripForDate(iso);
  const card = $("dateTripInfoCard");
  const emptyState = $("dateEmptyState");
  currentDateTrip = trip;
  if (!trip) { hide(card); show(emptyState); return; }
  hide(emptyState);
  show(card);
  $("dateTripNameLabel").textContent = trip.name;
  $("dateTripDestinoLabel").textContent = trip.destination || "—";
  const isCurrentTrip = trip.id === currentTripId;
  renderParticipants(trip, isCurrentTrip && can("removeParticipant"));
  $("participantEditRow").classList.toggle("hidden", !isCurrentTrip || !canAddParticipant());
  $("inviteCodeBlock").classList.toggle("hidden", !isCurrentTrip);
  $("editTripBtn").classList.toggle("hidden", !isCurrentTrip || !can("editTrip"));
  $("deleteTripBlock").classList.toggle("hidden", !isCurrentTrip || !can("deleteTrip"));
  $("editTripForm").classList.add("hidden");
  if (isCurrentTrip) $("inviteCodeValue").value = trip.id;
}

$("editTripBtn").addEventListener("click", () => {
  if (!currentDateTrip) return;
  $("editTripName").value = currentDateTrip.name || "";
  $("editTripDestination").value = currentDateTrip.destination || "";
  $("editTripStart").value = currentDateTrip.startDate || "";
  $("editTripEnd").value = currentDateTrip.endDate || "";
  $("editTripForm").classList.remove("hidden");
});
$("cancelTripEditBtn").addEventListener("click", () => {
  $("editTripForm").classList.add("hidden");
});
$("saveTripEditBtn").addEventListener("click", async () => {
  const name = $("editTripName").value.trim();
  const destination = $("editTripDestination").value.trim();
  const startDate = $("editTripStart").value;
  const endDate = $("editTripEnd").value;
  if (!name || !startDate || !endDate) { showToast("Preencha nome e as duas datas."); return; }
  if (endDate < startDate) { showToast("A data de fim não pode ser antes da data de início."); return; } // QA #8
  const destinationChanged = destination !== currentTripData.destination;
  try {
    await updateDoc(doc(db, "trips", currentTripId), { name, destination, startDate, endDate });
  } catch (err) {
    reportActionError("Não foi possível salvar a viagem. Tenta de novo em instantes.", err);
    return;
  }
  currentTripData = { ...currentTripData, name, destination, startDate, endDate };
  logActivity("geral", "viagem editada", `${name} (${startDate} – ${endDate})`);
  $("currentTripTitle").textContent = name;
  renderCountdown();
  renderHojeTab();
  if (destinationChanged) {
    localStorage.removeItem(`kipu_weather_v2_${currentTripId}`); // destino mudou, o clima cacheado não vale mais
    fetchWeatherIfNeeded();
  }
  const allIdx = allUserTrips.findIndex((t) => t.id === currentTripId);
  if (allIdx >= 0) allUserTrips[allIdx] = { ...allUserTrips[allIdx], name, destination, startDate, endDate };
  renderCalendar();
  if (selectedCalDate) updateDateTripInfo(selectedCalDate);
  $("editTripForm").classList.add("hidden");
});

$("deleteTripBtn").addEventListener("click", async () => {
  if (!currentDateTrip) return;
  const ok = await confirmDialog(
    `Excluir a viagem "${currentDateTrip.name}" de vez? Isso apaga TODO o conteúdo dela (itinerário, gastos, mala, tudo) para todo mundo. Não tem volta.`,
    "Excluir viagem"
  );
  if (!ok) return;

  const tripId = currentDateTrip.id;
  const subcollections = ["itinerario", "estadia", "documentos", "mala", "tarefas", "gastos", "emergencia", "activityLog", "lembretes"];
  for (const sub of subcollections) {
    const snap = await getDocs(collection(db, "trips", tripId, sub));
    await Promise.all(snap.docs.map(async (d) => {
      if (sub === "documentos") {
        const storagePath = d.data().storagePath;
        if (storagePath) await deleteObject(ref(storage, storagePath)).catch(() => {});
      }
      await deleteDoc(doc(db, "trips", tripId, sub, d.id));
    }));
  }
  await deleteDoc(doc(db, "trips", tripId));
  goToTripPicker();
});
$("copyInviteCodeBtn").addEventListener("click", async () => {
  const val = $("inviteCodeValue").value;
  try {
    await navigator.clipboard.writeText(val);
    $("copyInviteCodeBtn").textContent = "Copiado ✓";
    setTimeout(() => { $("copyInviteCodeBtn").textContent = "Copiar"; }, 1800);
  } catch {
    $("inviteCodeValue").select();
  }
});

function renderParticipants(trip, editable) {
  const listEl = $("participantsList");
  const emails = trip.participantEmails || [];
  const roles = trip.participantRoles || {};
  listEl.innerHTML = "";
  emails.forEach((email) => {
    const row = document.createElement("div");
    row.className = "list-row";
    const isLast = emails.length === 1;
    const isOriginalAdmin = email === trip.createdBy;
    const role = roles[email] || "colaborador";
    const canRemoveThis = editable && !isLast && !isOriginalAdmin;
    row.innerHTML = `
      <span class="card-meta" title="${escapeHtml(email)}">${escapeHtml(nameFor(email))} ${isOriginalAdmin ? "🔒" : ""}<span class="badge" style="margin-left:6px; font-size:9.5px; background:var(--panel-raised); color:var(--muted);">${escapeHtml(roleLabel(role))}</span></span>
      ${canRemoveThis ? `<button class="item-del">✕</button>` : isOriginalAdmin ? `<span class="card-meta" style="font-size:10px;" title="Admin original — não pode ser removido">🔒</span>` : ""}
    `;
    if (canRemoveThis) {
      row.querySelector("button").addEventListener("click", () => removeParticipant(email));
    }
    listEl.appendChild(row);
  });
}

// QA #5: versão com aviso de erro na tela (a lógica está em removeParticipantImpl).
function removeParticipant(...args) {
  return withErrorToast(removeParticipantImpl, "Não foi possível remover o participante. Atualize a página e tente de novo.")(...args);
}
async function removeParticipantImpl(email) {
  if (email === currentTripData.createdBy) {
    await confirmDialog("O Admin original não pode ser removido da viagem. Só excluindo a viagem inteira.", "Entendi");
    return;
  }
  const ok = await confirmDialog(`Remover ${email} da viagem?`);
  if (!ok) return;
  const updated = (currentTripData.participantEmails || []).filter((e) => e !== email);
  const updatedRoles = { ...(currentTripData.participantRoles || {}) };
  delete updatedRoles[email];
  const updatedAdmins = (currentTripData.adminEmails || []).filter((e) => e !== email);
  const updatedBlocked = [...new Set([...(currentTripData.blockedEmails || []), email])];
  await updateDoc(doc(db, "trips", currentTripId), {
    participantEmails: updated, participantRoles: updatedRoles, adminEmails: updatedAdmins, blockedEmails: updatedBlocked
  });
  currentTripData.participantEmails = updated;
  currentTripData.participantRoles = updatedRoles;
  currentTripData.adminEmails = updatedAdmins;
  currentTripData.blockedEmails = updatedBlocked;
  const idx = allUserTrips.findIndex((t) => t.id === currentTripId);
  if (idx >= 0) allUserTrips[idx].participantEmails = updated;
  await loadParticipantNames(currentTripData.participantEmails);
  if (selectedCalDate) updateDateTripInfo(selectedCalDate);
  populateResponsibleSelects();
  logActivity("geral", "participante removido", email);
}

$("addParticipantBtn").addEventListener("click", async () => {
  if (!canAddParticipant()) { showToast("Você não tem permissão pra adicionar participantes agora."); return; }
  const input = $("newParticipantEmail");
  const email = input.value.trim().toLowerCase();
  if (!email || !email.includes("@")) { showToast("Digite um e-mail válido."); return; }
  const current = currentTripData.participantEmails || [];
  if (current.includes(email)) { showToast("Esse participante já está na viagem."); input.value = ""; return; }
  const updated = [...current, email];
  const role = currentTripData.defaultJoinRole || "colaborador";
  const updatedRoles = { ...(currentTripData.participantRoles || {}), [email]: role };
  const updatedBlocked = (currentTripData.blockedEmails || []).filter((e) => e !== email);
  await updateDoc(doc(db, "trips", currentTripId), { participantEmails: updated, participantRoles: updatedRoles, blockedEmails: updatedBlocked });
  currentTripData.participantEmails = updated;
  currentTripData.participantRoles = updatedRoles;
  currentTripData.blockedEmails = updatedBlocked;
  sendInviteEmail(email, currentTripData.name, currentTripId, myDisplayName || currentUser.email);
  const idx = allUserTrips.findIndex((t) => t.id === currentTripId);
  if (idx >= 0) allUserTrips[idx].participantEmails = updated;
  await loadParticipantNames(currentTripData.participantEmails);
  if (selectedCalDate) updateDateTripInfo(selectedCalDate);
  populateResponsibleSelects();
  logActivity("geral", "participante adicionado", email);
  input.value = "";
});

// ================= CLIMA (Open-Meteo — grátis, sem chave de API) =================
// Mesmo padrão já usado pra cotação de câmbio: busca em API pública gratuita,
// cacheia no navegador (uma vez por dia), falha em silêncio se offline/indisponível
// — nunca trava o resto do app. Usa o campo "destination" (texto livre) da
// viagem pra geocodificar; cobre 1 local por viagem (o texto que já existe).
const WEATHER_CODE_KEYS = {
  0: "clear", 1: "partlyCloudy", 2: "partlyCloudy", 3: "cloudy",
  45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle", 56: "drizzle", 57: "drizzle",
  61: "rain", 63: "rain", 65: "rain", 66: "rain", 67: "rain",
  71: "snow", 73: "snow", 75: "snow", 77: "snow",
  80: "showers", 81: "showers", 82: "showers",
  85: "snowShowers", 86: "snowShowers",
  95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm"
};
const WEATHER_CODE_ICONS = {
  clear: "☀️", partlyCloudy: "⛅", cloudy: "☁️", fog: "🌫️", drizzle: "🌦️",
  rain: "🌧️", snow: "🌨️", showers: "🌦️", snowShowers: "🌨️", thunderstorm: "⛈️"
};
function weatherIcon(code) { return WEATHER_CODE_ICONS[WEATHER_CODE_KEYS[code]] || "🌡️"; }
function weatherLabel(code) { return t("weather." + (WEATHER_CODE_KEYS[code] || "clear")); }

let weatherData = null; // { current: {temp, code, todayMin, todayMax}, daily: [{date, min, max, code}, ...] }

async function fetchWeatherIfNeeded() {
  if (!currentTripData || !currentTripData.destination) return;
  const today = localISODate();
  const cacheKey = `kipu_weather_v2_${currentTripId}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.fetchedOn === today) {
        weatherData = parsed.data;
        renderHojeWeather();
        renderCalWeatherStrip();
        return;
      }
    } catch (err) { /* cache corrompido, ignora e busca de novo */ }
  }
  try {
    const coords = await geocodeDestination(currentTripData.destination);
    if (!coords) {
      console.warn(`Clima: não encontrei o destino "${currentTripData.destination}" na busca de localização. Tente deixar o campo Destino da viagem só com o nome da cidade (ex: "Cusco, Peru").`);
      renderWeatherUnavailable();
      return;
    }

    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code` +
      `&timezone=auto&forecast_days=6`
    );
    const data = await res.json();
    if (!data.current || !data.daily) { renderWeatherUnavailable(); return; }

    weatherData = {
      locationName: [coords.name, coords.admin1, coords.country].filter(Boolean).join(", "),
      lat: coords.lat, lon: coords.lon,
      current: { temp: Math.round(data.current.temperature_2m), code: data.current.weather_code },
      daily: data.daily.time.map((date, i) => ({
        date,
        min: Math.round(data.daily.temperature_2m_min[i]),
        max: Math.round(data.daily.temperature_2m_max[i]),
        code: data.daily.weather_code[i]
      }))
    };
    localStorage.setItem(cacheKey, JSON.stringify({ fetchedOn: today, data: weatherData }));
    renderHojeWeather();
    renderCalWeatherStrip();
  } catch (err) {
    console.warn("Não foi possível buscar o clima (offline?):", err);
    renderWeatherUnavailable();
  }
}

// Geocodifica um texto de destino em coordenadas (cacheado, já que o destino
// de uma viagem raramente muda). Tenta o texto inteiro primeiro; se não achar
// nada (comum quando o campo tem mais de um lugar, tipo "Cusco e Vale Sagrado"),
// tenta de novo só com o primeiro pedaço, separado por vírgula ou " e ".
async function geocodeDestination(rawDestination) {
  const attempts = [rawDestination];
  const simplified = rawDestination.split(/,| e |\/| - /i)[0].trim();
  if (simplified && simplified !== rawDestination) attempts.push(simplified);

  for (const attempt of attempts) {
    const geoCacheKey = `kipu_geo_v2_${encodeURIComponent(attempt)}`;
    const cachedCoords = JSON.parse(localStorage.getItem(geoCacheKey) || "null");
    if (cachedCoords) return cachedCoords;
    try {
      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=pt&name=${encodeURIComponent(attempt)}`);
      const geoData = await geoRes.json();
      if (geoData.results && geoData.results.length > 0) {
        const r = geoData.results[0];
        const coords = { lat: r.latitude, lon: r.longitude, name: r.name, admin1: r.admin1 || "", country: r.country || "" };
        localStorage.setItem(geoCacheKey, JSON.stringify(coords));
        return coords;
      }
    } catch (err) {
      console.warn(`Clima: falha ao geocodificar "${attempt}":`, err);
    }
  }
  return null;
}

function renderWeatherUnavailable() {
  const hojeEl = $("hojeWeatherCard");
  if (hojeEl) hojeEl.innerHTML = `<p class="screen-sub" style="margin-top:2px;">${t("weather.unavailable").replace("{destino}", escapeHtml(currentTripData.destination))}</p>`;
  const calEl = $("calWeatherStrip");
  if (calEl) calEl.innerHTML = "";
}

function renderHojeWeather() {
  const el = $("hojeWeatherCard");
  if (!el) return;
  if (!weatherData) { el.innerHTML = ""; return; }
  const todayForecast = weatherData.daily[0];
  const locationLabel = weatherData.locationName || currentTripData.destination;
  el.innerHTML = `
    <div class="weather-card">
      <div class="weather-icon">${weatherIcon(weatherData.current.code)}</div>
      <div>
        <div class="weather-temp">${weatherData.current.temp}°C</div>
        <div class="weather-desc" title="${weatherData.lat}, ${weatherData.lon}">${weatherLabel(weatherData.current.code)} · ${escapeHtml(locationLabel)}</div>
        ${todayForecast ? `<div class="weather-minmax">${t("weather.minMax").replace("{min}", todayForecast.min).replace("{max}", todayForecast.max)}</div>` : ""}
      </div>
    </div>`;
}

function renderCalWeatherStrip() {
  const el = $("calWeatherStrip");
  if (!el) return;
  if (!weatherData || !weatherData.daily.length) { el.innerHTML = ""; return; }
  const days = weatherData.daily.slice(1, 6); // próximos 5 dias, sem repetir o de hoje (já mostrado na aba Hoje)
  if (days.length === 0) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <div class="card-title" style="font-size:12.5px; color:var(--muted); margin-bottom:8px;">${t("weather.forecastTitle")}</div>
    <div class="forecast-strip">
      ${days.map((d) => `
        <div class="forecast-day">
          <div class="fd-date">${fmtDate(d.date)}</div>
          <div class="fd-icon">${weatherIcon(d.code)}</div>
          <div class="fd-temps">${d.max}° <span class="fd-min">${d.min}°</span></div>
        </div>`).join("")}
    </div>`;
}

function renderCountdown() {
  const start = new Date(currentTripData.startDate + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((start - today) / (1000 * 60 * 60 * 24));
  $("countdownNum").textContent = diff >= 0 ? diff : Math.abs(diff);
  $("countdownText").textContent = diff >= 0
    ? `dias para embarque · ${fmtDate(currentTripData.startDate)}–${fmtDate(currentTripData.endDate)}`
    : `dias desde o início da viagem`;
}

// ================= HOJE =================
// Aba de entrada: sempre que o app é aberto numa viagem, cai aqui — mostra só
// o que importa pro dia de hoje (itinerário + lembretes), sem precisar navegar.
function roleIntroDismissKey() {
  return `kipu_role_intro_${currentTripId}`;
}
// ================= FEEDBACK PÓS-VIAGEM =================
// Aparece no PENÚLTIMO dia da viagem (não no último — aí a pessoa ainda tem
// motivo de reabrir o app), em duas janelas de horário: meio-dia e 20h.
// Respondeu uma vez → nunca mais aparece. Só fechou sem responder → pode
// reaparecer na próxima janela (mas não fica repetindo dentro da mesma).
function dayBefore(dateISO) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return localISODate(d);
}
function feedbackDoneKey() { return `kipu_feedback_done_${currentTripId}`; }
function feedbackDismissedKey() { return `kipu_feedback_dismissed_${currentTripId}`; }

function maybeShowFeedbackPopup() {
  if (!currentTripData || !currentTripData.endDate || !currentTripId) return;
  if (!$("feedbackModal").classList.contains("hidden")) return; // já aberto, não reabre por cima
  // Viagem de 1 dia (QA #12): o "penúltimo dia" seria a véspera, antes do
  // passeio acontecer — então pergunta no próprio dia, só na janela da noite.
  const oneDayTrip = currentTripData.startDate === currentTripData.endDate;
  const feedbackDay = oneDayTrip ? currentTripData.endDate : dayBefore(currentTripData.endDate);
  if (localISODate() !== feedbackDay) return;
  const hour = new Date().getHours(); // hora local de quem está usando
  if (hour < (oneDayTrip ? 20 : 12)) return; // antes da primeira janela, nem checa o resto
  const windowName = hour >= 20 ? "evening" : "noon";
  if (localStorage.getItem(feedbackDoneKey())) return;
  if (localStorage.getItem(feedbackDismissedKey()) === windowName) return;
  showFeedbackModal(windowName);
}

let feedbackRatingValue = 0;
let feedbackAppRatingValue = 0;
function renderStarWidget(containerId, currentValue, onPick) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = [1, 2, 3, 4, 5].map((n) => {
    const active = n <= currentValue;
    return `<button data-star="${n}" style="width:38px; height:38px; border-radius:50%; border:1px solid ${active ? "var(--gold)" : "var(--line)"}; background:${active ? "var(--gold)" : "var(--panel-raised)"}; color:${active ? "#1B2430" : "var(--muted)"}; font-family:'JetBrains Mono',monospace; font-weight:700; font-size:14px; cursor:pointer;">${n}</button>`;
  }).join("");
  el.querySelectorAll("[data-star]").forEach((btn) => {
    btn.addEventListener("click", () => onPick(parseInt(btn.dataset.star, 10)));
  });
}
function renderFeedbackStars() {
  renderStarWidget("feedbackRating", feedbackRatingValue, (n) => { feedbackRatingValue = n; renderFeedbackStars(); });
  if (myRole === "admin") {
    renderStarWidget("feedbackAppRating", feedbackAppRatingValue, (n) => { feedbackAppRatingValue = n; renderFeedbackStars(); });
  }
}
function showFeedbackModal(windowName) {
  feedbackRatingValue = 0;
  feedbackAppRatingValue = 0;
  $("feedbackLiked").value = "";
  $("feedbackImprove").value = "";
  $("feedbackGroupComplaints").value = "";
  $("feedbackMissingFeatures").value = "";
  // Quem organiza (Admin/dono) vê perguntas extras — já ouviu reclamação
  // direto do grupo, consegue dar um retorno mais completo pro Kipu.
  const isAdmin = myRole === "admin";
  $("feedbackAdminExtra").classList.toggle("hidden", !isAdmin);
  renderFeedbackStars();
  $("feedbackModal").dataset.window = windowName;
  $("feedbackModal").classList.remove("hidden");
}
$("feedbackSkipBtn")?.addEventListener("click", () => {
  localStorage.setItem(feedbackDismissedKey(), $("feedbackModal").dataset.window || "noon");
  $("feedbackModal").classList.add("hidden");
});
$("feedbackSubmitBtn")?.addEventListener("click", async () => {
  if (feedbackRatingValue === 0) { showToast("Escolhe uma nota de 1 a 5 antes de enviar."); return; }
  const isAdmin = myRole === "admin";
  if (isAdmin && feedbackAppRatingValue === 0) { showToast("Escolhe também uma nota pro Kipu antes de enviar."); return; }
  setButtonLoading($("feedbackSubmitBtn"), true);
  try {
    const payload = {
      tripId: currentTripId,
      authorEmail: currentUser.email,
      nota: feedbackRatingValue,
      gostou: $("feedbackLiked").value.trim(),
      mudaria: $("feedbackImprove").value.trim(),
      createdAt: serverTimestamp()
    };
    if (isAdmin) {
      payload.notaApp = feedbackAppRatingValue;
      payload.reclamacoesDoGrupo = $("feedbackGroupComplaints").value.trim();
      payload.faltouNoApp = $("feedbackMissingFeatures").value.trim();
    }
    await addDoc(collection(db, "feedback"), payload);
    localStorage.setItem(feedbackDoneKey(), "1");
  } catch (err) {
    console.warn("Não foi possível enviar o feedback:", err);
  }
  setButtonLoading($("feedbackSubmitBtn"), false);
  $("feedbackModal").classList.add("hidden");
});

function maybeShowRoleIntro() {
  const banner = $("roleIntroBanner");
  // O Admin original já configurou a viagem inteira, não precisa de explicação.
  if (!currentTripData || currentUser.email === currentTripData.createdBy) { hide(banner); return; }
  if (localStorage.getItem(roleIntroDismissKey())) { hide(banner); return; }
  const key = "hoje.roleIntro." + (myRole || "colaborador");
  $("roleIntroText").textContent = t(key);
  show(banner);
}
$("roleIntroCloseBtn")?.addEventListener("click", () => {
  localStorage.setItem(roleIntroDismissKey(), "1");
  hide($("roleIntroBanner"));
});

function renderHojeTab() {
  if (!currentTripData) return;
  maybeShowRoleIntro();
  maybeShowFeedbackPopup();
  const todayISO = localISODate();
  const statusEl = $("hojeStatusLine");
  if (todayISO < currentTripData.startDate) {
    const diffDays = Math.ceil((new Date(currentTripData.startDate + "T00:00:00") - new Date(todayISO + "T00:00:00")) / 86400000);
    statusEl.textContent = t("hoje.beforeTrip").replace("{d}", diffDays);
    const isSoon = diffDays <= 7;
    statusEl.classList.toggle("countdown-hype", isSoon);
    if (isSoon) statusEl.textContent += " ✈️";
  } else if (todayISO > currentTripData.endDate) {
    statusEl.classList.remove("countdown-hype");
    statusEl.textContent = t("hoje.afterTrip");
  } else {
    statusEl.classList.remove("countdown-hype");
    const totalDays = Math.round((new Date(currentTripData.endDate + "T00:00:00") - new Date(currentTripData.startDate + "T00:00:00")) / 86400000) + 1;
    const dayNum = Math.round((new Date(todayISO + "T00:00:00") - new Date(currentTripData.startDate + "T00:00:00")) / 86400000) + 1;
    statusEl.textContent = t("hoje.duringTrip").replace("{day}", dayNum).replace("{total}", totalDays);
  }

  const itItems = itinerarioByDate[todayISO] || [];
  const itEl = $("hojeItineraryList");
  if (itItems.length === 0) {
    itEl.innerHTML = "";
  } else {
    itEl.innerHTML = `<div class="card-title" style="font-size:13px; margin:12px 0 8px;">📌 ${t("hoje.itineraryHeader")}</div>` +
      itItems.map((it) => {
        const hasValue = it.value && Number(it.value) > 0;
        return `
          <div class="card" data-itin-id="${escapeHtml(it.id)}" style="padding:12px 14px; margin-bottom:8px; cursor:pointer; border-left:4px solid var(--gold);">
            <div class="card-row">
              <div>
                <div class="card-title" style="font-size:14px;">${escapeHtml(it.title)}</div>
                <div class="card-meta">${it.time ? escapeHtml(it.time + (it.endTime ? "–" + it.endTime : "")) : ""}${hasValue ? " · R$ " + Number(it.value).toFixed(2) : ""}</div>
                ${it.location ? `<div class="card-meta">${escapeHtml(it.location)} ${mapLink(it.location)}</div>` : ""}
              </div>
              <span class="badge badge-${escapeHtml(it.status)}">${escapeHtml(t("status." + it.status))}</span>
            </div>
          </div>`;
      }).join("");
    itEl.querySelectorAll("[data-itin-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const it = itItems.find((i) => i.id === card.dataset.itinId);
        if (!it) return;
        const itinerarioTab = document.querySelector('.tab[data-tab="itinerario"]');
        if (itinerarioTab) itinerarioTab.click();
        openItinerarioForEdit(it.id, it);
      });
    });
  }

  const remItems = remindersByDate[todayISO] || [];
  const remEl = $("hojeReminderList");
  if (remItems.length === 0) {
    remEl.innerHTML = "";
  } else {
    remEl.innerHTML = `<div class="card-title" style="font-size:13px; margin:12px 0 8px;">💬 ${t("hoje.remindersHeader")}</div>` +
      remItems.map((r) => {
        const accentColor = r.visibility === "shared" ? "var(--teal)" : "var(--red)";
        return `
          <div class="card" style="padding:12px 14px; margin-bottom:8px; border-left:4px solid ${accentColor};">
            <span class="card-meta" style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--ink);">
              <span class="badge badge-${escapeHtml(r.visibility)}">${r.visibility === "shared" ? t("badge.group") : t("badge.onlyMe")}</span>
              ${escapeHtml(r.text)}
            </span>
          </div>`;
      }).join("");
  }

  if (itItems.length === 0 && remItems.length === 0) {
    itEl.innerHTML = `<p class="screen-sub" style="margin-top:2px;">${t("hoje.empty")}</p>`;
  }
}


function populateResponsibleSelects() {
  const emails = currentTripData.participantEmails || [];
  const opts = emails.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(nameFor(e))}</option>`).join("");
  ["itResponsible", "taskResponsible", "expPaidBy"].forEach((id) => {
    $(id).innerHTML = (id === "itResponsible" ? "<option value=''>—</option>" : "") + opts;
  });
  const splitGroup = $("expSplitGroup");
  splitGroup.innerHTML = "";
  emails.forEach((e) => {
    const chip = document.createElement("div");
    chip.className = "checkbox-chip checked";
    chip.textContent = nameFor(e);
    chip.dataset.email = e;
    chip.addEventListener("click", () => chip.classList.toggle("checked"));
    splitGroup.appendChild(chip);
  });
}

// ---------- Navegação por abas ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => hide(p));
    show($("panel-" + tab.dataset.tab));
    localStorage.setItem(LS_TAB_KEY, tab.dataset.tab);
  });
});

// ---------- Toggle de formulários ----------
document.querySelectorAll("[data-form]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $(btn.dataset.form).classList.toggle("hidden");
  });
});

// ================= ITINERÁRIO (inclui o que antes era Passeios) =================
let editingItinerarioId = null;

let itinerarioByDate = {}; // { "YYYY-MM-DD": [items] } — alimenta os marcadores do calendário

function subscribeItinerario() {
  const q = query(collection(db, "trips", currentTripId, "itinerario"), orderBy("date"));
  const unsub = onSnapshot(q, (snap) => {
    itinerarioByDate = {};
    const listEl = $("itinerarioList");
    const visibleCount = snap.docs.filter((d) => agencyOwnershipVisible(d.data())).length;
    updateBulkImportDefaultVisibility(visibleCount === 0);
    if (visibleCount === 0) {
      listEl.innerHTML = `<div class='empty'>${t("empty.itinerary")}</div>`;
      renderCalendar();
      if (selectedCalDate) renderItineraryForDay(selectedCalDate);
      renderHojeTab();
      return;
    }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const it = d.data();
      // Fase 4 (18/set/2026): Agência só enxerga o que ela mesma criou —
      // o que o cliente/colaborador acrescentar por conta própria fica
      // fora da visão da Agência.
      if (!agencyOwnershipVisible(it)) return;
      if (it.status === "cogitando") {
        updateDoc(doc(db, "trips", currentTripId, "itinerario", d.id), { status: "programado" }).catch(() => {});
        it.status = "programado";
      }
      if (!itinerarioByDate[it.date]) itinerarioByDate[it.date] = [];
      itinerarioByDate[it.date].push({ id: d.id, ...it });

      const hasValue = it.value && Number(it.value) > 0;
      const timeRange = it.time ? `· ${escapeHtml(it.time)}${it.endTime ? "–" + escapeHtml(it.endTime) : ""}` : "";
      const canEditIt = can("editCalendar");
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${escapeHtml(it.title)}</div>
            <div class="card-meta">
              ${fmtDate(it.date)} ${timeRange}
              ${hasValue ? ` · R$ ${Number(it.value).toFixed(2)} (${escapeHtml(it.paymentStatus || "pendente")})` : ""}
              ${it.responsible ? ` · resp: ${escapeHtml(nameFor(it.responsible))}` : ""}
              ${it.location ? ` · ${escapeHtml(it.location)}` : ""}
            </div>
            ${mapLink(it.location)} ${calendarLink(it)}
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            ${canEditIt ? `<button class="item-del" data-action="edit" title="Editar">✎</button>
            <button class="item-del" data-action="delete" title="Excluir" aria-label="Excluir">✕</button>
            <button class="badge badge-${escapeHtml(it.status)}" data-action="status">${escapeHtml(t("status." + it.status))}</button>`
            : `<span class="badge badge-${escapeHtml(it.status)}">${escapeHtml(t("status." + it.status))}</span>`}
          </div>
        </div>`;
      if (canEditIt) {
        card.querySelector('[data-action="status"]').addEventListener("click", () => cycleItinerarioStatus(d.id, it.status, it.title));
        card.querySelector('[data-action="edit"]').addEventListener("click", () => openItinerarioForEdit(d.id, it));
        card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("itinerario", d.id, it.title, "itinerario"));
      }
      listEl.appendChild(card);
    });
    renderCalendar();
    if (selectedCalDate) renderItineraryForDay(selectedCalDate);
    renderHojeTab();
  }, onSnapshotError("Itinerário"));
  unsubscribers.push(unsub);
}
const statusCycle = { programado: "confirmado", confirmado: "programado" };
// QA #5: versão com aviso de erro na tela (a lógica está em cycleItinerarioStatusImpl).
function cycleItinerarioStatus(...args) {
  return withErrorToast(cycleItinerarioStatusImpl, "Não foi possível mudar o status. Tenta de novo em instantes.")(...args);
}
async function cycleItinerarioStatusImpl(id, current, title) {
  const next = statusCycle[current] || "programado";
  await updateDoc(doc(db, "trips", currentTripId, "itinerario", id), { status: next });
  logActivity("itinerario", "status alterado", `"${title}": ${current} → ${next}`);
}

function openItinerarioForEdit(id, it) {
  editingItinerarioId = id;
  $("itDate").value = it.date || "";
  $("itTime").value = it.time || "";
  $("itEndTime").value = it.endTime || "";
  $("itTitle").value = it.title || "";
  $("itLocation").value = it.location || "";
  $("itStatus").value = it.status && it.status !== "cogitando" ? it.status : "programado";
  $("itValue").value = it.value || "";
  $("itPaymentStatus").value = it.paymentStatus || "pendente";
  $("itResponsible").value = it.responsible || "";
  $("saveItinerarioBtn").textContent = "Salvar alterações";
  $("itinerarioForm").classList.remove("hidden");
  $("itinerarioForm").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetItinerarioForm() {
  editingItinerarioId = null;
  $("itDate").value = ""; $("itTime").value = ""; $("itEndTime").value = ""; $("itTitle").value = "";
  $("itLocation").value = "";
  $("itValue").value = ""; $("itResponsible").value = ""; $("itStatus").value = "programado";
  $("itPaymentStatus").value = "pendente";
  $("saveItinerarioBtn").textContent = "Salvar";
  $("itinerarioForm").classList.add("hidden");
}

$("cancelItinerarioEditBtn").addEventListener("click", resetItinerarioForm);
$("addItinerarioToggleBtn").addEventListener("click", () => {
  $("bulkImportForm").classList.add("hidden");
  if (!$("itinerarioForm").classList.contains("hidden") || editingItinerarioId) {
    resetItinerarioForm();
    $("itinerarioForm").classList.remove("hidden");
  }
});

$("saveItinerarioBtn").addEventListener("click", async () => {
  const date = $("itDate").value, time = $("itTime").value, endTime = $("itEndTime").value;
  const title = $("itTitle").value.trim();
  const location = $("itLocation").value.trim();
  const status = $("itStatus").value;
  const value = parseFloat($("itValue").value) || 0;
  const paymentStatus = $("itPaymentStatus").value;
  const responsible = $("itResponsible").value;
  if (!date || !title) { showToast("Preencha data e atividade."); return; }
  const payload = { date, time, endTime, title, location, status, value, paymentStatus, responsible };

  setButtonLoading($("saveItinerarioBtn"), true);
  try {
    if (editingItinerarioId) {
      await updateDoc(doc(db, "trips", currentTripId, "itinerario", editingItinerarioId), payload);
      logActivity("itinerario", "item editado", title);
    } else {
      // createdByRole só é gravado na criação — nunca sobrescrito numa
      // edição, senão um item criado pela Agência que um Colaborador edita
      // depois sumiria da visão da Agência sem querer (Fase 4, 18/set/2026).
      await addDoc(collection(db, "trips", currentTripId, "itinerario"), { ...payload, createdByRole: myRole });
      logActivity("itinerario", "item adicionado", title);
    }
    resetItinerarioForm();
  } catch (err) {
    showToast("Não foi possível salvar. Tenta de novo em instantes.", "error"); console.warn("Não foi possível salvar:", err);
  } finally {
    setButtonLoading($("saveItinerarioBtn"), false);
  }
});

// ================= SEGMENTO ROTEIRO / DICAS ==================
// Abrir a aba Itinerário sempre cai em Roteiro (padrão) — Dicas só aparece
// se a pessoa clicar, pra não competir por atenção com o roteiro de verdade.
document.querySelectorAll("[data-itinseg]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-itinseg]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const seg = btn.dataset.itinseg;
    $("itinRoteiroSection").classList.toggle("hidden", seg !== "roteiro");
    $("itinDicasSection").classList.toggle("hidden", seg !== "dicas");
  });
});

// ================= DICAS (câmbio, restaurante, transporte... achados do grupo) =================
// Aberto pros 4 papéis (mesmo padrão de Lembretes) — é conteúdo colaborativo
// de baixo risco, qualquer participante pode contribuir, inclusive Convidado
// e Agência (que pode ter indicação local boa pra passar pro grupo).
const DICA_CATEGORIES = ["cambio", "restaurante", "transporte", "compras", "outro"];
const DICA_CATEGORY_ICONS = { cambio: "💱", restaurante: "🍽️", transporte: "🚕", compras: "🛍️", outro: "📌" };
let editingDicaId = null;
let dicasCache = [];
let dicaFilter = "todos";

function dicaCategoryLabel(cat) { return t("itinerary.cat" + cat.charAt(0).toUpperCase() + cat.slice(1)); }

function subscribeDicas() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "dicas"), (snap) => {
    dicasCache = [];
    snap.forEach((d) => dicasCache.push({ id: d.id, ...d.data() }));
    renderDicaFilters();
    renderDicasList();
  }, onSnapshotError("Dicas"));
  unsubscribers.push(unsub);
}

function renderDicaFilters() {
  const el = $("dicaFilterGroup");
  if (!el) return;
  const counts = {};
  dicasCache.forEach((d) => { counts[d.category] = (counts[d.category] || 0) + 1; });
  const chips = [{ key: "todos", label: t("itinerary.filterAll") }].concat(
    DICA_CATEGORIES.map((cat) => ({ key: cat, label: `${DICA_CATEGORY_ICONS[cat]} ${dicaCategoryLabel(cat)}` }))
  );
  el.innerHTML = chips.map((c) => `
    <span class="checkbox-chip${dicaFilter === c.key ? " checked" : ""}" data-filter="${c.key}">
      ${c.label}${counts[c.key] ? ` (${counts[c.key]})` : ""}
    </span>`).join("");
  el.querySelectorAll("[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      dicaFilter = chip.dataset.filter;
      renderDicaFilters();
      renderDicasList();
    });
  });
}

function renderDicasList() {
  const listEl = $("dicasList");
  if (!listEl) return;
  const visible = dicaFilter === "todos" ? dicasCache : dicasCache.filter((d) => d.category === dicaFilter);
  if (visible.length === 0) { listEl.innerHTML = `<div class="empty">${t("empty.dicas")}</div>`; return; }
  listEl.innerHTML = "";
  visible.forEach((dica) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-row">
        <div>
          <div class="card-title">${DICA_CATEGORY_ICONS[dica.category] || "📌"} ${escapeHtml(dica.titulo)}</div>
          <div class="card-meta">
            ${escapeHtml(dicaCategoryLabel(dica.category))}
            ${dica.indicadoPor ? ` · ${t("itinerary.dicaByLine")} ${escapeHtml(dica.indicadoPor)}` : ""}
          </div>
          ${dica.nota ? `<div class="card-meta" style="margin-top:4px;">${escapeHtml(dica.nota)}</div>` : ""}
          ${dica.local ? `<div class="card-meta">${escapeHtml(dica.local)}</div>${mapLink(dica.local)}` : ""}
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="item-del" data-action="edit" title="Editar">✎</button>
          <button class="item-del" data-action="delete" title="Excluir" aria-label="Excluir">✕</button>
        </div>
      </div>`;
    card.querySelector('[data-action="edit"]').addEventListener("click", () => openDicaForEdit(dica.id, dica));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("dicas", dica.id, dica.titulo, "dicas"));
    listEl.appendChild(card);
  });
}

function openDicaForEdit(id, dica) {
  editingDicaId = id;
  $("dicaTitulo").value = dica.titulo || "";
  $("dicaCategoria").value = dica.category || "outro";
  $("dicaNota").value = dica.nota || "";
  $("dicaLocal").value = dica.local || "";
  $("dicaIndicadoPor").value = dica.indicadoPor || "";
  $("saveDicaBtn").textContent = "Salvar alterações";
  $("dicaForm").classList.remove("hidden");
  $("dicaForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetDicaForm() {
  editingDicaId = null;
  $("dicaTitulo").value = ""; $("dicaCategoria").value = "cambio";
  $("dicaNota").value = ""; $("dicaLocal").value = ""; $("dicaIndicadoPor").value = "";
  $("saveDicaBtn").textContent = "Salvar";
  $("dicaForm").classList.add("hidden");
}
$("cancelDicaEditBtn")?.addEventListener("click", resetDicaForm);
$("addDicaToggleBtn")?.addEventListener("click", () => {
  if (!$("dicaForm").classList.contains("hidden") || editingDicaId) {
    resetDicaForm();
    $("dicaForm").classList.remove("hidden");
  }
});
$("saveDicaBtn")?.addEventListener("click", async () => {
  const titulo = $("dicaTitulo").value.trim();
  const category = $("dicaCategoria").value;
  const nota = $("dicaNota").value.trim();
  const local = $("dicaLocal").value.trim();
  const indicadoPor = $("dicaIndicadoPor").value.trim();
  if (!titulo) { showToast("Preencha o título."); return; }
  const payload = { titulo, category, nota, local, indicadoPor };

  setButtonLoading($("saveDicaBtn"), true);
  try {
    if (editingDicaId) {
      await updateDoc(doc(db, "trips", currentTripId, "dicas", editingDicaId), payload);
      logActivity("dicas", "dica editada", titulo);
    } else {
      await addDoc(collection(db, "trips", currentTripId, "dicas"), { ...payload, createdBy: currentUser.email });
      logActivity("dicas", "dica adicionada", titulo);
    }
    resetDicaForm();
  } catch (err) {
    showToast("Não foi possível salvar. Tenta de novo em instantes.", "error"); console.warn("Não foi possível salvar:", err);
  } finally {
    setButtonLoading($("saveDicaBtn"), false);
  }
});

// ================= IMPORTAR ITINERÁRIO EM MASSA (via Claude/IA externa) =================
// Em vez do app tentar "entender" texto livre (o que exigiria IA embutida,
// Cloud Function e custo), a gente pede pro usuário formatar as próprias
// anotações usando uma IA que ele já tem acesso (Claude), num formato fixo
// e simples que o app só precisa validar, não interpretar.
const BULK_IMPORT_PROMPT = `Organize as informações da minha viagem abaixo neste formato exato, uma linha por atividade, sem nenhum texto antes ou depois das linhas (não inclua a linha de cabeçalho, comece direto pela primeira atividade). Traduza tudo para português, mesmo que as informações originais estejam em espanhol, inglês ou qualquer outro idioma:

TITULO|DATA|HORA_INICIO|HORA_FIM|LOCAL|VALOR|STATUS

- DATA no formato AAAA-MM-DD
- HORA_INICIO e HORA_FIM no formato HH:MM (deixe vazio entre as barras se não souber)
- LOCAL e VALOR são opcionais (deixe vazio entre as barras se não tiver)
- STATUS só pode ser "programado" ou "confirmado"

Exemplo de uma linha:
Embarque para Lima|2026-09-05|14:00||Aeroporto de Guarulhos|1200|confirmado

Minhas anotações da viagem:
[cole aqui suas anotações bagunçadas]`;

function initBulkImportPromptBox() {
  const box = $("bulkImportPromptBox");
  if (box) box.value = BULK_IMPORT_PROMPT;
}
initBulkImportPromptBox();

// Visibilidade da seção de importar: decidida pelo que JÁ EXISTE na viagem
// (não mais um flag salvo no navegador de cada pessoa — bug real: a mãe do
// Diego via a seção de importar mesmo com o itinerário dele já preenchido,
// porque isso ficava só no localStorage do celular DELE, não era
// compartilhado entre os participantes). Continua sendo um toggle manual: se
// a pessoa mexer nele nessa sessão, a escolha dela é respeitada até recarregar
// a página.
let bulkImportUserOverride = null;
function setBulkImportToggle(isOn, opts = {}) {
  if (!opts.fromAuto) bulkImportUserOverride = isOn;
  const switchBtn = $("bulkImportSwitch");
  if (switchBtn) {
    switchBtn.classList.toggle("active", isOn);
    switchBtn.textContent = isOn ? "✓ " + t("common.on") : t("common.off");
  }
  $("bulkImportForm")?.classList.toggle("hidden", !isOn);
}
// Chamado pela subscrição do Itinerário sempre que os dados mudam de verdade.
function updateBulkImportDefaultVisibility(isEmpty) {
  if (bulkImportUserOverride !== null) return; // pessoa já mexeu manualmente nessa sessão — respeita a escolha dela
  setBulkImportToggle(isEmpty, { fromAuto: true });
}
function initBulkImportToggle() {
  if (!currentTripId) return;
  bulkImportUserOverride = null;
  // Estado neutro (fechado) até a primeira leitura real do Firestore decidir — evita "piscar" aberto antes de saber se já tem itens.
  setBulkImportToggle(false, { fromAuto: true });
}
$("bulkImportSwitch")?.addEventListener("click", () => {
  const isCurrentlyOn = $("bulkImportSwitch").classList.contains("active");
  setBulkImportToggle(!isCurrentlyOn);
  if (!isCurrentlyOn) $("bulkImportForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
});
$("closeBulkImportBtn")?.addEventListener("click", () => {
  setBulkImportToggle(false);
  $("itImportTextarea").value = "";
  $("itImportStatus").classList.add("hidden");
});
$("copyBulkPromptBtn")?.addEventListener("click", async () => {
  const btn = $("copyBulkPromptBtn");
  try {
    await navigator.clipboard.writeText(BULK_IMPORT_PROMPT);
    const original = btn.textContent;
    btn.textContent = "✓ Copiado!";
    setTimeout(() => { btn.textContent = original; }, 2000);
  } catch (err) {
    // Navegadores/contextos sem permissão de clipboard: seleciona o texto pra
    // a pessoa copiar manualmente (Ctrl+C / segurar e copiar no celular).
    const box = $("bulkImportPromptBox");
    box.focus();
    box.select();
  }
});

// Parseia o texto colado no formato TITULO|DATA|HORA_INICIO|HORA_FIM|LOCAL|VALOR|STATUS.
// Tolerante a: linha de cabeçalho acidental, linhas em branco, espaços extras.
// Nunca lança erro — linhas inválidas viram mensagem de erro específica, sem travar as demais.
function parseItineraryBulkText(raw) {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const items = [];
  const errors = [];
  lines.forEach((line, idx) => {
    if (/^TITULO\s*\|/i.test(line)) return; // ignora cabeçalho, se vier
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 7) {
      errors.push(`Linha ${idx + 1}: esperado 7 campos separados por "|", encontrado ${parts.length}.`);
      return;
    }
    const [title, date, timeStart, timeEnd, location, value, status] = parts;
    if (!title) { errors.push(`Linha ${idx + 1}: título vazio.`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`Linha ${idx + 1}: data "${date}" inválida (use AAAA-MM-DD).`); return; }
    const statusNorm = status.toLowerCase();
    if (statusNorm !== "programado" && statusNorm !== "confirmado") {
      errors.push(`Linha ${idx + 1}: status "${status}" inválido (use "programado" ou "confirmado").`);
      return;
    }
    if (timeStart && !/^\d{2}:\d{2}$/.test(timeStart)) { errors.push(`Linha ${idx + 1}: horário de início "${timeStart}" inválido (use HH:MM).`); return; }
    if (timeEnd && !/^\d{2}:\d{2}$/.test(timeEnd)) { errors.push(`Linha ${idx + 1}: horário de fim "${timeEnd}" inválido (use HH:MM).`); return; }
    let numValue = 0;
    if (value) {
      numValue = parseFloat(value.replace(",", "."));
      if (isNaN(numValue)) { errors.push(`Linha ${idx + 1}: valor "${value}" inválido.`); return; }
    }
    items.push({
      title, date, time: timeStart || "", endTime: timeEnd || "",
      location: location || "", value: numValue, status: statusNorm
    });
  });
  return { items, errors };
}

$("importItinerarioBtn")?.addEventListener("click", async () => {
  const raw = $("itImportTextarea").value;
  const statusEl = $("itImportStatus");
  const { items, errors } = parseItineraryBulkText(raw);

  if (items.length === 0) {
    statusEl.textContent = errors.length > 0
      ? `Nenhum item válido encontrado. ${errors[0]}`
      : "Cole o texto formatado na caixa acima antes de importar.";
    statusEl.classList.remove("hidden");
    return;
  }

  statusEl.textContent = `Importando ${items.length} item(ns)...`;
  statusEl.classList.remove("hidden");

  await Promise.all(items.map((it) =>
    addDoc(collection(db, "trips", currentTripId, "itinerario"), {
      title: it.title, date: it.date, time: it.time, endTime: it.endTime,
      location: it.location, value: it.value, paymentStatus: "pendente",
      status: it.status, responsible: "", createdByRole: myRole
    })
  ));
  logActivity("itinerario", "importação em massa", `${items.length} item(ns) importados`);

  // Marca como desligado (manual) sem esconder o formulário, pra mensagem de
  // sucesso abaixo (que está dentro dele) continuar visível.
  bulkImportUserOverride = false;
  const switchBtn = $("bulkImportSwitch");
  if (switchBtn) {
    switchBtn.classList.remove("active");
    switchBtn.textContent = t("common.off");
  }

  let msg = `✓ ${items.length} item(ns) importados com sucesso.`;
  if (errors.length > 0) {
    msg += ` ${errors.length} linha(s) ignorada(s) — ${errors.slice(0, 3).join(" ")}${errors.length > 3 ? " ..." : ""}`;
  }
  statusEl.textContent = msg;
  $("itImportTextarea").value = "";
});

// ================= ESTADIA =================
let editingEstadiaId = null;
let estadiaCache = [];

function subscribeEstadia() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "estadia"), (snap) => {
    estadiaCache = [];
    const listEl = $("estadiaList");
    const visibleCount = snap.docs.filter((d) => agencyOwnershipVisible(d.data())).length;
    if (visibleCount === 0) { listEl.innerHTML = `<div class='empty'>${t("empty.stay")}</div>`; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const s = d.data();
      if (!agencyOwnershipVisible(s)) return;
      estadiaCache.push({ id: d.id, ...s });
      const canEditEst = can("editCalendar");
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${escapeHtml(s.name)}</div>
            <div class="card-meta">${fmtDate(s.checkin)} – ${fmtDate(s.checkout)} · ${escapeHtml(s.address || "")}</div>
            ${mapLink(s.address)}
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            ${canEditEst ? `<button class="item-del" data-action="edit" title="Editar">✎</button>
            <button class="item-del" data-action="delete" title="Excluir" aria-label="Excluir">✕</button>` : ""}
            <span class="badge badge-${s.status === "pago" ? "confirmado" : "programado"}">${escapeHtml(t("status." + s.status))}</span>
          </div>
        </div>`;
      if (canEditEst) {
        card.querySelector('[data-action="edit"]').addEventListener("click", () => openEstadiaForEdit(d.id, s));
        card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("estadia", d.id, s.name, "estadia"));
      }
      listEl.appendChild(card);
    });
  }, onSnapshotError("Estadia"));
  unsubscribers.push(unsub);
}

function openEstadiaForEdit(id, s) {
  editingEstadiaId = id;
  $("stayName").value = s.name || "";
  $("stayCheckin").value = s.checkin || "";
  $("stayCheckout").value = s.checkout || "";
  $("stayAddress").value = s.address || "";
  $("stayStatus").value = s.status || "pendente";
  $("saveEstadiaBtn").textContent = "Salvar alterações";
  $("estadiaForm").classList.remove("hidden");
  $("estadiaForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetEstadiaForm() {
  editingEstadiaId = null;
  $("stayName").value = ""; $("stayCheckin").value = ""; $("stayCheckout").value = "";
  $("stayAddress").value = ""; $("stayStatus").value = "pendente";
  $("saveEstadiaBtn").textContent = "Salvar";
  $("estadiaForm").classList.add("hidden");
}
$("addEstadiaToggleBtn")?.addEventListener("click", () => {
  if (!$("estadiaForm").classList.contains("hidden") || editingEstadiaId) {
    resetEstadiaForm();
    $("estadiaForm").classList.remove("hidden");
  }
});
$("closeEstadiaFormBtn")?.addEventListener("click", resetEstadiaForm);
$("saveEstadiaBtn").addEventListener("click", async () => {
  const name = $("stayName").value.trim();
  const checkin = $("stayCheckin").value, checkout = $("stayCheckout").value;
  const address = $("stayAddress").value.trim(), status = $("stayStatus").value;
  if (!name || !checkin || !checkout) { showToast("Preencha nome e datas."); return; }
  const payload = { name, checkin, checkout, address, status };
  setButtonLoading($("saveEstadiaBtn"), true);
  try {
    if (editingEstadiaId) {
      await updateDoc(doc(db, "trips", currentTripId, "estadia", editingEstadiaId), payload);
      logActivity("estadia", "hospedagem editada", name);
    } else {
      await addDoc(collection(db, "trips", currentTripId, "estadia"), { ...payload, createdByRole: myRole });
      logActivity("estadia", "hospedagem adicionada", name);
    }
    resetEstadiaForm();
  } catch (err) {
    showToast("Não foi possível salvar. Tenta de novo em instantes.", "error"); console.warn("Não foi possível salvar:", err);
  } finally {
    setButtonLoading($("saveEstadiaBtn"), false);
  }
});

// ================= DOCUMENTOS =================
let editingDocId = null;
let docsCache = [];

// Ordem fixa das categorias base — "outro" sempre por último. Categorias
// criadas na hora (customDocTypes, salvas na própria viagem) entram entre
// as fixas e "outro" — ver getDocTypeOrder().
const DOC_TYPE_FIXED_ORDER = ["passaporte", "rg", "cpf", "cnh", "passagem", "ingresso", "voucher", "seguro", "vacina"];
const DOC_TYPE_KEYS = {
  passaporte: "documents.typePassaporte", rg: "documents.typeRg", cpf: "documents.typeCpf", cnh: "documents.typeCnh",
  passagem: "documents.typePassagem", ingresso: "documents.typeIngresso", voucher: "documents.typeVoucher",
  seguro: "documents.typeSeguro", vacina: "documents.typeVacina", outro: "documents.typeOutro"
};
// Categoria fixa: usa a tradução. Categoria criada na hora: não tem
// tradução, o texto é exatamente o que a pessoa digitou (mostra igual pra
// todo mundo, em qualquer idioma).
function docTypeLabel(type) { return DOC_TYPE_KEYS[type] ? t(DOC_TYPE_KEYS[type]) : type; }
function getDocTypeOrder() {
  const custom = (currentTripData && currentTripData.customDocTypes) || [];
  return [...DOC_TYPE_FIXED_ORDER, ...custom, "outro"];
}

// Sincroniza os selects de categoria (do formulário e do filtro) com as
// categorias criadas na hora pra essa viagem — guardadas em
// trips/{tripId}.customDocTypes, compartilhado com todo mundo (não é
// localStorage). Marca cada option criada dinamicamente com
// data-custom-type pra dar pra limpar e recriar sem duplicar.
function populateDocTypeOptions() {
  const custom = (currentTripData && currentTripData.customDocTypes) || [];
  const formSel = $("docType");
  const filterSel = $("docFilterType");
  if (formSel) {
    formSel.querySelectorAll("[data-custom-type]").forEach((o) => o.remove());
    const newOption = formSel.querySelector('option[value="__custom__"]');
    custom.forEach((label) => {
      const opt = document.createElement("option");
      opt.value = label; opt.textContent = label; opt.dataset.customType = "1";
      formSel.insertBefore(opt, newOption);
    });
  }
  if (filterSel) {
    const keepValue = filterSel.value;
    filterSel.querySelectorAll("[data-custom-type]").forEach((o) => o.remove());
    const outroOption = filterSel.querySelector('option[value="outro"]');
    custom.forEach((label) => {
      const opt = document.createElement("option");
      opt.value = label; opt.textContent = label; opt.dataset.customType = "1";
      filterSel.insertBefore(opt, outroOption);
    });
    if ([...filterSel.options].some((o) => o.value === keepValue)) filterSel.value = keepValue;
  }
}

// Preenche o filtro de pessoa com os participantes da viagem atual (nome, não e-mail cru).
function populateDocFilterPerson() {
  const sel = $("docFilterPerson");
  if (!sel) return;
  const emails = (currentTripData && currentTripData.participantEmails) || [];
  const keepValue = sel.value;
  sel.innerHTML = `<option value="">${t("documents.filterAllPeople")}</option>`;
  emails.slice().sort((a, b) => nameFor(a).localeCompare(nameFor(b), "pt-BR")).forEach((email) => {
    const opt = document.createElement("option");
    opt.value = email;
    opt.textContent = nameFor(email);
    sel.appendChild(opt);
  });
  if (emails.includes(keepValue)) sel.value = keepValue;
}

// Cria uma categoria nova pra essa viagem (compartilhada com todo mundo) a
// partir do que a pessoa digitou no campo inline do formulário.
// QA #5: versão com aviso de erro na tela (a lógica está em confirmNewDocTypeImpl).
function confirmNewDocType(...args) {
  return withErrorToast(confirmNewDocTypeImpl, "Não foi possível criar a categoria. Tenta de novo em instantes.")(...args);
}
async function confirmNewDocTypeImpl() {
  const input = $("docNewTypeInput");
  const label = input.value.trim();
  if (!label) return;
  const existing = (currentTripData.customDocTypes || []);
  if (!existing.some((c) => c.toLowerCase() === label.toLowerCase())) {
    await updateDoc(doc(db, "trips", currentTripId), { customDocTypes: arrayUnion(label) });
    currentTripData.customDocTypes = [...existing, label];
  }
  populateDocTypeOptions();
  $("docType").value = label;
  $("docNewTypeWrap").classList.add("hidden");
  input.value = "";
}
$("docType")?.addEventListener("change", () => {
  const isCustom = $("docType").value === "__custom__";
  $("docNewTypeWrap").classList.toggle("hidden", !isCustom);
  if (isCustom) $("docNewTypeInput").focus();
});
$("docNewTypeAddBtn")?.addEventListener("click", confirmNewDocType);
$("docNewTypeInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); confirmNewDocType(); } });

// Aplica os filtros ativos, agrupa por categoria (ordem fixa) e, dentro de
// cada grupo, mostra os documentos do próprio usuário primeiro, depois o
// resto em ordem alfabética pelo título.
function renderDocsList() {
  const listEl = $("docsList");
  const typeFilter = $("docFilterType") ? $("docFilterType").value : "";
  const personFilter = $("docFilterPerson") ? $("docFilterPerson").value : "";

  const filtered = docsCache.filter((doc_) => {
    const docType = doc_.docType || "outro";
    if (typeFilter && docType !== typeFilter) return false;
    if (personFilter && doc_.uploadedBy !== personFilter) return false;
    return true;
  });

  if (filtered.length === 0) { listEl.innerHTML = `<div class='empty'>${t("empty.documents")}</div>`; return; }

  const groups = {};
  filtered.forEach((doc_) => {
    const type = doc_.docType || "outro";
    (groups[type] = groups[type] || []).push(doc_);
  });

  listEl.innerHTML = "";
  getDocTypeOrder().forEach((type) => {
    const docsOfType = groups[type];
    if (!docsOfType || docsOfType.length === 0) return;

    const mine = docsOfType.filter((d) => d.uploadedBy === currentUser.email)
      .sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
    const others = docsOfType.filter((d) => d.uploadedBy !== currentUser.email)
      .sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));

    const header = document.createElement("div");
    header.className = "doc-group-title";
    header.textContent = docTypeLabel(type);
    listEl.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "doc-grid";

    [...mine, ...others].forEach((doc_) => {
      const isImage = doc_.fileType && doc_.fileType.startsWith("image/");
      const thumb = document.createElement("div");
      thumb.className = "doc-thumb";
      thumb.innerHTML = `
        ${isImage && safeUrl(doc_.url) ? `<img src="${escapeHtml(safeUrl(doc_.url))}" loading="lazy">` : `<span class="doc-thumb-icon">${doc_.url ? "🔗" : "📄"}</span>`}
        <div class="doc-thumb-title">${escapeHtml(doc_.title)}</div>
        <div class="doc-thumb-actions">
          <button data-action="edit" title="Editar">✎</button>
          <button data-action="delete" title="Excluir" aria-label="Excluir">✕</button>
        </div>
      `;
      thumb.addEventListener("click", (e) => {
        if (e.target.closest("[data-action]")) return;
        openDocDetailModal(doc_);
      });
      thumb.querySelector('[data-action="edit"]').addEventListener("click", (e) => {
        e.stopPropagation();
        openDocForEdit(doc_.id, doc_);
      });
      thumb.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
        e.stopPropagation();
        deleteItem("documentos", doc_.id, doc_.title, "documentos", doc_.storagePath);
      });
      grid.appendChild(thumb);
    });
    listEl.appendChild(grid);
  });
}

// Abre a caixa grande com o documento em destaque — imagem maior (ou ícone
// de link/arquivo), categoria, quem enviou, notas, validade, e os botões de
// editar/excluir "de verdade" (o card pequeno da grade já tem os mesmos,
// mas bem discretos).
function openDocDetailModal(doc_) {
  const isImage = doc_.fileType && doc_.fileType.startsWith("image/");
  const todayISO = localISODate();
  $("docDetailTitle").textContent = doc_.title;
  const docSafeUrl = safeUrl(doc_.url);
  $("docDetailImageWrap").innerHTML = isImage && docSafeUrl
    ? `<img src="${escapeHtml(docSafeUrl)}" style="max-width:100%; max-height:55vh; border-radius:10px;">`
    : `<div style="font-size:56px;">${doc_.url ? "🔗" : "📄"}</div>`;
  $("docDetailType").textContent = docTypeLabel(doc_.docType || "outro");
  $("docDetailOwner").textContent = t("documents.uploadedBy").replace("{name}", nameFor(doc_.uploadedBy));
  $("docDetailNotes").textContent = doc_.notes || "";
  $("docDetailNotes").classList.toggle("hidden", !doc_.notes);
  if (doc_.expiresAt) {
    const daysLeft = Math.ceil((new Date(doc_.expiresAt) - new Date(todayISO)) / 86400000);
    $("docDetailExpiry").textContent = "⏳ " + t("documents.expiresIn").replace("{d}", daysLeft);
    $("docDetailExpiry").classList.remove("hidden");
  } else {
    $("docDetailExpiry").classList.add("hidden");
  }
  $("docDetailLinkWrap").innerHTML = docSafeUrl
    ? `<a href="${escapeHtml(docSafeUrl)}" target="_blank" rel="noopener" style="color:var(--gold); font-size:12.5px;">Abrir ${escapeHtml(doc_.fileName ? doc_.fileName : "link")} ↗</a>`
    : "";
  $("docDetailEditBtn").onclick = () => { $("docDetailModal").classList.add("hidden"); openDocForEdit(doc_.id, doc_); };
  $("docDetailDeleteBtn").onclick = () => { $("docDetailModal").classList.add("hidden"); deleteItem("documentos", doc_.id, doc_.title, "documentos", doc_.storagePath); };
  $("docDetailModal").classList.remove("hidden");
}
$("docDetailCloseBtn")?.addEventListener("click", () => $("docDetailModal").classList.add("hidden"));

function subscribeDocumentos() {
  populateDocFilterPerson();
  populateDocTypeOptions();
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "documentos"), (snap) => {
    const todayISO = localISODate();
    const visibleDocs = [];

    snap.forEach((d) => {
      const doc_ = d.data();
      if (doc_.expiresAt && doc_.expiresAt < todayISO) {
        // Vencido: apaga o arquivo real do Storage (se houver) e o registro.
        if (doc_.storagePath) {
          deleteObject(ref(storage, doc_.storagePath)).catch(() => {});
        }
        deleteDoc(doc(db, "trips", currentTripId, "documentos", d.id)).catch(() => {});
        logActivity("documentos", "documento expirado removido", doc_.title);
        return;
      }
      visibleDocs.push({ id: d.id, ...doc_ });
    });

    docsCache = visibleDocs.filter(agencyOwnershipVisible);
    renderDocsList();
  }, onSnapshotError("Documentos"));
  unsubscribers.push(unsub);
}
$("docFilterType")?.addEventListener("change", renderDocsList);
$("docFilterPerson")?.addEventListener("change", renderDocsList);

let editingDocOriginalExpiresAt = null;

// Data padrão de expiração pra dados sensíveis sem validade explícita: N dias
// depois do fim da viagem (retenção mínima necessária, LGPD Art. 6º III).
// Nunca fica no passado — se a viagem já acabou há mais de N dias, expira "amanhã".
function defaultRetentionDate(days = 30) {
  const base = currentTripData && currentTripData.endDate
    ? new Date(currentTripData.endDate + "T00:00:00").getTime()
    : Date.now();
  const target = new Date(base + days * 86400000);
  const tomorrow = new Date(Date.now() + 86400000);
  return localISODate(target < tomorrow ? tomorrow : target);
}

function openDocForEdit(id, doc_) {
  editingDocId = id;
  editingDocOriginalExpiresAt = doc_.expiresAt || null;
  $("docTitle").value = doc_.title || "";
  $("docType").value = doc_.docType || "outro";
  $("docUrl").value = doc_.url || "";
  $("docNotes").value = doc_.notes || "";
  $("docExpiry").value = "keep";
  $("docIsMinor").checked = !!doc_.subjectIsMinor;
  $("docMinorConsent").classList.toggle("hidden", !doc_.subjectIsMinor);
  // Se o documento veio de um link (sem storagePath), já abre o campo de link
  // visível — a pessoa provavelmente vai editar/trocar o link, não anexar arquivo.
  const cameFromLink = !!doc_.url && !doc_.storagePath;
  $("docUrlWrap").classList.toggle("hidden", !cameFromLink);
  $("saveDocBtn").textContent = "Salvar alterações";
  $("docForm").classList.remove("hidden");
  $("docForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetDocForm() {
  editingDocId = null;
  editingDocOriginalExpiresAt = null;
  $("docTitle").value = ""; $("docUrl").value = ""; $("docNotes").value = ""; $("docFile").value = "";
  $("docType").value = "outro";
  $("docExpiry").value = "default";
  $("docIsMinor").checked = false;
  $("docMinorConsent").classList.add("hidden");
  $("docUrlWrap").classList.add("hidden");
  $("saveDocBtn").textContent = "Salvar";
  $("docForm").classList.add("hidden");
}
$("docLinkToggle")?.addEventListener("click", () => {
  $("docUrlWrap").classList.toggle("hidden");
});
$("docIsMinor")?.addEventListener("change", () => {
  $("docMinorConsent").classList.toggle("hidden", !$("docIsMinor").checked);
});
$("addDocToggleBtn")?.addEventListener("click", () => {
  if (!$("docForm").classList.contains("hidden") || editingDocId) {
    resetDocForm();
    $("docForm").classList.remove("hidden");
  }
});
$("closeDocFormBtn")?.addEventListener("click", resetDocForm);

// Fotos .heic (padrão de câmera do iPhone) não aparecem em preview na
// maioria dos navegadores — só o Safari/iOS entende nativamente. Converte
// pra .jpeg no próprio navegador antes do upload (usa a biblioteca heic2any,
// carregada no index.html). Se a conversão falhar por qualquer motivo (sem
// internet pra carregar a lib, arquivo corrompido, etc.), sobe o arquivo
// original mesmo assim — melhor um documento sem preview bonito do que um
// upload que não funciona.
async function maybeConvertHeic(file) {
  const looksHeic = /\.(heic|heif)$/i.test(file.name) || /^image\/(heic|heif)/i.test(file.type || "");
  if (!looksHeic || typeof window.heic2any !== "function") return file;
  try {
    const converted = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.85 });
    const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
    const newName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
    return new File([jpegBlob], newName, { type: "image/jpeg" });
  } catch (err) {
    console.error("Falha ao converter HEIC, subindo o arquivo original:", err);
    return file;
  }
}

$("saveDocBtn").addEventListener("click", async () => {
  const title = $("docTitle").value.trim();
  const docType = $("docType").value || "outro";
  if (docType === "__custom__") {
    showToast("Digite o nome da categoria nova e clique em Adicionar antes de salvar.");
    return;
  }
  const notes = $("docNotes").value.trim();
  let url = $("docUrl").value.trim();
  const fileInput = $("docFile");
  const file = fileInput.files[0];
  const statusEl = $("docUploadStatus");
  const expiryValue = $("docExpiry").value;
  const subjectIsMinor = $("docIsMinor").checked;
  let expiresAt;
  if (expiryValue === "keep") {
    expiresAt = editingDocOriginalExpiresAt;
  } else if (expiryValue === "default") {
    expiresAt = defaultRetentionDate(30);
  } else {
    const expiryDays = parseInt(expiryValue, 10) || 0;
    expiresAt = expiryDays > 0
      ? localISODate(new Date(Date.now() + expiryDays * 86400000))
      : null;
  }

  if (!title) { showToast("Preencha o título."); return; }
  if (!file && !url) { showToast("Anexe um arquivo ou cole um link."); return; }

  setButtonLoading($("saveDocBtn"), true);
  try {
    let fileType = "", fileName = "", storagePath = "";
    if (file) {
      statusEl.classList.remove("hidden");
      statusEl.textContent = "Preparando arquivo...";
      const uploadFile = await maybeConvertHeic(file);
      statusEl.textContent = "Enviando arquivo...";
      try {
        storagePath = `trips/${currentTripId}/documentos/${Date.now()}_${uploadFile.name}`;
        const fileRef = ref(storage, storagePath);
        await uploadBytes(fileRef, uploadFile);
        url = await getDownloadURL(fileRef);
        fileType = uploadFile.type;
        fileName = uploadFile.name;
        statusEl.textContent = "Upload concluído.";
      } catch (err) {
        statusEl.textContent = "Erro no upload. Tenta de novo em instantes.";
        console.warn("Erro no upload de documento:", err);
        return;
      }
    }

    if (editingDocId) {
      const payload = { title, docType, url, notes, expiresAt, subjectIsMinor };
      if (file) { payload.fileType = fileType; payload.fileName = fileName; payload.storagePath = storagePath; }
      await updateDoc(doc(db, "trips", currentTripId, "documentos", editingDocId), payload);
      logActivity("documentos", "documento editado", title);
    } else {
      await addDoc(collection(db, "trips", currentTripId, "documentos"), {
        title, docType, url, notes, fileType, fileName, storagePath, expiresAt, subjectIsMinor, uploadedBy: currentUser.email, createdByRole: myRole
      });
      logActivity("documentos", subjectIsMinor ? "documento adicionado (menor de idade — consentimento do responsável confirmado)" : "documento adicionado", title);
    }
    resetDocForm();
    statusEl.classList.add("hidden");
  } finally {
    setButtonLoading($("saveDocBtn"), false);
  }
});


// ================= MALA =================
document.querySelectorAll("[data-seg]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-seg]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    malaSeg = btn.dataset.seg;
    renderMalaList();
  });
});
let malaItemsCache = [];
let allSharedItemsCache = [];
function subscribeMala() {
  const q = query(collection(db, "trips", currentTripId, "mala"), where("ownerEmail", "==", currentUser.email));
  const unsub = onSnapshot(q, (snap) => {
    malaItemsCache = [];
    snap.forEach((d) => malaItemsCache.push({ id: d.id, ...d.data() }));
    renderMalaList();
    updateDefaultToggleState();
  }, onSnapshotError("Mala"));
  unsubscribers.push(unsub);

  const q2 = collection(db, "trips", currentTripId, "mala");
  const unsub2 = onSnapshot(q2, (snap) => {
    allSharedItemsCache = [];
    snap.forEach((d) => {
      const it = d.data();
      if (it.type === "shared") allSharedItemsCache.push(it);
    });
    renderGroupProgress();
  }, onSnapshotError("Mala"));
  unsubscribers.push(unsub2);
}
function renderMalaList() {
  const listEl = $("malaList");
  const items = malaItemsCache
    .filter((i) => i.type === malaSeg)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  if (items.length === 0) { listEl.innerHTML = `<div class='empty'>${t("empty.packing")}</div>`; return; }
  listEl.innerHTML = "";
  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <button class="checkbox ${it.done ? "checked " + escapeHtml(it.type) : ""}">${it.done ? "✓" : ""}</button>
      <div class="item-name ${it.done ? "done" : ""}" title="Clique duas vezes pra renomear">${escapeHtml(it.name)}</div>
      <div class="qty-stepper">
        <button class="qty-btn" data-action="minus">−</button>
        <span class="qty-value">${escapeHtml(it.qty || 1)}</span>
        <button class="qty-btn" data-action="plus">+</button>
      </div>
      <span class="badge badge-${escapeHtml(it.type)}">${it.type === "shared" ? t("badge.group") : t("badge.onlyMe")}</span>
      <button class="item-del">✕</button>
    `;
    row.querySelector('[data-action="minus"]').addEventListener("click", async () => {
      const newQty = Math.max(1, (it.qty || 1) - 1);
      await updateDoc(doc(db, "trips", currentTripId, "mala", it.id), { qty: newQty });
    });
    row.querySelector('[data-action="plus"]').addEventListener("click", async () => {
      const newQty = (it.qty || 1) + 1;
      await updateDoc(doc(db, "trips", currentTripId, "mala", it.id), { qty: newQty });
    });
    row.querySelector(".checkbox").addEventListener("click", async () => {
      await updateDoc(doc(db, "trips", currentTripId, "mala", it.id), { done: !it.done });
      logActivity("mala", it.done ? "item desmarcado" : "item marcado", it.name);
    });
    row.querySelector(".item-del").addEventListener("click", async () => {
      await deleteDoc(doc(db, "trips", currentTripId, "mala", it.id));
      logActivity("mala", "item removido", it.name);
    });
    row.querySelector(".item-name").addEventListener("dblclick", (e) => {
      const nameEl = e.target;
      const oldName = it.name;
      nameEl.setAttribute("contenteditable", "true");
      nameEl.focus();
      document.execCommand("selectAll", false, null);
      const finish = async () => {
        nameEl.removeAttribute("contenteditable");
        const newName = nameEl.textContent.trim();
        if (newName && newName !== oldName) {
          await updateDoc(doc(db, "trips", currentTripId, "mala", it.id), { name: newName });
          logActivity("mala", "item renomeado", `"${oldName}" → "${newName}"`);
        } else {
          nameEl.textContent = oldName;
        }
      };
      nameEl.addEventListener("blur", finish, { once: true });
      nameEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); nameEl.blur(); }
      });
    });
    listEl.appendChild(row);
  });
}
$("addItemBtn").addEventListener("click", async () => {
  const name = $("newItemName").value.trim();
  if (!name) return;
  setButtonLoading($("addItemBtn"), true);
  try {
    await addDoc(collection(db, "trips", currentTripId, "mala"), {
      name, type: malaSeg, done: false, ownerEmail: currentUser.email, qty: 1
    });
    logActivity("mala", "item adicionado", `${name} (${malaSeg})`);
    $("newItemName").value = "";
  } catch (err) {
    showToast("Não foi possível adicionar o item. Tenta de novo em instantes.", "error"); console.warn("Não foi possível adicionar o item:", err);
  } finally {
    setButtonLoading($("addItemBtn"), false);
  }
});

const DEFAULT_PACKING_LIST = [
  // 🔒 Pessoal — cada um leva o próprio
  { name: "Passaporte / documento de identidade", shared: false },
  { name: "Cópia dos documentos (física ou digital)", shared: false },
  { name: "Fone de ouvido", shared: false },
  { name: "Escova e pasta de dente", shared: false },
  { name: "Remédios de uso pessoal", shared: false },
  { name: "Óculos de sol", shared: false },
  { name: "Casaco/agasalho", shared: false },
  { name: "Meias extras", shared: false },
  { name: "Roupa íntima extra", shared: false },
  { name: "Chinelo", shared: false },
  { name: "Necessaire de higiene", shared: false },
  { name: "Toalha de banho pequena", shared: false },
  { name: "Máscara de dormir / tampão de ouvido", shared: false },
  { name: "Dinheiro em espécie / cartão", shared: false },
  { name: "Squeeze / garrafa de água", shared: false },
  { name: "Boné/chapéu", shared: false },
  { name: "Travesseiro de pescoço", shared: false },
  { name: "Guarda-chuva compactável / capa de chuva", shared: false },
  { name: "Protetor labial", shared: false },
  { name: "Escova de cabelo/pente", shared: false },
  { name: "Desodorante", shared: false },
  // 🧵 Compartilhado — vale coordenar quem leva
  { name: "Power bank", shared: true },
  { name: "Adaptador de tomada", shared: true },
  { name: "Protetor solar", shared: true },
  { name: "Kit de primeiros socorros", shared: true },
  { name: "Repelente de insetos", shared: true },
  { name: "Carregador de celular", shared: true }
];

function updateDefaultToggleState() {
  const hasPersonalDefaults = malaItemsCache.some((i) => i.isDefault && i.type === "personal");
  const hasSharedDefaults = malaItemsCache.some((i) => i.isDefault && i.type === "shared");
  const personalBtn = $("defaultListTogglePersonal");
  const sharedBtn = $("defaultListToggleShared");
  personalBtn.classList.toggle("active", hasPersonalDefaults);
  personalBtn.textContent = hasPersonalDefaults ? "✓ " + t("packing.activatedPersonal") : t("packing.activatePersonal");
  sharedBtn.classList.toggle("active", hasSharedDefaults);
  sharedBtn.textContent = hasSharedDefaults ? "✓ " + t("packing.activatedShared") : t("packing.activateShared");
}

// QA #5: versão com aviso de erro na tela (a lógica está em toggleDefaultListImpl).
function toggleDefaultList(...args) {
  return withErrorToast(toggleDefaultListImpl, "Não foi possível atualizar a lista padrão. Tenta de novo em instantes.")(...args);
}
async function toggleDefaultListImpl(kind) {
  // kind: "personal" ou "shared" — cada botão mexe só na própria categoria,
  // em vez de ativar as duas abas de uma vez (era a fonte de confusão antiga).
  const feedbackEl = $("defaultListFeedback");
  const hasDefaults = malaItemsCache.some((i) => i.isDefault && i.type === kind);

  if (hasDefaults) {
    const toRemove = malaItemsCache.filter((i) => i.isDefault && i.type === kind);
    await Promise.all(toRemove.map((i) => deleteDoc(doc(db, "trips", currentTripId, "mala", i.id))));
    logActivity("mala", "lista padrão removida", `${toRemove.length} item(ns) ${kind === "personal" ? "pessoais" : "compartilhados"} removidos`);
    feedbackEl.classList.add("hidden");
    return;
  }

  const existingNames = new Set(malaItemsCache.map((i) => i.name.trim().toLowerCase()));
  const wantShared = kind === "shared";
  const toAdd = DEFAULT_PACKING_LIST
    .filter((item) => item.shared === wantShared)
    .filter((item) => !existingNames.has(item.name.trim().toLowerCase()));

  await Promise.all(toAdd.map((item) =>
    addDoc(collection(db, "trips", currentTripId, "mala"), {
      name: item.name, type: kind, done: false, ownerEmail: currentUser.email, isDefault: true, qty: 1
    })
  ));
  logActivity("mala", "lista padrão adicionada", `${toAdd.length} item(ns) ${kind === "personal" ? "pessoais" : "compartilhados"} inseridos`);

  feedbackEl.textContent = `✓ ${t("packing.addedTo")} — ${toAdd.length} ${kind === "personal" ? t("badge.onlyMe") : t("badge.group")}`;
  feedbackEl.classList.remove("hidden");
}
$("defaultListTogglePersonal")?.addEventListener("click", () => toggleDefaultList("personal"));
$("defaultListToggleShared")?.addEventListener("click", () => toggleDefaultList("shared"));
function ownerColor(email) {
  const emails = currentTripData.participantEmails || [];
  const palette = ["var(--gold)", "var(--teal)", "#D65D5D", "#B08BD6", "#6FB3D2", "#8FD68F"];
  const idx = emails.indexOf(email);
  return palette[(idx >= 0 ? idx : 0) % palette.length];
}

function renderGroupProgress() {
  const el = $("groupProgress");
  const groups = {}; // nome (minúsculo) -> { displayName, entries: [{ownerEmail, done}] }
  allSharedItemsCache.forEach((it) => {
    const key = (it.name || "").trim().toLowerCase();
    if (!key) return;
    if (!groups[key]) groups[key] = { displayName: it.name, entries: [] };
    groups[key].entries.push({ ownerEmail: it.ownerEmail, done: it.done });
  });

  const keys = Object.keys(groups).sort((a, b) => groups[a].displayName.localeCompare(groups[b].displayName, "pt-BR"));
  if (keys.length === 0) {
    el.innerHTML = `<div class="empty">${t("packing.noSharedYet")}</div>`;
    return;
  }

  el.innerHTML = keys.map((k) => {
    const g = groups[k];
    const badges = g.entries.map((e) => {
      const color = ownerColor(e.ownerEmail);
      const displayName = nameFor(e.ownerEmail);
      const initial = (displayName || "?").trim().charAt(0).toUpperCase();
      const style = e.done
        ? `background:${color}; color:#1B2A41; border-color:${color};`
        : `background:transparent; color:${color}; border-color:${color};`;
      return `<span class="owner-badge" style="${style}" title="${escapeHtml(displayName)}${e.done ? " ✓" : ""}">${escapeHtml(initial)}</span>`;
    }).join("");
    return `
      <div class="list-row">
        <span class="card-meta" style="color:var(--ink); font-weight:600;">${escapeHtml(g.displayName)}</span>
        <div style="display:flex; gap:4px; flex-wrap:wrap;">${badges}</div>
      </div>`;
  }).join("");
}

// ================= TAREFAS =================
let editingTaskId = null;
function subscribeTarefas() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "tarefas"), (snap) => {
    const listEl = $("tasksList");
    if (snap.empty) { listEl.innerHTML = `<div class='empty'>${t("empty.tasks")}</div>`; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const task = d.data();
      const canEditTask = myPerms().editTarefas === "all";
      const canToggleTask = myPerms().editTarefas === "all" || myPerms().editTarefas === "toggle";
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${escapeHtml(task.description)}</div>
            <div class="card-meta">resp: ${escapeHtml(nameFor(task.responsible))}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            ${canEditTask ? `<button class="item-del" data-action="edit" title="Editar">✎</button>
            <button class="item-del" data-action="delete" title="Excluir" aria-label="Excluir">✕</button>` : ""}
            ${canToggleTask
              ? `<button class="badge badge-${escapeHtml(task.status)}" data-action="status">${escapeHtml(t("status." + task.status))}</button>`
              : `<span class="badge badge-${escapeHtml(task.status)}">${escapeHtml(t("status." + task.status))}</span>`}
          </div>
        </div>`;
      if (canToggleTask) {
        card.querySelector('[data-action="status"]').addEventListener("click", async () => {
          const next = task.status === "pendente" ? "feito" : "pendente";
          await updateDoc(doc(db, "trips", currentTripId, "tarefas", d.id), { status: next });
          logActivity("tarefas", "status alterado", `"${task.description}": ${next}`);
        });
      }
      if (canEditTask) {
        card.querySelector('[data-action="edit"]').addEventListener("click", () => openTaskForEdit(d.id, task));
        card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("tarefas", d.id, task.description, "tarefas"));
      }
      listEl.appendChild(card);
    });
  }, onSnapshotError("Tarefas"));
  unsubscribers.push(unsub);
}

function openTaskForEdit(id, task) {
  editingTaskId = id;
  $("taskDesc").value = task.description || "";
  $("taskResponsible").value = task.responsible || "";
  $("saveTaskBtn").textContent = "Salvar alterações";
  $("taskForm").classList.remove("hidden");
  $("taskForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetTaskForm() {
  editingTaskId = null;
  $("taskDesc").value = "";
  $("saveTaskBtn").textContent = "Salvar";
  $("taskForm").classList.add("hidden");
}
$("addTaskToggleBtn")?.addEventListener("click", () => {
  if (!$("taskForm").classList.contains("hidden") || editingTaskId) {
    resetTaskForm();
    $("taskForm").classList.remove("hidden");
  }
});
$("closeTaskFormBtn")?.addEventListener("click", resetTaskForm);

$("saveTaskBtn").addEventListener("click", async () => {
  const description = $("taskDesc").value.trim(), responsible = $("taskResponsible").value;
  if (!description) { showToast("Preencha a descrição."); return; }
  setButtonLoading($("saveTaskBtn"), true);
  try {
    if (editingTaskId) {
      await updateDoc(doc(db, "trips", currentTripId, "tarefas", editingTaskId), { description, responsible });
      logActivity("tarefas", "tarefa editada", description);
    } else {
      await addDoc(collection(db, "trips", currentTripId, "tarefas"), { description, responsible, status: "pendente" });
      logActivity("tarefas", "tarefa adicionada", description);
    }
    resetTaskForm();
  } catch (err) {
    showToast("Não foi possível salvar. Tenta de novo em instantes.", "error"); console.warn("Não foi possível salvar:", err);
  } finally {
    setButtonLoading($("saveTaskBtn"), false);
  }
});

// ================= GASTOS =================
let expensesCache = [];
let editingExpenseId = null;
let expTypeSeg = "shared";

// Cotações vs Real (moeda-base pra todos os totais/saldos do app).
// Persistidas no navegador pra não precisar redigitar toda vez.
let usdToBrlRate = parseFloat(localStorage.getItem("kipu_usd_brl")) || 5.40;
let penToBrlRate = parseFloat(localStorage.getItem("kipu_pen_brl")) || 1.45;

const LS_RATE_FETCH_DATE = "kipu_rate_fetch_date";
const LS_RATE_MANUAL_DATE = "kipu_rate_manual_date";
function todayStr() { return localISODate(); }

// Busca a cotação do dia automaticamente (uma vez por dia, cacheada).
// Se o usuário já editou manualmente hoje, não sobrescreve o que ele digitou.
async function autoFetchRates() {
  const today = todayStr();
  if (localStorage.getItem(LS_RATE_FETCH_DATE) === today) return;
  if (localStorage.getItem(LS_RATE_MANUAL_DATE) === today) {
    localStorage.setItem(LS_RATE_FETCH_DATE, today);
    return;
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await res.json();
    if (data.result === "success" && data.rates && data.rates.BRL && data.rates.PEN) {
      usdToBrlRate = data.rates.BRL;
      penToBrlRate = data.rates.BRL / data.rates.PEN;
      localStorage.setItem("kipu_usd_brl", usdToBrlRate);
      localStorage.setItem("kipu_pen_brl", penToBrlRate);
      localStorage.setItem(LS_RATE_FETCH_DATE, today);
      if (document.getElementById("rateFromCurrency")) updateRateWidget();
      renderExpenses();
      renderBalance();
    }
  } catch (err) {
    console.warn("Não foi possível buscar a cotação automática (offline?):", err);
  }
}

function usdRate() { return usdToBrlRate; }
function penRate() { return penToBrlRate; }
function toBRL(value, currency) {
  if (currency === "USD") return value * usdRate();
  if (currency === "PEN") return value * penRate();
  return value;
}
function fmtBRL(value) {
  return `R$ ${value.toFixed(2)}`;
}
function fmtOriginal(value, currency) {
  if (currency === "USD") return `US$ ${Number(value).toFixed(2)}`;
  if (currency === "PEN") return `S/ ${Number(value).toFixed(2)}`;
  return `R$ ${Number(value).toFixed(2)}`;
}

function subscribeGastos() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "gastos"), (snap) => {
    expensesCache = [];
    snap.forEach((d) => expensesCache.push({ id: d.id, ...d.data() }));
    renderExpenses();
    renderBalance();
  }, onSnapshotError("Gastos"));
  unsubscribers.push(unsub);
}

function renderExpenses() {
  const shared = expensesCache.filter((e) => (e.type || "shared") === "shared");
  const personal = expensesCache.filter((e) => e.type === "personal" && e.ownerEmail === currentUser.email);

  const sharedListEl = $("expensesList");
  if (shared.length === 0) { sharedListEl.innerHTML = `<div class='empty'>${t("empty.expensesShared")}</div>`; }
  else {
    sharedListEl.innerHTML = "";
    shared.forEach((e) => {
      const card = document.createElement("div");
      card.className = "card card-row";
      const currency = e.currency || "BRL";
      const converted = currency !== "BRL" ? ` (≈ ${fmtBRL(toBRL(e.value, currency))})` : "";
      card.innerHTML = `
        <div>
          <div class="card-title">${escapeHtml(e.description)} — ${escapeHtml(fmtOriginal(e.value, currency))}${converted}</div>
          <div class="card-meta">pago por ${escapeHtml(nameFor(e.paidBy))} · dividido entre ${(e.splitAmong || []).length} pessoa(s)</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="item-del" data-action="edit" title="Editar">✎</button>
          <button class="item-del" data-action="delete" title="Excluir" aria-label="Excluir">✕</button>
        </div>
      `;
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openExpenseForEdit(e.id, e));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("gastos", e.id, e.description, "gastos"));
      sharedListEl.appendChild(card);
    });
  }
  const sharedTotalBRL = shared.reduce((sum, e) => sum + toBRL(Number(e.value), e.currency || "BRL"), 0);
  $("sharedTotal").textContent = fmtBRL(sharedTotalBRL);

  const personalListEl = $("personalExpensesList");
  if (personal.length === 0) { personalListEl.innerHTML = `<div class='empty'>${t("empty.expensesPersonal")}</div>`; }
  else {
    personalListEl.innerHTML = "";
    personal.forEach((e) => {
      const card = document.createElement("div");
      card.className = "card card-row";
      const currency = e.currency || "BRL";
      const converted = currency !== "BRL" ? ` (≈ ${fmtBRL(toBRL(e.value, currency))})` : "";
      card.innerHTML = `
        <div class="card-title">${escapeHtml(e.description)} — ${escapeHtml(fmtOriginal(e.value, currency))}${converted}</div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="item-del" data-action="edit" title="Editar">✎</button>
          <button class="item-del" data-action="delete" title="Excluir" aria-label="Excluir">✕</button>
        </div>
      `;
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openExpenseForEdit(e.id, e));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("gastos", e.id, e.description, "gastos"));
      personalListEl.appendChild(card);
    });
  }
  const personalTotalBRL = personal.reduce((sum, e) => sum + toBRL(Number(e.value), e.currency || "BRL"), 0);
  $("personalTotal").textContent = fmtBRL(personalTotalBRL);
}

function renderBalance() {
  const shared = expensesCache.filter((e) => (e.type || "shared") === "shared");
  const balances = {};
  (currentTripData.participantEmails || []).forEach((e) => { balances[e] = 0; });
  shared.forEach((e) => {
    const valueBRL = toBRL(Number(e.value), e.currency || "BRL");
    const per = valueBRL / (e.splitAmong.length || 1);
    balances[e.paidBy] = (balances[e.paidBy] || 0) + valueBRL;
    e.splitAmong.forEach((p) => { balances[p] = (balances[p] || 0) - per; });
  });
  const el = $("balanceSummary");
  el.innerHTML = Object.entries(balances).map(([email, val]) => {
    const cls = val >= 0 ? "balance-positive" : "balance-negative";
    const label = val >= 0 ? "a receber" : "deve";
    return `<div class="list-row"><span class="card-meta">${escapeHtml(nameFor(email))}</span><span class="${cls}">${fmtBRL(Math.abs(val))} ${label}</span></div>`;
  }).join("");
}

const CURRENCY_LABELS = { BRL: "R$", USD: "US$", PEN: "S/" };

function populateRateToOptions() {
  const from = $("rateFromCurrency").value;
  const toSel = $("rateToCurrency");
  const prevTo = toSel.value;
  const options = ["BRL", "PEN", "USD"].filter((c) => c !== from);
  toSel.innerHTML = options.map((c) => `<option value="${c}">${CURRENCY_LABELS[c]}</option>`).join("");
  toSel.value = options.includes(prevTo) ? prevTo : "BRL";
}

function updateRateWidget() {
  const from = $("rateFromCurrency").value;
  const to = $("rateToCurrency").value;
  const valueInput = $("rateValue");
  const fromToBRL = from === "USD" ? usdToBrlRate : penToBrlRate;

  if (to === "BRL") {
    valueInput.value = fromToBRL;
    valueInput.readOnly = false;
  } else {
    const toToBRL = to === "USD" ? usdToBrlRate : penToBrlRate;
    valueInput.value = (fromToBRL / toToBRL).toFixed(4).replace(/\.?0+$/, "");
    valueInput.readOnly = true;
  }
}

$("rateFromCurrency").addEventListener("change", () => {
  populateRateToOptions();
  updateRateWidget();
});
$("rateToCurrency").addEventListener("change", updateRateWidget);
$("rateValue").addEventListener("input", () => {
  if ($("rateValue").readOnly) return;
  const from = $("rateFromCurrency").value;
  const val = parseFloat($("rateValue").value) || 1;
  if (from === "USD") { usdToBrlRate = val; localStorage.setItem("kipu_usd_brl", val); }
  else { penToBrlRate = val; localStorage.setItem("kipu_pen_brl", val); }
  localStorage.setItem(LS_RATE_MANUAL_DATE, todayStr());
  renderExpenses();
  renderBalance();
});

populateRateToOptions();
updateRateWidget();

// ================= CONVERSOR RÁPIDO =================
function convertAmount(value, from, to) {
  if (isNaN(value)) return "";
  if (from === to) return value;
  const brl = toBRL(value, from); // toBRL já trata BRL como identidade
  if (to === "BRL") return brl;
  if (to === "USD") return brl / usdRate();
  if (to === "PEN") return brl / penRate();
  return value;
}

let convLastEdited = "A";
function updateConverter() {
  const currA = $("convCurrencyA").value;
  const currB = $("convCurrencyB").value;
  if (convLastEdited === "A") {
    const valA = parseFloat($("convValueA").value);
    const result = convertAmount(valA, currA, currB);
    $("convValueB").value = result === "" ? "" : result.toFixed(2);
  } else {
    const valB = parseFloat($("convValueB").value);
    const result = convertAmount(valB, currB, currA);
    $("convValueA").value = result === "" ? "" : result.toFixed(2);
  }
}
$("convValueA").addEventListener("input", () => { convLastEdited = "A"; updateConverter(); });
$("convValueB").addEventListener("input", () => { convLastEdited = "B"; updateConverter(); });
$("convCurrencyA").addEventListener("change", updateConverter);
$("convCurrencyB").addEventListener("change", updateConverter);

document.querySelectorAll("[data-exptype]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-exptype]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    expTypeSeg = btn.dataset.exptype;
    $("expSharedFields").classList.toggle("hidden", expTypeSeg === "personal");
  });
});

function openExpenseForEdit(id, e) {
  editingExpenseId = id;
  expTypeSeg = e.type || "shared";
  document.querySelectorAll("[data-exptype]").forEach((b) => b.classList.toggle("active", b.dataset.exptype === expTypeSeg));
  $("expSharedFields").classList.toggle("hidden", expTypeSeg === "personal");
  $("expDesc").value = e.description || "";
  $("expValue").value = e.value || "";
  $("expCurrency").value = e.currency || "BRL";
  $("expPaidBy").value = e.paidBy || "";
  $("expSplitGroup").querySelectorAll(".checkbox-chip").forEach((chip) => {
    chip.classList.toggle("checked", (e.splitAmong || []).includes(chip.dataset.email));
  });
  $("saveExpenseBtn").textContent = "Salvar alterações";
  $("expenseForm").classList.remove("hidden");
  $("expenseForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetExpenseForm() {
  editingExpenseId = null;
  expTypeSeg = "shared";
  document.querySelectorAll("[data-exptype]").forEach((b) => b.classList.toggle("active", b.dataset.exptype === "shared"));
  $("expSharedFields").classList.remove("hidden");
  $("expDesc").value = ""; $("expValue").value = ""; $("expCurrency").value = "BRL";
  $("expSplitGroup").querySelectorAll(".checkbox-chip").forEach((chip) => chip.classList.add("checked"));
  $("saveExpenseBtn").textContent = "Salvar";
  $("expenseForm").classList.add("hidden");
}
$("addExpenseToggleBtn")?.addEventListener("click", () => {
  if (!$("expenseForm").classList.contains("hidden") || editingExpenseId) {
    resetExpenseForm();
    $("expenseForm").classList.remove("hidden");
  }
});
$("closeExpenseFormBtn")?.addEventListener("click", resetExpenseForm);

$("saveExpenseBtn").addEventListener("click", async () => {
  const description = $("expDesc").value.trim();
  const value = parseFloat($("expValue").value);
  const currency = $("expCurrency").value;
  if (!description || !value) { showToast("Preencha descrição e valor."); return; }
  if (!(value > 0)) { showToast("O valor precisa ser maior que zero."); return; } // QA #13

  let payload = { description, value, currency, type: expTypeSeg };
  if (expTypeSeg === "shared") {
    const paidBy = $("expPaidBy").value;
    const splitAmong = Array.from($("expSplitGroup").querySelectorAll(".checkbox-chip.checked")).map((c) => c.dataset.email);
    if (splitAmong.length === 0) { showToast("Escolha ao menos um participante na divisão."); return; }
    payload = { ...payload, paidBy, splitAmong };
  } else {
    payload.ownerEmail = currentUser.email;
  }

  if (editingExpenseId) {
    // QA #13: ao trocar o tipo, apaga os campos do tipo anterior — senão um
    // gasto que virou "do grupo" continuava com dono (e o "Remover meus
    // dados" de quem criou apagaria um gasto do grupo inteiro).
    const editPayload = expTypeSeg === "shared"
      ? { ...payload, ownerEmail: deleteField() }
      : { ...payload, paidBy: deleteField(), splitAmong: deleteField() };
    try {
      await updateDoc(doc(db, "trips", currentTripId, "gastos", editingExpenseId), editPayload);
    } catch (err) {
      reportActionError("Não foi possível salvar o gasto. Tenta de novo em instantes.", err);
      return;
    }
    logActivity("gastos", "gasto editado", `${description} — ${fmtOriginal(value, currency)}`);
  } else {
    setButtonLoading($("saveExpenseBtn"), true);
    try {
      await addDoc(collection(db, "trips", currentTripId, "gastos"), payload);
      logActivity("gastos", "gasto adicionado", `${description} — ${fmtOriginal(value, currency)} (${expTypeSeg})`);
    } catch (err) {
      showToast("Não foi possível salvar. Tenta de novo em instantes.", "error"); console.warn("Não foi possível salvar:", err);
      setButtonLoading($("saveExpenseBtn"), false);
      return;
    }
    setButtonLoading($("saveExpenseBtn"), false);
  }
  resetExpenseForm();
});

// ================= EMERGÊNCIA =================
let editingEmergencyId = null;
let emergCategory = "contato"; // segmento selecionado: "contato" ou "saude"
let emergItemsCache = [];

const EMERG_PLACEHOLDERS = {
  contato: { label: "Ex: Agência (Landy)", value: "Ex: +51 999 999 999" },
  saude: { label: "Ex: Alergia", value: "Ex: Penicilina — portar anti-histamínico" }
};

function applyEmergFormCopy() {
  const ph = EMERG_PLACEHOLDERS[emergCategory];
  $("emLabel").placeholder = ph.label;
  $("emValue").placeholder = ph.value;
}

document.querySelectorAll("[data-emergseg]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-emergseg]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    emergCategory = btn.dataset.emergseg;
    applyEmergFormCopy();
    renderEmergencyList();
  });
});

function renderEmergencyList() {
  const listEl = $("emergencyList");
  // Itens antigos não têm campo "category" — tratados como "contato" (comportamento anterior).
  const visibleItems = emergItemsCache.filter((it) => (it.category || "contato") === emergCategory);
  if (visibleItems.length === 0) { listEl.innerHTML = `<div class='empty'>${t("empty.emergency")}</div>`; return; }
  listEl.innerHTML = "";
  visibleItems.forEach((it) => {
    const card = document.createElement("div");
    card.className = "card card-row";
    card.innerHTML = `
      <div><span class="card-title">${escapeHtml(it.label)}</span><br><span class="card-meta">${escapeHtml(it.value)}</span></div>
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="item-del" data-action="edit" title="Editar">✎</button>
        <button class="item-del" data-action="delete" title="Excluir" aria-label="Excluir">✕</button>
      </div>
    `;
    card.querySelector('[data-action="edit"]').addEventListener("click", () => openEmergencyForEdit(it.id, it));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("emergencia", it.id, it.label, "emergencia"));
    listEl.appendChild(card);
  });
}

function subscribeEmergencia() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "emergencia"), (snap) => {
    const todayISO = localISODate();
    emergItemsCache = [];
    snap.forEach((d) => {
      const it = d.data();
      // Retenção automática (LGPD Art. 6º III): dado de emergência sem finalidade
      // depois que a viagem já acabou há tempo suficiente é apagado sozinho,
      // do mesmo jeito que Documentos já faz — mesma varredura preguiçosa,
      // só roda quando alguém abre a aba.
      if (it.expiresAt && it.expiresAt < todayISO) {
        deleteDoc(doc(db, "trips", currentTripId, "emergencia", d.id)).catch(() => {});
        logActivity("emergencia", "informação expirada removida (retenção automática)", it.label);
        return;
      }
      if (!agencyOwnershipVisible(it)) return;
      emergItemsCache.push({ id: d.id, ...it });
    });
    renderEmergencyList();
  }, onSnapshotError("Emergência"));
  unsubscribers.push(unsub);
}

function openEmergencyForEdit(id, it) {
  editingEmergencyId = id;
  $("emLabel").value = it.label || "";
  $("emValue").value = it.value || "";
  $("emIsMinor").checked = !!it.subjectIsMinor;
  $("emMinorConsent").classList.toggle("hidden", !it.subjectIsMinor);
  $("saveEmergencyBtn").textContent = "Salvar alterações";
  $("emergencyForm").classList.remove("hidden");
  $("emergencyForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetEmergencyForm() {
  editingEmergencyId = null;
  $("emLabel").value = ""; $("emValue").value = "";
  $("emIsMinor").checked = false;
  $("emMinorConsent").classList.add("hidden");
  $("saveEmergencyBtn").textContent = "Salvar";
  $("emergencyForm").classList.add("hidden");
  applyEmergFormCopy();
}
$("emIsMinor")?.addEventListener("change", () => {
  $("emMinorConsent").classList.toggle("hidden", !$("emIsMinor").checked);
});
$("addEmergencyToggleBtn")?.addEventListener("click", () => {
  if (!$("emergencyForm").classList.contains("hidden") || editingEmergencyId) {
    resetEmergencyForm();
    $("emergencyForm").classList.remove("hidden");
  }
});
$("closeEmergencyFormBtn")?.addEventListener("click", resetEmergencyForm);

$("saveEmergencyBtn").addEventListener("click", async () => {
  const label = $("emLabel").value.trim(), value = $("emValue").value.trim();
  const subjectIsMinor = $("emIsMinor").checked;
  if (!label || !value) { showToast("Preencha rótulo e valor."); return; }
  setButtonLoading($("saveEmergencyBtn"), true);
  try {
    if (editingEmergencyId) {
      // Editar sem mexer na validade não reseta ela — mesmo padrão dos Documentos.
      // Categoria não muda na edição (não há seletor no formulário de edição).
      await updateDoc(doc(db, "trips", currentTripId, "emergencia", editingEmergencyId), { label, value, subjectIsMinor });
      logActivity("emergencia", "informação editada", label);
    } else {
      await addDoc(collection(db, "trips", currentTripId, "emergencia"), {
        label, value, subjectIsMinor, category: emergCategory, createdBy: currentUser.email, createdByRole: myRole, expiresAt: defaultRetentionDate(30)
      });
      logActivity("emergencia", subjectIsMinor ? "informação adicionada (menor de idade — consentimento do responsável confirmado)" : "informação adicionada", label);
    }
    resetEmergencyForm();
  } catch (err) {
    showToast("Não foi possível salvar. Tenta de novo em instantes.", "error"); console.warn("Não foi possível salvar:", err);
  } finally {
    setButtonLoading($("saveEmergencyBtn"), false);
  }
});


// ================= EXCLUSÃO DE DADOS PELO TITULAR (LGPD Art. 18) =================
// Diferente do "Resetar app" (que é uma ação de Admin, apaga a viagem inteira
// pra todo mundo), isso é auto-aplicado: qualquer participante pode pedir a
// remoção só dos próprios dados, sem depender de ninguém.
async function eraseMyData() {
  const email = currentUser.email;
  if (email === currentTripData.createdBy) {
    await confirmDialog(
      "Você é o Admin original desta viagem (quem criou), então não dá pra remover só os seus dados por aqui — isso deixaria a viagem sem dono. Pra remover seus dados, exclua a viagem inteira (se você for a única pessoa nela) ou peça pra outro Admin assumir antes.",
      "Entendi"
    );
    return;
  }
  const ok = await confirmDialog(
    "Isso remove você desta viagem e apaga os dados que só dizem respeito a você: seus itens da mala, seus gastos pessoais, os documentos que você enviou e as informações de emergência que você cadastrou. Itens compartilhados que você criou (itinerário, estadia, tarefas, gastos em grupo) continuam, já que outras pessoas dependem deles. Essa ação não pode ser desfeita. Quer continuar?",
    "Remover meus dados"
  );
  if (!ok) return;

  // QA #7 (25/set/2026): tudo dentro de try/catch — antes, se qualquer passo
  // falhasse (ex: a regra não deixava Convidado sair da viagem), os dados
  // eram apagados mas a pessoa continuava na viagem, sem nenhum aviso.
  const btn = $("eraseMyDataBtn");
  if (btn) setButtonLoading(btn, true);
  try {
    // Log primeiro, enquanto o usuário ainda é participante (senão a regra de
    // segurança bloqueia a escrita no activityLog depois que ele sair da lista).
    await logActivity("geral", "solicitação de exclusão de dados pelo titular", email);

    // Apaga, em paralelo, tudo que é claramente dado pessoal do próprio usuário.
    // Agência não tem Mala/Gastos, e só enxerga Documentos/Emergência que ela
    // mesma criou — a consulta precisa dizer isso, senão o Firestore recusa.
    const isAgencyRole = myRole === "agencia";
    const deleteWhereOwner = async (subcollection, field) => {
      const filters = [where(field, "==", email)];
      if (isAgencyRole) filters.push(where("createdByRole", "==", "agencia"));
      const q = query(collection(db, "trips", currentTripId, subcollection), ...filters);
      const snap = await getDocs(q);
      await Promise.all(snap.docs.map(async (d) => {
        const data = d.data();
        if (data.storagePath) {
          await deleteObject(ref(storage, data.storagePath)).catch(() => {});
        }
        await deleteDoc(doc(db, "trips", currentTripId, subcollection, d.id));
      }));
    };
    const jobs = [
      deleteWhereOwner("documentos", "uploadedBy"),
      deleteWhereOwner("emergencia", "createdBy")
    ];
    if (!isAgencyRole) {
      jobs.push(deleteWhereOwner("mala", "ownerEmail"));
      jobs.push(deleteWhereOwner("gastos", "ownerEmail")); // só gastos pessoais têm ownerEmail
    }
    await Promise.all(jobs);

    // Sai da viagem: remove SÓ o próprio e-mail (arrayRemove/deleteField, em
    // vez de regravar as listas inteiras — assim não apaga sem querer alguém
    // que tenha entrado enquanto a tela estava aberta). A regra isSelfLeave
    // do firestore.rules aceita exatamente esse formato, pra qualquer papel.
    await updateDoc(doc(db, "trips", currentTripId),
      "participantEmails", arrayRemove(email),
      new FieldPath("participantRoles", email), deleteField(),
      "adminEmails", arrayRemove(email)
    );
  } catch (err) {
    console.warn("Não foi possível concluir a remoção dos dados:", err);
    showToast("Não foi possível concluir a remoção dos seus dados. Parte deles pode já ter sido apagada — tente de novo em instantes; se continuar, fale com o Admin da viagem.", "error");
    if (btn) setButtonLoading(btn, false);
    return;
  }
  if (btn) setButtonLoading(btn, false);
  showToast("Pronto — você saiu da viagem e seus dados pessoais foram apagados.", "info");
  goToTripPicker();
}
$("eraseMyDataBtn")?.addEventListener("click", eraseMyData);

// ================= HISTÓRICO =================
function subscribeHistorico() {
  const q = query(collection(db, "trips", currentTripId, "activityLog"), orderBy("timestamp", "desc"));
  const unsub = onSnapshot(q, (snap) => {
    const listEl = $("historyList");
    if (snap.empty) { listEl.innerHTML = `<div class='empty'>${t("empty.history")}</div>`; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const log = d.data();
      const row = document.createElement("div");
      row.className = "log-entry";
      const time = log.timestamp ? log.timestamp.toDate().toLocaleString("pt-BR") : "agora";
      row.innerHTML = `<span class="log-author">${escapeHtml(nameFor(log.authorEmail))}</span> — ${escapeHtml(log.action)}: ${escapeHtml(log.description)} <div class="log-time">${time}</div>`;
      listEl.appendChild(row);
    });
  }, onSnapshotError("Histórico"));
  unsubscribers.push(unsub);
}

// Senha simples pra proteger o reset contra clique acidental de alguém
// da família — não é segurança de verdade (o código é público no GitHub),
// só uma trava contra "apertei sem querer".
const RESET_PASSWORD = "#987321";

function showResetModal() {
  const input = $("resetPasswordInput");
  input.value = "";
  $("resetPasswordError").classList.add("hidden");
  $("resetModal").classList.remove("hidden");
  input.focus();
}
function hideResetModal() {
  $("resetModal").classList.add("hidden");
}

$("resetAppBtn")?.addEventListener("click", showResetModal);
$("resetModalCancelBtn")?.addEventListener("click", hideResetModal);
$("resetPasswordInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("resetModalConfirmBtn")?.click();
});

$("resetModalConfirmBtn")?.addEventListener("click", async () => {
  const val = $("resetPasswordInput").value;
  if (val !== RESET_PASSWORD) {
    $("resetPasswordError").classList.remove("hidden");
    return;
  }
  hideResetModal();

  const subcollections = ["itinerario", "estadia", "documentos", "mala", "tarefas", "gastos", "emergencia", "activityLog", "lembretes"];
  let totalDeleted = 0;
  for (const sub of subcollections) {
    const snap = await getDocs(collection(db, "trips", currentTripId, sub));
    await Promise.all(snap.docs.map(async (d) => {
      if (sub === "documentos") {
        const storagePath = d.data().storagePath;
        if (storagePath) await deleteObject(ref(storage, storagePath)).catch(() => {});
      }
      await deleteDoc(doc(db, "trips", currentTripId, sub, d.id));
    }));
    totalDeleted += snap.size;
  }

  await addDoc(collection(db, "trips", currentTripId, "activityLog"), {
    authorEmail: currentUser.email,
    area: "reset",
    action: "app resetado",
    description: `${totalDeleted} registro(s) apagado(s) — reinício com informações reais da viagem`,
    timestamp: serverTimestamp()
  });
});

// ================= CALENDÁRIO + LEMBRETES =================
let remindersByDate = {}; // { "YYYY-MM-DD": [{id, text, visibility, authorEmail}] }
let currentRemVis = "personal";

function subscribeReminders() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "lembretes"), (snap) => {
    remindersByDate = {};
    snap.forEach((d) => {
      const r = { id: d.id, ...d.data() };
      const visible = r.visibility === "shared" || r.authorEmail === currentUser.email;
      if (!visible) return;
      if (!remindersByDate[r.date]) remindersByDate[r.date] = [];
      remindersByDate[r.date].push(r);
    });
    renderCalendar();
    if (selectedCalDate) renderReminderEntries(selectedCalDate);
    renderHojeTab();
  }, onSnapshotError("Lembretes"));
  unsubscribers.push(unsub);
}

const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const DIAS_SEMANA = ["D","S","T","Q","Q","S","S"];

function toISODate(y, m, day) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function renderCalendar() {
  if (!calendarViewDate) return;
  const y = calendarViewDate.getFullYear();
  const m = calendarViewDate.getMonth();
  $("calMonthLabel").textContent = `${MESES[m]} ${y}`;

  const grid = $("calendarGrid");
  grid.innerHTML = "";
  DIAS_SEMANA.forEach((d) => {
    const el = document.createElement("div");
    el.className = "cal-weekday";
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement("div");
    empty.className = "cal-day empty";
    grid.appendChild(empty);
  }

  const todayISO = localISODate();

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = toISODate(y, m, day);
    const cell = document.createElement("div");
    cell.className = "cal-day";
    const tripHere = findTripForDate(iso);
    if (tripHere) {
      cell.classList.add("trip-day");
      const isEndpoint = iso === tripHere.startDate || iso === tripHere.endDate;
      cell.classList.add(isEndpoint ? "trip-endpoint" : "trip-mid");
    }
    if (iso === todayISO) cell.classList.add("today");
    if (remindersByDate[iso] && remindersByDate[iso].length > 0) cell.classList.add("has-reminder");
    if (itinerarioByDate[iso] && itinerarioByDate[iso].length > 0) cell.classList.add("has-itinerary");
    if (iso === selectedCalDate) cell.classList.add("selected");
    cell.textContent = day;
    cell.addEventListener("click", () => selectCalendarDay(iso, day));
    grid.appendChild(cell);
  }
}

function selectCalendarDay(iso, day) {
  selectedCalDate = iso;
  renderCalendar();
  updateDateTripInfo(iso);
  const editor = $("reminderEditor");
  editor.classList.remove("hidden");
  const m = calendarViewDate.getMonth();
  $("reminderEditorLabel").textContent = `🔔 Lembretes para ${day}/${m + 1}`;
  $("reminderText").value = "";
  renderItineraryForDay(iso);
  renderReminderEntries(iso);
}

function renderItineraryForDay(iso) {
  const el = $("itineraryForDayList");
  const items = itinerarioByDate[iso] || [];
  if (items.length === 0) { el.innerHTML = ""; return; }
  el.innerHTML = `<div style="font-size:14px; font-weight:700; color:var(--gold); margin-bottom:8px; display:flex; align-items:center; gap:6px;">📌 Itinerário do dia <span style="font-weight:500; font-size:11px; color:var(--muted);">(clique para editar)</span></div>` +
    items.map((it) => {
      const hasValue = it.value && Number(it.value) > 0;
      return `
        <div class="card" data-itin-id="${escapeHtml(it.id)}" style="padding:12px 14px; margin-bottom:8px; cursor:pointer; border-left:4px solid var(--gold);">
          <div class="card-row">
            <div>
              <div class="card-title" style="font-size:14px;">${escapeHtml(it.title)}</div>
              <div class="card-meta">${it.time ? escapeHtml(it.time + (it.endTime ? "–" + it.endTime : "")) : ""}${hasValue ? " · R$ " + Number(it.value).toFixed(2) : ""}</div>
              ${it.location ? `<div class="card-meta">${escapeHtml(it.location)} ${mapLink(it.location)}</div>` : ""}
              <div class="card-meta">${calendarLink(it)}</div>
            </div>
            <span class="badge badge-${escapeHtml(it.status)}">${escapeHtml(t("status." + it.status))}</span>
          </div>
        </div>`;
    }).join("") +
    `<div style="height:14px;"></div>`;

  el.querySelectorAll("[data-itin-id]").forEach((card) => {
    card.addEventListener("click", () => {
      const it = items.find((i) => i.id === card.dataset.itinId);
      if (!it) return;
      const itinerarioTab = document.querySelector('.tab[data-tab="itinerario"]');
      if (itinerarioTab) itinerarioTab.click();
      openItinerarioForEdit(it.id, it);
    });
  });
}

function renderReminderEntries(iso) {
  const listEl = $("reminderEntriesList");
  const entries = remindersByDate[iso] || [];
  if (entries.length === 0) { listEl.innerHTML = `<div class='empty' style='padding:8px 0;'>${t("empty.reminders")}</div>`; return; }
  listEl.innerHTML = "";
  entries.forEach((r) => {
    const canDelete = r.visibility === "shared" || r.authorEmail === currentUser.email;
    const accentColor = r.visibility === "shared" ? "var(--teal)" : "var(--red)";
    const row = document.createElement("div");
    row.className = "card";
    row.style.cssText = `padding:12px 14px; margin-bottom:8px; border-left:4px solid ${accentColor};`;
    row.innerHTML = `
      <div class="card-row">
        <span class="card-meta" style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--ink);">
          <span class="badge badge-${escapeHtml(r.visibility)}">${r.visibility === "shared" ? t("badge.group") : t("badge.onlyMe")}</span>
          ${escapeHtml(r.text)}
        </span>
        ${canDelete ? `<button class="item-del">✕</button>` : ""}
      </div>
    `;
    if (canDelete) {
      row.querySelector("button").addEventListener("click", async () => {
        await deleteDoc(doc(db, "trips", currentTripId, "lembretes", r.id));
        logActivity("calendario", "lembrete removido", `${iso}: ${r.text}`);
      });
    }
    listEl.appendChild(row);
  });
}

document.querySelectorAll("[data-remvis]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-remvis]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentRemVis = btn.dataset.remvis;
  });
});

$("calPrevBtn").addEventListener("click", () => {
  calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
  renderCalendar();
});
$("calNextBtn").addEventListener("click", () => {
  calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
  renderCalendar();
});

$("saveReminderBtn").addEventListener("click", async () => {
  const text = $("reminderText").value.trim();
  if (!text || !selectedCalDate) { showToast("Escreva algo pro lembrete."); return; }
  setButtonLoading($("saveReminderBtn"), true);
  try {
    await addDoc(collection(db, "trips", currentTripId, "lembretes"), {
      text, visibility: currentRemVis, authorEmail: currentUser.email, date: selectedCalDate
    });
    logActivity("calendario", "lembrete adicionado", `${selectedCalDate}: ${text} (${currentRemVis})`);
    $("reminderText").value = "";
  } catch (err) {
    showToast("Não foi possível salvar o lembrete. Tenta de novo em instantes.", "error"); console.warn("Não foi possível salvar o lembrete:", err);
  } finally {
    setButtonLoading($("saveReminderBtn"), false);
  }
});
