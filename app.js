import { auth, googleProvider, db, storage } from "./firebase-config.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

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

function mapLink(address) {
  if (!address || !address.trim()) return "";
  const url = `https://maps.google.com/maps?q=${encodeURIComponent(address.trim())}`;
  return `<a href="${url}" target="_blank" rel="noopener" class="map-link" onclick="event.stopPropagation()">📍 Ver no mapa</a>`;
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

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    $("userEmailLabel").textContent = user.email;
    hide($("loginScreen"));
    const savedTripId = localStorage.getItem(LS_TRIP_KEY);
    if (savedTripId) {
      openTrip(savedTripId).catch(() => {
        localStorage.removeItem(LS_TRIP_KEY);
        goToTripPicker();
      });
    } else {
      goToTripPicker();
    }
  } else {
    show($("loginScreen"));
    hide($("tripPickerScreen"));
    hide($("appScreen"));
  }
});

// ---------- Seleção / criação de viagem ----------
function goToTripPicker() {
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
    listEl.innerHTML = "<div class='empty'>Nenhuma viagem ainda. Crie a primeira abaixo.</div>";
    return;
  }
  listEl.innerHTML = "";
  snap.forEach((d) => {
    const trip = d.data();
    const card = document.createElement("div");
    card.className = "trip-card";
    card.innerHTML = `
      <div class="trip-card-title">${trip.name}</div>
      <div class="trip-card-meta">${trip.destination || ""} · ${fmtDate(trip.startDate)} – ${fmtDate(trip.endDate)}</div>
    `;
    card.addEventListener("click", () => openTrip(d.id));
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
  if (!participantEmails.includes(currentUser.email.toLowerCase())) {
    participantEmails.push(currentUser.email.toLowerCase());
  }
  const docRef = await addDoc(collection(db, "trips"), {
    name, destination, startDate, endDate,
    participantEmails,
    createdBy: currentUser.email,
    createdAt: serverTimestamp()
  });
  $("newTripForm").classList.add("hidden");
  $("tripName").value = ""; $("tripDestination").value = "";
  $("tripStart").value = ""; $("tripEnd").value = ""; $("tripParticipants").value = "";
  openTrip(docRef.id);
});

$("backToTripsBtn").addEventListener("click", goToTripPicker);

// ---------- Abrir viagem ----------
async function openTrip(tripId) {
  currentTripId = tripId;
  currentTripData = null;
  const snap = await getDocs(query(collection(db, "trips"), where("__name__", "==", tripId)));
  snap.forEach((d) => { currentTripData = d.data(); });

  if (!currentTripData) {
    throw new Error("Viagem não encontrada ou sem acesso.");
  }

  localStorage.setItem(LS_TRIP_KEY, tripId);

  // Carrega todas as viagens do usuário, pra o calendário saber qual viagem
  // cobre cada data (pode ser esta ou outra, ex: Peru dia 4-12, Miami dia 22-26)
  const allSnap = await getDocs(query(collection(db, "trips"), where("participantEmails", "array-contains", currentUser.email)));
  allUserTrips = [];
  allSnap.forEach((d) => allUserTrips.push({ id: d.id, ...d.data() }));

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
  return allUserTrips.find((t) => iso >= t.startDate && iso <= t.endDate) || null;
}

function updateDateTripInfo(iso) {
  const trip = findTripForDate(iso);
  const card = $("dateTripInfoCard");
  const emptyState = $("dateEmptyState");
  if (!trip) { hide(card); show(emptyState); return; }
  hide(emptyState);
  show(card);
  $("dateTripNameLabel").textContent = trip.name;
  $("dateTripDestinoLabel").textContent = trip.destination || "—";
  const isCurrentTrip = trip.id === currentTripId;
  renderParticipants(trip, isCurrentTrip);
  $("participantEditRow").classList.toggle("hidden", !isCurrentTrip);
}

