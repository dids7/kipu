// =====================================================================
// Kipu — Testes automáticos das regras do Firestore (ARQ-5, 29/set/2026)
// ---------------------------------------------------------------------
// Roda contra o EMULADOR do Firestore, nunca contra o banco de dados
// real — nenhum dado de verdade é tocado. Dispara sozinho, pelo GitHub
// Actions, sempre que firestore.rules ou esta pasta mudam.
//
// Não cobre TUDO que as regras fazem — cobre os pontos mais sensíveis,
// cada um ligado a um achado do QA ou do ARQ, pra pegar regressão (uma
// correção que "volta a acontecer" sem ninguém perceber, como já
// aconteceu com a trava do convite — QA #15).
// =====================================================================

const fs = require("fs");
const path = require("path");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, FieldPath } = require("firebase/firestore");

const RULES_PATH = path.join(__dirname, "..", "firestore.rules");
const CREATION_CODE = "codigo-de-teste-nao-e-o-de-producao";

// Datas relativas a "agora" — assim os testes continuam válidos em
// qualquer dia em que o workflow rodar, sem data fixa no passado/futuro.
function isoDaysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10); // "AAAA-MM-DD"
}

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "kipu-rules-test",
    firestore: { rules: fs.readFileSync(RULES_PATH, "utf8"), host: "127.0.0.1", port: 8080 }
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

// Contexto sem regras (setup dos testes) — nunca usado para o que está sendo
// testado. Precisa ser chamado como testEnv.withSecurityRulesDisabled(...),
// nunca "destacado" da instância (senão o "this" interno da biblioteca some
// e ela quebra) — por isso aqui é uma função que já chama direto, em vez de
// devolver a função pra ser chamada depois.
function admin(callback) {
  return testEnv.withSecurityRulesDisabled(callback);
}

