// =====================================================================
// Kipu — Cloud Functions
// ---------------------------------------------------------------------
// 1) retencaoDiaria — ARQ-1 (28/set/2026): retenção automática de dados
//    sensíveis.
// 2) contarViagensDaAgencia + sincronizarAgencias — ARQ-4 (28/set/2026):
//    o servidor passa a ser o dono da verdade dos contadores das agências.
//
// (ARQ-1, em detalhe:)
// A Política de Privacidade promete apagar Documentos e informações de
// Emergência 30 dias após o fim da viagem. Antes, essa exclusão só
// acontecia no navegador, e só quando alguém abria a aba daquela viagem —
// viagem encerrada que ninguém reabre guardava RG, passaporte e dados de
// saúde pra sempre. Agora um robô no servidor faz a varredura todo dia.
//
// Este arquivo é público e não contém nenhum segredo.
// =====================================================================

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

const STORAGE_BUCKET = "kipu-c1e97.firebasestorage.app";
const TIME_ZONE = "America/Sao_Paulo";
const REGION = "southamerica-east1"; // mesma região do banco de dados

initializeApp({ storageBucket: STORAGE_BUCKET }); // uma vez só, fora da função

// Subcoleções da viagem que têm data de expiração (campo "expiresAt",
// texto AAAA-MM-DD) e o nome que aparece no registro do Histórico.
const RETENTION_COLLECTIONS = [
  { name: "documentos", label: "documento(s)", hasFile: true },
  { name: "emergencia", label: "informação(ões) de emergência", hasFile: false }
];

// "Hoje" no fuso de Brasília, no mesmo formato das datas do app (AAAA-MM-DD).
// Mesma regra do app: expiresAt < hoje → vencido.
function todayInBrazil(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
}

// Apaga o que venceu em UMA viagem. Devolve quantos itens foram removidos
// por coleção. Recebe db e bucket de fora pra dar pra testar sem Firebase.
async function purgeExpiredInTrip(db, bucket, tripId, today) {
  const removed = {};
  for (const col of RETENTION_COLLECTIONS) {
    const snap = await db.collection("trips").doc(tripId).collection(col.name)
      .where("expiresAt", "<", today).get();
    let count = 0;
    for (const item of snap.docs) {
      const data = item.data();
      // Arquivo (foto/PDF) no Storage: apaga primeiro. Se já não existe,
      // tudo bem — o importante é não sobrar nada.
      if (col.hasFile && data.storagePath) {
        try {
          await bucket.file(data.storagePath).delete({ ignoreNotFound: true });
        } catch (err) {
          logger.warn("Não consegui apagar o arquivo; o documento fica pra próxima varredura", { tripId, path: data.storagePath, err: String(err) });
          continue; // não apaga o registro se o arquivo ficou — evita sobrar arquivo órfão
        }
      }
      await item.ref.delete();
      count++;
    }
    if (count > 0) removed[col.name] = count;
  }
  return removed;
}

// Varre todas as viagens. Uma viagem com problema não derruba as outras.
async function runRetention(db, bucket, now = new Date()) {
  const today = todayInBrazil(now);
  const summary = { today, trips: 0, tripsWithRemovals: 0, removed: 0, errors: 0 };

  const tripsSnap = await db.collection("trips").select().get(); // só os IDs
  for (const trip of tripsSnap.docs) {
    summary.trips++;
    try {
      const removed = await purgeExpiredInTrip(db, bucket, trip.id, today);
      const total = Object.values(removed).reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      summary.tripsWithRemovals++;
      summary.removed += total;
      // Registro no Histórico da viagem. De propósito só CONTA os itens —
      // sem título nem conteúdo, senão o registro guardaria justamente o
      // dado que acabou de ser apagado.
      const parts = RETENTION_COLLECTIONS
        .filter((c) => removed[c.name])
        .map((c) => `${removed[c.name]} ${c.label}`);
      await db.collection("trips").doc(trip.id).collection("activityLog").add({
        authorEmail: "Kipu (automático)",
        area: "geral",
        action: "retenção automática",
        description: `Removido(s) por prazo de retenção vencido: ${parts.join(" e ")}.`,
        timestamp: FieldValue.serverTimestamp()
      });
    } catch (err) {
      summary.errors++;
      logger.error("Falha ao processar viagem", { tripId: trip.id, err: String(err) });
    }
  }
  logger.info("Varredura de retenção concluída", summary);
  return summary;
}

// Todo dia às 3h da manhã (Brasília).
exports.retencaoDiaria = onSchedule(
  {
    schedule: "every day 03:00",
    timeZone: TIME_ZONE,
    region: REGION,
    timeoutSeconds: 540,
    memory: "256MiB"
  },
  async () => {
    await runRetention(getFirestore(), getStorage().bucket());
  }
);

// =====================================================================
// ARQ-4 — contadores das agências
// ---------------------------------------------------------------------
// Antes, o navegador mantinha os contadores da agência (viagens ativas e
// total criado) e as regras do Firestore vigiavam cada passo. O ajuste só
// acontecia quando alguém da agência abria o painel — o Painel Master
// leria números desatualizados. Agora o servidor recalcula, do zero, sempre
// que uma viagem de agência muda, e faz uma varredura diária. Como o
// cálculo é sempre "contar de novo" (nunca somar/subtrair), ele corrige
// sozinho qualquer erro ou gravação duplicada, e duas execuções ao mesmo
// tempo chegam no mesmo número.
// O app e as regras continuam iguais: o app grava como antes, e a função
// só confirma/corrige por cima.
// =====================================================================