function renderParticipants(trip, editable) {
  const listEl = $("participantsList");
  const emails = trip.participantEmails || [];
  listEl.innerHTML = "";
  emails.forEach((email) => {
    const row = document.createElement("div");
    row.className = "card-row";
    row.style.padding = "4px 0";
    const isLast = emails.length === 1;
    row.innerHTML = `
      <span class="card-meta">${email}</span>
      ${editable ? `<button class="item-del" ${isLast ? "disabled title='precisa ter ao menos 1 participante'" : ""}>✕</button>` : ""}
    `;
    if (editable && !isLast) {
      row.querySelector("button").addEventListener("click", () => removeParticipant(email));
    }
    listEl.appendChild(row);
  });
}

async function removeParticipant(email) {
  if (!confirm(`Remover ${email} da viagem?`)) return;
  const updated = (currentTripData.participantEmails || []).filter((e) => e !== email);
  await updateDoc(doc(db, "trips", currentTripId), { participantEmails: updated });
  currentTripData.participantEmails = updated;
  const idx = allUserTrips.findIndex((t) => t.id === currentTripId);
  if (idx >= 0) allUserTrips[idx].participantEmails = updated;
  if (selectedCalDate) updateDateTripInfo(selectedCalDate);
  populateResponsibleSelects();
  logActivity("geral", "participante removido", email);
}

$("addParticipantBtn").addEventListener("click", async () => {
  const input = $("newParticipantEmail");
  const email = input.value.trim().toLowerCase();
  if (!email || !email.includes("@")) { alert("Digite um e-mail válido."); return; }
  const current = currentTripData.participantEmails || [];
  if (current.includes(email)) { alert("Esse participante já está na viagem."); input.value = ""; return; }
  const updated = [...current, email];
  await updateDoc(doc(db, "trips", currentTripId), { participantEmails: updated });
  currentTripData.participantEmails = updated;
  const idx = allUserTrips.findIndex((t) => t.id === currentTripId);
  if (idx >= 0) allUserTrips[idx].participantEmails = updated;
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
  const opts = emails.map((e) => `<option value="${e}">${e}</option>`).join("");
  ["itResponsible", "taskResponsible", "expPaidBy"].forEach((id) => {
    $(id).innerHTML = (id === "itResponsible" ? "<option value=''>—</option>" : "") + opts;
  });
  const splitGroup = $("expSplitGroup");
  splitGroup.innerHTML = "";
  emails.forEach((e) => {
    const chip = document.createElement("div");
    chip.className = "checkbox-chip checked";
    chip.textContent = e;
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
      listEl.innerHTML = "<div class='empty'>Nenhum item ainda.</div>";
      renderCalendar();
      if (selectedCalDate) renderItineraryForDay(selectedCalDate);
      return;
    }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const it = d.data();
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
              ${it.responsible ? ` · resp: ${it.responsible}` : ""}
              ${it.location ? ` · ${it.location}` : ""}
            </div>
            ${mapLink(it.location)}
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="item-del" data-action="edit" title="Editar">✎</button>
            <button class="badge badge-${it.status}" data-action="status">${it.status}</button>
          </div>
        </div>`;
      card.querySelector('[data-action="status"]').addEventListener("click", () => cycleItinerarioStatus(d.id, it.status, it.title));
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openItinerarioForEdit(d.id, it));
      listEl.appendChild(card);
    });
    renderCalendar();
    if (selectedCalDate) renderItineraryForDay(selectedCalDate);
  });
  unsubscribers.push(unsub);
}
const statusCycle = { cogitando: "programado", programado: "confirmado", confirmado: "cogitando" };
async function cycleItinerarioStatus(id, current, title) {
  const next = statusCycle[current];
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
  $("itStatus").value = it.status || "cogitando";
  $("itValue").value = it.value || "";
  $("itPaymentStatus").value = it.paymentStatus || "pendente";
  $("itResponsible").value = it.responsible || "";
  $("saveItinerarioBtn").textContent = "Salvar alterações";
  $("cancelItinerarioEditBtn").classList.remove("hidden");
  $("itinerarioForm").classList.remove("hidden");
  $("itinerarioForm").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetItinerarioForm() {
  editingItinerarioId = null;
  $("itDate").value = ""; $("itTime").value = ""; $("itEndTime").value = ""; $("itTitle").value = "";
  $("itLocation").value = "";
  $("itValue").value = ""; $("itResponsible").value = ""; $("itStatus").value = "cogitando";
  $("itPaymentStatus").value = "pendente";
  $("saveItinerarioBtn").textContent = "Salvar";
  $("cancelItinerarioEditBtn").classList.add("hidden");
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
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhuma hospedagem ainda.</div>"; return; }
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
            <span class="badge badge-${s.status === "pago" ? "confirmado" : "programado"}">${s.status}</span>
          </div>
        </div>`;
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openEstadiaForEdit(d.id, s));
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
  if (!$("estadiaForm").classList.contains("hidden") || editingEstadiaId) resetEstadiaForm();
});
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
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhum documento ainda.</div>"; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const doc_ = d.data();
      const card = document.createElement("div");
      card.className = "card";
      const isImage = doc_.fileType && doc_.fileType.startsWith("image/");
      card.innerHTML = `
        <div class="card-row">
          <div class="card-title">${doc_.title}</div>
          <button class="item-del" data-action="edit" title="Editar">✎</button>
        </div>
        <div class="card-meta">${doc_.notes || ""}</div>
        ${isImage ? `<img src="${doc_.url}" style="max-width:100%; border-radius:8px; margin-top:8px;">` : ""}
        ${doc_.url ? `<a href="${doc_.url}" target="_blank" style="color:var(--gold); font-size:12.5px; display:block; margin-top:6px;">Abrir ${doc_.fileName ? doc_.fileName : "link"} ↗</a>` : ""}
      `;
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openDocForEdit(d.id, doc_));
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}

