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
const { doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc, writeBatch, FieldPath, serverTimestamp, Timestamp } = require("firebase/firestore");

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
      // withSecurityRulesDisabled() não devolve o que o callback retorna (só
      // roda pro efeito colateral) — por isso a leitura guarda o resultado
      // numa variável de fora, em vez de tentar usar o retorno da função.
      let before;
      await admin(async (ctx) => { before = (await getDoc(doc(ctx.firestore(), "trips/t5"))).data(); });
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

  describe("Presença — cliente já abriu o app? (COM-9)", () => {
    // Viagem de agência: cliente (admin), convidado da família, e um
    // funcionário da agência (papel "agencia") que também é participante.
    async function seedAgencyTripForPresence() {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "agencies/ag4"), { name: "Agência 4", memberEmails: ["agente@agencia.com"] });
        await setDoc(doc(ctx.firestore(), "trips/tp1"), {
          name: "x", startDate: isoDaysFromNow(5), endDate: isoDaysFromNow(10),
          participantEmails: ["cliente@x.com", "familiar@x.com", "agente@agencia.com"],
          participantRoles: { "cliente@x.com": "admin", "familiar@x.com": "convidado", "agente@agencia.com": "agencia" },
          adminEmails: ["cliente@x.com"], createdBy: "cliente@x.com",
          agencyId: "ag4", agencyCancelled: false, countsTowardLimit: true
        });
      });
    }
    const novaPresenca = (email) => ({ email, firstOpenedAt: serverTimestamp(), lastOpenedAt: serverTimestamp() });

    it("cliente registra a PRÓPRIA presença: aceita", async () => {
      await seedAgencyTripForPresence();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertSucceeds(setDoc(doc(cliente.firestore(), "trips/tp1/presence/cliente@x.com"), novaPresenca("cliente@x.com")));
    });

    it("gravar a presença de OUTRA pessoa: recusa", async () => {
      await seedAgencyTripForPresence();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertFails(setDoc(doc(cliente.firestore(), "trips/tp1/presence/familiar@x.com"), novaPresenca("familiar@x.com")));
    });

    it("data de 1º acesso inventada (não é a hora do servidor): recusa", async () => {
      await seedAgencyTripForPresence();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertFails(setDoc(doc(cliente.firestore(), "trips/tp1/presence/cliente@x.com"), {
        email: "cliente@x.com",
        firstOpenedAt: Timestamp.fromDate(new Date("2020-01-01T00:00:00Z")),
        lastOpenedAt: serverTimestamp()
      }));
    });

    it("campo extra no registro de presença: recusa", async () => {
      await seedAgencyTripForPresence();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertFails(setDoc(doc(cliente.firestore(), "trips/tp1/presence/cliente@x.com"), {
        ...novaPresenca("cliente@x.com"), nota: "qualquer coisa"
      }));
    });

    it("quem não participa da viagem não grava presença: recusa", async () => {
      await seedAgencyTripForPresence();
      const estranho = testEnv.authenticatedContext("e", { email: "estranho@fora.com" });
      await assertFails(setDoc(doc(estranho.firestore(), "trips/tp1/presence/estranho@fora.com"), novaPresenca("estranho@fora.com")));
    });

    it("funcionário da agência (papel 'agencia') não grava presença: recusa", async () => {
      await seedAgencyTripForPresence();
      const agente = testEnv.authenticatedContext("a", { email: "agente@agencia.com" });
      await assertFails(setDoc(doc(agente.firestore(), "trips/tp1/presence/agente@agencia.com"), novaPresenca("agente@agencia.com")));
    });

    it("atualizar só o último acesso: aceita; mexer no 1º acesso: recusa", async () => {
      await seedAgencyTripForPresence();
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "trips/tp1/presence/cliente@x.com"), {
          email: "cliente@x.com",
          firstOpenedAt: Timestamp.fromDate(new Date("2026-09-01T10:00:00Z")),
          lastOpenedAt: Timestamp.fromDate(new Date("2026-09-01T10:00:00Z"))
        });
      });
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      const ref = doc(cliente.firestore(), "trips/tp1/presence/cliente@x.com");
      await assertSucceeds(updateDoc(ref, { lastOpenedAt: serverTimestamp() }));
      await assertFails(updateDoc(ref, { firstOpenedAt: serverTimestamp() }));
    });

    it("agência lê a presença de todos os clientes (consulta da coleção inteira)", async () => {
      await seedAgencyTripForPresence();
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "trips/tp1/presence/cliente@x.com"), { email: "cliente@x.com", firstOpenedAt: Timestamp.now(), lastOpenedAt: Timestamp.now() });
      });
      const agente = testEnv.authenticatedContext("a", { email: "agente@agencia.com" });
      await assertSucceeds(getDocs(collection(agente.firestore(), "trips/tp1/presence")));
    });

    it("outro participante NÃO enxerga quem já abriu (nem a coleção, nem o registro alheio)", async () => {
      await seedAgencyTripForPresence();
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "trips/tp1/presence/cliente@x.com"), { email: "cliente@x.com", firstOpenedAt: Timestamp.now(), lastOpenedAt: Timestamp.now() });
      });
      const familiar = testEnv.authenticatedContext("f", { email: "familiar@x.com" });
      await assertFails(getDocs(collection(familiar.firestore(), "trips/tp1/presence")));
      await assertFails(getDoc(doc(familiar.firestore(), "trips/tp1/presence/cliente@x.com")));
    });

    it("a pessoa lê o próprio registro de presença", async () => {
      await seedAgencyTripForPresence();
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "trips/tp1/presence/familiar@x.com"), { email: "familiar@x.com", firstOpenedAt: Timestamp.now(), lastOpenedAt: Timestamp.now() });
      });
      const familiar = testEnv.authenticatedContext("f", { email: "familiar@x.com" });
      await assertSucceeds(getDoc(doc(familiar.firestore(), "trips/tp1/presence/familiar@x.com")));
    });

    it("apagar: o próprio e o Admin podem; um convidado não apaga o de outro", async () => {
      await seedAgencyTripForPresence();
      await admin(async (ctx) => {
        for (const e of ["cliente@x.com", "familiar@x.com"]) {
          await setDoc(doc(ctx.firestore(), `trips/tp1/presence/${e}`), { email: e, firstOpenedAt: Timestamp.now(), lastOpenedAt: Timestamp.now() });
        }
      });
      const familiar = testEnv.authenticatedContext("f", { email: "familiar@x.com" });
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertFails(deleteDoc(doc(familiar.firestore(), "trips/tp1/presence/cliente@x.com")));
      await assertSucceeds(deleteDoc(doc(familiar.firestore(), "trips/tp1/presence/familiar@x.com")));
      await assertSucceeds(deleteDoc(doc(cliente.firestore(), "trips/tp1/presence/cliente@x.com")));
    });

    it("viagem cancelada pela agência: cliente não grava presença", async () => {
      await seedAgencyTripForPresence();
      await admin(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), "trips/tp1"), { agencyCancelled: true, countsTowardLimit: false });
      });
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertFails(setDoc(doc(cliente.firestore(), "trips/tp1/presence/cliente@x.com"), novaPresenca("cliente@x.com")));
    });
  });

  describe("Dicas do grupo — agência só vê o que ela criou", () => {
    // Viagem de agência com cliente (admin), um convidado e um funcionário da
    // agência (papel "agencia"). Uma dica de cada um já cadastrada.
    async function seedTripWithDicas() {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "agencies/ag5"), { name: "Agência 5", memberEmails: ["agente@agencia.com"] });
        await setDoc(doc(ctx.firestore(), "trips/td1"), {
          name: "x", startDate: isoDaysFromNow(5), endDate: isoDaysFromNow(10),
          participantEmails: ["cliente@x.com", "convidado@x.com", "agente@agencia.com"],
          participantRoles: { "cliente@x.com": "admin", "convidado@x.com": "convidado", "agente@agencia.com": "agencia" },
          adminEmails: ["cliente@x.com"], createdBy: "cliente@x.com",
          agencyId: "ag5", agencyCancelled: false, countsTowardLimit: true
        });
        await setDoc(doc(ctx.firestore(), "trips/td1/dicas/d-cliente"), { titulo: "Torre Eiffel", category: "outro", createdBy: "cliente@x.com", createdByRole: "admin" });
        await setDoc(doc(ctx.firestore(), "trips/td1/dicas/d-agencia"), { titulo: "Câmbio da agência", category: "cambio", createdBy: "agente@agencia.com", createdByRole: "agencia" });
      });
    }

    it("qualquer papel de participante cria dica com o próprio papel: aceita", async () => {
      await seedTripWithDicas();
      for (const [uid, email, role] of [["c", "cliente@x.com", "admin"], ["g", "convidado@x.com", "convidado"], ["a", "agente@agencia.com", "agencia"]]) {
        const ctx = testEnv.authenticatedContext(uid, { email });
        await assertSucceeds(setDoc(doc(ctx.firestore(), `trips/td1/dicas/nova-${uid}`), { titulo: "Nova", category: "outro", createdBy: email, createdByRole: role }));
      }
    });

    it("criar dica se passando por agência (createdByRole falso): recusa", async () => {
      await seedTripWithDicas();
      const convidado = testEnv.authenticatedContext("g", { email: "convidado@x.com" });
      await assertFails(setDoc(doc(convidado.firestore(), "trips/td1/dicas/fake"), { titulo: "x", category: "outro", createdBy: "convidado@x.com", createdByRole: "agencia" }));
    });

    it("quem não participa da viagem não lê nem cria dica: recusa", async () => {
      await seedTripWithDicas();
      const estranho = testEnv.authenticatedContext("e", { email: "estranho@fora.com" });
      await assertFails(getDoc(doc(estranho.firestore(), "trips/td1/dicas/d-cliente")));
      await assertFails(setDoc(doc(estranho.firestore(), "trips/td1/dicas/x"), { titulo: "x", category: "outro", createdBy: "estranho@fora.com", createdByRole: "colaborador" }));
    });

    it("cliente (admin) e convidado leem todas as dicas, inclusive as da agência", async () => {
      await seedTripWithDicas();
      for (const [uid, email] of [["c", "cliente@x.com"], ["g", "convidado@x.com"]]) {
        const ctx = testEnv.authenticatedContext(uid, { email });
        await assertSucceeds(getDocs(collection(ctx.firestore(), "trips/td1/dicas")));
      }
    });

    it("agência lê a própria dica, mas não a do cliente", async () => {
      await seedTripWithDicas();
      const agente = testEnv.authenticatedContext("a", { email: "agente@agencia.com" });
      await assertSucceeds(getDoc(doc(agente.firestore(), "trips/td1/dicas/d-agencia")));
      await assertFails(getDoc(doc(agente.firestore(), "trips/td1/dicas/d-cliente")));
    });

    it("agência: consulta filtrada por createdByRole funciona; a coleção inteira sem filtro é recusada", async () => {
      await seedTripWithDicas();
      const agente = testEnv.authenticatedContext("a", { email: "agente@agencia.com" });
      await assertSucceeds(getDocs(query(collection(agente.firestore(), "trips/td1/dicas"), where("createdByRole", "==", "agencia"))));
      await assertFails(getDocs(collection(agente.firestore(), "trips/td1/dicas")));
    });

    it("agência edita/apaga a própria dica, mas não a do cliente", async () => {
      await seedTripWithDicas();
      const agente = testEnv.authenticatedContext("a", { email: "agente@agencia.com" });
      await assertSucceeds(updateDoc(doc(agente.firestore(), "trips/td1/dicas/d-agencia"), { nota: "atualizada" }));
      await assertFails(updateDoc(doc(agente.firestore(), "trips/td1/dicas/d-cliente"), { nota: "invadida" }));
      await assertFails(deleteDoc(doc(agente.firestore(), "trips/td1/dicas/d-cliente")));
      await assertSucceeds(deleteDoc(doc(agente.firestore(), "trips/td1/dicas/d-agencia")));
    });

    it("editar a dica não deixa trocar o createdByRole (nem pra expor à agência)", async () => {
      await seedTripWithDicas();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertSucceeds(updateDoc(doc(cliente.firestore(), "trips/td1/dicas/d-cliente"), { nota: "ok" }));
      await assertFails(updateDoc(doc(cliente.firestore(), "trips/td1/dicas/d-cliente"), { createdByRole: "agencia" }));
    });
  });

  describe("Agência na viagem — o cliente não remove nem muda o papel dos funcionários", () => {
    // Viagem de agência: cliente (admin), um colaborador, e DOIS funcionários da
    // agência: agente (participante, papel "agencia") e agente2 (da agência, mas
    // fora da lista de participantes — ex: colega abrindo a viagem).
    async function seedAgencyStaffTrip() {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "agencies/ag7"), { name: "Agência 7", memberEmails: ["agente@agencia.com", "agente2@agencia.com"] });
        await setDoc(doc(ctx.firestore(), "trips/ts1"), {
          name: "x", startDate: isoDaysFromNow(5), endDate: isoDaysFromNow(10),
          participantEmails: ["cliente@x.com", "colab@x.com", "agente@agencia.com"],
          participantRoles: { "cliente@x.com": "admin", "colab@x.com": "colaborador", "agente@agencia.com": "agencia" },
          adminEmails: ["cliente@x.com"], blockedEmails: [], createdBy: "cliente@x.com",
          agencyId: "ag7", agencyCancelled: false, countsTowardLimit: true
        });
        await setDoc(doc(ctx.firestore(), "trips/ts1/itinerario/i-cliente"), { title: "do cliente", date: isoDaysFromNow(6), createdBy: "cliente@x.com", createdByRole: "admin" });
        await setDoc(doc(ctx.firestore(), "trips/ts1/itinerario/i-agencia"), { title: "da agência", date: isoDaysFromNow(7), createdBy: "agente@agencia.com", createdByRole: "agencia" });
      });
    }

    it("cliente (Admin) tentando remover a agência da lista de participantes: recusa", async () => {
      await seedAgencyStaffTrip();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertFails(updateDoc(doc(cliente.firestore(), "trips/ts1"), {
        participantEmails: ["cliente@x.com", "colab@x.com"],
        participantRoles: { "cliente@x.com": "admin", "colab@x.com": "colaborador" },
        blockedEmails: ["agente@agencia.com"]
      }));
    });

    it("cliente (Admin) tentando mudar o papel da agência: recusa", async () => {
      await seedAgencyStaffTrip();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertFails(updateDoc(doc(cliente.firestore(), "trips/ts1"), {
        participantRoles: { "cliente@x.com": "admin", "colab@x.com": "colaborador", "agente@agencia.com": "colaborador" }
      }));
    });

    it("Colaborador promovendo a agência a Colaborador (pra ela ler mala/gastos): recusa", async () => {
      await seedAgencyStaffTrip();
      const colab = testEnv.authenticatedContext("k", { email: "colab@x.com" });
      await assertFails(updateDoc(doc(colab.firestore(), "trips/ts1"), {
        participantRoles: { "cliente@x.com": "admin", "colab@x.com": "colaborador", "agente@agencia.com": "colaborador" }
      }));
    });

    it("cliente continua removendo e mudando o papel de participante comum: aceita", async () => {
      await seedAgencyStaffTrip();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      const ref = doc(cliente.firestore(), "trips/ts1");
      await assertSucceeds(updateDoc(ref, {
        participantRoles: { "cliente@x.com": "admin", "colab@x.com": "convidado", "agente@agencia.com": "agencia" }
      }));
      await assertSucceeds(updateDoc(ref, {
        participantEmails: ["cliente@x.com", "agente@agencia.com"],
        participantRoles: { "cliente@x.com": "admin", "agente@agencia.com": "agencia" },
        blockedEmails: ["colab@x.com"]
      }));
    });

    it("cliente convida alguém novo em viagem de agência: aceita (a trava não atrapalha)", async () => {
      await seedAgencyStaffTrip();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertSucceeds(updateDoc(doc(cliente.firestore(), "trips/ts1"), {
        participantEmails: ["cliente@x.com", "colab@x.com", "agente@agencia.com", "novo@x.com"],
        participantRoles: { "cliente@x.com": "admin", "colab@x.com": "colaborador", "agente@agencia.com": "agencia", "novo@x.com": "convidado" }
      }));
    });

    it("viagem pessoal (sem agência): remover participante continua funcionando", async () => {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "trips/tp-pessoal"), {
          name: "x", startDate: isoDaysFromNow(5), endDate: isoDaysFromNow(10),
          participantEmails: ["dono@x.com", "amigo@x.com"],
          participantRoles: { "dono@x.com": "admin", "amigo@x.com": "colaborador" },
          adminEmails: ["dono@x.com"], blockedEmails: [], createdBy: "dono@x.com"
        });
      });
      const dono = testEnv.authenticatedContext("d", { email: "dono@x.com" });
      await assertSucceeds(updateDoc(doc(dono.firestore(), "trips/tp-pessoal"), {
        participantEmails: ["dono@x.com"],
        participantRoles: { "dono@x.com": "admin" },
        blockedEmails: ["amigo@x.com"]
      }));
    });

    it("2º funcionário da agência (fora da lista de participantes): abre a viagem e lê só o que a agência criou", async () => {
      await seedAgencyStaffTrip();
      const agente2 = testEnv.authenticatedContext("a2", { email: "agente2@agencia.com" });
      await assertSucceeds(getDoc(doc(agente2.firestore(), "trips/ts1")));
      await assertSucceeds(getDocs(query(collection(agente2.firestore(), "trips/ts1/itinerario"), where("createdByRole", "==", "agencia"))));
      await assertFails(getDoc(doc(agente2.firestore(), "trips/ts1/itinerario/i-cliente")));
      await assertFails(getDocs(collection(agente2.firestore(), "trips/ts1/mala")));
    });
  });

  describe("E-mail de convite (coleção mail) — só pra participantes da viagem", () => {
    // Viagem de agência: cliente (admin), colaborador, convidado, funcionário da
    // agência (participante, papel "agencia") e um 2º funcionário (da agência, fora da lista).
    async function seedMailTrip(extra = {}) {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "agencies/ag9"), { name: "Agência 9", memberEmails: ["agente@agencia.com", "agente2@agencia.com"] });
        await setDoc(doc(ctx.firestore(), "trips/tm1"), {
          name: "Viagem", startDate: isoDaysFromNow(5), endDate: isoDaysFromNow(10),
          participantEmails: ["cliente@x.com", "colab@x.com", "convidado@x.com", "agente@agencia.com"],
          participantRoles: { "cliente@x.com": "admin", "colab@x.com": "colaborador", "convidado@x.com": "convidado", "agente@agencia.com": "agencia" },
          adminEmails: ["cliente@x.com"], createdBy: "cliente@x.com",
          agencyId: "ag9", agencyCancelled: false, countsTowardLimit: true, ...extra
        });
      });
    }
    const convite = (to, over = {}) => ({ to, tripId: "tm1", message: { subject: "Te convidou", html: "<p>oi</p>" }, ...over });
    const como = (uid, email) => testEnv.authenticatedContext(uid, { email });

    it("Admin envia convite pra outro participante da viagem: aceita", async () => {
      await seedMailTrip();
      await assertSucceeds(setDoc(doc(como("c", "cliente@x.com").firestore(), "mail/m1"), convite("colab@x.com")));
    });

    it("funcionário da agência (participante) envia convite ao cliente: aceita", async () => {
      await seedMailTrip();
      await assertSucceeds(setDoc(doc(como("a", "agente@agencia.com").firestore(), "mail/m1"), convite("cliente@x.com")));
    });

    it("2º funcionário da agência (fora da lista de participantes) envia convite: aceita", async () => {
      await seedMailTrip();
      await assertSucceeds(setDoc(doc(como("a2", "agente2@agencia.com").firestore(), "mail/m1"), convite("cliente@x.com")));
    });

    it("destinatário que NÃO é participante da viagem: recusa", async () => {
      await seedMailTrip();
      await assertFails(setDoc(doc(como("c", "cliente@x.com").firestore(), "mail/m1"), convite("qualquer@fora.com")));
    });

    it("quem não participa da viagem não consegue mandar e-mail: recusa", async () => {
      await seedMailTrip();
      await assertFails(setDoc(doc(como("e", "estranho@fora.com").firestore(), "mail/m1"), convite("cliente@x.com")));
    });

    it("Convidado não envia convite: recusa", async () => {
      await seedMailTrip();
      await assertFails(setDoc(doc(como("g", "convidado@x.com").firestore(), "mail/m1"), convite("colab@x.com")));
    });

    it("campo extra no documento (ex: bcc pra espalhar o e-mail): recusa", async () => {
      await seedMailTrip();
      await assertFails(setDoc(doc(como("c", "cliente@x.com").firestore(), "mail/m1"), convite("colab@x.com", { bcc: "spam@fora.com" })));
    });

    it("mais de um destinatário (lista no campo to): recusa", async () => {
      await seedMailTrip();
      await assertFails(setDoc(doc(como("c", "cliente@x.com").firestore(), "mail/m1"), convite(["colab@x.com", "convidado@x.com"])));
    });

    it("campo extra dentro da mensagem (ex: anexo): recusa", async () => {
      await seedMailTrip();
      await assertFails(setDoc(doc(como("c", "cliente@x.com").firestore(), "mail/m1"), convite("colab@x.com", {
        message: { subject: "x", html: "<p>x</p>", attachments: [{ filename: "a.txt", content: "x" }] }
      })));
    });

    it("sem tripId (como era antes da correção): recusa", async () => {
      await seedMailTrip();
      await assertFails(setDoc(doc(como("c", "cliente@x.com").firestore(), "mail/m1"), { to: "colab@x.com", message: { subject: "x", html: "<p>x</p>" } }));
    });

    it("viagem cancelada pela agência: ninguém dispara convite", async () => {
      await seedMailTrip({ agencyCancelled: true, countsTowardLimit: false });
      await assertFails(setDoc(doc(como("c", "cliente@x.com").firestore(), "mail/m1"), convite("colab@x.com")));
    });

    it("ninguém lê, altera nem apaga os e-mails da fila pelo app", async () => {
      await seedMailTrip();
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "mail/m9"), convite("colab@x.com"));
      });
      const cliente = como("c", "cliente@x.com");
      await assertFails(getDoc(doc(cliente.firestore(), "mail/m9")));
      await assertFails(updateDoc(doc(cliente.firestore(), "mail/m9"), { to: "outro@x.com" }));
      await assertFails(deleteDoc(doc(cliente.firestore(), "mail/m9")));
    });
  });

  describe("Agência edita nome, destino e datas da viagem — só antes de começar", () => {
    // Viagem de agência futura (começa em 10 dias, termina em 15). Cliente (admin),
    // funcionário da agência (participante) e um 2º funcionário (da agência, fora da lista).
    async function seedEditableTrip(extra = {}) {
      await admin(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "agencies/ag10"), { name: "Agência 10", memberEmails: ["agente@agencia.com", "agente2@agencia.com"] });
        await setDoc(doc(ctx.firestore(), "trips/te1"), {
          name: "Lisboa", destination: "Lisboa", startDate: isoDaysFromNow(10), endDate: isoDaysFromNow(15),
          participantEmails: ["cliente@x.com", "agente@agencia.com"],
          participantRoles: { "cliente@x.com": "admin", "agente@agencia.com": "agencia" },
          adminEmails: ["cliente@x.com"], createdBy: "cliente@x.com",
          agencyId: "ag10", agencyCancelled: false, countsTowardLimit: true, ...extra
        });
      });
    }
    const agente = () => testEnv.authenticatedContext("a", { email: "agente@agencia.com" });

    it("agência corrige nome, destino e datas antes da viagem começar: aceita", async () => {
      await seedEditableTrip();
      await assertSucceeds(updateDoc(doc(agente().firestore(), "trips/te1"), {
        name: "Lisboa e Porto", destination: "Portugal", startDate: isoDaysFromNow(12), endDate: isoDaysFromNow(20)
      }));
    });

    it("2º funcionário da agência (fora da lista de participantes) também corrige: aceita", async () => {
      await seedEditableTrip();
      const a2 = testEnv.authenticatedContext("a2", { email: "agente2@agencia.com" });
      await assertSucceeds(updateDoc(doc(a2.firestore(), "trips/te1"), { name: "Lisboa 2" }));
    });

    it("agência jogando o fim da viagem pro passado (liberaria vaga do plano): recusa", async () => {
      await seedEditableTrip();
      await assertFails(updateDoc(doc(agente().firestore(), "trips/te1"), { startDate: isoDaysFromNow(-5), endDate: isoDaysFromNow(-2) }));
    });

    it("agência puxando o início pro passado: recusa", async () => {
      await seedEditableTrip();
      await assertFails(updateDoc(doc(agente().firestore(), "trips/te1"), { startDate: isoDaysFromNow(-1) }));
    });

    it("fim antes do início: recusa", async () => {
      await seedEditableTrip();
      await assertFails(updateDoc(doc(agente().firestore(), "trips/te1"), { startDate: isoDaysFromNow(20), endDate: isoDaysFromNow(18) }));
    });

    it("viagem que já começou: a agência não edita mais: recusa", async () => {
      await seedEditableTrip({ startDate: isoDaysFromNow(-2), endDate: isoDaysFromNow(3) });
      await assertFails(updateDoc(doc(agente().firestore(), "trips/te1"), { name: "Outro nome" }));
    });

    it("viagem cancelada: a agência não edita: recusa", async () => {
      await seedEditableTrip({ agencyCancelled: true, countsTowardLimit: false });
      await assertFails(updateDoc(doc(agente().firestore(), "trips/te1"), { name: "Outro nome" }));
    });

    it("agência não aproveita a edição pra mexer em outros campos (participantes, admin, agência): recusa", async () => {
      await seedEditableTrip();
      const ref = doc(agente().firestore(), "trips/te1");
      await assertFails(updateDoc(ref, { name: "x", adminEmails: ["agente@agencia.com"] }));
      await assertFails(updateDoc(ref, { name: "x", participantEmails: ["cliente@x.com", "agente@agencia.com", "intruso@x.com"] }));
      await assertFails(updateDoc(ref, { name: "x", agencyId: "outra" }));
      await assertFails(updateDoc(ref, { name: "x", countsTowardLimit: false }));
    });

    it("data em formato inválido ou nome vazio: recusa", async () => {
      await seedEditableTrip();
      const ref = doc(agente().firestore(), "trips/te1");
      await assertFails(updateDoc(ref, { startDate: "amanhã" }));
      await assertFails(updateDoc(ref, { name: "" }));
    });

    it("o cliente (Admin) continua editando a própria viagem como antes: aceita", async () => {
      await seedEditableTrip();
      const cliente = testEnv.authenticatedContext("c", { email: "cliente@x.com" });
      await assertSucceeds(updateDoc(doc(cliente.firestore(), "trips/te1"), { name: "Nome do cliente", startDate: isoDaysFromNow(11) }));
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
