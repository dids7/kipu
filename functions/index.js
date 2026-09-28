// =====================================================================
// Kipu — Cloud Functions
// ---------------------------------------------------------------------
// ARQ-1 (28/set/2026): retenção automática de dados sensíveis.
//
// A Política de Privacidade promete apagar Documentos e informações de
// Emergência 30 dias após o fim da viagem. Antes, essa exclusão só
// acontecia no navegador, e só quando alguém abria a aba daquela viagem —
// viagem encerrada que ninguém reabre guardava RG, passaporte e dados de
// saúde pra sempre. Agora um robô no servidor faz a varredura todo dia.
//
// Este arquivo é público e não contém nenhum segredo.
// =====================================================================

const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

const STORAGE_BUCKET = "kipu-c1e97.firebasestorage.app";
const TIME_ZONE = "America/Sao_Paulo";

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
    region: "southamerica-east1",
    timeoutSeconds: 540,
    memory: "256MiB"
  },
  async () => {
    await runRetention(getFirestore(), getStorage().bucket());
  }
);

// Exportado só pros testes.
exports._test = { todayInBrazil, purgeExpiredInTrip, runRetention };