function openDocForEdit(id, doc_) {
  editingDocId = id;
  $("docTitle").value = doc_.title || "";
  $("docUrl").value = doc_.url || "";
  $("docNotes").value = doc_.notes || "";
  $("saveDocBtn").textContent = "Salvar alterações";
  $("docForm").classList.remove("hidden");
  $("docForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetDocForm() {
  editingDocId = null;
  $("docTitle").value = ""; $("docUrl").value = ""; $("docNotes").value = ""; $("docFile").value = "";
  $("saveDocBtn").textContent = "Salvar";
  $("docForm").classList.add("hidden");
}
$("addDocToggleBtn")?.addEventListener("click", () => {
  if (!$("docForm").classList.contains("hidden") || editingDocId) resetDocForm();
});

$("saveDocBtn").addEventListener("click", async () => {
  const title = $("docTitle").value.trim();
  const notes = $("docNotes").value.trim();
  let url = $("docUrl").value.trim();
  const fileInput = $("docFile");
  const file = fileInput.files[0];
  const statusEl = $("docUploadStatus");

  if (!title) { alert("Preencha o título."); return; }
  if (!file && !url) { alert("Anexe um arquivo ou cole um link."); return; }

  let fileType = "", fileName = "";
  if (file) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Enviando arquivo...";
    try {
      const path = `trips/${currentTripId}/documentos/${Date.now()}_${file.name}`;
      const fileRef = ref(storage, path);
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
    const payload = { title, url, notes };
    if (file) { payload.fileType = fileType; payload.fileName = fileName; }
    await updateDoc(doc(db, "trips", currentTripId, "documentos", editingDocId), payload);
    logActivity("documentos", "documento editado", title);
  } else {
    await addDoc(collection(db, "trips", currentTripId, "documentos"), { title, url, notes, fileType, fileName });
    logActivity("documentos", "documento adicionado", title);
  }
  resetDocForm();
  statusEl.classList.add("hidden");
});

// ================= MALA =================
document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
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
  if (items.length === 0) { listEl.innerHTML = "<div class='empty'>Nenhum item aqui ainda.</div>"; return; }
  listEl.innerHTML = "";
  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <button class="checkbox ${it.done ? "checked " + it.type : ""}">${it.done ? "✓" : ""}</button>
      <div class="item-name ${it.done ? "done" : ""}" title="Clique duas vezes pra renomear">${it.name}</div>
      <span class="badge badge-${it.type}">${it.type === "shared" ? "grupo" : "só eu"}</span>
      <button class="item-del">✕</button>
    `;
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
    name, type: malaSeg, done: false, ownerEmail: currentUser.email
  });
  logActivity("mala", "item adicionado", `${name} (${malaSeg})`);
  $("newItemName").value = "";
});

const DEFAULT_PACKING_LIST = [
  "Passaporte / documento de identidade",
  "Cópia dos documentos (física ou digital)",
  "Carregador de celular",
  "Power bank",
  "Adaptador de tomada",
  "Fone de ouvido",
  "Escova e pasta de dente",
  "Remédios de uso pessoal",
  "Protetor solar",
  "Óculos de sol",
  "Casaco/agasalho",
  "Meias extras",
  "Roupa íntima extra",
  "Chinelo",
  "Necessaire de higiene",
  "Toalha de banho pequena",
  "Máscara de dormir / tampão de ouvido",
  "Dinheiro em espécie / cartão"
];

function updateDefaultToggleState() {
  const btn = $("defaultListToggle");
  const hasDefaults = malaItemsCache.some((i) => i.isDefault);
  btn.classList.toggle("active", hasDefaults);
  btn.textContent = hasDefaults ? "Ativado ✓" : "Ativar";
}

$("defaultListToggle").addEventListener("click", async () => {
  const btn = $("defaultListToggle");
  const hasDefaults = malaItemsCache.some((i) => i.isDefault);

  if (hasDefaults) {
    const toRemove = malaItemsCache.filter((i) => i.isDefault);
    await Promise.all(toRemove.map((i) => deleteDoc(doc(db, "trips", currentTripId, "mala", i.id))));
    logActivity("mala", "lista padrão removida", `${toRemove.length} item(ns) essenciais removidos`);
    return;
  }

  const existingNames = new Set(malaItemsCache.map((i) => i.name.trim().toLowerCase()));
  const toAdd = DEFAULT_PACKING_LIST.filter((name) => !existingNames.has(name.trim().toLowerCase()));

  await Promise.all(toAdd.map((name) =>
    addDoc(collection(db, "trips", currentTripId, "mala"), {
      name, type: "shared", done: false, ownerEmail: currentUser.email, isDefault: true
    })
  ));
  logActivity("mala", "lista padrão adicionada", `${toAdd.length} item(ns) essenciais inseridos`);
});
function renderGroupProgress() {
  const el = $("groupProgress");
  const byOwner = {};
  (currentTripData.participantEmails || []).forEach((e) => { byOwner[e] = { done: 0, total: 0 }; });
  allSharedItemsCache.forEach((it) => {
    if (!byOwner[it.ownerEmail]) byOwner[it.ownerEmail] = { done: 0, total: 0 };
    byOwner[it.ownerEmail].total++;
    if (it.done) byOwner[it.ownerEmail].done++;
  });
  el.innerHTML = "";
  Object.entries(byOwner).forEach(([email, { done, total }]) => {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const row = document.createElement("div");
    row.className = "person-row";
    row.innerHTML = `
      <div class="person-head">
        <span class="person-name">${email}</span>
        <span class="person-count">${done}/${total}</span>
      </div>
      <div class="weave-track"><div class="weave-fill" style="width:${pct}%"></div></div>
    `;
    el.appendChild(row);
  });
}

// ================= TAREFAS =================
let editingTaskId = null;
function subscribeTarefas() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "tarefas"), (snap) => {
    const listEl = $("tasksList");
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhuma tarefa ainda.</div>"; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const t = d.data();
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${t.description}</div>
            <div class="card-meta">resp: ${t.responsible}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="item-del" data-action="edit" title="Editar">✎</button>
            <button class="badge badge-${t.status}" data-action="status">${t.status}</button>
          </div>
        </div>`;
      card.querySelector('[data-action="status"]').addEventListener("click", async () => {
        const next = t.status === "pendente" ? "feito" : "pendente";
        await updateDoc(doc(db, "trips", currentTripId, "tarefas", d.id), { status: next });
        logActivity("tarefas", "status alterado", `"${t.description}": ${next}`);
      });
      card.querySelector('[data-action="edit"]').addEventListener("click", () => openTaskForEdit(d.id, t));
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}

