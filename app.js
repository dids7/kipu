import { auth, googleProvider, db } from "./firebase-config.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- Estado global ----------
let currentUser = null;
let currentTripId = null;
let currentTripData = null;
let malaSeg = "shared";
let unsubscribers = [];

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

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    $("userEmailLabel").textContent = user.email;
    hide($("loginScreen"));
    goToTripPicker();
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
  const snap = await getDocs(query(collection(db, "trips"), where("__name__", "==", tripId)));
  snap.forEach((d) => { currentTripData = d.data(); });

  hide($("tripPickerScreen"));
  show($("appScreen"));
  $("currentTripTitle").textContent = currentTripData.name;
  $("tripDestinationLabel").textContent = currentTripData.destination || "—";
  renderParticipants();
  renderCountdown();
  populateResponsibleSelects();

  subscribeItinerario();
  subscribeEstadia();
  subscribePasseios();
  subscribeDocumentos();
  subscribeMala();
  subscribeTarefas();
  subscribeGastos();
  subscribeEmergencia();
  subscribeHistorico();
}

function clearSubscriptions() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
}

function renderParticipants() {
  $("participantsList").textContent = (currentTripData.participantEmails || []).join(", ");
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

function populateResponsibleSelects() {
  const emails = currentTripData.participantEmails || [];
  const opts = emails.map((e) => `<option value="${e}">${e}</option>`).join("");
  ["tourResponsible", "taskResponsible", "expPaidBy"].forEach((id) => {
    $(id).innerHTML = opts;
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
  });
});

// ---------- Toggle de formulários ----------
document.querySelectorAll("[data-form]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $(btn.dataset.form).classList.toggle("hidden");
  });
});

// ================= ITINERÁRIO =================
function subscribeItinerario() {
  const q = query(collection(db, "trips", currentTripId, "itinerario"), orderBy("date"));
  const unsub = onSnapshot(q, (snap) => {
    const listEl = $("itinerarioList");
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhum item ainda.</div>"; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const it = d.data();
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${it.title}</div>
            <div class="card-meta">${fmtDate(it.date)} ${it.time ? "· " + it.time : ""}</div>
          </div>
          <button class="badge badge-${it.status}" data-id="${d.id}" data-status="${it.status}">${it.status}</button>
        </div>`;
      card.querySelector("button").addEventListener("click", (e) => cycleItinerarioStatus(d.id, it.status, it.title));
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
  if (!date || !title) { alert("Preencha data e atividade."); return; }
  await addDoc(collection(db, "trips", currentTripId, "itinerario"), { date, time, title, status });
  logActivity("itinerario", "item adicionado", title);
  $("itDate").value = ""; $("itTime").value = ""; $("itTitle").value = "";
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

// ================= PASSEIOS =================
function subscribePasseios() {
  const unsub = onSnapshot(collection(db, "trips", currentTripId, "passeios"), (snap) => {
    const listEl = $("passeiosList");
    if (snap.empty) { listEl.innerHTML = "<div class='empty'>Nenhum passeio ainda.</div>"; return; }
    listEl.innerHTML = "";
    snap.forEach((d) => {
      const t = d.data();
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-row">
          <div>
            <div class="card-title">${t.name}</div>
            <div class="card-meta">${fmtDate(t.date)} ${t.time ? "· " + t.time : ""} · R$ ${Number(t.value || 0).toFixed(2)} · resp: ${t.responsible || "—"}</div>
          </div>
          <span class="badge badge-${t.status === "pago" ? "confirmado" : "programado"}">${t.status}</span>
        </div>`;
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}
$("saveTourBtn").addEventListener("click", async () => {
  const name = $("tourName").value.trim(), date = $("tourDate").value, time = $("tourTime").value;
  const value = parseFloat($("tourValue").value) || 0, status = $("tourStatus").value, responsible = $("tourResponsible").value;
  if (!name || !date) { alert("Preencha nome e data."); return; }
  await addDoc(collection(db, "trips", currentTripId, "passeios"), { name, date, time, value, status, responsible });
  logActivity("passeios", "passeio adicionado", name);
  $("tourName").value = ""; $("tourDate").value = ""; $("tourTime").value = ""; $("tourValue").value = "";
  $("passeioForm").classList.add("hidden");
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
      card.innerHTML = `
        <div class="card-title">${doc_.title}</div>
        <div class="card-meta">${doc_.notes || ""}</div>
        ${doc_.url ? `<a href="${doc_.url}" target="_blank" style="color:var(--gold); font-size:12.5px;">Abrir link ↗</a>` : ""}
      `;
      listEl.appendChild(card);
    });
  });
  unsubscribers.push(unsub);
}
$("saveDocBtn").addEventListener("click", async () => {
  const title = $("docTitle").value.trim(), url = $("docUrl").value.trim(), notes = $("docNotes").value.trim();
  if (!title) { alert("Preencha o título."); return; }
  await addDoc(collection(db, "trips", currentTripId, "documentos"), { title, url, notes });
  logActivity("documentos", "documento adicionado", title);
  $("docTitle").value = ""; $("docUrl").value = ""; $("docNotes").value = "";
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
