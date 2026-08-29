import { auth, googleProvider, db, storage } from "./firebase-config.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, serverTimestamp, getDocs, getDoc, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { translations, SUPPORTED_LANGS, DEFAULT_LANG } from "./translations.js";

// Flag simples: só true depois que uma viagem foi de fato aberta.
// Declarada bem no topo pra nunca dar erro de "usar antes de declarar".
let appIsOpen = false;

// ================= PERMISSÕES (papéis) =================
let myRole = "colaborador";

const ROLE_PERMS = {
  admin:       { viewCalendar: 1, editCalendar: 1, viewMala: 1, editMala: "all", viewTarefas: 1, editTarefas: "all", viewDocs: 1, editDocs: 1, viewHistorico: 1, addReminder: 1, addParticipant: true, removeParticipant: true, promote: true, editTrip: true, deleteTrip: true, reset: true },
  colaborador: { viewCalendar: 1, editCalendar: 1, viewMala: 1, editMala: "all", viewTarefas: 1, editTarefas: "all", viewDocs: 1, editDocs: 1, viewHistorico: 1, addReminder: 1, addParticipant: true, removeParticipant: true, promote: false, editTrip: true, deleteTrip: false, reset: false },
  agencia:     { viewCalendar: 1, editCalendar: 1, viewMala: 0, editMala: "none", viewTarefas: 0, editTarefas: "none", viewDocs: 0, editDocs: 0, viewHistorico: 0, addReminder: 0, addParticipant: "beforeTripStart", removeParticipant: false, promote: false, editTrip: false, deleteTrip: false, reset: false },
  convidado:   { viewCalendar: 1, editCalendar: 0, viewMala: 1, editMala: "own", viewTarefas: 1, editTarefas: "toggle", viewDocs: 1, editDocs: 1, viewHistorico: 1, addReminder: 1, addParticipant: false, removeParticipant: false, promote: false, editTrip: false, deleteTrip: false, reset: false }
};
const ROLE_ORDER = ["admin", "colaborador", "agencia", "convidado"];

function myPerms() {
  return ROLE_PERMS[myRole] || ROLE_PERMS.colaborador;
}
function can(action) {
  return !!myPerms()[action];
}
function canAddParticipant() {
  const val = myPerms().addParticipant;
  if (val === true) return true;
  if (val === "beforeTripStart") {
    return currentTripData && new Date().toISOString().slice(0, 10) < currentTripData.startDate;
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
  // Abas: Agência só enxerga Calendário, Itinerário e Estadia.
  const restrictedTabs = ["mala", "tarefas", "documentos", "gastos", "emergencia", "historico"];
  document.querySelectorAll(".tab").forEach((btn) => {
    const tabName = btn.dataset.tab;
    const hide = !can("viewCalendar") ? false : (myRole === "agencia" && restrictedTabs.includes(tabName));
    btn.classList.toggle("hidden", hide);
  });

  // Botões de adicionar item, por aba.
  $("addItinerarioToggleBtn")?.classList.toggle("hidden", !can("editCalendar"));
  $("addEstadiaToggleBtn")?.classList.toggle("hidden", !can("editCalendar"));
  $("addDocToggleBtn")?.classList.toggle("hidden", myPerms().editDocs !== 1 && myPerms().editDocs !== true);
  $("addExpenseToggleBtn")?.classList.toggle("hidden", myPerms().editDocs !== 1 && myPerms().editDocs !== true);
  $("addEmergencyToggleBtn")?.classList.toggle("hidden", myPerms().editDocs !== 1 && myPerms().editDocs !== true);
  $("addTaskToggleBtn")?.classList.toggle("hidden", myPerms().editTarefas !== "all");
  $("addItemBtn")?.classList.toggle("hidden", myPerms().editMala === "none");
  $("newItemName")?.classList.toggle("hidden", myPerms().editMala === "none");
  $("defaultListToggle")?.classList.toggle("hidden", myPerms().editMala === "none");

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


// ================= PWA: instalação =================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

(function setupInstallBanner() {
  const LS_DISMISS_KEY = "kipu_install_dismissed";
  const banner = document.getElementById("installBanner");
  const textEl = document.getElementById("installBannerText");
  const actionBtn = document.getElementById("installBannerActionBtn");
  const closeBtn = document.getElementById("installBannerCloseBtn");

  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (isStandalone) return;

  if (localStorage.getItem(LS_DISMISS_KEY)) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  let deferredPrompt = null;

  function showBanner() { banner.classList.remove("hidden"); }
  function dismissBanner() {
    banner.classList.add("hidden");
    localStorage.setItem(LS_DISMISS_KEY, "1");
  }

  closeBtn.addEventListener("click", dismissBanner);

  if (isIOS) {
    textEl.textContent = "📲 Instale o Kipu: toque em Compartilhar e depois em \"Adicionar à Tela de Início\".";
    actionBtn.textContent = "Entendi";
    actionBtn.addEventListener("click", dismissBanner);
    showBanner();
  } else {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      showBanner();
    });
    actionBtn.addEventListener("click", async () => {
      if (!deferredPrompt) { dismissBanner(); return; }
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      dismissBanner();
    });
  }
})();