function openTaskForEdit(id, t) {
  editingTaskId = id;
  $("taskDesc").value = t.description || "";
  $("taskResponsible").value = t.responsible || "";
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
  if (!$("taskForm").classList.contains("hidden") || editingTaskId) resetTaskForm();
});

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

function usdRate() {
  return parseFloat($("usdRate").value) || 1;
}
function toBRL(value, currency) {
  return currency === "USD" ? value * usdRate() : value;
}
function fmtBRL(value) {
  return `R$ ${value.toFixed(2)}`;
}
function fmtOriginal(value, currency) {
  return currency === "USD" ? `US$ ${Number(value).toFixed(2)}` : `R$ ${Number(value).toFixed(2)}`;
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
  if (shared.length === 0) { sharedListEl.innerHTML = "<div class='empty'>Nenhum gasto compartilhado ainda.</div>"; }
  else {
    sharedListEl.innerHTML = "";
    shared.forEach((e) => {
      const card = document.createElement("div");
      card.className = "card card-row";
      const currency = e.currency || "BRL";
      const converted = currency === "USD" ? ` (≈ ${fmtBRL(toBRL(e.value, currency))})` : "";
      card.innerHTML = `
        <div>
          <div class="card-title">${e.description} — ${fmtOriginal(e.value, currency)}${converted}</div>
          <div class="card-meta">pago por ${e.paidBy} · dividido entre ${(e.splitAmong || []).length} pessoa(s)</div>
        </div>
        <button class="item-del" title="Editar">✎</button>
      `;
      card.querySelector("button").addEventListener("click", () => openExpenseForEdit(e.id, e));
      sharedListEl.appendChild(card);
    });
  }
  const sharedTotalBRL = shared.reduce((sum, e) => sum + toBRL(Number(e.value), e.currency || "BRL"), 0);
  $("sharedTotal").textContent = fmtBRL(sharedTotalBRL);

  const personalListEl = $("personalExpensesList");
  if (personal.length === 0) { personalListEl.innerHTML = "<div class='empty'>Nenhum gasto pessoal ainda.</div>"; }
  else {
    personalListEl.innerHTML = "";
    personal.forEach((e) => {
      const card = document.createElement("div");
      card.className = "card card-row";
      const currency = e.currency || "BRL";
      const converted = currency === "USD" ? ` (≈ ${fmtBRL(toBRL(e.value, currency))})` : "";
      card.innerHTML = `
        <div class="card-title">${e.description} — ${fmtOriginal(e.value, currency)}${converted}</div>
        <button class="item-del" title="Editar">✎</button>
      `;
      card.querySelector("button").addEventListener("click", () => openExpenseForEdit(e.id, e));
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
    return `<div class="card-row" style="padding:4px 0;"><span class="card-meta">${email}</span><span class="${cls}">${fmtBRL(Math.abs(val))} ${label}</span></div>`;
  }).join("");
}

$("usdRate").addEventListener("input", () => { renderExpenses(); renderBalance(); });

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
  if (!$("expenseForm").classList.contains("hidden") || editingExpenseId) resetExpenseForm();
});

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
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhuma informação ainda.</div>"; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const it = d.data();
      const card = document.createElement("div");
      card.className = "card card-row";
      card.innerHTML = `
        <div><span class="card-title">${it.label}</span><br><span class="card-meta">${it.value}</span></div>
        <button class="item-del" title="Editar">✎</button>
      `;
      card.querySelector("button").addEventListener("click", () => openEmergencyForEdit(d.id, it));
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
  if (!$("emergencyForm").classList.contains("hidden") || editingEmergencyId) resetEmergencyForm();
});

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
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhuma alteração registrada ainda.</div>"; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const log = d.data();
      const row = document.createElement("div");
      row.className = "log-entry";
      const time = log.timestamp ? log.timestamp.toDate().toLocaleString("pt-BR") : "agora";
      row.innerHTML = `<span class="log-author">${log.authorEmail}</span> — ${log.action}: ${log.description} <div class="log-time">${time}</div>`;
      listEl.appendChild(row);
    });
  });
  unsubscribers.push(unsub);
}