describe("Kipu — firestore.rules", () => {

  describe("Criação de viagem pessoal", () => {
    it("código certo, batch com tripCreationLog: cria", async () => {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "config/creation"), { code: CREATION_CODE });
      });
      const alice = testEnv.authenticatedContext("alice", { email: "alice@example.com" });
      const tripRef = doc(alice.firestore(), "trips/t1");
      const batch = writeBatch(alice.firestore());
      batch.set(tripRef, {
        name: "Viagem de teste", destination: "Peru",
        startDate: isoDaysFromNow(10), endDate: isoDaysFromNow(15),
        participantEmails: ["alice@example.com"],
        participantRoles: { "alice@example.com": "admin" },
        adminEmails: ["alice@example.com"], blockedEmails: [],
        defaultJoinRole: "colaborador", createdBy: "alice@example.com"
      });
      batch.set(doc(alice.firestore(), "tripCreationLog/t1"), {
        tripId: "t1", tripName: "Viagem de teste", createdBy: "alice@example.com", code: CREATION_CODE
      });
      await assertSucceeds(batch.commit());
    });

    it("código errado: recusa", async () => {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "config/creation"), { code: CREATION_CODE });
      });
      const alice = testEnv.authenticatedContext("alice", { email: "alice@example.com" });
      const batch = writeBatch(alice.firestore());
      batch.set(doc(alice.firestore(), "trips/t1"), {
        name: "x", startDate: isoDaysFromNow(10), endDate: isoDaysFromNow(15),
        participantEmails: ["alice@example.com"], participantRoles: { "alice@example.com": "admin" },
        adminEmails: ["alice@example.com"], blockedEmails: [], defaultJoinRole: "colaborador",
        createdBy: "alice@example.com"
      });
      batch.set(doc(alice.firestore(), "tripCreationLog/t1"), {
        tripId: "t1", tripName: "x", createdBy: "alice@example.com", code: "errado"
      });
      await assertFails(batch.commit());
    });

    it("viagem de agência sem ser membro: recusa (QA #16)", async () => {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "agencies/ag1"), {
          name: "Agência 1", memberEmails: ["dono@agencia.com"], planId: "chaski", activeTripsCount: 0
        });
        await setDoc(doc(ctx.firestore(), "plans/chaski"), { maxActiveTrips: 8 });
      });
      const intruso = testEnv.authenticatedContext("intruso", { email: "intruso@fora.com" });
      const batch = writeBatch(intruso.firestore());
      batch.set(doc(intruso.firestore(), "trips/t2"), {
        name: "x", destination: "", startDate: isoDaysFromNow(10), endDate: isoDaysFromNow(15),
        participantEmails: ["intruso@fora.com"], participantRoles: {},
        adminEmails: [], createdBy: "intruso@fora.com",
        agencyId: "ag1", countsTowardLimit: true, agencyCancelled: false
      });
      batch.update(doc(intruso.firestore(), "agencies/ag1"), {
        activeTripsCount: 1, totalTripsCreated: 1, lastCounterTripId: "t2"
      });
      await assertFails(batch.commit());
    });
  });

  describe("Viagem cancelada pela agência (tripAccessible)", () => {
    async function seedCancelledTrip() {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "agencies/ag1"), {
          name: "Agência 1", memberEmails: ["dono@agencia.com"], planId: "chaski", activeTripsCount: 0
        });
        await setDoc(doc(ctx.firestore(), "trips/t3"), {
          name: "Cancelada", startDate: isoDaysFromNow(20), endDate: isoDaysFromNow(25),
          participantEmails: ["cliente@x.com"], participantRoles: { "cliente@x.com": "admin" },
          adminEmails: ["cliente@x.com"], createdBy: "cliente@x.com",
          agencyId: "ag1", agencyCancelled: true, countsTowardLimit: false
        });
      });
    }

    it("quem não é da agência não consegue mais abrir (QA #1 original)", async () => {
      await seedCancelledTrip();
      const cliente = testEnv.authenticatedContext("cliente", { email: "cliente@x.com" });
      await assertFails(getDoc(doc(cliente.firestore(), "trips/t3")));
    });

    it("quem É da agência continua abrindo (pra poder reativar)", async () => {
      await seedCancelledTrip();
      const agente = testEnv.authenticatedContext("agente", { email: "dono@agencia.com" });
      await assertSucceeds(getDoc(doc(agente.firestore(), "trips/t3")));
    });
  });

  describe("Entrar pelo código de convite (isSelfJoin, QA #15)", () => {
    async function seedOpenTrip() {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "trips/t4"), {
          name: "Aberta", participantEmails: ["dono@x.com"],
          participantRoles: { "dono@x.com": "admin" }, adminEmails: ["dono@x.com"],
          blockedEmails: [], defaultJoinRole: "convidado", createdBy: "dono@x.com"
        });
      });
    }

    it("só acrescenta o próprio e-mail, com o papel padrão: aceita", async () => {
      await seedOpenTrip();
      const bob = testEnv.authenticatedContext("bob", { email: "bob@x.com" });
      // FieldPath, não string com ponto (o e-mail tem "." — é o mesmo
      // cuidado do QA #19: string dotada reparte a chave errado).
      await assertSucceeds(updateDoc(doc(bob.firestore(), "trips/t4"),
        "participantEmails", ["dono@x.com", "bob@x.com"],
        new FieldPath("participantRoles", "bob@x.com"), "convidado"
      ));
    });

    it("tentar remover outro participante de carona: recusa", async () => {
      await seedOpenTrip();
      const bob = testEnv.authenticatedContext("bob", { email: "bob@x.com" });
      await assertFails(updateDoc(doc(bob.firestore(), "trips/t4"),
        "participantEmails", ["bob@x.com"], // tirou o dono
        new FieldPath("participantRoles", "bob@x.com"), "convidado"
      ));
    });
  });

  describe("Sair da viagem (isSelfLeave, QA #7)", () => {
    async function seedTripWithGuest() {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "trips/t5"), {
          name: "x", participantEmails: ["dono@x.com", "convidado@x.com"],
          participantRoles: { "dono@x.com": "admin", "convidado@x.com": "convidado" },
          adminEmails: ["dono@x.com"], createdBy: "dono@x.com"
        });
      });
    }

    it("convidado sai removendo só o próprio e-mail: aceita", async () => {
      await seedTripWithGuest();
      const convidado = testEnv.authenticatedContext("g", { email: "convidado@x.com" });
      const ref = doc(convidado.firestore(), "trips/t5");
      const before = (await admin(async (ctx) => (await getDoc(doc(ctx.firestore(), "trips/t5"))).data()));
      const newRoles = { ...before.participantRoles }; delete newRoles["convidado@x.com"];
      await assertSucceeds(updateDoc(ref, {
        participantEmails: ["dono@x.com"], participantRoles: newRoles, adminEmails: ["dono@x.com"]
      }));
    });

    it("isSelfLeave() sozinha recusa o createdBy (mesmo sem ser Admin de verdade)", async () => {
      // Isolado de propósito: se o dono também estiver em adminEmails (o
      // caso normal, sempre verdadeiro numa viagem criada pelo app), a
      // rota genérica de Admin já permite mexer nos participantes — é o
      // mesmo caminho do botão "remover participante" do painel, e não é
      // isSelfLeave() quem estaria decidindo. Este teste isola só a trava
      // que isSelfLeave() tem, com um dono que (por algum motivo legado)
      // não está em adminEmails.
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "trips/t5b"), {
          name: "x", participantEmails: ["dono@x.com"],
          participantRoles: { "dono@x.com": "convidado" },
          adminEmails: [], createdBy: "dono@x.com"
        });
      });
      const dono = testEnv.authenticatedContext("d", { email: "dono@x.com" });
      await assertFails(updateDoc(doc(dono.firestore(), "trips/t5b"),
        "participantEmails", [],
        "participantRoles", {},
        "adminEmails", []
      ));
    });
  });

  it("quem NÃO participa não edita a viagem só sabendo o ID (QA #15b)", async () => {
    await admin(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "trips/t6"), {
        name: "x", participantEmails: ["dono@x.com"],
        participantRoles: { "dono@x.com": "admin" }, adminEmails: ["dono@x.com"], createdBy: "dono@x.com"
      });
    });
    const estranho = testEnv.authenticatedContext("e", { email: "estranho@fora.com" });
    await assertFails(updateDoc(doc(estranho.firestore(), "trips/t6"), { name: "Sequestrada" }));
  });

  it("cliente (admin da viagem) não mexe em agencyCancelled/countsTowardLimit", async () => {
    await admin(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "trips/t7"), {
        name: "x", startDate: isoDaysFromNow(5), endDate: isoDaysFromNow(10),
        participantEmails: ["cliente@x.com"], participantRoles: { "cliente@x.com": "admin" },
        adminEmails: ["cliente@x.com"], createdBy: "cliente@x.com",
        agencyId: "ag1", agencyCancelled: false, countsTowardLimit: true
      });
    });
    const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
    await assertFails(updateDoc(doc(cliente.firestore(), "trips/t7"), { agencyCancelled: true }));
  });

  describe("Contador da agência (QA #17)", () => {
    it("'-1' avulso, sem viagem correspondente: recusa", async () => {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "agencies/ag2"), {
          name: "x", memberEmails: ["m@x.com"], activeTripsCount: 3, totalTripsCreated: 5
        });
      });
      const membro = testEnv.authenticatedContext("m", { email: "m@x.com" });
      await assertFails(updateDoc(doc(membro.firestore(), "agencies/ag2"), { activeTripsCount: 2 }));
    });
  });

  describe("Configuração e log de criação — ninguém lê pelo app", () => {
    it("config/creation: leitura recusada mesmo autenticado", async () => {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "config/creation"), { code: CREATION_CODE });
      });
      const alice = testEnv.authenticatedContext("alice", { email: "alice@example.com" });
      await assertFails(getDoc(doc(alice.firestore(), "config/creation")));
    });

    it("tripCreationLog: leitura recusada mesmo pra quem criou", async () => {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "tripCreationLog/t1"), {
          tripId: "t1", tripName: "x", createdBy: "alice@example.com", code: CREATION_CODE
        });
      });
      const alice = testEnv.authenticatedContext("alice", { email: "alice@example.com" });
      await assertFails(getDoc(doc(alice.firestore(), "tripCreationLog/t1")));
    });
  });

  describe("Agência só vê o que ela mesma cadastrou (QA #6)", () => {
    async function seedTripWithAgencyItems() {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "agencies/ag3"), { name: "x", memberEmails: ["m@x.com"] });
        await setDoc(doc(ctx.firestore(), "trips/t8"), {
          name: "x", participantEmails: ["cliente@x.com"],
          participantRoles: { "cliente@x.com": "admin" }, adminEmails: ["cliente@x.com"],
          createdBy: "cliente@x.com", agencyId: "ag3"
        });
        await setDoc(doc(ctx.firestore(), "trips/t8/itinerario/i1"), { title: "Do cliente", createdByRole: "admin" });
        await setDoc(doc(ctx.firestore(), "trips/t8/itinerario/i2"), { title: "Da agência", createdByRole: "agencia" });
      });
    }

    it("agência lê só o item que ela mesma criou", async () => {
      await seedTripWithAgencyItems();
      const agente = testEnv.authenticatedContext("m", { email: "m@x.com" });
      await assertSucceeds(getDoc(doc(agente.firestore(), "trips/t8/itinerario/i2")));
      await assertFails(getDoc(doc(agente.firestore(), "trips/t8/itinerario/i1")));
    });
  });

  it("qualquer pessoa logada lê os planos; ninguém grava pelo app", async () => {
    await admin(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "plans/chaski"), { label: "Chaski", maxActiveTrips: 8 });
    });
    const alice = testEnv.authenticatedContext("alice", { email: "alice@example.com" });
    await assertSucceeds(getDoc(doc(alice.firestore(), "plans/chaski")));
    await assertFails(setDoc(doc(alice.firestore(), "plans/chaski"), { maxActiveTrips: 999 }));
  });

  it("ninguém desconhecido do banco (sem login) lê nada", async () => {
    await admin(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "trips/t9"), { name: "x", participantEmails: ["a@x.com"] });
    });
    const anonimo = testEnv.unauthenticatedContext();
    await assertFails(getDoc(doc(anonimo.firestore(), "trips/t9")));
  });
});
