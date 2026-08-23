// firebase-config.js
// Configuração do projeto Firebase do Kipu

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCaPDdcKgN38RDl6PRFaqPIlZ-Wfq9t9ng",
  authDomain: "kipu-c1e97.firebaseapp.com",
  projectId: "kipu-c1e97",
  storageBucket: "kipu-c1e97.firebasestorage.app",
  messagingSenderId: "949214107672",
  appId: "1:949214107672:web:e0d3273b913b78441ccb6d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);

// Habilita cache local — permite ler dados já carregados mesmo sem sinal
// (escrever offline também funciona; o Firestore sincroniza quando a conexão volta)
enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("Persistência offline não ativada: app aberto em mais de uma aba.");
  } else if (err.code === "unimplemented") {
    console.warn("Este navegador não suporta persistência offline.");
  }
});