// ---------- Estado global ----------
let currentUser = null;
let currentTripId = null;
let currentTripData = null;
let malaSeg = "shared";
let unsubscribers = [];
let calendarViewDate = null; // Date — mês sendo exibido
let selectedCalDate = null;  // string YYYY-MM-DD selecionada
let allUserTrips = [];       // todas as viagens onde o usuário é participante

// ---------- Helpers de tela ----------
const $ = (id) => document.getElementById(id);
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

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

async function deleteItem(subcollection, id, label, area) {
  const ok = await confirmDialog(`Excluir "${label}"? Essa ação não pode ser desfeita.`);
  if (!ok) return;
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
  const [y, m, day] = d.split("-");
  return `${day}/${m}`;
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
    alert("Erro ao entrar: " + err.message);
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

function showNameModal({ prefill = "", skipText = null } = {}) {
  return new Promise((resolve) => {
    $("profileNameInput").value = prefill;
    if (skipText) $("profileNameSkipBtn").textContent = skipText;
    $("nameModal").classList.remove("hidden");
    $("profileNameInput").focus();

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
      if (snap.exists() && snap.data().name) {
        myDisplayName = snap.data().name;
        resolve();
        return;
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
  await showNameModal({ prefill: myDisplayName || "", skipText: t("common.cancel") });
  $("userEmailLabel").textContent = myDisplayName || currentUser.email;
  $("userEmailLabel").title = currentUser.email;
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    hide($("loginScreen"));
    checkAndPromptProfile().then(() => {
      $("userEmailLabel").textContent = myDisplayName || user.email;
      $("userEmailLabel").title = user.email;
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
  loadTripList();
}

async function loadTripList() {
  const listEl = $("tripList");
  listEl.innerHTML = "<div class='empty'>Carregando...</div>";
  const q = query(collection(db, "trips"), where("participantEmails", "array-contains", currentUser.email));
  const snap = await getDocs(q);
  if (snap.empty) {
    listEl.innerHTML = `<div class='empty'>${t("empty.noTrips")}</div>`;
    return;
  }
  listEl.innerHTML = "";
  snap.forEach((d) => {
    const trip = d.data();
    const claimedRole = (trip.participantRoles || {})[currentUser.email] || (trip.participantRoles ? "colaborador" : "admin");
    const isRealAdmin = !trip.participantRoles || (trip.adminEmails || []).includes(currentUser.email);
    const myTripRole = claimedRole === "admin" && !isRealAdmin ? "colaborador" : claimedRole;
    const card = document.createElement("div");
    card.className = "trip-card";
    card.innerHTML = `
      <div class="card-row">
        <div>
          <div class="trip-card-title">${trip.name}</div>
          <div class="trip-card-meta">${trip.destination || ""} · ${fmtDate(trip.startDate)} – ${fmtDate(trip.endDate)}</div>
        </div>
        ${myTripRole === "admin" ? `<button class="icon-btn" data-admin-gear title="Gerenciar viagem" style="flex:0 0 auto;">⚙️</button>` : ""}
      </div>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-admin-gear]")) return;
      openTrip(d.id);
    });
    const gearBtn = card.querySelector("[data-admin-gear]");
    if (gearBtn) gearBtn.addEventListener("click", (e) => { e.stopPropagation(); openAdminPanel(d.id); });
    listEl.appendChild(card);
  });
}

$("showNewTripFormBtn").addEventListener("click", () => {
  $("newTripForm").classList.toggle("hidden");
});

$("createTripBtn").addEventListener("click", async () => {
  const name = $("tripName").value.trim();
  const destination = $("tripDestination").value.trim();
  const startDate = $("tripStart").value;
  const endDate = $("tripEnd").value;
  const emailsRaw = $("tripParticipants").value.trim();
  if (!name || !startDate || !endDate || !emailsRaw) {
    alert("Preencha nome, datas e ao menos um participante.");
    return;
  }
  const participantEmails = emailsRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const myEmail = currentUser.email.toLowerCase();
  if (!participantEmails.includes(myEmail)) {
    participantEmails.push(myEmail);
  }
  const participantRoles = {};
  participantEmails.forEach((e) => { participantRoles[e] = e === myEmail ? "admin" : "colaborador"; });
  const docRef = await addDoc(collection(db, "trips"), {
    name, destination, startDate, endDate,
    participantEmails,
    participantRoles,
    adminEmails: [myEmail],
    blockedEmails: [],
    defaultJoinRole: "colaborador",
    createdBy: currentUser.email,
    createdAt: serverTimestamp()
  });
  $("newTripForm").classList.add("hidden");
  $("tripName").value = ""; $("tripDestination").value = "";
  $("tripStart").value = ""; $("tripEnd").value = ""; $("tripParticipants").value = "";
  openTrip(docRef.id);
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
      openTrip(tripData.id);
      return;
    }
    if ((tripData.blockedEmails || []).map((e) => e.toLowerCase()).includes(myEmail)) {
      statusEl.textContent = "Você foi removido dessa viagem. Peça pra alguém te adicionar de novo manualmente.";
      return;
    }

    statusEl.textContent = `Encontrado: "${tripData.name}". Entrando...`;
    const joinRole = tripData.defaultJoinRole || "colaborador";
    await updateDoc(doc(db, "trips", tripData.id), {
      participantEmails: arrayUnion(myEmail),
      [`participantRoles.${myEmail}`]: joinRole
    });
    $("joinCodeInput").value = "";
    openTrip(tripData.id);
  } catch (err) {
    statusEl.textContent = `Não foi possível entrar (${err.code || err.message}). Confira o código e tente de novo.`;
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
      <span class="card-meta" title="${email}">${nameFor(email)} ${isOriginalAdmin ? "🔒" : ""}</span>
      <div style="display:flex; align-items:center; gap:6px;">
        <select data-role-select ${isOriginalAdmin ? "disabled" : ""} style="width:auto; font-size:11px; padding:5px 7px;">
          <option value="admin" data-i18n="role.admin">Admin</option>
          <option value="colaborador" data-i18n="role.colaborador">Colaborador</option>
          <option value="agencia" data-i18n="role.agencia">Agência</option>
          <option value="convidado" data-i18n="role.convidado">Convidado</option>
        </select>
        ${isOriginalAdmin ? "" : `<button class="item-del" data-remove>✕</button>`}
      </div>
    `;
    const select = row.querySelector("[data-role-select]");
    select.value = role;
    applyLanguageToElement(select);
    select.addEventListener("change", () => onAdminRoleChange(email, select.value, select));
    const removeBtn = row.querySelector("[data-remove]");
    if (removeBtn) removeBtn.addEventListener("click", () => onAdminRemoveParticipant(email));
    listEl.appendChild(row);
  });
}

function applyLanguageToElement(el) {
  el.querySelectorAll("[data-i18n]").forEach((opt) => { opt.textContent = t(opt.getAttribute("data-i18n")); });
}

async function onAdminRoleChange(email, newRole, selectEl) {
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
  const patch = { [`participantRoles.${email}`]: newRole };
  const currentAdmins = adminPanelTripData.adminEmails || [];
  if (newRole === "admin" && !currentAdmins.includes(email)) {
    adminPanelTripData.adminEmails = [...currentAdmins, email];
    patch.adminEmails = arrayUnion(email);
  } else if (newRole !== "admin" && currentAdmins.includes(email) && email !== adminPanelTripData.createdBy) {
    adminPanelTripData.adminEmails = currentAdmins.filter((e) => e !== email);
    patch.adminEmails = adminPanelTripData.adminEmails;
  }
  await updateDoc(doc(db, "trips", adminPanelTripId), patch);
  logActivity("geral", "papel alterado", `${email} → ${roleLabel(newRole)}`);
  if (adminPanelTripId === currentTripId) {
    currentTripData.participantRoles = adminPanelTripData.participantRoles;
    currentTripData.adminEmails = adminPanelTripData.adminEmails;
    myRole = computeMyRole();
    applyRolePermissions();
  }
}

async function onAdminRemoveParticipant(email) {
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

$("adminAddParticipantBtn").addEventListener("click", async () => {
  const email = $("adminNewEmail").value.trim().toLowerCase();
  const role = $("adminNewRole").value;
  if (!email || !email.includes("@")) { alert("Digite um e-mail válido."); return; }
  if ((adminPanelTripData.participantEmails || []).includes(email)) { alert("Esse participante já está na viagem."); return; }
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
  allSnap.forEach((d) => allUserTrips.push({ id: d.id, ...d.data() }));

  await loadParticipantNames(currentTripData.participantEmails);

  hide($("tripPickerScreen"));
  show($("appScreen"));
  $("currentTripTitle").textContent = currentTripData.name;
  renderCountdown();
  populateResponsibleSelects();

  subscribeItinerario();
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

  const savedTab = localStorage.getItem(LS_TAB_KEY) || "geral";
  const tabBtn = document.querySelector(`.tab[data-tab="${savedTab}"]`);
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
  if (!name || !startDate || !endDate) { alert("Preencha nome e as duas datas."); return; }
  await updateDoc(doc(db, "trips", currentTripId), { name, destination, startDate, endDate });
  currentTripData = { ...currentTripData, name, destination, startDate, endDate };
  logActivity("geral", "viagem editada", `${name} (${startDate} – ${endDate})`);
  $("currentTripTitle").textContent = name;
  renderCountdown();
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
    await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, "trips", tripId, sub, d.id))));
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
      <span class="card-meta" title="${email}">${nameFor(email)} ${isOriginalAdmin ? "🔒" : ""}<span class="badge" style="margin-left:6px; font-size:9.5px; background:var(--panel-raised); color:var(--muted);">${roleLabel(role)}</span></span>
      ${canRemoveThis ? `<button class="item-del">✕</button>` : isOriginalAdmin ? `<span class="card-meta" style="font-size:10px;" title="Admin original — não pode ser removido">🔒</span>` : ""}
    `;
    if (canRemoveThis) {
      row.querySelector("button").addEventListener("click", () => removeParticipant(email));
    }
    listEl.appendChild(row);
  });
}

async function removeParticipant(email) {
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
  if (!canAddParticipant()) { alert("Você não tem permissão pra adicionar participantes agora."); return; }
  const input = $("newParticipantEmail");
  const email = input.value.trim().toLowerCase();
  if (!email || !email.includes("@")) { alert("Digite um e-mail válido."); return; }
  const current = currentTripData.participantEmails || [];
  if (current.includes(email)) { alert("Esse participante já está na viagem."); input.value = ""; return; }
  const updated = [...current, email];
  const role = currentTripData.defaultJoinRole || "colaborador";
  const updatedRoles = { ...(currentTripData.participantRoles || {}), [email]: role };
  const updatedBlocked = (currentTripData.blockedEmails || []).filter((e) => e !== email);
  await updateDoc(doc(db, "trips", currentTripId), { participantEmails: updated, participantRoles: updatedRoles, blockedEmails: updatedBlocked });
  currentTripData.participantEmails = updated;
  currentTripData.participantRoles = updatedRoles;
  currentTripData.blockedEmails = updatedBlocked;
  const idx = allUserTrips.findIndex((t) => t.id === currentTripId);
  if (idx >= 0) allUserTrips[idx].participantEmails = updated;
  await loadParticipantNames(currentTripData.participantEmails);
  if (selectedCalDate) updateDateTripInfo(selectedCalDate);
  populateResponsibleSelects();
  logActivity("geral", "participante adicionado", email);
  input.value = "";
});

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

function populateResponsibleSelects() {
  const emails = currentTripData.participantEmails || [];
  const opts = emails.map((e) => `<option value="${e}">${nameFor(e)}</option>`).join("");
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
    if (snap.empty) {
      listEl.innerHTML = `<div class='empty'>${t("empty.itinerary")}</div>`;
      renderCalendar();
      if (selectedCalDate) renderItineraryForDay(selectedCalDate);
      return;
    }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const it = d.data();
      if (it.status === "cogitando") {
        updateDoc(doc(db, "trips", currentTripId, "itinerario", d.id), { status: "programado" }).catch(() => {});
        it.status = "programado";
      }
      if (!itinerarioByDate[it.date]) itinerarioByDate[it.date] = [];
      itinerarioByDate[it.date].push({ id: d.id, ...it });

      const hasValue = it.value && Number(it.value) > 0;
      const timeRange = it.time ? `· ${it.time}${it.endTime ? "–" + it.endTime : ""}` : "";
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${it.title}</div>
            <div class="card-meta">
              ${fmtDate(it.date)} ${timeRange}
              ${hasValue ? ` · R$ ${Number(it.value).toFixed(2)} (${it.paymentStatus || "pendente"})` : ""}
              ${it.responsible ? ` · resp: ${nameFor(it.responsible)}` : ""}
              ${it.location ? ` · ${it.location}` : ""}
            </div>
            ${mapLink(it.location)} ${calendarLink(it)}
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="item-del" data-action="edit" title="Editar">✎</button>
            <button class="item-del" data-action="delete" title="Excluir">✕</button>
            <button class="badge badge-${it.status}" data-action="status">${t("status." + it.status)}</button>
          </div>
        </div>`;
      card.querySelector('[data-action="status"]').addEventListener("click", () => cycleItinerarioStatus(d.id, it.status, it.title));
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openItinerarioForEdit(d.id, it));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("itinerario", d.id, it.title, "itinerario"));
      listEl.appendChild(card);
    });
    renderCalendar();
    if (selectedCalDate) renderItineraryForDay(selectedCalDate);
  });
  unsubscribers.push(unsub);
}
const statusCycle = { programado: "confirmado", confirmado: "programado" };
async function cycleItinerarioStatus(id, current, title) {
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
  if (!date || !title) { alert("Preencha data e atividade."); return; }
  const payload = { date, time, endTime, title, location, status, value, paymentStatus, responsible };

  if (editingItinerarioId) {
    await updateDoc(doc(db, "trips", currentTripId, "itinerario", editingItinerarioId), payload);
    logActivity("itinerario", "item editado", title);
  } else {
    await addDoc(collection(db, "trips", currentTripId, "itinerario"), payload);
    logActivity("itinerario", "item adicionado", title);
  }
  resetItinerarioForm();
});