$("clearHistoryBtn").addEventListener("click", async () => {
  if (!confirm("Isso vai apagar TODO o histórico de alterações desta viagem, sem volta. Continuar?")) return;
  const snap = await getDocs(collection(db, "trips", currentTripId, "activityLog"));
  const deletions = [];
  snap.forEach((d) => deletions.push(deleteDoc(doc(db, "trips", currentTripId, "activityLog", d.id))));
  await Promise.all(deletions);
  await addDoc(collection(db, "trips", currentTripId, "activityLog"), {
    authorEmail: currentUser.email,
    area: "historico",
    action: "histórico limpo",
    description: `${deletions.length} registro(s) removido(s) — reinício para uso real da viagem`,
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
  $("reminderEditorLabel").textContent = `Lembretes para ${day}/${m + 1}`;
  $("reminderText").value = "";
  renderItineraryForDay(iso);
  renderReminderEntries(iso);
}

function renderItineraryForDay(iso) {
  const el = $("itineraryForDayList");
  const items = itinerarioByDate[iso] || [];
  if (items.length === 0) { el.innerHTML = ""; return; }
  el.innerHTML = `<div style="font-size:11px; color:var(--muted); margin-bottom:6px;">📌 Itinerário do dia — clique para editar</div>` +
    items.map((it) => {
      const hasValue = it.value && Number(it.value) > 0;
      return `
        <div class="card" data-itin-id="${it.id}" style="padding:10px 12px; margin-bottom:6px; cursor:pointer;">
          <div class="card-row">
            <div>
              <div class="card-title" style="font-size:13px;">${it.title}</div>
              <div class="card-meta">${it.time ? it.time + (it.endTime ? "–" + it.endTime : "") : ""}${hasValue ? " · R$ " + Number(it.value).toFixed(2) : ""}</div>
              ${it.location ? `<div class="card-meta">${it.location} ${mapLink(it.location)}</div>` : ""}
            </div>
            <span class="badge badge-${it.status}">${it.status}</span>
          </div>
        </div>`;
    }).join("");

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
  if (entries.length === 0) { listEl.innerHTML = "<div class='empty' style='padding:8px 0;'>Nenhum lembrete ainda.</div>"; return; }
  listEl.innerHTML = "";
  entries.forEach((r) => {
    const canDelete = r.visibility === "shared" || r.authorEmail === currentUser.email;
    const row = document.createElement("div");
    row.className = "card-row";
    row.style.padding = "6px 0";
    row.innerHTML = `
      <span class="card-meta" style="display:flex; align-items:center; gap:6px;">
        <span class="badge badge-${r.visibility}">${r.visibility === "shared" ? "grupo" : "só eu"}</span>
        ${r.text}
      </span>
      ${canDelete ? `<button class="item-del">✕</button>` : ""}
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