// Recalcula os contadores de UMA agência, dentro de uma transação (leitura
// das viagens e escrita do contador enxergam o mesmo instante).
// - activeTripsCount: viagens com countsTowardLimit ligado e não canceladas.
// - totalTripsCreated: nunca diminui (uma viagem excluída não "des-cria").
async function recalcAgencyCounters(db, agencyId) {
  const agencyRef = db.collection("agencies").doc(agencyId);
  return db.runTransaction(async (tx) => {
    const agencySnap = await tx.get(agencyRef);
    if (!agencySnap.exists) return null; // agencyId sem cadastro em agencies
    const tripsSnap = await tx.get(db.collection("trips").where("agencyId", "==", agencyId));
    let active = 0;
    tripsSnap.docs.forEach((d) => {
      const t = d.data();
      if (t.countsTowardLimit === true && t.agencyCancelled !== true) active++;
    });
    const cur = agencySnap.data();
    const total = Math.max(cur.totalTripsCreated || 0, tripsSnap.docs.length);
    if ((cur.activeTripsCount || 0) === active && (cur.totalTripsCreated || 0) === total) {
      return { changed: false, active, total };
    }
    tx.update(agencyRef, { activeTripsCount: active, totalTripsCreated: total });
    return { changed: true, active, total };
  });
}

// O que fazer quando uma viagem é criada, alterada ou excluída.
// before/after = dados da viagem (ou null se não existia / foi excluída).
async function handleTripWrite(db, before, after) {
  const agencyIds = new Set();
  if (before && before.agencyId) agencyIds.add(before.agencyId);
  if (after && after.agencyId) agencyIds.add(after.agencyId);
  if (agencyIds.size === 0) return { skipped: "viagem pessoal" };
  // Alteração que não mexe em nada que conta (ex: nome, datas, participantes)
  // não precisa recalcular.
  if (before && after
      && before.agencyId === after.agencyId
      && before.countsTowardLimit === after.countsTowardLimit
      && before.agencyCancelled === after.agencyCancelled) {
    return { skipped: "nada que conta mudou" };
  }
  const results = {};
  for (const id of agencyIds) results[id] = await recalcAgencyCounters(db, id);
  return results;
}

// Varredura diária: ajusta o "conta no limite" de cada viagem de agência e
// recalcula todos os contadores. Regras: viagem cancelada ou já encerrada
// (data de fim anterior a hoje, em Brasília) NÃO conta; qualquer outra conta.
async function syncAgencies(db, now = new Date()) {
  const today = todayInBrazil(now);
  const summary = { today, trips: 0, tripsAdjusted: 0, agencies: 0, agenciesCorrected: 0, errors: 0 };

  const tripsSnap = await db.collection("trips").where("agencyId", ">", "").get();
  for (const d of tripsSnap.docs) {
    summary.trips++;
    const t = d.data();
    const ended = !!(t.endDate && t.endDate < today);
    const shouldCount = t.agencyCancelled !== true && !ended;
    if ((t.countsTowardLimit === true) === shouldCount) continue;
    try {
      await d.ref.update({ countsTowardLimit: shouldCount });
      summary.tripsAdjusted++;
      await d.ref.collection("activityLog").add({
        authorEmail: "Kipu (automático)",
        area: "agencia",
        action: shouldCount ? "contador religado" : "contador desligado",
        description: shouldCount
          ? "Viagem ativa que estava fora da contagem do plano voltou a contar (ajuste automático)."
          : "Viagem encerrada ou cancelada deixou de contar no limite do plano (ajuste automático).",
        timestamp: FieldValue.serverTimestamp()
      });
    } catch (err) {
      summary.errors++;
      logger.error("Falha ao ajustar viagem de agência", { tripId: d.id, err: String(err) });
    }
  }

  const agenciesSnap = await db.collection("agencies").get();
  for (const a of agenciesSnap.docs) {
    summary.agencies++;
    try {
      const r = await recalcAgencyCounters(db, a.id);
      if (r && r.changed) summary.agenciesCorrected++;
    } catch (err) {
      summary.errors++;
      logger.error("Falha ao recalcular agência", { agencyId: a.id, err: String(err) });
    }
  }
  logger.info("Sincronização das agências concluída", summary);
  return summary;
}

// Sempre que uma viagem é criada, alterada ou excluída.
exports.contarViagensDaAgencia = onDocumentWritten(
  { document: "trips/{tripId}", region: REGION },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    await handleTripWrite(getFirestore(), before, after);
  }
);

// Todo dia às 3h30 (Brasília), meia hora depois da retenção.
exports.sincronizarAgencias = onSchedule(
  { schedule: "every day 03:30", timeZone: TIME_ZONE, region: REGION, timeoutSeconds: 540, memory: "256MiB" },
  async () => {
    await syncAgencies(getFirestore());
  }
);

// Exportado só pros testes.
exports._test = { todayInBrazil, purgeExpiredInTrip, runRetention, recalcAgencyCounters, handleTripWrite, syncAgencies };