// ================= ESTADIA =================
let editingEstadiaId = null;
let estadiaCache = [];

function subscribeEstadia() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "estadia"), (snap) => {
    estadiaCache = [];
    const listEl = $("estadiaList");
    if (snap.empty) { listEl.innerHTML = `<div class='empty'>${t("empty.stay")}</div>`; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const s = d.data();
      estadiaCache.push({ id: d.id, ...s });
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${s.name}</div>
            <div class="card-meta">${fmtDate(s.checkin)} – ${fmtDate(s.checkout)} · ${s.address || ""}</div>
            ${mapLink(s.address)}
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="item-del" data-action="edit" title="Editar">✎</button>
            <button class="item-del" data-action="delete" title="Excluir">✕</button>
            <span class="badge badge-${s.status === "pago" ? "confirmado" : "programado"}">${t("status." + s.status)}</span>
          </div>
        </div>`;
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openEstadiaForEdit(d.id, s));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("estadia", d.id, s.name, "estadia"));
      listEl.appendChild(card);
    });
  });
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
  if (!name || !checkin || !checkout) { alert("Preencha nome e datas."); return; }
  const payload = { name, checkin, checkout, address, status };
  if (editingEstadiaId) {
    await updateDoc(doc(db, "trips", currentTripId, "estadia", editingEstadiaId), payload);
    logActivity("estadia", "hospedagem editada", name);
  } else {
    await addDoc(collection(db, "trips", currentTripId, "estadia"), payload);
    logActivity("estadia", "hospedagem adicionada", name);
  }
  resetEstadiaForm();
});

// ================= DOCUMENTOS =================
let editingDocId = null;

function subscribeDocumentos() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "documentos"), (snap) => {
    const listEl = $("docsList");
    const todayISO = new Date().toISOString().slice(0, 10);
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

    if (visibleDocs.length === 0) { listEl.innerHTML = `<div class='empty'>${t("empty.documents")}</div>`; return; }
    listEl.innerHTML = "";
    visibleDocs.forEach((doc_) => {
      const card = document.createElement("div");
      card.className = "card";
      const isImage = doc_.fileType && doc_.fileType.startsWith("image/");
      let expiryLine = "";
      if (doc_.expiresAt) {
        const daysLeft = Math.ceil((new Date(doc_.expiresAt) - new Date(todayISO)) / 86400000);
        expiryLine = `<div class="card-meta" style="color:var(--gold);">⏳ ${t("documents.expiresIn").replace("{d}", daysLeft)}</div>`;
      }
      card.innerHTML = `
        <div class="card-row">
          <div class="card-title">${doc_.title}</div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="item-del" data-action="edit" title="Editar">✎</button>
            <button class="item-del" data-action="delete" title="Excluir">✕</button>
          </div>
        </div>
        <div class="card-meta">${doc_.notes || ""}</div>
        ${expiryLine}
        ${isImage ? `<img src="${doc_.url}" style="max-width:100%; border-radius:8px; margin-top:8px;">` : ""}
        ${doc_.url ? `<a href="${doc_.url}" target="_blank" style="color:var(--gold); font-size:12.5px; display:block; margin-top:6px;">Abrir ${doc_.fileName ? doc_.fileName : "link"} ↗</a>` : ""}
      `;
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openDocForEdit(doc_.id, doc_));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("documentos", doc_.id, doc_.title, "documentos"));
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}

let editingDocOriginalExpiresAt = null;

function openDocForEdit(id, doc_) {
  editingDocId = id;
  editingDocOriginalExpiresAt = doc_.expiresAt || null;
  $("docTitle").value = doc_.title || "";
  $("docUrl").value = doc_.url || "";
  $("docNotes").value = doc_.notes || "";
  $("docExpiry").value = "keep";
  $("saveDocBtn").textContent = "Salvar alterações";
  $("docForm").classList.remove("hidden");
  $("docForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetDocForm() {
  editingDocId = null;
  editingDocOriginalExpiresAt = null;
  $("docTitle").value = ""; $("docUrl").value = ""; $("docNotes").value = ""; $("docFile").value = "";
  $("docExpiry").value = "0";
  $("saveDocBtn").textContent = "Salvar";
  $("docForm").classList.add("hidden");
}
$("addDocToggleBtn")?.addEventListener("click", () => {
  if (!$("docForm").classList.contains("hidden") || editingDocId) {
    resetDocForm();
    $("docForm").classList.remove("hidden");
  }
});
$("closeDocFormBtn")?.addEventListener("click", resetDocForm);

$("saveDocBtn").addEventListener("click", async () => {
  const title = $("docTitle").value.trim();
  const notes = $("docNotes").value.trim();
  let url = $("docUrl").value.trim();
  const fileInput = $("docFile");
  const file = fileInput.files[0];
  const statusEl = $("docUploadStatus");
  const expiryValue = $("docExpiry").value;
  let expiresAt;
  if (expiryValue === "keep") {
    expiresAt = editingDocOriginalExpiresAt;
  } else {
    const expiryDays = parseInt(expiryValue, 10) || 0;
    expiresAt = expiryDays > 0
      ? new Date(Date.now() + expiryDays * 86400000).toISOString().slice(0, 10)
      : null;
  }

  if (!title) { alert("Preencha o título."); return; }
  if (!file && !url) { alert("Anexe um arquivo ou cole um link."); return; }

  let fileType = "", fileName = "", storagePath = "";
  if (file) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Enviando arquivo...";
    try {
      storagePath = `trips/${currentTripId}/documentos/${Date.now()}_${file.name}`;
      const fileRef = ref(storage, storagePath);
      await uploadBytes(fileRef, file);
      url = await getDownloadURL(fileRef);
      fileType = file.type;
      fileName = file.name;
      statusEl.textContent = "Upload concluído.";
    } catch (err) {
      statusEl.textContent = "Erro no upload: " + err.message;
      return;
    }
  }

  if (editingDocId) {
    const payload = { title, url, notes, expiresAt };
    if (file) { payload.fileType = fileType; payload.fileName = fileName; payload.storagePath = storagePath; }
    await updateDoc(doc(db, "trips", currentTripId, "documentos", editingDocId), payload);
    logActivity("documentos", "documento editado", title);
  } else {
    await addDoc(collection(db, "trips", currentTripId, "documentos"), { title, url, notes, fileType, fileName, storagePath, expiresAt });
    logActivity("documentos", "documento adicionado", title);
  }
  resetDocForm();
  statusEl.classList.add("hidden");
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
  });
  unsubscribers.push(unsub);

  const q2 = collection(db, "trips", currentTripId, "mala");
  const unsub2 = onSnapshot(q2, (snap) => {
    allSharedItemsCache = [];
    snap.forEach((d) => {
      const it = d.data();
      if (it.type === "shared") allSharedItemsCache.push(it);
    });
    renderGroupProgress();
  });
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
      <button class="checkbox ${it.done ? "checked " + it.type : ""}">${it.done ? "✓" : ""}</button>
      <div class="item-name ${it.done ? "done" : ""}" title="Clique duas vezes pra renomear">${it.name}</div>
      <div class="qty-stepper">
        <button class="qty-btn" data-action="minus">−</button>
        <span class="qty-value">${it.qty || 1}</span>
        <button class="qty-btn" data-action="plus">+</button>
      </div>
      <span class="badge badge-${it.type}">${it.type === "shared" ? t("badge.group") : t("badge.onlyMe")}</span>
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
  await addDoc(collection(db, "trips", currentTripId, "mala"), {
    name, type: malaSeg, done: false, ownerEmail: currentUser.email, qty: 1
  });
  logActivity("mala", "item adicionado", `${name} (${malaSeg})`);
  $("newItemName").value = "";
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
  const btn = $("defaultListToggle");
  const hasDefaults = malaItemsCache.some((i) => i.isDefault);
  btn.classList.toggle("active", hasDefaults);
  btn.textContent = hasDefaults ? "Ativado ✓" : "Ativar";
}

$("defaultListToggle").addEventListener("click", async () => {
  const btn = $("defaultListToggle");
  const feedbackEl = $("defaultListFeedback");
  const hasDefaults = malaItemsCache.some((i) => i.isDefault);

  if (hasDefaults) {
    const toRemove = malaItemsCache.filter((i) => i.isDefault);
    await Promise.all(toRemove.map((i) => deleteDoc(doc(db, "trips", currentTripId, "mala", i.id))));
    logActivity("mala", "lista padrão removida", `${toRemove.length} item(ns) essenciais removidos`);
    feedbackEl.classList.add("hidden");
    return;
  }

  const existingNames = new Set(malaItemsCache.map((i) => i.name.trim().toLowerCase()));
  const toAdd = DEFAULT_PACKING_LIST.filter((item) => !existingNames.has(item.name.trim().toLowerCase()));
  const sharedCount = toAdd.filter((i) => i.shared).length;
  const personalCount = toAdd.filter((i) => !i.shared).length;

  await Promise.all(toAdd.map((item) =>
    addDoc(collection(db, "trips", currentTripId, "mala"), {
      name: item.name, type: item.shared ? "shared" : "personal", done: false, ownerEmail: currentUser.email, isDefault: true, qty: 1
    })
  ));
  logActivity("mala", "lista padrão adicionada", `${toAdd.length} item(ns) essenciais inseridos`);

  feedbackEl.textContent = `✓ ${t("packing.addedTo")} — 🔒 ${personalCount} ${t("badge.onlyMe")} · 🧵 ${sharedCount} ${t("badge.group")}`;
  feedbackEl.classList.remove("hidden");
});
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
      return `<span class="owner-badge" style="${style}" title="${displayName}${e.done ? " ✓" : ""}">${initial}</span>`;
    }).join("");
    return `
      <div class="list-row">
        <span class="card-meta" style="color:var(--ink); font-weight:600;">${g.displayName}</span>
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
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${task.description}</div>
            <div class="card-meta">resp: ${nameFor(task.responsible)}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="item-del" data-action="edit" title="Editar">✎</button>
            <button class="item-del" data-action="delete" title="Excluir">✕</button>
            <button class="badge badge-${task.status}" data-action="status">${t("status." + task.status)}</button>
          </div>
        </div>`;
      card.querySelector('[data-action="status"]').addEventListener("click", async () => {
        const next = task.status === "pendente" ? "feito" : "pendente";
        await updateDoc(doc(db, "trips", currentTripId, "tarefas", d.id), { status: next });
        logActivity("tarefas", "status alterado", `"${task.description}": ${next}`);
      });
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openTaskForEdit(d.id, task));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("tarefas", d.id, task.description, "tarefas"));
      listEl.appendChild(card);
    });
  });
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
  if (!description) { alert("Preencha a descrição."); return; }
  if (editingTaskId) {
    await updateDoc(doc(db, "trips", currentTripId, "tarefas", editingTaskId), { description, responsible });
    logActivity("tarefas", "tarefa editada", description);
  } else {
    await addDoc(collection(db, "trips", currentTripId, "tarefas"), { description, responsible, status: "pendente" });
    logActivity("tarefas", "tarefa adicionada", description);
  }
  resetTaskForm();
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
function todayStr() { return new Date().toISOString().slice(0, 10); }

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
  });
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
          <div class="card-title">${e.description} — ${fmtOriginal(e.value, currency)}${converted}</div>
          <div class="card-meta">pago por ${nameFor(e.paidBy)} · dividido entre ${(e.splitAmong || []).length} pessoa(s)</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="item-del" data-action="edit" title="Editar">✎</button>
          <button class="item-del" data-action="delete" title="Excluir">✕</button>
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
        <div class="card-title">${e.description} — ${fmtOriginal(e.value, currency)}${converted}</div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="item-del" data-action="edit" title="Editar">✎</button>
          <button class="item-del" data-action="delete" title="Excluir">✕</button>
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
    return `<div class="list-row"><span class="card-meta">${nameFor(email)}</span><span class="${cls}">${fmtBRL(Math.abs(val))} ${label}</span></div>`;
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
  if (!description || !value) { alert("Preencha descrição e valor."); return; }

  let payload = { description, value, currency, type: expTypeSeg };
  if (expTypeSeg === "shared") {
    const paidBy = $("expPaidBy").value;
    const splitAmong = Array.from($("expSplitGroup").querySelectorAll(".checkbox-chip.checked")).map((c) => c.dataset.email);
    if (splitAmong.length === 0) { alert("Escolha ao menos um participante na divisão."); return; }
    payload = { ...payload, paidBy, splitAmong };
  } else {
    payload.ownerEmail = currentUser.email;
  }

  if (editingExpenseId) {
    await updateDoc(doc(db, "trips", currentTripId, "gastos", editingExpenseId), payload);
    logActivity("gastos", "gasto editado", `${description} — ${fmtOriginal(value, currency)}`);
  } else {
    await addDoc(collection(db, "trips", currentTripId, "gastos"), payload);
    logActivity("gastos", "gasto adicionado", `${description} — ${fmtOriginal(value, currency)} (${expTypeSeg})`);
  }
  resetExpenseForm();
});

// ================= EMERGÊNCIA =================
let editingEmergencyId = null;
function subscribeEmergencia() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "emergencia"), (snap) => {
    const listEl = $("emergencyList");
    if (snap.empty) { listEl.innerHTML = `<div class='empty'>${t("empty.emergency")}</div>`; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const it = d.data();
      const card = document.createElement("div");
      card.className = "card card-row";
      card.innerHTML = `
        <div><span class="card-title">${it.label}</span><br><span class="card-meta">${it.value}</span></div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="item-del" data-action="edit" title="Editar">✎</button>
          <button class="item-del" data-action="delete" title="Excluir">✕</button>
        </div>
      `;
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openEmergencyForEdit(d.id, it));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteItem("emergencia", d.id, it.label, "emergencia"));
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}

function openEmergencyForEdit(id, it) {
  editingEmergencyId = id;
  $("emLabel").value = it.label || "";
  $("emValue").value = it.value || "";
  $("saveEmergencyBtn").textContent = "Salvar alterações";
  $("emergencyForm").classList.remove("hidden");
  $("emergencyForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetEmergencyForm() {
  editingEmergencyId = null;
  $("emLabel").value = ""; $("emValue").value = "";
  $("saveEmergencyBtn").textContent = "Salvar";
  $("emergencyForm").classList.add("hidden");
}
$("addEmergencyToggleBtn")?.addEventListener("click", () => {
  if (!$("emergencyForm").classList.contains("hidden") || editingEmergencyId) {
    resetEmergencyForm();
    $("emergencyForm").classList.remove("hidden");
  }
});
$("closeEmergencyFormBtn")?.addEventListener("click", resetEmergencyForm);

$("saveEmergencyBtn").addEventListener("click", async () => {
  const label = $("emLabel").value.trim(), value = $("emValue").value.trim();
  if (!label || !value) { alert("Preencha rótulo e valor."); return; }
  if (editingEmergencyId) {
    await updateDoc(doc(db, "trips", currentTripId, "emergencia", editingEmergencyId), { label, value });
    logActivity("emergencia", "informação editada", label);
  } else {
    await addDoc(collection(db, "trips", currentTripId, "emergencia"), { label, value });
    logActivity("emergencia", "informação adicionada", label);
  }
  resetEmergencyForm();
});

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
      row.innerHTML = `<span class="log-author">${nameFor(log.authorEmail)}</span> — ${log.action}: ${log.description} <div class="log-time">${time}</div>`;
      listEl.appendChild(row);
    });
  });
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
    await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, "trips", currentTripId, sub, d.id))));
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
  });
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

  const todayISO = toISODate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

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
        <div class="card" data-itin-id="${it.id}" style="padding:12px 14px; margin-bottom:8px; cursor:pointer; border-left:4px solid var(--gold);">
          <div class="card-row">
            <div>
              <div class="card-title" style="font-size:14px;">${it.title}</div>
              <div class="card-meta">${it.time ? it.time + (it.endTime ? "–" + it.endTime : "") : ""}${hasValue ? " · R$ " + Number(it.value).toFixed(2) : ""}</div>
              ${it.location ? `<div class="card-meta">${it.location} ${mapLink(it.location)}</div>` : ""}
              <div class="card-meta">${calendarLink(it)}</div>
            </div>
            <span class="badge badge-${it.status}">${t("status." + it.status)}</span>
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
          <span class="badge badge-${r.visibility}">${r.visibility === "shared" ? t("badge.group") : t("badge.onlyMe")}</span>
          ${r.text}
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
  if (!text || !selectedCalDate) { alert("Escreva algo pro lembrete."); return; }
  await addDoc(collection(db, "trips", currentTripId, "lembretes"), {
    text, visibility: currentRemVis, authorEmail: currentUser.email, date: selectedCalDate
  });
  logActivity("calendario", "lembrete adicionado", `${selectedCalDate}: ${text} (${currentRemVis})`);
  $("reminderText").value = "";
});
