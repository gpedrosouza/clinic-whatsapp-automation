-- ===========================================================================
-- Banco de controle local (SQLite).
--
-- Ele existe por UM motivo: o serviço roda em polling e pode reiniciar a
-- qualquer momento. Sem esta tabela, um restart reenviaria mensagem para
-- paciente que já recebeu. A garantia NÃO é do código — é do índice único
-- abaixo, que o banco faz valer mesmo com dois processos concorrentes.
-- ===========================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Mensagens enviadas (confirmação e lembretes)
--
-- `tipo` guarda o horizonte do lembrete ('lembrete_48h', 'lembrete_24h') e não
-- só 'lembrete': o vault previa lembrete ESCALONADO, e uma chave
-- (codAgendamento, 'lembrete') bloquearia o segundo disparo.
--
-- Ciclo de `statusEnvio`:
--   pendente      -> linha reservada ANTES de chamar a Meta
--   enviado       -> a Meta aceitou (idMensagemMeta preenchido)
--   simulado      -> WHATSAPP_MODO_SECO=true, não saiu de verdade
--   invalido      -> telefone não forma E.164 (não adianta repetir)
--   falhou        -> a Meta recusou/erro de rede; pode ser retentado
--   indeterminado -> ficou 'pendente' além do timeout: o processo caiu entre
--                    o disparo e a gravação. NÃO reenviar automaticamente
--                    (risco de duplicar); exige olhada humana.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mensagens_enviadas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  codAgendamento  INTEGER NOT NULL,
  -- guardado no envio para que uma resposta ("ACEITO"/"SAIR") chegue ao
  -- paciente certo: o webhook só conhece o telefone e a mensagem original.
  codPaciente     INTEGER,
  tipo            TEXT    NOT NULL,
  statusEnvio     TEXT    NOT NULL DEFAULT 'pendente',
  tentativas      INTEGER NOT NULL DEFAULT 0,
  telefone        TEXT,
  idMensagemMeta  TEXT,
  erro            TEXT,
  dataAgendamento TEXT,
  criadoEm        TEXT    NOT NULL DEFAULT (datetime('now')),
  enviadoEm       TEXT,
  atualizadoEm    TEXT    NOT NULL DEFAULT (datetime('now')),

  CHECK (statusEnvio IN
    ('pendente','enviado','simulado','invalido','falhou','indeterminado'))
);

-- A garantia de idempotência. Sem ele, nada do resto importa.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_idempotencia
  ON mensagens_enviadas (codAgendamento, tipo);

CREATE INDEX IF NOT EXISTS idx_mensagens_telefone
  ON mensagens_enviadas (telefone, enviadoEm);

CREATE INDEX IF NOT EXISTS idx_mensagens_meta
  ON mensagens_enviadas (idMensagemMeta);

CREATE INDEX IF NOT EXISTS idx_mensagens_status
  ON mensagens_enviadas (statusEnvio);

-- ---------------------------------------------------------------------------
-- Respostas recebidas pelo webhook.
--
-- A Meta REENVIA o webhook quando não recebe 200 rápido. `idMensagemMeta`
-- único evita processar (e dar PATCH n'a ClinicWeb) duas vezes a mesma
-- resposta do paciente.
--
-- `interpretacao`: confirmar | cancelar | remarcar | optout | ambiguo | ignorado
-- `acao`:          status_atualizado | pendente_revisao | sem_correspondencia
--                  | erro | ignorado | escrita_bloqueada
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS respostas_recebidas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  idMensagemMeta TEXT    NOT NULL UNIQUE,
  telefone       TEXT,
  texto          TEXT,
  interpretacao  TEXT,
  codAgendamento INTEGER,
  acao           TEXT,
  detalhe        TEXT,
  recebidoEm     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_respostas_pendentes
  ON respostas_recebidas (acao, recebidoEm);

-- ---------------------------------------------------------------------------
-- Opt-in de Marketing (Fase 2b) — exigência da Meta e da LGPD.
--
-- Confirmação e lembrete são Utilidade: comunicação transacional sobre um
-- agendamento que o paciente marcou. Aniversário e retorno são MARKETING —
-- só podem sair para quem consentiu, e o consentimento precisa ser
-- comprovável: base legal + data + a evidência (o texto que o paciente
-- mandou).
--
-- Uma linha por (paciente, canal). `status` alterna entre 'ativo' e
-- 'revogado' — o histórico de revogação fica em revogadoEm, e nunca
-- apagamos a linha: prova de que o pedido foi respeitado.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opt_in_pacientes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  codPaciente  INTEGER NOT NULL,
  canal        TEXT    NOT NULL DEFAULT 'whatsapp',
  status       TEXT    NOT NULL DEFAULT 'ativo',
  baseLegal    TEXT,
  evidencia    TEXT,
  telefone     TEXT,
  consentidoEm TEXT,
  revogadoEm   TEXT,
  atualizadoEm TEXT    NOT NULL DEFAULT (datetime('now')),

  CHECK (status IN ('ativo', 'revogado'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_optin_paciente_canal
  ON opt_in_pacientes (codPaciente, canal);

CREATE INDEX IF NOT EXISTS idx_optin_status ON opt_in_pacientes (status);

-- Um pedido de SAIR chega pelo telefone, não pelo codPaciente. Este índice
-- permite revogar mesmo quando não sabemos quem é o paciente.
CREATE INDEX IF NOT EXISTS idx_optin_telefone ON opt_in_pacientes (telefone);

-- ---------------------------------------------------------------------------
-- Campanhas enviadas (aniversário e retorno).
--
-- Mesma lógica de idempotência das mensagens transacionais, com a competência
-- no lugar do agendamento:
--   aniversario -> competencia = 'YYYY-MM' do disparo (o aniversário só cai
--                  em um mês do ano, então isso dá 1 envio por ano)
--   retorno     -> competencia = 'YYYY-MM' do ÚLTIMO AGENDAMENTO do paciente,
--                  e não do disparo. A janela de recall desliza todo dia e
--                  atravessa a virada de mês; com o mês do disparo o mesmo
--                  paciente receberia dois recalls seguidos. Ancorando no
--                  último agendamento, cada "sumiço" gera no máximo um convite.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campanhas_enviadas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  codPaciente    INTEGER NOT NULL,
  tipo           TEXT    NOT NULL,
  competencia    TEXT    NOT NULL,
  statusEnvio    TEXT    NOT NULL DEFAULT 'pendente',
  tentativas     INTEGER NOT NULL DEFAULT 0,
  telefone       TEXT,
  idMensagemMeta TEXT,
  erro           TEXT,
  criadoEm       TEXT    NOT NULL DEFAULT (datetime('now')),
  enviadoEm      TEXT,
  atualizadoEm   TEXT    NOT NULL DEFAULT (datetime('now')),

  CHECK (tipo IN ('aniversario', 'retorno')),
  CHECK (statusEnvio IN
    ('pendente','enviado','simulado','invalido','falhou','indeterminado'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_campanhas_idempotencia
  ON campanhas_enviadas (codPaciente, tipo, competencia);

CREATE INDEX IF NOT EXISTS idx_campanhas_status ON campanhas_enviadas (statusEnvio);
CREATE INDEX IF NOT EXISTS idx_campanhas_meta ON campanhas_enviadas (idMensagemMeta);
