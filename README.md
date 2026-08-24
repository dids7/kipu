# Kipu — App de Checklist de Viagem em Grupo

App base pronto para teste na viagem ao Peru. Vanilla JS, Firebase (Auth + Firestore), sem build step.

## Arquivos

- `index.html` — estrutura de todas as telas
- `style.css` — identidade visual (paleta andina: dourado/teal/vermelho sobre fundo escuro)
- `app.js` — toda a lógica (auth, navegação, CRUD do Firestore)
- `firebase-config.js` — credenciais do projeto Firebase (já preenchidas)
- `manifest.json` — configuração do PWA (nome, cores, ícones)
- `sw.js` — service worker mínimo (necessário pro navegador permitir a instalação)
- `icons/` — ícones do app em vários tamanhos
- `firestore.rules` — regras de segurança do Firestore para colar no console
- `storage.rules` — regras de segurança do Storage (upload de documentos) para colar no console

## Como subir pro GitHub

1. Coloque estes 5 arquivos na raiz do seu repositório `kipu`
2. Commit e push (`git add . && git commit -m "App base do Kipu" && git push`)
3. No GitHub: **Settings → Pages → Source: branch `main`, pasta `/root`** → salvar
4. Em alguns minutos o link fica disponível em `https://SEU-USUARIO.github.io/kipu/`

## Ativar o Firebase Storage (para upload de documentos)

1. No [Firebase Console](https://console.firebase.google.com) → projeto **kipu-c1e97** → menu **Build → Storage**
2. Clique em **Começar** — ele vai pedir para **fazer upgrade para o plano Blaze** (pago sob demanda). Isso é uma exigência do Google desde outubro de 2024 para qualquer novo bucket de Storage, mesmo que o uso fique dentro da faixa gratuita — é necessário cadastrar um cartão, mas não deve gerar cobrança no volume de uso de uma viagem
3. Escolha a localização `southamerica-east1` (mesma do Firestore)
4. Depois de criado, vá em **Regras** e cole o conteúdo de `storage.rules`
5. Clique em **Publicar**

## Antes de testar: aplicar as regras de segurança

1. Abra o [Firebase Console](https://console.firebase.google.com) → projeto **kipu-c1e97**
2. Vá em **Firestore Database → Regras**
3. Cole o conteúdo de `firestore.rules` (substituindo a regra temporária de teste, se você já tinha colado uma)
4. Clique em **Publicar**

Essas regras garantem que só quem está na lista de participantes de uma viagem consegue ler ou escrever os dados dela — ninguém de fora acessa nada mesmo tendo o link.

## Como usar

1. Abra o link (local ou GitHub Pages) e clique em **Entrar com Google**
2. Na tela de viagens, clique em **Criar nova viagem** e preencha:
   - Nome, destino, datas
   - E-mails dos participantes (separados por vírgula — inclua o e-mail Google de cada pessoa do grupo)
3. Abra a viagem criada e navegue pelas abas: Geral, Itinerário, Estadia, Passeios, Documentos, Mala, Tarefas, Gastos, Emergência, Histórico
4. Cada pessoa do grupo entra com a própria conta Google (usando o mesmo link) e já vê a viagem automaticamente, desde que o e-mail dela esteja na lista de participantes

## O que já funciona nesta base

- Login com Google, múltiplas viagens por conta
- Itinerário com status cíclico (clique no badge: cogitando → programado → confirmado), já incluindo valor, status de pagamento e responsável de cada item (fundido com o que antes era a aba Passeios)
- Estadia e Documentos com formulários simples (Documentos aceita upload de imagem/PDF ou link)
- Mini calendário com lembretes por dia, visível na Visão Geral
- Participantes editáveis (adicionar/remover e-mail) direto na Visão Geral
- Mala com itens **compartilhados** (contam no placar do grupo) e **pessoais** (privados)
- Placar de progresso do grupo (só considera itens compartilhados)
- Tarefas do grupo com responsável e status
- Divisão de gastos com cálculo automático de saldo por pessoa
- Informações de emergência
- Histórico completo de alterações (quem, o quê, quando)
- Cache offline básico do Firestore (funciona para leitura sem sinal; escritas sincronizam quando a conexão volta)
- "Ver no mapa" — link direto pro Google Maps a partir do endereço cadastrado em Estadia e no local (opcional) de cada item do Itinerário

## Rodando localmente antes de subir

Qualquer servidor estático simples funciona, por exemplo:

```
python3 -m http.server 8000
```

Depois abra `http://localhost:8000` no navegador. Ou use a extensão **Live Server** no VS Code.

## Instalação como app (PWA)

O Kipu agora se comporta como um app instalável direto do navegador — sem passar pela loja de aplicativos:

- **Android/Chrome/Edge**: aparece uma faixa no topo oferecendo "Instalar". Ao aceitar, o navegador cuida de tudo e o ícone vai pra tela inicial
- **iPhone/Safari**: a Apple não permite instalação automática via navegador — aparece uma faixa com instrução manual ("toque em Compartilhar → Adicionar à Tela de Início")
- A faixa só aparece se o app ainda não estiver instalado, e some para sempre depois que a pessoa clica em "Instalar"/"Entendi" ou no ✕ (fica salvo no navegador dela, `localStorage`)
- Isso **não** cria um app "de verdade" na App Store/Play Store — é o mesmo site, só que abre em tela cheia, sem barra de endereço, com ícone próprio, como se fosse nativo

## Possíveis próximos passos

- Editar/excluir itens de itinerário, estadia, passeios, gastos (hoje só é possível adicionar e, no caso do itinerário/tarefas, alternar status)
- Anexar arquivos reais aos documentos (hoje só aceita link)
- Convite de participantes por e-mail com notificação
- Assistente de IA para sugerir checklist e passeios (fica para uma fase futura — ver decisão registrada)
