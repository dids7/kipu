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
  if (!trip) { hide(card); return; }
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
function subscribeItinerario() {
  const q = query(collection(db, "trips", currentTripId, "itinerario"), orderBy("date"));
  const unsub = onSnapshot(q, (snap) => {
    const listEl = $("itinerarioList");
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhum item ainda.</div>"; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const it = d.data();
      const hasValue = it.value && Number(it.value) > 0;
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${it.title}</div>
            <div class="card-meta">
              ${fmtDate(it.date)} ${it.time ? "· " + it.time : ""}
              ${hasValue ? ` · R$ ${Number(it.value).toFixed(2)} (${it.paymentStatus || "pendente"})` : ""}
              ${it.responsible ? ` · resp: ${it.responsible}` : ""}
            </div>
          </div>
          <button class="badge badge-${it.status}" data-id="${d.id}" data-status="${it.status}">${it.status}</button>
        </div>`;
      card.querySelector("button").addEventListener("click", () => cycleItinerarioStatus(d.id, it.status, it.title));
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}
const statusCycle = { cogitando: "programado", programado: "confirmado", confirmado: "cogitando" };
async function cycleItinerarioStatus(id, current, title) {
  const next = statusCycle[current];
  await updateDoc(doc(db, "trips", currentTripId, "itinerario", id), { status: next });
  logActivity("itinerario", "status alterado", `"${title}": ${current} → ${next}`);
}
$("saveItinerarioBtn").addEventListener("click", async () => {
  const date = $("itDate").value, time = $("itTime").value, title = $("itTitle").value.trim();
  const status = $("itStatus").value;
  const value = parseFloat($("itValue").value) || 0;
  const paymentStatus = $("itPaymentStatus").value;
  const responsible = $("itResponsible").value;
  if (!date || !title) { alert("Preencha data e atividade."); return; }
  await addDoc(collection(db, "trips", currentTripId, "itinerario"), {
    date, time, title, status, value, paymentStatus, responsible
  });
  logActivity("itinerario", "item adicionado", title);
  $("itDate").value = ""; $("itTime").value = ""; $("itTitle").value = "";
  $("itValue").value = ""; $("itResponsible").value = "";
  $("itinerarioForm").classList.add("hidden");
});

// ================= ESTADIA =================
function subscribeEstadia() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "estadia"), (snap) => {
    const listEl = $("estadiaList");
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhuma hospedagem ainda.</div>"; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const s = d.data();
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${s.name}</div>
            <div class="card-meta">${fmtDate(s.checkin)} – ${fmtDate(s.checkout)} · ${s.address || ""}</div>
          </div>
          <span class="badge badge-${s.status === "pago" ? "confirmado" : "programado"}">${s.status}</span>
        </div>`;
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}
$("saveEstadiaBtn").addEventListener("click", async () => {
  const name = $("stayName").value.trim();
  const checkin = $("stayCheckin").value, checkout = $("stayCheckout").value;
  const address = $("stayAddress").value.trim(), status = $("stayStatus").value;
  if (!name || !checkin || !checkout) { alert("Preencha nome e datas."); return; }
  await addDoc(collection(db, "trips", currentTripId, "estadia"), { name, checkin, checkout, address, status });
  logActivity("estadia", "hospedagem adicionada", name);
  $("stayName").value = ""; $("stayCheckin").value = ""; $("stayCheckout").value = ""; $("stayAddress").value = "";
  $("estadiaForm").classList.add("hidden");
});

// ================= DOCUMENTOS =================
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
        <div class="card-title">${doc_.title}</div>
        <div class="card-meta">${doc_.notes || ""}</div>
        ${isImage ? `<img src="${doc_.url}" style="max-width:100%; border-radius:8px; margin-top:8px;">` : ""}
        ${doc_.url ? `<a href="${doc_.url}" target="_blank" style="color:var(--gold); font-size:12.5px; display:block; margin-top:6px;">Abrir ${doc_.fileName ? doc_.fileName : "link"} ↗</a>` : ""}
      `;
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}
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

  await addDoc(collection(db, "trips", currentTripId, "documentos"), { title, url, notes, fileType, fileName });
  logActivity("documentos", "documento adicionado", title);
  $("docTitle").value = ""; $("docUrl").value = ""; $("docNotes").value = ""; fileInput.value = "";
  statusEl.classList.add("hidden");
  $("docForm").classList.add("hidden");
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
  const items = malaItemsCache.filter((i) => i.type === malaSeg);
  if (items.length === 0) { listEl.innerHTML = "<div class='empty'>Nenhum item aqui ainda.</div>"; return; }
  listEl.innerHTML = "";
  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <button class="checkbox ${it.done ? "checked " + it.type : ""}">${it.done ? "✓" : ""}</button>
      <div class="item-name ${it.done ? "done" : ""}">${it.name}</div>
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
          <button class="badge badge-${t.status}">${t.status}</button>
        </div>`;
      card.querySelector("button").addEventListener("click", async () => {
        const next = t.status === "pendente" ? "feito" : "pendente";
        await updateDoc(doc(db, "trips", currentTripId, "tarefas", d.id), { status: next });
        logActivity("tarefas", "status alterado", `"${t.description}": ${next}`);
      });
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}
$("saveTaskBtn").addEventListener("click", async () => {
  const description = $("taskDesc").value.trim(), responsible = $("taskResponsible").value;
  if (!description) { alert("Preencha a descrição."); return; }
  await addDoc(collection(db, "trips", currentTripId, "tarefas"), { description, responsible, status: "pendente" });
  logActivity("tarefas", "tarefa adicionada", description);
  $("taskDesc").value = "";
  $("taskForm").classList.add("hidden");
});

// ================= GASTOS =================
let expensesCache = [];
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
  const listEl = $("expensesList");
  if (expensesCache.length === 0) { listEl.innerHTML = "<div class='empty'>Nenhum gasto ainda.</div>"; return; }
  listEl.innerHTML = "";
  expensesCache.forEach((e) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-title">${e.description} — R$ ${Number(e.value).toFixed(2)}</div>
      <div class="card-meta">pago por ${e.paidBy} · dividido entre ${(e.splitAmong || []).length} pessoa(s)</div>
    `;
    listEl.appendChild(card);
  });
}
function renderBalance() {
  const balances = {};
  (currentTripData.participantEmails || []).forEach((e) => { balances[e] = 0; });
  expensesCache.forEach((e) => {
    const per = e.value / (e.splitAmong.length || 1);
    balances[e.paidBy] = (balances[e.paidBy] || 0) + e.value;
    e.splitAmong.forEach((p) => { balances[p] = (balances[p] || 0) - per; });
  });
  const el = $("balanceSummary");
  el.innerHTML = Object.entries(balances).map(([email, val]) => {
    const cls = val >= 0 ? "balance-positive" : "balance-negative";
    const label = val >= 0 ? "a receber" : "deve";
    return `<div class="card-row" style="padding:4px 0;"><span class="card-meta">${email}</span><span class="${cls}">R$ ${Math.abs(val).toFixed(2)} ${label}</span></div>`;
  }).join("");
}
$("saveExpenseBtn").addEventListener("click", async () => {
  const description = $("expDesc").value.trim();
  const value = parseFloat($("expValue").value);
  const paidBy = $("expPaidBy").value;
  const splitAmong = Array.from($("expSplitGroup").querySelectorAll(".checkbox-chip.checked")).map((c) => c.dataset.email);
  if (!description || !value || splitAmong.length === 0) { alert("Preencha descrição, valor e ao menos um participante na divisão."); return; }
  await addDoc(collection(db, "trips", currentTripId, "gastos"), { description, value, paidBy, splitAmong });
  logActivity("gastos", "gasto adicionado", `${description} — R$ ${value.toFixed(2)}`);
  $("expDesc").value = ""; $("expValue").value = "";
  $("expenseForm").classList.add("hidden");
});

// ================= EMERGÊNCIA =================
function subscribeEmergencia() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "emergencia"), (snap) => {
    const listEl = $("emergencyList");
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhuma informação ainda.</div>"; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const it = d.data();
      const card = document.createElement("div");
      card.className = "card card-row";
      card.innerHTML = `<span class="card-title">${it.label}</span><span class="card-meta">${it.value}</span>`;
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}
$("saveEmergencyBtn").addEventListener("click", async () => {
  const label = $("emLabel").value.trim(), value = $("emValue").value.trim();
  if (!label || !value) { alert("Preencha rótulo e valor."); return; }
  await addDoc(collection(db, "trips", currentTripId, "emergencia"), { label, value });
  logActivity("emergencia", "informação adicionada", label);
  $("emLabel").value = ""; $("emValue").value = "";
  $("emergencyForm").classList.add("hidden");
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
    if (findTripForDate(iso)) cell.classList.add("trip-day");
    if (iso === todayISO) cell.classList.add("today");
    if (remindersByDate[iso] && remindersByDate[iso].length > 0) cell.classList.add("has-reminder");
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
  renderReminderEntries(iso);
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
