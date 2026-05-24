"use strict";

/**
 * Hermes Gateway Adapter — with multi-agent orchestration
 *
 * The main Hermes agent acts as an orchestrator and can:
 *   - spawn_agent(name, role, instructions, wipe, continuity, boundaries)
 *   - delegate_task(agent_id, message)
 *   - list_team()
 *   - configure_agent(agent_id, ...)
 *   - dismiss_agent(agent_id)
 *
 * Sub-agents appear as 3D characters in the office, each with their own
 * conversation history, system prompt, and settings.
 *
 * Environment variables:
 *   HERMES_API_URL        Hermes HTTP API base URL   (default: http://localhost:8642)
 *   HERMES_API_KEY        Bearer token for Hermes     (default: empty)
 *   HERMES_ADAPTER_PORT   WebSocket port              (default: 18789)
 *   HERMES_MODEL          Model identifier            (default: hermes)
 *   HERMES_AGENT_NAME     Display name in Claw3D UI   (default: Hermes)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

function loadDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadRuntimeEnv() {
  const cwd = process.cwd();
  loadDotenvFile(path.join(cwd, ".env.local"));
  loadDotenvFile(path.join(cwd, ".env"));
}

loadRuntimeEnv();

const HERMES_API_URL = (process.env.HERMES_API_URL || "http://localhost:8642").replace(/\/$/, "");
const HERMES_API_KEY = process.env.HERMES_API_KEY || "";
const ADAPTER_PORT = parseInt(process.env.HERMES_ADAPTER_PORT || "18789", 10);
const HERMES_MODEL = process.env.HERMES_MODEL || "hermes";
const HERMES_AGENT_NAME = process.env.HERMES_AGENT_NAME || "Hermes";
const HOME = process.env.HOME || "/tmp";
const HERMES_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.HERMES_REQUEST_TIMEOUT_MS || "120000", 10);
const JRC_HUB_BASE_URL = (process.env.JRC_HUB_BASE_URL || "http://127.0.0.1:8150").replace(/\/$/, "");
const JRC_HUB_MCP_READONLY_KEY = process.env.JRC_HUB_MCP_READONLY_KEY || "";
const JRC_HUB_TRIGGER_INTERVAL_MIN = Number.parseInt(process.env.JRC_HUB_TRIGGER_INTERVAL_MIN || "60", 10);
const JRC_TASK_RUN_DAILY_LIMIT = Number.parseInt(process.env.JRC_TASK_RUN_DAILY_LIMIT || "6", 10);
const JRC_TASK_RUN_DOMAIN_DAILY_LIMIT = Number.parseInt(process.env.JRC_TASK_RUN_DOMAIN_DAILY_LIMIT || "2", 10);
const JRC_TASK_RUN_COOLDOWN_MS = Number.parseInt(process.env.JRC_TASK_RUN_COOLDOWN_MS || "180000", 10);
const JRC_AUTO_RUN_ENABLED = process.env.JRC_AUTO_RUN_ENABLED === "1";

const AGENT_ID = "hermes";
const MAIN_KEY = "main";
const MAIN_SESSION_KEY = `agent:${AGENT_ID}:${MAIN_KEY}`;
const CONFIG_PATH = `${HOME}/.hermes/config.json`;
const OBSIDIAN_VAULT_DIR = process.env.JRC_OBSIDIAN_VAULT_DIR || `${HOME}/Documents/Obsidian Vault`;
const MAX_TOOL_ROUNDS = 8;

// ---------------------------------------------------------------------------
// Orchestrator system prompt
// ---------------------------------------------------------------------------

const ORCHESTRATOR_SYSTEM_PROMPT = `You are ${HERMES_AGENT_NAME}, an AI orchestrator managing a team of sub-agents in a virtual 3D office.

You have tools to build and manage your team autonomously:

- **spawn_agent**: Create a new specialist agent with a name, role, instructions, and settings (wipe/continuity/boundaries).
- **delegate_task**: Send a task to a specific agent and receive their response.
- **list_team**: See all current team members and their IDs, names, and roles.
- **configure_agent**: Update an agent's name, role/title, instructions, or settings.
- **dismiss_agent**: Remove an agent from the team.
- **read_agent_context**: Read the recent conversation history of another agent to understand what they are currently working on, what they have already done, or what their status is. Use this for coordination — before delegating a task, check if the agent already has relevant context.

When given a goal:
1. Analyse what specialist roles are needed.
2. spawn_agent for each specialist.
3. delegate_task to assign work and coordinate.
4. Use read_agent_context to check what an agent has done or is doing before re-delegating.
5. Synthesise results into a final answer for the user.

Each spawned agent will appear as an animated character in the 3D office — walking when active, standing when idle.
Be concise in your responses to the user; do the heavy lifting via tool calls.`;

// ---------------------------------------------------------------------------
// Team management tools definition (OpenAI tool-calling format)
// ---------------------------------------------------------------------------

const TEAM_TOOLS = [
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description: "Create a new sub-agent team member. Returns the agent's ID.",
      parameters: {
        type: "object",
        required: ["name", "role"],
        properties: {
          name: { type: "string", description: "Display name, e.g. 'Backend Dev'" },
          role: { type: "string", description: "Short role description, e.g. 'Python backend specialist'" },
          instructions: { type: "string", description: "System prompt / instructions for this agent" },
          wipe: { type: "boolean", description: "Clear history before each run (stateless). Default false." },
          continuity: { type: "boolean", description: "Maintain full conversation history. Default true." },
          boundaries: { type: "string", description: "Hard constraints on what this agent may do" },
          model: { type: "string", description: "Model to use. Defaults to hermes." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_task",
      description: "Send a task or question to a specific team member and get their response.",
      parameters: {
        type: "object",
        required: ["agent_id", "message"],
        properties: {
          agent_id: { type: "string", description: "ID returned by spawn_agent" },
          message: { type: "string", description: "The task, question, or instructions to send" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_team",
      description: "List all current team members with their IDs, names, and roles.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "configure_agent",
      description: "Update an existing agent's name, role/title, instructions, or settings.",
      parameters: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "string" },
          name: { type: "string" },
          role: { type: "string", description: "Short role or title shown as subtitle below the agent name in the office (e.g. 'Marketing Chef', 'Code Reviewer')." },
          instructions: { type: "string" },
          wipe: { type: "boolean" },
          continuity: { type: "boolean" },
          boundaries: { type: "string" },
          model: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dismiss_agent",
      description: "Remove an agent from the team.",
      parameters: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_agent_context",
      description: "Read the recent conversation history of another agent to understand what they are working on, what they have already done, or what their current status is. Useful for coordination and avoiding duplicate work.",
      parameters: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "string", description: "ID of the agent whose context you want to read" },
          last_n: { type: "number", description: "How many recent messages to return (default 10, max 40)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List the current operational work queue: tasks, owners, status, blockers and approval needs.",
      parameters: {
        type: "object",
        properties: {
          includeArchived: { type: "boolean", description: "Include archived tasks. Default false." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a persistent internal task for the JRC team. This never performs external actions.",
      parameters: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["todo", "in_progress", "blocked", "review", "done"] },
          assignedAgentId: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          domain: { type: "string", enum: ["bpc", "prazos", "legalmail", "meta", "marketing", "comercial", "financeiro", "devops", "geral"] },
          needsHumanApproval: { type: "boolean" },
          approvalReason: { type: "string" },
          notes: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Update a persistent internal task: status, owner, notes, blocker, priority or approval state.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["todo", "in_progress", "blocked", "review", "done"] },
          assignedAgentId: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          domain: { type: "string" },
          needsHumanApproval: { type: "boolean" },
          approvalStatus: { type: "string", enum: ["not_required", "pending", "approved", "rejected"] },
          approvalReason: { type: "string" },
          note: { type: "string" },
          archived: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_next_task",
      description: "Run the next safe internal task by delegating it to its assigned agent. External actions remain blocked.",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Optional domain filter: bpc, prazos, meta, devops, etc." },
          agent_id: { type: "string", description: "Optional assigned agent filter." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_team_meeting",
      description: "Open an internal JRC team meeting for a goal, select participants, create an execution plan and enqueue safe internal tasks. This never performs external actions.",
      parameters: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string", description: "Operational objective for the team meeting." },
          domain: { type: "string", description: "Optional domain hint: bpc, prazos, legalmail, meta, marketing, comercial, financeiro, devops, geral." },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sync_jrc_hub_triggers",
      description: "Read JRC Hub in read-only mode and create operational tasks for deadlines, inbox, automations and service health.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** @type {Map<string, Array<{role: string, content: string}>>} */
const conversationHistory = new Map();

/** @type {Map<string, {model?: string, thinkingLevel?: string}>} */
const sessionSettings = new Map();

/** @type {Map<string, string>} agentId/filename → content */
const agentFiles = new Map();

/** @type {Map<string, {runId: string, sessionKey: string, agentId: string, abort: () => void}>} runId → abort handle */
const activeRuns = new Map();

/** @type {Map<string, object>} jobId → CronJobSummary */
const cronJobs = new Map();
let jrcHubTriggerTimer = null;

/** @type {Map<string, object>} taskId → TaskRecord */
const operationalTasks = new Map();

/**
 * @type {Map<string, {
 *   id: string, name: string, workspace: string,
 *   role?: string, systemPrompt?: string,
 *   settings: { wipe: boolean, continuity: boolean, model: string, boundaries?: string }
 * }>}
 */
const agentRegistry = new Map([
  [AGENT_ID, {
    id: AGENT_ID,
    name: HERMES_AGENT_NAME,
    workspace: `${HOME}/.hermes/workspace-hermes`,
    role: "T0 / Maestro JRC",
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    settings: { wipe: false, continuity: true, model: HERMES_MODEL },
  }],
]);

const JRC_AGENT_BOUNDARIES =
  "Hard locks JRC: nao protocolar, enviar peticao, submeter, agendar protocolo, cobrar, contatar terceiros ou executar acao externa sem aprovacao humana explicita. Nao expor credenciais, tokens, cookies, certificados ou dados sensiveis em logs/respostas.";

const JRC_SEEDED_AGENTS = [
  {
    id: "jrc-maestro",
    name: "Maestro JRC",
    role: "Coordenacao de reunioes, delegacao e governanca",
    workspace: `${HOME}/.hermes/workspace-jrc-maestro`,
    systemPrompt:
      "Voce coordena a equipe JRC como chefe de gabinete operacional. Transforma objetivos em plano, escolhe especialistas, controla budget, exige revisao e nunca autoriza acao externa sem humano.",
  },
  {
    id: "jrc-legalmail",
    name: "LegalMail Monitor",
    role: "Prazos, andamentos e triagem LegalMail",
    workspace: `${HOME}/.hermes/workspace-jrc-legalmail`,
    systemPrompt:
      "Voce monitora e classifica andamentos LegalMail da JRC. Produz triagem, riscos, proximas acoes e rascunhos internos. Nunca envia, protocola ou clica em botoes finais.",
  },
  {
    id: "jrc-bpc",
    name: "BPC / LOAS",
    role: "Organizacao documental e minutas BPC",
    workspace: `${HOME}/.hermes/workspace-jrc-bpc`,
    systemPrompt:
      "Voce organiza documentos, identifica faltantes, prepara checklist e minutas para BPC/LOAS. Toda conclusao operacional deve passar por revisao humana.",
  },
  {
    id: "jrc-juridico",
    name: "Juridico Pecas",
    role: "Teses, pesquisa e redacao juridica",
    workspace: `${HOME}/.hermes/workspace-jrc-juridico`,
    systemPrompt:
      "Voce apoia pesquisa, estrategia, redacao e revisao de pecas juridicas da JRC. Para merito e recursos, trabalhar com estrategia previa e revisao critica.",
  },
  {
    id: "jrc-revisor",
    name: "Revisor 10/10",
    role: "Sala de reuniao e revisao critica",
    workspace: `${HOME}/.hermes/workspace-jrc-revisor`,
    systemPrompt:
      "Voce atua na sala T0/reuniao como revisor critico. Procura falhas, lacunas, riscos, contradicoes e pontos que impedem nota 10/10.",
  },
  {
    id: "jrc-marketing",
    name: "Marketing JRC",
    role: "Conteudo, campanha e posicionamento",
    workspace: `${HOME}/.hermes/workspace-jrc-marketing`,
    systemPrompt:
      "Voce planeja conteudo, campanhas, criativos, calendario editorial e distribuicao para marketing juridico da JRC, respeitando OAB e aprovacao humana.",
  },
  {
    id: "jrc-comercial",
    name: "Comercial JRC",
    role: "Leads, briefing e follow-up aprovado",
    workspace: `${HOME}/.hermes/workspace-jrc-comercial`,
    systemPrompt:
      "Voce qualifica leads, cria briefings, roteiros e proximos passos comerciais. Nao contata clientes ou terceiros sem aprovacao humana explicita.",
  },
  {
    id: "jrc-atendimento",
    name: "Atendimento JRC",
    role: "Recepcao, triagem e organizacao inicial",
    workspace: `${HOME}/.hermes/workspace-jrc-atendimento`,
    systemPrompt:
      "Voce organiza entrada de demandas, triagem inicial, documentos recebidos e encaminhamentos internos para os agentes corretos.",
  },
  {
    id: "jrc-financeiro",
    name: "Financeiro JRC",
    role: "Relatorios, controles e previsibilidade",
    workspace: `${HOME}/.hermes/workspace-jrc-financeiro`,
    systemPrompt:
      "Voce apoia relatorios financeiros, organizacao de recebiveis, custos, previsoes e indicadores internos da JRC.",
  },
  {
    id: "jrc-devops",
    name: "DevOps / VPS",
    role: "Infra, deploy, logs e integracoes",
    workspace: `${HOME}/.hermes/workspace-jrc-devops`,
    systemPrompt:
      "Voce apoia infra, VPS, logs, deploys, integracoes e diagnosticos tecnicos. Evita acoes destrutivas e preserva segredos.",
  },
];

const JRC_SKILL_CATALOG = [
  {
    skillKey: "jrc-t0-governance",
    name: "JRC T0 Governance",
    description: "Orquestracao principal, roteamento de agentes, checkpoints e hard locks do escritorio.",
    engine: "claude",
    filePath: `${HOME}/.codex/skills/jrc-t0/SKILL.md`,
  },
  {
    skillKey: "jrc-legalmail-governance",
    name: "LegalMail Governance",
    description: "Triagem LegalMail, prazos, rascunhos, auditoria e bloqueio de envio/protocolo sem aprovacao.",
    engine: "claude",
    filePath: `${HOME}/.codex/skills/jrc-legalmail-governance/SKILL.md`,
  },
  {
    skillKey: "jrc-bpc-loas",
    name: "BPC / LOAS",
    description: "Checklist documental, organizacao de provas, minuta e conferencia de casos BPC/LOAS.",
    engine: "claude",
    filePath: `${HOME}/.codex/skills/claude-agents/jrc-bpc/SKILL.md`,
  },
  {
    skillKey: "jrc-pesquisa-juridica",
    name: "Pesquisa Juridica",
    description: "Jurisprudencia, doutrina, legislacao e sintese de fundamentos para pecas.",
    engine: "claude",
    filePath: `${HOME}/.codex/skills/jrc-pesquisador/SKILL.md`,
  },
  {
    skillKey: "jrc-peticao",
    name: "Peticao e Peca",
    description: "Estrutura, redacao e melhoria de pecas juridicas com revisao critica.",
    engine: "claude",
    filePath: `${HOME}/.codex/skills/peticao/SKILL.md`,
  },
  {
    skillKey: "jrc-revisao-10-10",
    name: "Revisao 10/10",
    description: "Critica adversarial, lacunas, contradicoes, riscos e checklist antes de entrega.",
    engine: "claude",
    filePath: `${HOME}/.codex/skills/claude-agents/jrc-desembargador/SKILL.md`,
  },
  {
    skillKey: "jrc-marketing",
    name: "Marketing Juridico",
    description: "Conteudo, campanhas, calendario editorial, criativos e conformidade OAB.",
    engine: "claude",
    filePath: `${HOME}/.codex/skills/marketing-skills/content-strategy/SKILL.md`,
  },
  {
    skillKey: "jrc-comercial",
    name: "Comercial e Leads",
    description: "Analise de lead, briefing, qualificacao e follow-up apenas aprovado.",
    engine: "claude",
    filePath: `${HOME}/.codex/skills/claude-command-analise-lead/SKILL.md`,
  },
  {
    skillKey: "jrc-financeiro",
    name: "Financeiro",
    description: "Relatorios, previsibilidade, custos, recebiveis e indicadores internos.",
    engine: "claude",
    filePath: `${HOME}/.codex/skills/claude-commands/relatorio-financeiro/SKILL.md`,
  },
  {
    skillKey: "jrc-devops",
    name: "DevOps / VPS",
    description: "Infraestrutura, logs, deploys, integracoes, diagnostico e seguranca operacional.",
    engine: "codex",
    filePath: `${HOME}/.codex/skills/claude-command-n8n-jrc-system/SKILL.md`,
  },
];

const JRC_AGENT_SKILLS = {
  hermes: ["jrc-t0-governance", "jrc-revisao-10-10", "jrc-devops"],
  "jrc-maestro": ["jrc-t0-governance", "jrc-revisao-10-10", "jrc-devops"],
  "jrc-legalmail": ["jrc-legalmail-governance", "jrc-peticao", "jrc-revisao-10-10"],
  "jrc-bpc": ["jrc-bpc-loas", "jrc-peticao", "jrc-revisao-10-10"],
  "jrc-juridico": ["jrc-pesquisa-juridica", "jrc-peticao", "jrc-revisao-10-10"],
  "jrc-revisor": ["jrc-revisao-10-10", "jrc-pesquisa-juridica", "jrc-peticao"],
  "jrc-marketing": ["jrc-marketing", "jrc-comercial"],
  "jrc-comercial": ["jrc-comercial", "jrc-marketing"],
  "jrc-atendimento": ["jrc-comercial", "jrc-bpc-loas", "jrc-legalmail-governance"],
  "jrc-financeiro": ["jrc-financeiro"],
  "jrc-devops": ["jrc-devops", "jrc-t0-governance"],
};

function readSkillMetadata(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf8").slice(0, 12000);
    const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    const yaml = yamlMatch ? yamlMatch[1] : "";
    const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return {
      name: name || heading,
      description,
    };
  } catch {
    return {};
  }
}

function buildSkillStatusEntry(skill, agentId) {
  const allowlist = JRC_AGENT_SKILLS[agentId] || [];
  const enabled = allowlist.includes(skill.skillKey);
  const exists = Boolean(skill.filePath && fs.existsSync(skill.filePath));
  const metadata = readSkillMetadata(skill.filePath);
  const baseDir = skill.filePath ? path.dirname(skill.filePath) : `${HOME}/.hermes/skills/${skill.skillKey}`;
  return {
    ...skill,
    name: metadata.name || skill.name,
    description: `${metadata.description || skill.description} Engine preferencial: ${skill.engine}.`,
    source: exists ? "codex-skill" : "jrc-runtime",
    bundled: false,
    filePath: skill.filePath,
    baseDir,
    always: false,
    disabled: !enabled,
    blockedByAllowlist: !enabled,
    eligible: enabled && exists,
    requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
    missing: { bins: [], anyBins: [], env: [], config: exists ? [] : [skill.filePath], os: [] },
    configChecks: exists ? [] : [{ path: skill.filePath, ok: false, reason: "SKILL.md nao encontrado" }],
    install: [],
  };
}

for (const agent of JRC_SEEDED_AGENTS) {
  agentRegistry.set(agent.id, {
    ...agent,
    systemPrompt: `${agent.systemPrompt}\n\n${JRC_AGENT_BOUNDARIES}`,
    settings: {
      wipe: false,
      continuity: true,
      model: HERMES_MODEL,
      boundaries: JRC_AGENT_BOUNDARIES,
    },
  });
}

// Set of all active sendEvent functions (one per connected WS client)
/** @type {Set<(frame: object) => void>} */
const activeSendEventFns = new Set();

// ---------------------------------------------------------------------------
// Disk persistence for conversation history
// ---------------------------------------------------------------------------

const HISTORY_FILE = path.join(HOME, ".hermes", "clawd3d-history.json");
const TASKS_FILE = path.join(HOME, ".hermes", "jrc-operational-tasks.json");
const BUDGET_FILE = path.join(HOME, ".hermes", "jrc-agent-budget.json");
const OPS_MODE_FILE = path.join(HOME, ".hermes", "jrc-office-ops-mode.json");
const COST_MODE_FILE = path.join(HOME, ".hermes", "jrc-office-cost-mode.json");
const MEETINGS_FILE = path.join(HOME, ".hermes", "jrc-office-meetings.json");
const TRACES_FILE = path.join(HOME, ".hermes", "jrc-office-traces.json");
const MEDIA_JOBS_FILE = path.join(HOME, ".hermes", "jrc-media-jobs.json");
const MEDIA_BUDGET_FILE = path.join(HOME, ".hermes", "jrc-media-budget.json");
let persistDebounceTimer = null;
let tasksPersistDebounceTimer = null;
let budgetPersistDebounceTimer = null;
let opsModePersistDebounceTimer = null;
let costModePersistDebounceTimer = null;
let tracesPersistDebounceTimer = null;
let mediaJobsPersistDebounceTimer = null;
let mediaBudgetPersistDebounceTimer = null;
let taskRunInFlight = false;

function loadHistoryFromDisk() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        for (const [key, messages] of Object.entries(data)) {
          if (Array.isArray(messages)) conversationHistory.set(key, messages);
        }
        console.log(`[hermes-adapter] Loaded history for ${Object.keys(data).length} session(s).`);
      }
    }
  } catch (err) {
    console.warn("[hermes-adapter] Could not load history:", sanitizeErrorMessage(err));
  }
}

function saveHistoryToDisk() {
  if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
  persistDebounceTimer = setTimeout(() => {
    try {
      const data = {};
      for (const [key, messages] of conversationHistory.entries()) {
        if (messages.length > 0) data[key] = messages;
      }
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.warn("[hermes-adapter] Could not save history:", sanitizeErrorMessage(err));
    }
  }, 500);
}

function getHistory(sessionKey) {
  if (!conversationHistory.has(sessionKey)) conversationHistory.set(sessionKey, []);
  return conversationHistory.get(sessionKey);
}

function clearHistory(sessionKey) {
  conversationHistory.delete(sessionKey);
  saveHistoryToDisk();
}

function randomId() {
  return require("crypto").randomBytes(8).toString("hex");
}

function stableTaskKey(value) {
  return require("crypto").createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16);
}

function redactSecrets(value) {
  if (typeof value !== "string" || !value) return value;
  let redacted = value;
  if (HERMES_API_KEY) {
    redacted = redacted.split(HERMES_API_KEY).join("[REDACTED]");
  }
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
  return redacted;
}

// ---------------------------------------------------------------------------
// Hermes HTTP API helpers
// ---------------------------------------------------------------------------

function hermesPost(path, body) {
  return new Promise((resolve, reject) => {
    const urlStr = HERMES_API_URL + path;
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const transport = url.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) };
    if (HERMES_API_KEY) headers["Authorization"] = `Bearer ${HERMES_API_KEY}`;
    const req = transport.request(
      { hostname: url.hostname, port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""), method: "POST", headers },
      resolve
    );
    req.on("error", reject);
    req.setTimeout(HERMES_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Hermes API request timed out after ${HERMES_REQUEST_TIMEOUT_MS}ms`));
    });
    req.write(bodyStr);
    req.end();
  });
}

function hermesGet(path) {
  return new Promise((resolve, reject) => {
    const urlStr = HERMES_API_URL + path;
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const transport = url.protocol === "https:" ? https : http;
    const headers = {};
    if (HERMES_API_KEY) headers["Authorization"] = `Bearer ${HERMES_API_KEY}`;
    const req = transport.request(
      { hostname: url.hostname, port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""), method: "GET", headers },
      resolve
    );
    req.on("error", reject);
    req.setTimeout(HERMES_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Hermes API request timed out after ${HERMES_REQUEST_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

async function readJsonBody(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function sanitizeErrorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return redactSecrets(error);
  return redactSecrets(error.message || String(error));
}

function extractOpenAiStyleError(payload, fallbackMessage) {
  if (payload && typeof payload === "object") {
    const message =
      typeof payload?.error?.message === "string"
        ? payload.error.message.trim()
        : "";
    if (message) return message;
  }
  return fallbackMessage;
}

function normalizeEngineName(modelId) {
  const value = typeof modelId === "string" ? modelId.trim() : "";
  if (!value) return "Hermes";
  if (value.includes("kimi")) return "Kimi";
  if (value.includes("claude")) return "Claude";
  if (value.includes("codex")) return "Codex";
  if (value.includes("ollama") || value.includes("phi4") || value.includes("qwen") || value.includes("llama")) return "Ollama";
  if (value.includes("gemini")) return "Gemini";
  if (value.includes("deepseek")) return "DeepSeek";
  return value;
}

function withEngineMarker(text, modelId) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return trimmed;
  return `[[engine:${normalizeEngineName(modelId)}]]\n${trimmed}`;
}

let cachedHermesModels = null;
let cachedHermesModelsAt = 0;

async function fetchHermesModels() {
  const now = Date.now();
  if (cachedHermesModels && now - cachedHermesModelsAt < 30_000) {
    return cachedHermesModels;
  }
  const res = await hermesGet("/v1/models");
  if (res.statusCode >= 400) {
    res.resume();
    throw new Error(`Hermes models API HTTP ${res.statusCode}`);
  }
  const payload = await readJsonBody(res);
  const models = Array.isArray(payload?.data)
    ? payload.data
        .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
        .filter(Boolean)
    : [];
  cachedHermesModels = models;
  cachedHermesModelsAt = now;
  return models;
}

async function fetchEngineUsage() {
  try {
    const res = await hermesGet("/usage");
    const payload = await readJsonBody(res);
    if (res.statusCode >= 400) {
      throw new Error(`Hermes usage API HTTP ${res.statusCode}`);
    }
    return { ok: true, ...payload };
  } catch (error) {
    return { ok: false, error: sanitizeErrorMessage(error) };
  }
}

async function resolveHermesModel(requestedModel) {
  const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const normalized = trimmed.includes("/") ? trimmed.split("/").pop().trim() : trimmed;
  try {
    const models = await fetchHermesModels();
    if (models.length === 0) {
      return normalized || trimmed || HERMES_MODEL;
    }
    const candidates = [trimmed, normalized, HERMES_MODEL]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    for (const candidate of candidates) {
      const exact = models.find((modelId) => modelId === candidate);
      if (exact) return exact;
    }
    for (const candidate of candidates) {
      const suffix = models.find((modelId) => modelId.endsWith(`/${candidate}`));
      if (suffix) return suffix;
    }
    return models[0];
  } catch {
    return normalized || trimmed || HERMES_MODEL;
  }
}

async function completeOneTurn(messages, model, tools) {
  const resolvedModel = await resolveHermesModel(model);
  const body = { model: resolvedModel, messages, stream: false };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const res = await hermesPost("/v1/chat/completions", body);
  const payload = await readJsonBody(res);
  if (res.statusCode >= 400) {
    throw new Error(
      extractOpenAiStyleError(payload, `Hermes API HTTP ${res.statusCode}`)
    );
  }
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message || {};
  const textContent =
    typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
        : "";
  const finishReason =
    typeof choice?.finish_reason === "string" && choice.finish_reason
      ? choice.finish_reason
      : "stop";
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((tc) => {
        let args = {};
        const rawArgs = tc?.function?.arguments;
        if (typeof rawArgs === "string" && rawArgs.trim()) {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = { _raw: rawArgs };
          }
        }
        return {
          id: typeof tc?.id === "string" ? tc.id : randomId(),
          name: typeof tc?.function?.name === "string" ? tc.function.name : "",
          args,
        };
      })
    : [];
  return { textContent, toolCalls, finishReason, resolvedModel, engineModel: payload?.model || resolvedModel };
}

// ---------------------------------------------------------------------------
// SSE streaming — handles both text deltas and tool calls
// ---------------------------------------------------------------------------

/**
 * Stream one LLM turn.
 * @returns {{ textContent: string, toolCalls: Array<{id,name,args}>, finishReason: string }}
 */
async function streamOneTurn(messages, model, tools, onTextDelta, abortCheck) {
  const body = { model, messages, stream: true };
  if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = "auto"; }

  const resolvedModel = await resolveHermesModel(model);
  body.model = resolvedModel;
  const res = await hermesPost("/v1/chat/completions", body);
  if (res.statusCode >= 400) {
    res.resume();
    throw new Error(`Hermes API HTTP ${res.statusCode}`);
  }

  let textContent = "";
  let finishReason = "stop";
  /** @type {Record<number, {id: string, name: string, argsStr: string}>} */
  const toolCallAccum = {};
  let buffer = "";

  await new Promise((resolve, reject) => {
    res.on("data", (chunk) => {
      if (abortCheck && abortCheck()) { res.destroy(); return; }
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(trimmed.slice(6));
          const choice = data?.choices?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === "string" && choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          const delta = choice.delta || {};
          // Text content
          if (typeof delta.content === "string" && delta.content) {
            textContent += delta.content;
            if (onTextDelta) onTextDelta(textContent);
          }
          // Tool call accumulation
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              if (!toolCallAccum[idx]) toolCallAccum[idx] = { id: "", name: "", argsStr: "" };
              if (tc.id) toolCallAccum[idx].id = tc.id;
              if (tc.function?.name) toolCallAccum[idx].name += tc.function.name;
              if (tc.function?.arguments) toolCallAccum[idx].argsStr += tc.function.arguments;
            }
          }
        } catch { /* ignore malformed */ }
      }
    });
    res.on("end", resolve);
    res.on("error", reject);
  });

  const toolCalls = Object.values(toolCallAccum).map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.argsStr); } catch { args = { _raw: tc.argsStr }; }
    return { id: tc.id, name: tc.name, args };
  });

  if (!textContent.trim() && toolCalls.length === 0 && finishReason === "stop") {
    const fallback = await completeOneTurn(messages, resolvedModel, tools);
    return {
      textContent: fallback.textContent,
      toolCalls: fallback.toolCalls,
      finishReason: fallback.finishReason,
      engineModel: fallback.engineModel || fallback.resolvedModel || resolvedModel,
    };
  }

  return { textContent, toolCalls, finishReason, engineModel: resolvedModel };
}

// ---------------------------------------------------------------------------
// Broadcast a gateway event to all connected clients
// ---------------------------------------------------------------------------

function broadcastEvent(frame) {
  for (const fn of activeSendEventFns) {
    try { fn(frame); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

async function execSpawnAgent(args) {
  const name = (typeof args.name === "string" ? args.name : "Agent").trim() || "Agent";
  const role = (typeof args.role === "string" ? args.role : "").trim();
  const instructions = typeof args.instructions === "string" ? args.instructions.trim() : "";
  const boundaries = typeof args.boundaries === "string" ? args.boundaries.trim() : "";
  const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : HERMES_MODEL;
  const wipe = Boolean(args.wipe);
  const continuity = args.continuity !== false;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const newId = `${slug}-${randomId().slice(0, 6)}`;

  let systemPrompt = instructions || `You are ${name}, a ${role || "specialist"} agent.`;
  if (boundaries) systemPrompt += `\n\nBoundaries: ${boundaries}`;

  agentRegistry.set(newId, {
    id: newId, name, workspace: `${HOME}/.hermes/workspace-${slug}`,
    role, systemPrompt, settings: { wipe, continuity, model, boundaries },
  });

  console.log(`[hermes-adapter] Spawned agent: ${name} (${newId})`);

  // Broadcast presence so the 3D office loads the new agent immediately
  broadcastEvent({
    type: "event", event: "presence",
    payload: {
      sessions: {
        recent: [],
        byAgent: [...agentRegistry.keys()].map((aid) => ({
          agentId: aid,
          recent: [],
        })),
      },
    },
  });

  return JSON.stringify({ ok: true, agent_id: newId, name, role });
}

async function execDelegateTask(args) {
  const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!targetId || !message) return JSON.stringify({ ok: false, error: "agent_id and message required" });

  const agent = agentRegistry.get(targetId);
  if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });

  const sessionKey = `agent:${targetId}:${MAIN_KEY}`;
  const history = getHistory(sessionKey);
  const model = agent.settings.model || HERMES_MODEL;

  // Build messages for sub-agent
  const systemMsg = agent.systemPrompt ? [{ role: "system", content: agent.systemPrompt }] : [];
  const contextHistory = agent.settings.wipe ? [] : [...history];
  const messages = [...systemMsg, ...contextHistory, { role: "user", content: message }];

  // Emit chat start event for this sub-agent
  const subRunId = randomId();
  let seqCounter = 0;
  const emitSub = (state, extra) => {
    broadcastEvent({ type: "event", event: "chat", seq: seqCounter++,
      payload: { runId: subRunId, sessionKey, state, ...extra } });
  };

  emitSub("delta", { message: { role: "assistant", content: "…" } });

  let responseText = "";
  try {
    const result = await streamOneTurn(messages, model, [], (partial) => {
      responseText = partial;
      emitSub("delta", { message: { role: "assistant", content: partial } });
    }, null);
    responseText = result.textContent;

    // Persist to sub-agent history
    if (agent.settings.continuity !== false) {
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: responseText });
      saveHistoryToDisk();
    }

    emitSub("final", { stopReason: "end_turn", message: { role: "assistant", content: withEngineMarker(responseText, result.engineModel) } });

    // Presence update for sub-agent session
    broadcastEvent({
      type: "event", event: "presence",
      payload: { sessions: { recent: [{ key: sessionKey, updatedAt: Date.now() }],
        byAgent: [{ agentId: targetId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }] } },
    });
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    emitSub("error", { errorMessage: message });
    return JSON.stringify({ ok: false, error: message });
  }

  return JSON.stringify({ ok: true, agent_id: targetId, response: responseText });
}

function execListTeam() {
  const members = [...agentRegistry.values()].map((a) => ({
    id: a.id, name: a.name, role: a.role || "",
    settings: a.settings,
  }));
  return JSON.stringify({ team: members });
}

function execConfigureAgent(args) {
  const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  const agent = agentRegistry.get(targetId);
  if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });
  if (typeof args.name === "string" && args.name.trim()) agent.name = args.name.trim();
  if (typeof args.role === "string") agent.role = args.role.trim();
  if (typeof args.instructions === "string") agent.systemPrompt = args.instructions;
  if (typeof args.wipe === "boolean") agent.settings.wipe = args.wipe;
  if (typeof args.continuity === "boolean") agent.settings.continuity = args.continuity;
  if (typeof args.boundaries === "string") {
    agent.settings.boundaries = args.boundaries;
    if (agent.systemPrompt && args.boundaries) {
      agent.systemPrompt = agent.systemPrompt.replace(/\n\nBoundaries:.*$/s, "") + `\n\nBoundaries: ${args.boundaries}`;
    }
  }
  if (typeof args.model === "string" && args.model.trim()) agent.settings.model = args.model.trim();
  console.log(`[hermes-adapter] Configured agent: ${agent.name} (${targetId})`);
  broadcastEvent({
    type: "event", event: "presence",
    payload: {
      sessions: {
        recent: [],
        byAgent: [...agentRegistry.keys()].map((aid) => ({
          agentId: aid,
          recent: [],
        })),
      },
    },
  });
  return JSON.stringify({ ok: true, agent_id: targetId, name: agent.name, role: agent.role, settings: agent.settings });
}

function execDismissAgent(args) {
  const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  if (!targetId || targetId === AGENT_ID) return JSON.stringify({ ok: false, error: "Cannot dismiss the main orchestrator." });
  const agent = agentRegistry.get(targetId);
  if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });
  agentRegistry.delete(targetId);
  clearHistory(`agent:${targetId}:${MAIN_KEY}`);
  console.log(`[hermes-adapter] Dismissed agent: ${agent.name} (${targetId})`);
  return JSON.stringify({ ok: true, dismissed: targetId });
}

function execReadAgentContext(args) {
  const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  const agent = agentRegistry.get(targetId);
  if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });
  const lastN = Math.min(40, Math.max(1, typeof args.last_n === "number" ? Math.floor(args.last_n) : 10));
  const sessionKey = `agent:${targetId}:${MAIN_KEY}`;
  const history = getHistory(sessionKey);
  const messages = history.slice(-lastN);
  if (messages.length === 0) {
    return JSON.stringify({ ok: true, agent_id: targetId, name: agent.name, role: agent.role || "", message_count: 0, context: "(no conversation history yet)" });
  }
  const contextLines = messages.map((m) => {
    const role = m.role === "assistant" ? agent.name : "User";
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `[${role}]: ${content.slice(0, 800)}${content.length > 800 ? "…" : ""}`;
  });
  return JSON.stringify({
    ok: true,
    agent_id: targetId,
    name: agent.name,
    role: agent.role || "",
    message_count: history.length,
    showing_last: messages.length,
    context: contextLines.join("\n\n"),
  });
}

function execListTasks(args) {
  return JSON.stringify({
    ok: true,
    tasks: listTasks(Boolean(args?.includeArchived)),
    playbooks: JRC_PLAYBOOKS.map(({ id, name, domain, owner, description }) => ({
      id,
      name,
      domain,
      owner,
      description,
    })),
  });
}

function execCreateTask(args) {
  try {
    const task = createOperationalTask({
      ...args,
      source: "claw3d_manual",
    });
    return JSON.stringify({ ok: true, task });
  } catch (error) {
    return JSON.stringify({ ok: false, error: sanitizeErrorMessage(error) });
  }
}

function execUpdateTask(args) {
  try {
    const taskId = typeof args?.id === "string" ? args.id.trim() : "";
    if (!taskId) return JSON.stringify({ ok: false, error: "id required" });
    const task = updateOperationalTask(taskId, args);
    return JSON.stringify({ ok: true, task });
  } catch (error) {
    return JSON.stringify({ ok: false, error: sanitizeErrorMessage(error) });
  }
}

async function runOperationalTask(taskId, sendEvent) {
  const task = operationalTasks.get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.archived) throw new Error(`Task ${taskId} is archived`);
  if (!task.assignedAgentId) throw new Error(`Task ${taskId} has no assigned agent`);
  if (!agentRegistry.has(task.assignedAgentId)) {
    throw new Error(`Assigned agent ${task.assignedAgentId} not found`);
  }
  const agent = agentRegistry.get(task.assignedAgentId);
  const engine = agent?.settings?.model || HERMES_MODEL;
  const riskLevel = inferRiskLevel(task);
  const handoff = buildHandoffContract(task, { riskLevel });
  const startedTrace = recordTrace({
    kind: "task.run",
    status: "started",
    taskId: task.id,
    agentId: task.assignedAgentId,
    domain: task.domain,
    engine,
    riskLevel,
    handoff,
    message: `Execucao iniciada: ${task.title}`,
  });
  const budget = checkTaskRunBudget(task);
  if (!budget.ok) {
    recordTaskRunBudget(task, "blocked", budget.reason);
    recordTrace({
      kind: "task.run",
      status: "blocked_budget",
      taskId: task.id,
      agentId: task.assignedAgentId,
      domain: task.domain,
      engine,
      riskLevel,
      handoff,
      message: budget.reason,
    });
    return {
      task: serializeTask(task),
      blockedByBudget: true,
      budget,
      traceId: startedTrace.id,
      message: `Execucao bloqueada pelo budget anti-consumo: ${budget.reason}`,
    };
  }
  taskRunInFlight = true;
  recordTaskRunBudget(task, "started");

  try {
    const started = updateOperationalTask(task.id, {
      status: "in_progress",
      note: "Execucao interna iniciada pela fila operacional com budget anti-consumo reservado.",
    });
    const prompt = [
      "Execute esta tarefa interna da JRC sem realizar acao externa.",
      "Entregue resultado pratico, proximos passos, riscos e o que depende de aprovacao humana.",
      `Titulo: ${started.title}`,
      `Dominio: ${started.domain}`,
      `Prioridade: ${started.priority}`,
      started.description ? `Descricao:\n${started.description}` : "",
      started.approval?.required
        ? `Aprovacao humana obrigatoria: ${started.approval.reason || "etapa sensivel"}`
        : "Nao faca protocolo, envio, cobranca, contato externo ou alteracao destrutiva.",
      started.notes?.length ? `Notas existentes:\n- ${started.notes.slice(-6).join("\n- ")}` : "",
    ].filter(Boolean).join("\n\n");

    const sessionKey = `agent:${started.assignedAgentId}:${MAIN_KEY}`;
    const history = getHistory(sessionKey);
    const messages = [
      ...(agent.systemPrompt ? [{ role: "system", content: agent.systemPrompt }] : []),
      ...history.slice(-12),
      { role: "user", content: prompt },
    ];

    let responseText = "";
    try {
      const result = await completeOneTurn(messages, engine, []);
      responseText = result.textContent || "";
    } catch (error) {
      recordTrace({
        kind: "task.run",
        status: "error",
        taskId: task.id,
        agentId: started.assignedAgentId,
        domain: started.domain,
        engine,
        riskLevel,
        handoff,
        message: sanitizeErrorMessage(error),
      });
      return updateOperationalTask(task.id, {
        status: "blocked",
        note: `Falha na execucao interna: ${sanitizeErrorMessage(error)}`,
      });
    }
    if (!responseText.trim()) {
      recordTrace({
        kind: "task.run",
        status: "empty_response",
        taskId: task.id,
        agentId: started.assignedAgentId,
        domain: started.domain,
        engine,
        riskLevel,
        handoff,
        message: "Resposta vazia do agente.",
      });
      return updateOperationalTask(task.id, {
        status: "blocked",
        note: "Falha na execucao interna: resposta vazia do agente.",
      });
    }

    if (agent.settings.continuity !== false) {
      history.push({ role: "user", content: prompt });
      history.push({ role: "assistant", content: responseText });
      saveHistoryToDisk();
    }

    const finalStatus = started.approval?.required ? "review" : "done";
    const qualityScore = buildQualityScore(started, responseText);
    const completedTrace = recordTrace({
      kind: "task.run",
      status: finalStatus,
      taskId: task.id,
      agentId: started.assignedAgentId,
      domain: started.domain,
      engine,
      riskLevel,
      qualityScore,
      handoff,
      message: responseText,
    });
    const completed = updateOperationalTask(task.id, {
      status: finalStatus,
      traceId: completedTrace.id,
      handoff,
      riskLevel,
      qualityScore,
      note: `Resposta de ${started.assignedAgentId}:\n${responseText.slice(0, 6000)}`,
    });
    const unblocked = finalStatus === "done" ? unblockNextPlaybookTask(completed) : null;
    broadcastEvent({
      type: "event",
      event: "presence",
      payload: {
        sessions: {
          recent: [{ key: sessionKey, updatedAt: Date.now() }],
          byAgent: [{ agentId: started.assignedAgentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }],
        },
      },
    });
    return { task: completed, unblocked, budget: getBudgetStatus(), traceId: completedTrace.id, qualityScore };
  } finally {
    taskRunInFlight = false;
  }
}

async function execRunNextTask(args, sendEvent) {
  try {
    const task = findNextRunnableTask({
      domain: args?.domain,
      agentId: args?.agent_id || args?.agentId,
    });
    if (!task) return JSON.stringify({ ok: true, ran: false, reason: "no_runnable_task" });
    const result = await runOperationalTask(task.id, sendEvent);
    return JSON.stringify({ ok: true, ran: true, result });
  } catch (error) {
    return JSON.stringify({ ok: false, error: sanitizeErrorMessage(error) });
  }
}

function execStartTeamMeeting(args) {
  try {
    const result = startTeamMeeting({
      goal: args?.goal,
      domain: args?.domain,
      priority: args?.priority,
      source: "tool",
    });
    return JSON.stringify({ ok: true, ...result });
  } catch (error) {
    return JSON.stringify({ ok: false, error: sanitizeErrorMessage(error) });
  }
}

async function execSyncJrcHubTriggers() {
  try {
    const result = await syncJrcHubTriggers();
    return JSON.stringify({
      ok: true,
      created: result.created,
      createdCount: result.created.length,
      sources: Object.fromEntries(Object.entries(result.snapshot).map(([key, value]) => [key, Boolean(value?.ok)])),
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: sanitizeErrorMessage(error) });
  }
}

async function executeToolCall(tc, sendEvent) {
  console.log(`[hermes-adapter] Tool call: ${tc.name}`, JSON.stringify(tc.args).slice(0, 120));
  switch (tc.name) {
    case "spawn_agent":          return execSpawnAgent(tc.args, sendEvent);
    case "delegate_task":        return execDelegateTask(tc.args, sendEvent);
    case "list_team":            return execListTeam();
    case "configure_agent":      return execConfigureAgent(tc.args);
    case "dismiss_agent":        return execDismissAgent(tc.args);
    case "read_agent_context":   return execReadAgentContext(tc.args);
    case "list_tasks":           return execListTasks(tc.args);
    case "create_task":          return execCreateTask(tc.args);
    case "update_task":          return execUpdateTask(tc.args);
    case "run_next_task":        return execRunNextTask(tc.args, sendEvent);
    case "start_team_meeting":   return execStartTeamMeeting(tc.args);
    case "sync_jrc_hub_triggers": return execSyncJrcHubTriggers();
    default:                     return JSON.stringify({ ok: false, error: `Unknown tool: ${tc.name}` });
  }
}

// ---------------------------------------------------------------------------
// Agentic loop — handles multi-round tool-calling conversations
// ---------------------------------------------------------------------------

async function runAgenticLoop({ sessionKey, agentId, userMessage, model, tools, emitDelta, abortCheck, sendEvent }) {
  const agent = agentRegistry.get(agentId);
  const systemMsg = agent?.systemPrompt ? [{ role: "system", content: agent.systemPrompt }] : [];
  const history = getHistory(sessionKey);
  const contextHistory = (agent?.settings?.wipe) ? [] : [...history];
  let messages = [...systemMsg, ...contextHistory, { role: "user", content: userMessage }];

  let finalText = "";
  let finalEngineModel = model;
  let round = 0;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    const { textContent, toolCalls, finishReason, engineModel } = await streamOneTurn(
      messages, model, tools, emitDelta, abortCheck
    );
    if (engineModel) finalEngineModel = engineModel;

    if (finishReason === "tool_calls" && toolCalls.length > 0) {
      // Inform user that tools are being executed (brief status text)
      const toolNames = toolCalls.map((t) => t.name).join(", ");
      const statusText = textContent || `Executing: ${toolNames}…`;
      if (statusText) emitDelta(statusText);

      // Add assistant message with tool_calls to messages
      messages.push({
        role: "assistant",
        content: textContent || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id, type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      // Execute all tool calls and collect results
      const toolResults = await Promise.all(
        toolCalls.map(async (tc) => {
          const result = await executeToolCall(tc, sendEvent);
          return { role: "tool", tool_call_id: tc.id, content: result };
        })
      );
      messages.push(...toolResults);
      continue;
    }

    // finish_reason = "stop" (or length/unknown) — we're done
    finalText = textContent;
    break;
  }

  // Persist to history
  if (agent?.settings?.continuity !== false) {
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: finalText });
    saveHistoryToDisk();
  }

  return { text: finalText, engineModel: finalEngineModel };
}

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

function resOk(id, payload) { return { type: "res", id, ok: true, payload: payload ?? {} }; }
function resErr(id, code, message) { return { type: "res", id, ok: false, error: { code, message } }; }

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleMethod(method, params, id, sendEvent) {
  const p = params || {};

  switch (method) {
    // --- Agent management ---------------------------------------------------

    case "agents.list": {
      const allAgents = [...agentRegistry.values()].map((agent) => ({
        id: agent.id, name: agent.name, workspace: agent.workspace,
        identity: { name: agent.name, emoji: "🤖" },
        role: agent.role,
      }));
      return resOk(id, { defaultId: AGENT_ID, mainKey: MAIN_KEY, agents: allAgents });
    }

    case "agents.create": {
      const agentName = (typeof p.name === "string" && p.name.trim()) ? p.name.trim() : "Agent";
      const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const newId = `${slug}-${randomId().slice(0, 6)}`;
      const workspace = (typeof p.workspace === "string" && p.workspace)
        ? p.workspace : `${HOME}/.hermes/workspace-${slug}`;
      agentRegistry.set(newId, {
        id: newId, name: agentName, workspace,
        role: "", systemPrompt: `You are ${agentName}.`,
        settings: { wipe: false, continuity: true, model: HERMES_MODEL },
      });
      return resOk(id, { agentId: newId, name: agentName, workspace });
    }

    case "agents.delete": {
      const delId = typeof p.agentId === "string" ? p.agentId : "";
      if (delId && delId !== AGENT_ID) {
        agentRegistry.delete(delId);
        clearHistory(`agent:${delId}:${MAIN_KEY}`);
      }
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.update": {
      const updId = typeof p.agentId === "string" ? p.agentId : "";
      const existing = agentRegistry.get(updId);
      if (existing) {
        if (typeof p.name === "string" && p.name.trim()) existing.name = p.name.trim();
        if (typeof p.workspace === "string" && p.workspace.trim()) existing.workspace = p.workspace.trim();
        if (typeof p.role === "string") existing.role = p.role.trim();
      }
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.files.get": {
      const key = `${p.agentId || AGENT_ID}/${p.name || ""}`;
      const content = agentFiles.get(key);
      return resOk(id, { file: content !== undefined ? { content } : { missing: true } });
    }

    case "agents.files.set": {
      const key = `${p.agentId || AGENT_ID}/${p.name || ""}`;
      agentFiles.set(key, typeof p.content === "string" ? p.content : "");
      return resOk(id, {});
    }

    // --- Config -------------------------------------------------------------

    case "config.get":
      return resOk(id, { config: { gateway: { reload: { mode: "hot" } } },
        hash: "hermes-adapter", exists: true, path: CONFIG_PATH });

    case "config.patch":
    case "config.set":
      return resOk(id, { hash: "hermes-adapter" });

    // --- Sessions -----------------------------------------------------------

    case "sessions.list": {
      const sessions = [...agentRegistry.values()].map((agent) => {
        const sessionKey = `agent:${agent.id}:${MAIN_KEY}`;
        const history = getHistory(sessionKey);
        const settings = sessionSettings.get(sessionKey) || {};
        return {
          key: sessionKey, agentId: agent.id,
          updatedAt: history.length > 0 ? Date.now() : null,
          displayName: "Main",
          origin: { label: agent.name, provider: "hermes" },
          model: settings.model || agent.settings?.model || HERMES_MODEL,
          modelProvider: "hermes",
        };
      });
      return resOk(id, { sessions });
    }

    case "sessions.preview": {
      const keys = Array.isArray(p.keys) ? p.keys : [];
      const limit = typeof p.limit === "number" ? p.limit : 8;
      const maxChars = typeof p.maxChars === "number" ? p.maxChars : 240;
      const previews = keys.map((key) => {
        const history = getHistory(key);
        if (history.length === 0) return { key, status: "empty", items: [] };
        const items = history.slice(-limit).map((msg) => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          text: String(msg.content || "").slice(0, maxChars),
          timestamp: Date.now(),
        }));
        return { key, status: "ok", items };
      });
      return resOk(id, { ts: Date.now(), previews });
    }

    case "sessions.patch": {
      const key = typeof p.key === "string" ? p.key : MAIN_SESSION_KEY;
      const current = sessionSettings.get(key) || {};
      const next = { ...current };
      if (p.model !== undefined) next.model = typeof p.model === "string" ? p.model.trim() : p.model;
      if (p.thinkingLevel !== undefined) next.thinkingLevel = p.thinkingLevel;
      if (p.execHost !== undefined) next.execHost = p.execHost;
      if (p.execSecurity !== undefined) next.execSecurity = p.execSecurity;
      if (p.execAsk !== undefined) next.execAsk = p.execAsk;
      sessionSettings.set(key, next);
      const resolvedModel = await resolveHermesModel(next.model || HERMES_MODEL);
      return resOk(id, { ok: true, key, entry: { thinkingLevel: next.thinkingLevel },
        resolved: { model: resolvedModel, modelProvider: "hermes" } });
    }

    case "sessions.reset": {
      const key = typeof p.key === "string" ? p.key : MAIN_SESSION_KEY;
      clearHistory(key);
      return resOk(id, { ok: true });
    }

    // --- Chat ---------------------------------------------------------------

    case "chat.send": {
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : MAIN_SESSION_KEY;
      const userMessage = typeof p.message === "string" ? p.message.trim() : String(p.message || "").trim();
      const runId = (typeof p.idempotencyKey === "string" && p.idempotencyKey) ? p.idempotencyKey : randomId();

      if (!userMessage) return resOk(id, { status: "no-op", runId });

      // Resolve which agent owns this session
      const sessionAgentId = sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : AGENT_ID;
      const agent = agentRegistry.get(sessionAgentId);
      const isOrchestrator = sessionAgentId === AGENT_ID;

      let aborted = false;
      activeRuns.set(runId, {
        runId,
        sessionKey,
        agentId: sessionAgentId,
        abort() { aborted = true; },
      });

      setImmediate(async () => {
        const model = (sessionSettings.get(sessionKey) || {}).model
          || agent?.settings?.model || HERMES_MODEL;
        let seqCounter = 0;

        const emitChat = (state, extra) => {
          sendEvent({ type: "event", event: "chat", seq: seqCounter++,
            payload: { runId, sessionKey, state, ...extra } });
        };

        const onTextDelta = (partial) => {
          if (!aborted) emitChat("delta", { message: { role: "assistant", content: partial } });
        };

        try {
          // Only the orchestrator gets team management tools
          const tools = isOrchestrator ? TEAM_TOOLS : [];

          const finalResult = await runAgenticLoop({
            sessionKey, agentId: sessionAgentId, userMessage,
            model, tools, emitDelta: onTextDelta,
            abortCheck: () => aborted, sendEvent,
          });
          const finalText = finalResult.text || "";

          if (aborted) {
            emitChat("aborted", {});
          } else {
            emitChat("final", { stopReason: "end_turn",
              message: { role: "assistant", content: withEngineMarker(finalText, finalResult.engineModel) } });
            sendEvent({ type: "event", event: "presence", seq: seqCounter++,
              payload: { sessions: { recent: [{ key: sessionKey, updatedAt: Date.now() }],
                byAgent: [{ agentId: sessionAgentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }] } } });
          }
        } catch (err) {
          if (!aborted) emitChat("error", { errorMessage: sanitizeErrorMessage(err) || "Hermes API error" });
          else emitChat("aborted", {});
        } finally {
          activeRuns.delete(runId);
        }
      });

      return resOk(id, { status: "started", runId });
    }

    case "chat.abort": {
      const runId = typeof p.runId === "string" ? p.runId.trim() : "";
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
      let aborted = 0;
      if (runId) {
        const handle = activeRuns.get(runId);
        if (handle) {
          handle.abort();
          activeRuns.delete(runId);
          aborted += 1;
        }
      } else if (sessionKey) {
        for (const [activeRunId, handle] of activeRuns.entries()) {
          if (handle.sessionKey !== sessionKey) continue;
          handle.abort();
          activeRuns.delete(activeRunId);
          aborted += 1;
        }
      }
      return resOk(id, { ok: true, aborted });
    }

    case "chat.history": {
      const histKey = typeof p.sessionKey === "string" ? p.sessionKey : MAIN_SESSION_KEY;
      return resOk(id, { sessionKey: histKey, messages: getHistory(histKey) });
    }

    case "agent.wait": {
      const { runId, timeoutMs = 30000 } = p;
      const start = Date.now();
      while (activeRuns.has(runId) && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return resOk(id, { status: activeRuns.has(runId) ? "running" : "done" });
    }

    // --- Approvals ----------------------------------------------------------

    case "exec.approvals.get":
      return resOk(id, { path: "", exists: true, hash: "hermes-approvals",
        file: { version: 1, defaults: { security: "full", ask: "off", autoAllowSkills: true }, agents: {} } });

    case "exec.approvals.set":
      return resOk(id, { hash: "hermes-approvals" });

    case "exec.approval.resolve":
      return resOk(id, { ok: true });

    // --- Status & heartbeat -------------------------------------------------

    case "status": {
      const recent = [...agentRegistry.keys()].flatMap((aid) => {
        const h = getHistory(`agent:${aid}:${MAIN_KEY}`);
        return h.length > 0 ? [{ key: `agent:${aid}:${MAIN_KEY}`, updatedAt: Date.now() }] : [];
      });
      return resOk(id, { sessions: { recent,
        byAgent: [...agentRegistry.keys()].map((aid) => ({
          agentId: aid,
          recent: recent.filter((r) => r.key.includes(`:${aid}:`)),
        })) } });
    }

    case "wake":
      return resOk(id, { ok: true });

    // --- Skills & models ----------------------------------------------------

    case "skills.status": {
      const agentId = typeof p.agentId === "string" ? p.agentId.trim() : AGENT_ID;
      const agent = agentRegistry.get(agentId) || agentRegistry.get(AGENT_ID);
      const workspaceDir = agent?.workspace || `${HOME}/.hermes/workspace-hermes`;
      return resOk(id, {
        workspaceDir,
        managedSkillsDir: `${HOME}/.hermes/skills`,
        skills: JRC_SKILL_CATALOG.map((skill) => buildSkillStatusEntry(skill, agentId)),
      });
    }

    case "models.list":
      try {
        const models = await fetchHermesModels();
        return resOk(id, {
          models: (models.length > 0 ? models : [HERMES_MODEL]).map((modelId) => ({
            id: modelId,
            name: modelId,
          })),
        });
      } catch {
        return resOk(id, { models: [{ id: HERMES_MODEL, name: HERMES_MODEL }] });
      }

    case "tasks.list":
      return resOk(id, {
        tasks: listTasks(Boolean(p.includeArchived)),
        playbooks: JRC_PLAYBOOKS.map(({ id, name, domain, owner, description, steps }) => ({
          id,
          name,
          domain,
          owner,
          description,
          stepCount: steps.length,
        })),
      });

    case "tasks.create":
      try {
        return resOk(id, createOperationalTask({
          title: p.title,
          description: p.description,
          status: p.status,
          assignedAgentId: p.assignedAgentId,
          playbookJobId: p.playbookJobId,
          runId: p.runId,
          channel: p.channel,
          externalThreadId: p.externalThreadId,
          notes: p.notes,
          source: p.source,
          sourceEventId: p.sourceEventId,
          priority: p.priority,
          domain: p.domain,
          needsHumanApproval: p.needsHumanApproval,
          approvalReason: p.approvalReason,
        }));
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "tasks.update":
      try {
        const taskId = typeof p.id === "string" ? p.id.trim() : "";
        if (!taskId) return resErr(id, "INVALID_REQUEST", "Task id is required.");
        return resOk(id, updateOperationalTask(taskId, p));
      } catch (error) {
        return resErr(id, "NOT_FOUND", sanitizeErrorMessage(error));
      }

    case "tasks.delete": {
      const taskId = typeof p.id === "string" ? p.id.trim() : "";
      if (!taskId) return resErr(id, "INVALID_REQUEST", "Task id is required.");
      return resOk(id, { ok: true, removed: deleteOperationalTask(taskId) });
    }

    case "tasks.approval.resolve":
      try {
        const taskId = typeof p.id === "string" ? p.id.trim() : "";
        const decision = p.approved === true ? "approved" : p.approved === false ? "rejected" : p.approvalStatus;
        if (!taskId) return resErr(id, "INVALID_REQUEST", "Task id is required.");
        return resOk(id, updateOperationalTask(taskId, {
          approvalStatus: decision,
          note: typeof p.note === "string" ? p.note : "",
        }));
      } catch (error) {
        return resErr(id, "NOT_FOUND", sanitizeErrorMessage(error));
      }

    case "tasks.run":
      try {
        const taskId = typeof p.id === "string" ? p.id.trim() : "";
        if (!taskId) return resErr(id, "INVALID_REQUEST", "Task id is required.");
        return resOk(id, await runOperationalTask(taskId, sendEvent));
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "tasks.runNext":
      try {
        const task = findNextRunnableTask({
          domain: p.domain,
          agentId: p.agentId || p.assignedAgentId,
        });
        if (!task) return resOk(id, { ran: false, reason: "no_runnable_task" });
        return resOk(id, { ran: true, ...(await runOperationalTask(task.id, sendEvent)) });
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "tasks.runChain":
      try {
        return resOk(id, await runOperationalChain({
          maxSteps: p.maxSteps,
          domain: p.domain,
          dryRun: p.dryRun,
        }, sendEvent));
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "meetings.list":
      return resOk(id, summarizeMeetings());

    case "meetings.start":
      try {
        return resOk(id, startTeamMeeting({
          goal: p.goal,
          domain: p.domain,
          priority: p.priority,
          source: "gateway",
        }));
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "playbooks.list":
      return resOk(id, { playbooks: JRC_PLAYBOOKS });

    case "playbooks.start":
      try {
        const playbookId = typeof p.id === "string" ? p.id.trim() : "";
        return resOk(id, startPlaybook(playbookId, {
          caseLabel: p.caseLabel,
          context: p.context,
          priority: p.priority,
        }));
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "budget.status":
      return resOk(id, getBudgetStatus());

    case "budget.reset": {
      budgetState = {
        date: todayKey(),
        totalRuns: 0,
        byDomain: {},
        byAgent: {},
        lastRunAtMs: 0,
        blocked: [],
      };
      saveBudgetToDisk();
      return resOk(id, getBudgetStatus());
    }

    case "ops.status":
      return resOk(id, await getOperationsStatus());

    case "ops.mode.set":
      try {
        return resOk(id, setOpsMode(p.mode));
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "ops.costMode.set":
      try {
        return resOk(id, setCostMode(p.mode));
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "ops.traces.list":
      return resOk(id, summarizeTraces(Number(p.limit || 20)));

    case "ops.report.write":
      try {
        return resOk(id, writeEndOfDayReport({ dryRun: p.dryRun }));
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "media.jobs.list":
      return resOk(id, { jobs: mediaJobState.jobs.filter((job) => !job.archived), summary: summarizeMediaJobs() });

    case "media.jobs.create":
      try {
        return resOk(id, { job: createMediaJob(p), summary: summarizeMediaJobs() });
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "media.jobs.update":
      try {
        const jobId = typeof p.id === "string" ? p.id.trim() : "";
        if (!jobId) return resErr(id, "INVALID_REQUEST", "Media job id is required.");
        return resOk(id, { job: updateMediaJob(jobId, p), summary: summarizeMediaJobs() });
      } catch (error) {
        return resErr(id, "NOT_FOUND", sanitizeErrorMessage(error));
      }

    case "media.jobs.approval.resolve":
      try {
        const jobId = typeof p.id === "string" ? p.id.trim() : "";
        const decision = p.approved === true ? "approved" : p.approved === false ? "rejected" : p.approvalStatus;
        if (!jobId) return resErr(id, "INVALID_REQUEST", "Media job id is required.");
        const job = updateMediaJob(jobId, {
          approvalStatus: decision,
          note: typeof p.note === "string" ? p.note : "",
        });
        recordTrace({
          kind: "media.approval.resolve",
          status: job.approval?.status || "unknown",
          agentId: "jrc-amy",
          domain: job.domain,
          riskLevel: "medium",
          message: `${job.title}: ${job.approval?.status || "unknown"}`,
        });
        return resOk(id, { job, summary: summarizeMediaJobs() });
      } catch (error) {
        return resErr(id, "NOT_FOUND", sanitizeErrorMessage(error));
      }

    case "media.jobs.run":
      try {
        const jobId = typeof p.id === "string" ? p.id.trim() : "";
        if (!jobId) return resErr(id, "INVALID_REQUEST", "Media job id is required.");
        return resOk(id, runMediaJob(jobId, { dryRun: p.dryRun !== false }));
      } catch (error) {
        return resErr(id, "INVALID_REQUEST", sanitizeErrorMessage(error));
      }

    case "media.budget.status":
      return resOk(id, getMediaBudgetStatus());

    case "media.budget.reset":
      mediaBudgetState = {
        date: todayKey(),
        preparedRuns: 0,
        byProvider: {},
        blocked: [],
      };
      saveMediaBudgetToDisk();
      return resOk(id, getMediaBudgetStatus());

    case "jrcHub.status":
      try {
        const snapshot = await getJrcHubSnapshot();
        return resOk(id, {
          baseUrl: JRC_HUB_BASE_URL,
          readOnlyKeyConfigured: Boolean(JRC_HUB_MCP_READONLY_KEY),
          sources: Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, {
            ok: Boolean(value?.ok),
            path: value?.path,
            error: value?.error,
          }])),
        });
      } catch (error) {
        return resErr(id, "JRC_HUB_ERROR", sanitizeErrorMessage(error));
      }

    case "jrcHub.syncTriggers":
      try {
        const result = await syncJrcHubTriggers();
        return resOk(id, {
          created: result.created,
          createdCount: result.created.length,
          sources: Object.fromEntries(Object.entries(result.snapshot).map(([key, value]) => [key, Boolean(value?.ok)])),
        });
      } catch (error) {
        return resErr(id, "JRC_HUB_ERROR", sanitizeErrorMessage(error));
      }

    // --- Cron jobs ----------------------------------------------------------

    case "cron.list": {
      const includeDisabled = p.includeDisabled !== false;
      const jobs = [...cronJobs.values()];
      return resOk(id, { jobs: includeDisabled ? jobs : jobs.filter((j) => j.enabled) });
    }

    case "cron.add": {
      const jobId = randomId();
      const job = {
        id: jobId, name: typeof p.name === "string" ? p.name : "Cron Job",
        agentId: typeof p.agentId === "string" ? p.agentId : AGENT_ID,
        sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : MAIN_SESSION_KEY,
        description: typeof p.description === "string" ? p.description : "",
        enabled: p.enabled !== false, deleteAfterRun: Boolean(p.deleteAfterRun),
        updatedAtMs: Date.now(), schedule: p.schedule || { kind: "every", everyMs: 3600000 },
        sessionTarget: p.sessionTarget || "main", wakeMode: p.wakeMode || "next-heartbeat",
        payload: p.payload || { kind: "systemEvent", text: "tick" }, state: {},
      };
      cronJobs.set(jobId, job);
      return resOk(id, job);
    }

    case "cron.remove": {
      const jobId = typeof p.id === "string" ? p.id : "";
      return resOk(id, { ok: true, removed: cronJobs.delete(jobId) });
    }

    case "cron.patch": {
      const jobId = typeof p.id === "string" ? p.id : "";
      const job = cronJobs.get(jobId);
      if (!job) return resOk(id, { ok: false, error: "not_found" });
      const updated = { ...job };
      if (p.enabled !== undefined) updated.enabled = Boolean(p.enabled);
      if (p.name !== undefined) updated.name = String(p.name);
      if (p.schedule !== undefined) updated.schedule = p.schedule;
      if (p.payload !== undefined) updated.payload = p.payload;
      updated.updatedAtMs = Date.now();
      cronJobs.set(jobId, updated);
      return resOk(id, { ok: true, job: updated });
    }

    case "cron.run": {
      const jobId = typeof p.id === "string" ? p.id : "";
      return resOk(id, await runCronJob(jobId));
    }

    default:
      console.warn(`[hermes-adapter] Unhandled method: ${method}`);
      return resOk(id, {});
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

function startAdapter() {
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hermes Gateway Adapter – OK\n");
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("error", (err) => {
    if (err.code !== "EADDRINUSE") console.error("[hermes-adapter] Server error:", sanitizeErrorMessage(err));
  });

  wss.on("connection", (ws) => {
    let connected = false;
    let globalSeq = 0;

    const send = (frame) => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(frame)); }
        catch (e) { console.error("[hermes-adapter] send error:", sanitizeErrorMessage(e)); }
      }
    };

    // Register this connection's send function for broadcasts
    const sendEventFn = (frame) => {
      if (frame.type === "event" && typeof frame.seq !== "number") frame.seq = globalSeq++;
      send(frame);
    };
    activeSendEventFns.add(sendEventFn);

    send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

    ws.on("message", async (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (!frame || typeof frame !== "object" || frame.type !== "req") return;
      const { id, method, params } = frame;
      if (typeof id !== "string" || typeof method !== "string") return;

      if (method === "connect") {
        connected = true;
        const allAgents = [...agentRegistry.values()].map((a) => ({ agentId: a.id, name: a.name, isDefault: a.id === AGENT_ID }));
        send({
          type: "res", id, ok: true,
          payload: {
            type: "hello-ok", protocol: 3,
            adapterType: "hermes",
            features: { methods: ["agents.list","agents.create","agents.delete","agents.update",
              "sessions.list","sessions.preview","sessions.patch","sessions.reset",
              "chat.send","chat.abort","chat.history","agent.wait",
              "status","config.get","config.set","config.patch",
              "agents.files.get","agents.files.set",
              "exec.approvals.get","exec.approvals.set","exec.approval.resolve",
              "wake","skills.status","models.list",
              "tasks.list","tasks.create","tasks.update","tasks.delete","tasks.approval.resolve",
              "tasks.run","tasks.runNext","tasks.runChain",
              "meetings.list","meetings.start",
              "playbooks.list","playbooks.start",
              "budget.status","budget.reset",
              "ops.status","ops.mode.set","ops.costMode.set","ops.traces.list","ops.report.write",
              "media.jobs.list","media.jobs.create","media.jobs.update","media.jobs.approval.resolve",
              "media.jobs.run","media.budget.status","media.budget.reset",
              "jrcHub.status","jrcHub.syncTriggers",
              "cron.list","cron.add","cron.remove","cron.patch","cron.run"],
              events: ["chat","presence","heartbeat","cron","task"] },
            snapshot: { health: { agents: allAgents, defaultAgentId: AGENT_ID },
              sessionDefaults: { mainKey: MAIN_KEY } },
            auth: { role: "operator", scopes: ["operator.admin","operator.approvals"] },
            policy: { tickIntervalMs: 30000 },
          },
        });
        return;
      }

      if (!connected) { send(resErr(id, "not_connected", "Send connect first.")); return; }

      try {
        const response = await handleMethod(method, params, id, sendEventFn);
        send(response);
      } catch (err) {
        const message = sanitizeErrorMessage(err);
        console.error(`[hermes-adapter] Error handling ${method}:`, message);
        send(resErr(id, "internal_error", message || "Internal error"));
      }
    });

    ws.on("close", () => activeSendEventFns.delete(sendEventFn));
    ws.on("error", (err) => {
      console.error("[hermes-adapter] WebSocket error:", sanitizeErrorMessage(err));
      activeSendEventFns.delete(sendEventFn);
    });
  });

  httpServer.listen(ADAPTER_PORT, "127.0.0.1", () => {
    startJrcHubTriggerTimer();
    console.log(`\n[hermes-adapter] ✓ Listening on ws://localhost:${ADAPTER_PORT}`);
    console.log(`[hermes-adapter] ✓ Forwarding to Hermes API at ${HERMES_API_URL}`);
    console.log(`[hermes-adapter] ✓ Model: ${HERMES_MODEL}`);
    console.log(`[hermes-adapter] ✓ Multi-agent orchestration: ENABLED`);
    console.log(`[hermes-adapter] ✓ JRC Hub trigger sync: every ${JRC_HUB_TRIGGER_INTERVAL_MIN} min`);
    console.log(`\nOpen Claw3D → ws://localhost:${ADAPTER_PORT}\n`);
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[hermes-adapter] Port ${ADAPTER_PORT} in use. Set HERMES_ADAPTER_PORT to change it.`);
    } else {
      console.error("[hermes-adapter] Server error:", sanitizeErrorMessage(err));
    }
    process.exit(1);
  });
}

loadHistoryFromDisk();

const todayKey = () => new Date().toISOString().slice(0, 10);

let budgetState = {
  date: todayKey(),
  totalRuns: 0,
  byDomain: {},
  byAgent: {},
  lastRunAtMs: 0,
  blocked: [],
};

function loadBudgetFromDisk() {
  try {
    if (!fs.existsSync(BUDGET_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8"));
    if (parsed && typeof parsed === "object") budgetState = { ...budgetState, ...parsed };
  } catch (error) {
    console.warn("[hermes-adapter] Failed to load budget:", sanitizeErrorMessage(error));
  }
}

function ensureBudgetDate() {
  const current = todayKey();
  if (budgetState.date === current) return;
  budgetState = {
    date: current,
    totalRuns: 0,
    byDomain: {},
    byAgent: {},
    lastRunAtMs: 0,
    blocked: [],
  };
  saveBudgetToDisk();
}

function saveBudgetToDisk() {
  clearTimeout(budgetPersistDebounceTimer);
  budgetPersistDebounceTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true });
      fs.writeFileSync(BUDGET_FILE, JSON.stringify({ version: 1, ...budgetState }, null, 2), "utf8");
    } catch (error) {
      console.warn("[hermes-adapter] Failed to save budget:", sanitizeErrorMessage(error));
    }
  }, 100);
}

function getBudgetStatus() {
  ensureBudgetDate();
  return {
    ...budgetState,
    limits: {
      totalDaily: JRC_TASK_RUN_DAILY_LIMIT,
      perDomainDaily: JRC_TASK_RUN_DOMAIN_DAILY_LIMIT,
      cooldownMs: JRC_TASK_RUN_COOLDOWN_MS,
      autoRunEnabled: JRC_AUTO_RUN_ENABLED,
    },
    remainingTotal: Math.max(0, JRC_TASK_RUN_DAILY_LIMIT - Number(budgetState.totalRuns || 0)),
  };
}

function checkTaskRunBudget(task, options = {}) {
  ensureBudgetDate();
  if (taskRunInFlight) return { ok: false, reason: "task_run_in_flight" };
  if (options.automatic === true && !JRC_AUTO_RUN_ENABLED) return { ok: false, reason: "auto_run_disabled" };
  const now = Date.now();
  const elapsed = now - Number(budgetState.lastRunAtMs || 0);
  if (budgetState.lastRunAtMs && elapsed < JRC_TASK_RUN_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", retryAfterMs: JRC_TASK_RUN_COOLDOWN_MS - elapsed };
  }
  if (Number(budgetState.totalRuns || 0) >= JRC_TASK_RUN_DAILY_LIMIT) {
    return { ok: false, reason: "daily_total_limit" };
  }
  const domain = task.domain || "geral";
  if (Number(budgetState.byDomain?.[domain] || 0) >= JRC_TASK_RUN_DOMAIN_DAILY_LIMIT) {
    return { ok: false, reason: "daily_domain_limit", domain };
  }
  return { ok: true };
}

function recordTaskRunBudget(task, status, detail = "") {
  ensureBudgetDate();
  const domain = task.domain || "geral";
  const agentId = task.assignedAgentId || "unassigned";
  if (status === "started") {
    budgetState.totalRuns = Number(budgetState.totalRuns || 0) + 1;
    budgetState.byDomain = { ...(budgetState.byDomain || {}), [domain]: Number(budgetState.byDomain?.[domain] || 0) + 1 };
    budgetState.byAgent = { ...(budgetState.byAgent || {}), [agentId]: Number(budgetState.byAgent?.[agentId] || 0) + 1 };
    budgetState.lastRunAtMs = Date.now();
  } else if (status === "blocked") {
    budgetState.blocked = [
      { atMs: Date.now(), taskId: task.id, title: task.title, domain, agentId, reason: detail },
      ...(budgetState.blocked || []),
    ].slice(0, 40);
  }
  saveBudgetToDisk();
}

loadBudgetFromDisk();

const OPS_MODES = new Set(["manual", "assisted", "auto_safe"]);
const COST_MODES = new Set(["economy", "balanced", "critical"]);
let opsModeState = {
  mode: "assisted",
  updatedAtMs: 0,
  updatedBy: "system",
};

let costModeState = {
  mode: "balanced",
  updatedAtMs: 0,
  updatedBy: "system",
};

let meetingState = {
  version: 1,
  meetings: [],
};

let traceState = {
  version: 1,
  traces: [],
};

let mediaJobState = {
  version: 1,
  jobs: [],
};

let mediaBudgetState = {
  date: todayKey(),
  preparedRuns: 0,
  byProvider: {},
  blocked: [],
};

function loadOpsModeFromDisk() {
  try {
    if (!fs.existsSync(OPS_MODE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(OPS_MODE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    const mode = OPS_MODES.has(parsed.mode) ? parsed.mode : opsModeState.mode;
    opsModeState = {
      mode,
      updatedAtMs: Number(parsed.updatedAtMs || 0),
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : "system",
    };
  } catch (error) {
    console.warn("[hermes-adapter] Failed to load ops mode:", sanitizeErrorMessage(error));
  }
}

function saveOpsModeToDisk() {
  clearTimeout(opsModePersistDebounceTimer);
  opsModePersistDebounceTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(OPS_MODE_FILE), { recursive: true });
      fs.writeFileSync(OPS_MODE_FILE, JSON.stringify({ version: 1, ...opsModeState }, null, 2), "utf8");
    } catch (error) {
      console.warn("[hermes-adapter] Failed to save ops mode:", sanitizeErrorMessage(error));
    }
  }, 100);
}

function setOpsMode(mode) {
  const normalized = typeof mode === "string" ? mode.trim() : "";
  if (!OPS_MODES.has(normalized)) {
    throw new Error("Mode must be manual, assisted or auto_safe.");
  }
  opsModeState = {
    mode: normalized,
    updatedAtMs: Date.now(),
    updatedBy: "operator",
  };
  saveOpsModeToDisk();
  return getOpsModeStatus();
}

function getOpsModeStatus() {
  return {
    ...opsModeState,
    labels: {
      manual: "Manual",
      assisted: "Assistido",
      auto_safe: "Automatico seguro",
    },
    externalActionsLocked: true,
    autoRunEnabled: JRC_AUTO_RUN_ENABLED,
    note:
      opsModeState.mode === "auto_safe" && !JRC_AUTO_RUN_ENABLED
        ? "Modo visual em automatico seguro, mas auto-run global segue desligado no .env."
        : "",
  };
}

function loadCostModeFromDisk() {
  try {
    if (!fs.existsSync(COST_MODE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(COST_MODE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    costModeState = {
      mode: COST_MODES.has(parsed.mode) ? parsed.mode : costModeState.mode,
      updatedAtMs: Number(parsed.updatedAtMs || 0),
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : "system",
    };
  } catch (error) {
    console.warn("[hermes-adapter] Failed to load cost mode:", sanitizeErrorMessage(error));
  }
}

function saveCostModeToDisk() {
  clearTimeout(costModePersistDebounceTimer);
  costModePersistDebounceTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(COST_MODE_FILE), { recursive: true });
      fs.writeFileSync(COST_MODE_FILE, JSON.stringify({ version: 1, ...costModeState }, null, 2), "utf8");
    } catch (error) {
      console.warn("[hermes-adapter] Failed to save cost mode:", sanitizeErrorMessage(error));
    }
  }, 100);
}

function setCostMode(mode) {
  const normalized = typeof mode === "string" ? mode.trim() : "";
  if (!COST_MODES.has(normalized)) {
    throw new Error("Cost mode must be economy, balanced or critical.");
  }
  costModeState = {
    mode: normalized,
    updatedAtMs: Date.now(),
    updatedBy: "operator",
  };
  saveCostModeToDisk();
  return getCostModeStatus();
}

function getCostModeStatus() {
  return {
    ...costModeState,
    labels: {
      economy: "Economia",
      balanced: "Balanceado",
      critical: "Critico",
    },
    routing: {
      economy: "Prioriza Kimi/Ollama e evita Claude/Codex salvo pedido humano.",
      balanced: "Usa Kimi para volume e Claude/Codex apenas em tarefas criticas do dominio.",
      critical: "Permite motor forte para juridico sensivel, arquitetura e incidentes, sempre com budget.",
    }[costModeState.mode],
    hardLocks: [
      "Nao remove limite diario, cooldown ou aprovacao humana.",
      "Nao autoriza protocolo/envio/contato/cobranca/deploy destrutivo.",
    ],
  };
}

function loadTracesFromDisk() {
  try {
    if (!fs.existsSync(TRACES_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(TRACES_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    const traces = Array.isArray(parsed.traces) ? parsed.traces : [];
    traceState = {
      version: 1,
      traces: traces.filter((trace) => trace && typeof trace === "object").slice(0, 200),
    };
  } catch (error) {
    console.warn("[hermes-adapter] Failed to load traces:", sanitizeErrorMessage(error));
  }
}

function saveTracesToDisk() {
  clearTimeout(tracesPersistDebounceTimer);
  tracesPersistDebounceTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(TRACES_FILE), { recursive: true });
      fs.writeFileSync(TRACES_FILE, JSON.stringify(traceState, null, 2), "utf8");
    } catch (error) {
      console.warn("[hermes-adapter] Failed to save traces:", sanitizeErrorMessage(error));
    }
  }, 100);
}

function inferRiskLevel(task, text = "") {
  const combined = `${task?.domain || ""} ${task?.title || ""} ${task?.description || ""} ${text}`.toLowerCase();
  if (task?.approval?.required || /protocol|enviar|peti|prazo|legalmail|cobran|contato|deploy destrutivo/.test(combined)) {
    return "high";
  }
  if (/marketing|meta|comercial|financeiro|cliente|lead|devops|vps|codigo/.test(combined)) return "medium";
  return "low";
}

function buildHandoffContract(task, extra = {}) {
  return {
    objetivo: task.title,
    entrada: task.description || "Contexto operacional registrado na fila Hermes Office.",
    saidaEsperada: "Resultado interno, proximos passos, riscos e dependencias de aprovacao humana.",
    responsavel: task.assignedAgentId || "unassigned",
    dominio: task.domain || "geral",
    risco: extra.riskLevel || inferRiskLevel(task),
    precisaAprovacao: Boolean(task.approval?.required),
    criterioDePronto: task.approval?.required
      ? "Artefato pronto para revisao humana, sem executar ato externo."
      : "Artefato interno concluido sem ato externo.",
  };
}

function buildQualityScore(task, responseText = "") {
  const text = responseText.toLowerCase();
  let score = 70;
  const checks = [];
  if (/risco|riscos|aten[cç][aã]o|bloqueio/.test(text)) {
    score += 8;
    checks.push("riscos");
  }
  if (/pr[oó]ximo|proximos|passo|checklist|pend[eê]ncia/.test(text)) {
    score += 8;
    checks.push("proximos_passos");
  }
  if (/aprova[cç][aã]o humana|depende de aprova[cç][aã]o|sem aprova[cç][aã]o/.test(text)) {
    score += 8;
    checks.push("aprovacao");
  }
  if (responseText.trim().length > 700) {
    score += 6;
    checks.push("substancia");
  }
  if (/protocol(ei|ado|ar)|enviei|enviado|contatei|cobrei|deploy executado/.test(text)) {
    score -= 30;
    checks.push("possivel_acao_externa");
  }
  if (task.approval?.required && !/aprova[cç][aã]o|revis[aã]o|humana/.test(text)) {
    score -= 12;
    checks.push("aprovacao_pouco_explicita");
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    checks,
    verdict: score >= 90 ? "forte" : score >= 75 ? "bom" : score >= 60 ? "revisar" : "bloquear",
  };
}

function recordTrace(input = {}) {
  const trace = {
    id: typeof input.id === "string" ? input.id : `trace-${todayKey()}-${randomId()}`,
    kind: typeof input.kind === "string" ? input.kind : "event",
    status: typeof input.status === "string" ? input.status : "ok",
    taskId: typeof input.taskId === "string" ? input.taskId : null,
    meetingId: typeof input.meetingId === "string" ? input.meetingId : null,
    agentId: typeof input.agentId === "string" ? input.agentId : null,
    domain: typeof input.domain === "string" ? input.domain : null,
    engine: typeof input.engine === "string" ? input.engine : null,
    riskLevel: typeof input.riskLevel === "string" ? input.riskLevel : null,
    qualityScore: input.qualityScore && typeof input.qualityScore === "object" ? input.qualityScore : null,
    handoff: input.handoff && typeof input.handoff === "object" ? input.handoff : null,
    message: typeof input.message === "string" ? input.message.slice(0, 1200) : "",
    occurredAt: nowIso(),
    occurredAtMs: Date.now(),
  };
  traceState = {
    version: 1,
    traces: [trace, ...traceState.traces].slice(0, 200),
  };
  saveTracesToDisk();
  return trace;
}

function summarizeTraces(limit = 12) {
  return {
    total: traceState.traces.length,
    latest: traceState.traces.slice(0, limit),
  };
}

const MEDIA_JOB_KINDS = new Set(["image", "video", "voice", "avatar", "edit", "carousel", "ad_creative"]);
const MEDIA_JOB_STATUSES = new Set(["draft", "pending_approval", "approved", "blocked", "ready", "done", "rejected"]);
const MEDIA_APPROVAL_STATUSES = new Set(["not_required", "pending", "approved", "rejected"]);
const MEDIA_PROVIDER_IDS = new Set(["elevenlabs", "google-gemini", "openai", "fal", "replicate", "ideogram", "creatomate"]);
const MEDIA_RUN_DAILY_LIMIT = Number.parseInt(process.env.JRC_MEDIA_PREP_DAILY_LIMIT || "12", 10);

function getMediaProviders() {
  return [
    {
      id: "elevenlabs",
      label: "ElevenLabs",
      kind: "voice",
      env: "ELEVENLABS_API_KEY",
      role: "voz natural e voice clone para videos HeyGen/Reels",
      defaultUse: "roteiro -> voz PT-BR natural",
      approval: "required_for_publish",
    },
    {
      id: "google-gemini",
      label: "Google/Gemini",
      kind: "image",
      env: "GOOGLE_API_KEY",
      role: "nano-banana/Gemini image para criativos e imagens isoladas",
      defaultUse: "imagem estatica e variacoes de campanha",
      approval: "required_for_external_use",
    },
    {
      id: "openai",
      label: "OpenAI",
      kind: "image",
      env: "OPENAI_API_KEY",
      role: "fallback de imagem/vision quando modelo local nao basta",
      defaultUse: "criativo pontual e analise visual nao sensivel",
      approval: "required_for_sensitive_docs",
    },
    {
      id: "fal",
      label: "Fal.ai",
      kind: "image_video",
      env: "FAL_API_KEY",
      role: "Flux/Veo/Kling e geracao de B-roll",
      defaultUse: "video curto, B-roll e imagem premium",
      approval: "required_for_paid_generation",
    },
    {
      id: "replicate",
      label: "Replicate",
      kind: "image_video",
      env: "REPLICATE_API_KEY",
      role: "fallback para modelos de imagem/video",
      defaultUse: "experimentos controlados e fallback",
      approval: "required_for_paid_generation",
    },
    {
      id: "ideogram",
      label: "Ideogram",
      kind: "image",
      env: "IDEOGRAM_API_KEY",
      role: "arte com texto e criativos de campanha",
      defaultUse: "posts com lettering/titulos",
      approval: "required_for_external_use",
    },
    {
      id: "creatomate",
      label: "Creatomate",
      kind: "video_edit",
      env: "CREATOMATE_API_KEY",
      role: "montagem programatica de videos, templates e render",
      defaultUse: "juntar voz, avatar, legenda e B-roll",
      approval: "required_for_publish",
    },
  ].map((provider) => ({
    ...provider,
    configured: Boolean(process.env[provider.env]?.trim()),
  }));
}

function normalizeMediaKind(kind) {
  const value = typeof kind === "string" ? kind.trim() : "";
  return MEDIA_JOB_KINDS.has(value) ? value : "ad_creative";
}

function normalizeMediaProvider(providerId, kind) {
  const value = typeof providerId === "string" ? providerId.trim() : "";
  if (MEDIA_PROVIDER_IDS.has(value)) return value;
  if (kind === "voice") return "elevenlabs";
  if (kind === "video" || kind === "avatar") return "creatomate";
  if (kind === "edit") return "creatomate";
  if (kind === "carousel" || kind === "ad_creative") return "ideogram";
  return "google-gemini";
}

function estimateMediaCost(kind, providerId) {
  if (providerId === "fal" || providerId === "replicate" || kind === "video" || kind === "avatar") {
    return { costUsdMin: 1, costUsdMax: 5, tier: "high", credits: "paid_video" };
  }
  if (providerId === "creatomate" || kind === "edit") {
    return { costUsdMin: 0.05, costUsdMax: 0.5, tier: "medium", credits: "render" };
  }
  if (providerId === "elevenlabs" || kind === "voice") {
    return { costUsdMin: 0.05, costUsdMax: 0.5, tier: "medium", credits: "voice_chars" };
  }
  return { costUsdMin: 0.02, costUsdMax: 0.2, tier: "low", credits: "image" };
}

function requiresMediaApproval(kind, providerId, estimate) {
  return ["low", "medium", "high"].includes(estimate.tier)
    || ["video", "avatar", "edit", "ad_creative", "carousel"].includes(kind)
    || ["fal", "replicate", "creatomate", "ideogram"].includes(providerId);
}

function saveMediaJobsToDisk() {
  clearTimeout(mediaJobsPersistDebounceTimer);
  mediaJobsPersistDebounceTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(MEDIA_JOBS_FILE), { recursive: true });
      fs.writeFileSync(MEDIA_JOBS_FILE, JSON.stringify(mediaJobState, null, 2), "utf8");
    } catch (error) {
      console.warn("[hermes-adapter] Failed to save media jobs:", sanitizeErrorMessage(error));
    }
  }, 100);
}

function loadMediaJobsFromDisk() {
  try {
    if (!fs.existsSync(MEDIA_JOBS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(MEDIA_JOBS_FILE, "utf8"));
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    mediaJobState = {
      version: 1,
      jobs: jobs.filter((job) => job && typeof job === "object" && typeof job.id === "string").slice(0, 200),
    };
  } catch (error) {
    console.warn("[hermes-adapter] Failed to load media jobs:", sanitizeErrorMessage(error));
  }
}

function ensureMediaBudgetDate() {
  const current = todayKey();
  if (mediaBudgetState.date === current) return;
  mediaBudgetState = {
    date: current,
    preparedRuns: 0,
    byProvider: {},
    blocked: [],
  };
  saveMediaBudgetToDisk();
}

function saveMediaBudgetToDisk() {
  clearTimeout(mediaBudgetPersistDebounceTimer);
  mediaBudgetPersistDebounceTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(MEDIA_BUDGET_FILE), { recursive: true });
      fs.writeFileSync(MEDIA_BUDGET_FILE, JSON.stringify({ version: 1, ...mediaBudgetState }, null, 2), "utf8");
    } catch (error) {
      console.warn("[hermes-adapter] Failed to save media budget:", sanitizeErrorMessage(error));
    }
  }, 100);
}

function loadMediaBudgetFromDisk() {
  try {
    if (!fs.existsSync(MEDIA_BUDGET_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(MEDIA_BUDGET_FILE, "utf8"));
    if (parsed && typeof parsed === "object") mediaBudgetState = { ...mediaBudgetState, ...parsed };
    ensureMediaBudgetDate();
  } catch (error) {
    console.warn("[hermes-adapter] Failed to load media budget:", sanitizeErrorMessage(error));
  }
}

function getMediaBudgetStatus() {
  ensureMediaBudgetDate();
  return {
    ...mediaBudgetState,
    limits: {
      preparedDaily: MEDIA_RUN_DAILY_LIMIT,
      externalSpendRequiresApproval: true,
      publishRequiresApproval: true,
      actualProviderCallsEnabled: false,
    },
    remainingTotal: Math.max(0, MEDIA_RUN_DAILY_LIMIT - Number(mediaBudgetState.preparedRuns || 0)),
  };
}

function recordMediaBudget(job, status, detail = "") {
  ensureMediaBudgetDate();
  if (status === "prepared") {
    mediaBudgetState.preparedRuns = Number(mediaBudgetState.preparedRuns || 0) + 1;
    mediaBudgetState.byProvider = {
      ...(mediaBudgetState.byProvider || {}),
      [job.providerId]: Number(mediaBudgetState.byProvider?.[job.providerId] || 0) + 1,
    };
  } else if (status === "blocked") {
    mediaBudgetState.blocked = [
      { atMs: Date.now(), jobId: job.id, title: job.title, providerId: job.providerId, reason: detail },
      ...(mediaBudgetState.blocked || []),
    ].slice(0, 40);
  }
  saveMediaBudgetToDisk();
}

function buildMediaProviderPayload(job) {
  const base = {
    jobId: job.id,
    title: job.title,
    prompt: job.prompt,
    safety: "Do not publish, contact third parties, or spend credits without explicit human approval.",
  };
  if (job.providerId === "elevenlabs") {
    return { provider: "elevenlabs", endpoint: "text-to-speech", body: { ...base, voice: "pt-BR natural", format: "mp3" } };
  }
  if (job.providerId === "creatomate") {
    return { provider: "creatomate", endpoint: "render-template", body: { ...base, template: "jrc-short-video", render: "requires_human_approval" } };
  }
  if (job.providerId === "fal") {
    return { provider: "fal", endpoint: "queued-generation", body: { ...base, model: "selected_after_approval", mode: "video_or_image" } };
  }
  if (job.providerId === "replicate") {
    return { provider: "replicate", endpoint: "predictions", body: { ...base, version: "selected_after_approval" } };
  }
  if (job.providerId === "ideogram") {
    return { provider: "ideogram", endpoint: "image-generation", body: { ...base, aspectRatio: "4:5", textAccuracy: "high" } };
  }
  return { provider: job.providerId, endpoint: "image-generation", body: { ...base, aspectRatio: "4:5" } };
}

function summarizeMediaJobs(limit = 6) {
  const jobs = mediaJobState.jobs.filter((job) => !job.archived);
  const byStatus = {};
  for (const job of jobs) {
    byStatus[job.status] = Number(byStatus[job.status] || 0) + 1;
  }
  const pendingApproval = jobs.filter((job) => job.approval?.status === "pending").length;
  return {
    total: jobs.length,
    byStatus,
    pendingApproval,
    latest: jobs
      .slice()
      .sort((left, right) => Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0))
      .slice(0, limit),
  };
}

function createMediaJob(input = {}) {
  const kind = normalizeMediaKind(input.kind);
  const providerId = normalizeMediaProvider(input.providerId, kind);
  const prompt = typeof input.prompt === "string" && input.prompt.trim()
    ? input.prompt.trim()
    : "Criativo educativo BPC/LOAS para Instagram, sem publicar.";
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : `Midia JRC - ${kind} via ${providerId}`;
  const estimate = estimateMediaCost(kind, providerId);
  const approvalRequired = requiresMediaApproval(kind, providerId, estimate);
  const createdAt = nowIso();
  const trace = recordTrace({
    kind: "media.job.create",
    status: approvalRequired ? "pending_approval" : "draft",
    agentId: "jrc-amy",
    domain: "marketing",
    riskLevel: approvalRequired ? "medium" : "low",
    message: `${title} (${kind}/${providerId})`,
  });
  const job = {
    id: `media-job-${todayKey()}-${randomId()}`,
    kind,
    providerId,
    title,
    prompt,
    domain: typeof input.domain === "string" && input.domain.trim() ? input.domain.trim() : "marketing",
    priority: normalizePriority(input.priority || "normal"),
    status: approvalRequired ? "pending_approval" : "draft",
    createdAt,
    updatedAt: createdAt,
    updatedAtMs: Date.now(),
    estimate,
    approval: {
      required: approvalRequired,
      status: approvalRequired ? "pending" : "not_required",
      reason: approvalRequired
        ? "Geracao de midia pode consumir creditos ou ser usada externamente; exige aprovacao humana."
        : "",
      resolvedAt: null,
      resolvedBy: null,
    },
    providerPayload: null,
    outputs: [],
    notes: ["Criado como job local. Nenhuma chamada externa foi executada."],
    traceId: trace.id,
    archived: false,
  };
  mediaJobState = { version: 1, jobs: [job, ...mediaJobState.jobs].slice(0, 200) };
  saveMediaJobsToDisk();
  return job;
}

function updateMediaJob(id, patch = {}) {
  const index = mediaJobState.jobs.findIndex((job) => job.id === id);
  if (index < 0) throw new Error(`Media job ${id} not found`);
  const job = { ...mediaJobState.jobs[index], approval: { ...(mediaJobState.jobs[index].approval || {}) } };
  if (typeof patch.title === "string" && patch.title.trim()) job.title = patch.title.trim();
  if (typeof patch.prompt === "string" && patch.prompt.trim()) job.prompt = patch.prompt.trim();
  if (typeof patch.status === "string" && MEDIA_JOB_STATUSES.has(patch.status)) job.status = patch.status;
  if (typeof patch.priority === "string") job.priority = normalizePriority(patch.priority);
  if (typeof patch.note === "string" && patch.note.trim()) job.notes = [...(job.notes || []), patch.note.trim()];
  if (typeof patch.archived === "boolean") job.archived = patch.archived;
  if (typeof patch.approvalStatus === "string" && MEDIA_APPROVAL_STATUSES.has(patch.approvalStatus)) {
    job.approval.status = patch.approvalStatus;
    if (patch.approvalStatus === "approved" || patch.approvalStatus === "rejected") {
      job.approval.resolvedAt = nowIso();
      job.approval.resolvedBy = "human";
      job.status = patch.approvalStatus === "approved" ? "approved" : "rejected";
    }
  }
  job.updatedAt = nowIso();
  job.updatedAtMs = Date.now();
  mediaJobState.jobs[index] = job;
  saveMediaJobsToDisk();
  return job;
}

function runMediaJob(id, options = {}) {
  const index = mediaJobState.jobs.findIndex((job) => job.id === id);
  if (index < 0) throw new Error(`Media job ${id} not found`);
  const job = mediaJobState.jobs[index];
  const budget = getMediaBudgetStatus();
  if (budget.remainingTotal <= 0) {
    recordMediaBudget(job, "blocked", "daily_media_prepare_limit");
    return { dryRun: true, blocked: true, reason: "daily_media_prepare_limit", job, budget: getMediaBudgetStatus() };
  }
  const dryRun = options.dryRun !== false;
  const approved = job.approval?.status === "approved" || job.approval?.status === "not_required";
  const providerPayload = buildMediaProviderPayload(job);
  const plan = {
    title: job.title,
    kind: job.kind,
    providerId: job.providerId,
    steps: [
      "Validar briefing, publico e risco OAB.",
      "Preparar prompt/payload do provedor sem enviar chamada externa.",
      "Revisar custo estimado e aprovacao humana.",
      "Somente depois de aprovacao explicita executar provedor fora do dry-run.",
    ],
    providerPayload,
  };
  if (!approved) {
    const updated = updateMediaJob(job.id, {
      status: "pending_approval",
      note: "Dry-run preparado; aguardando aprovacao humana antes de qualquer geracao paga.",
    });
    recordTrace({
      kind: "media.job.run",
      status: "pending_approval",
      agentId: "jrc-amy",
      domain: updated.domain,
      riskLevel: "medium",
      message: updated.title,
    });
    return { dryRun, blocked: true, reason: "human_approval_required", plan, job: updated, budget: getMediaBudgetStatus() };
  }
  const updated = updateMediaJob(job.id, {
    status: "ready",
    note: dryRun
      ? "Dry-run concluido; payload pronto, sem chamada externa."
      : "Payload pronto. Execucao real de provedor permanece desligada neste build.",
  });
  updated.providerPayload = providerPayload;
  mediaJobState.jobs[index] = updated;
  saveMediaJobsToDisk();
  recordMediaBudget(updated, "prepared");
  recordTrace({
    kind: "media.job.run",
    status: "ready",
    agentId: "jrc-amy",
    domain: updated.domain,
    riskLevel: "medium",
    message: `${updated.title} preparado sem chamada externa.`,
  });
  return { dryRun, preparedOnly: true, externalCallMade: false, plan, job: updated, budget: getMediaBudgetStatus() };
}


function loadMeetingsFromDisk() {
  try {
    if (!fs.existsSync(MEETINGS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(MEETINGS_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    const meetings = Array.isArray(parsed.meetings) ? parsed.meetings : [];
    meetingState = {
      version: 1,
      meetings: meetings.filter((meeting) => meeting && typeof meeting === "object").slice(0, 50),
    };
  } catch (error) {
    console.warn("[hermes-adapter] Failed to load meetings:", sanitizeErrorMessage(error));
  }
}

function saveMeetingsToDisk() {
  try {
    fs.mkdirSync(path.dirname(MEETINGS_FILE), { recursive: true });
    fs.writeFileSync(MEETINGS_FILE, JSON.stringify(meetingState, null, 2), "utf8");
  } catch (error) {
    console.warn("[hermes-adapter] Failed to save meetings:", sanitizeErrorMessage(error));
  }
}

const DOMAIN_AGENT_MAP = {
  bpc: ["jrc-maestro", "jrc-bpc", "jrc-revisor"],
  prazos: ["jrc-maestro", "jrc-legalmail", "jrc-revisor"],
  legalmail: ["jrc-maestro", "jrc-legalmail", "jrc-juridico", "jrc-revisor"],
  meta: ["jrc-maestro", "jrc-marketing", "jrc-comercial"],
  marketing: ["jrc-maestro", "jrc-marketing", "jrc-revisor"],
  comercial: ["jrc-maestro", "jrc-comercial", "jrc-atendimento"],
  financeiro: ["jrc-maestro", "jrc-financeiro"],
  devops: ["jrc-maestro", "jrc-devops", "jrc-revisor"],
  geral: ["jrc-maestro", "jrc-atendimento", "jrc-revisor"],
};

function inferMeetingDomain(goal, explicitDomain) {
  const explicit = typeof explicitDomain === "string" ? explicitDomain.trim().toLowerCase() : "";
  if (explicit && DOMAIN_AGENT_MAP[explicit]) return explicit;
  const text = typeof goal === "string" ? goal.toLowerCase() : "";
  if (/\bbpc\b|loas|inss|beneficio|document/.test(text)) return "bpc";
  if (/legalmail|prazo|andamento|process|peti|protoc/.test(text)) return "legalmail";
  if (/meta|ads|campanha|criativo|marketing|conteudo|instagram|telegram/.test(text)) return "marketing";
  if (/lead|cliente|comercial|contrato|follow/.test(text)) return "comercial";
  if (/financeiro|cobranca|recebivel|pagamento|honorario/.test(text)) return "financeiro";
  if (/vps|deploy|servidor|bug|codigo|devops|infra|log/.test(text)) return "devops";
  return "geral";
}

function selectMeetingParticipants(domain) {
  const ids = DOMAIN_AGENT_MAP[domain] || DOMAIN_AGENT_MAP.geral;
  return ids
    .map((agentId) => {
      const agent = agentRegistry.get(agentId);
      if (!agent) return null;
      return { agentId: agent.id, name: agent.name, role: agent.role || "" };
    })
    .filter(Boolean);
}

function buildMeetingAgenda(goal, domain) {
  const common = [
    "1. Maestro classifica objetivo, riscos, dependencias e budget.",
    "2. Especialista da area produz plano de execucao interna.",
    "3. Revisor procura falhas, pendencias e pontos que exigem aprovacao humana.",
    "4. Tarefas sao enfileiradas; qualquer ato externo fica em review/pending.",
  ];
  const byDomain = {
    bpc: "Checklist documental, documentos faltantes, minuta/estrategia e conferencia antes de protocolo.",
    legalmail: "Classificacao de prazo/andamento, providencia recomendada, rascunho interno e trava de protocolo.",
    marketing: "Diagnostico de campanha/conteudo, proposta de criativos e pontos que exigem aprovacao OAB/humana.",
    comercial: "Triagem de lead/contrato, briefing, proximo passo interno e trava de contato externo.",
    financeiro: "Resumo financeiro, anomalias, acoes internas e itens que exigem cobranca/aprovacao.",
    devops: "Diagnostico read-only, plano tecnico, riscos, comandos propostos e trava de deploy destrutivo.",
    geral: "Triagem geral, roteamento para area certa e criacao de proximos passos internos.",
  };
  return [byDomain[domain] || byDomain.geral, ...common, `Objetivo: ${goal}`];
}

function startTeamMeeting(input = {}) {
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) throw new Error("Meeting goal is required.");
  const domain = inferMeetingDomain(goal, input.domain);
  const priority = normalizePriority(input.priority || "high");
  const meetingId = `meeting-${todayKey()}-${randomId()}`;
  const createdAt = nowIso();
  const participants = selectMeetingParticipants(domain);
  const agenda = buildMeetingAgenda(goal, domain);
  const sourceEventId = `meeting:${stableTaskKey(`${domain}:${goal}`)}`;
  const existing = meetingState.meetings.find((meeting) => meeting.sourceEventId === sourceEventId);
  if (existing) {
    return { meeting: existing, createdTasks: [] };
  }

  const taskSpecs = [
    {
      title: `Reuniao JRC - plano maestro: ${goal}`,
      assignedAgentId: "jrc-maestro",
      approval: false,
      note: "Maestro deve consolidar objetivo, responsaveis, ordem de execucao, budget e riscos.",
    },
    {
      title: `Especialista ${domain} - executar analise interna: ${goal}`,
      assignedAgentId: (participants.find((item) => item.agentId !== "jrc-maestro" && item.agentId !== "jrc-revisor") || participants[1] || participants[0])?.agentId,
      approval: ["bpc", "legalmail", "prazos", "comercial", "marketing"].includes(domain),
      note: "Especialista entrega artefato interno e lista o que depende de aprovacao humana.",
    },
    {
      title: `Revisor 10/10 - auditar resultado da reuniao: ${goal}`,
      assignedAgentId: "jrc-revisor",
      approval: true,
      note: "Revisor deve procurar lacunas, riscos juridicos/operacionais e bloquear qualquer ato externo.",
    },
  ].filter((spec) => spec.assignedAgentId && agentRegistry.has(spec.assignedAgentId));

  const createdTasks = taskSpecs.map((spec, index) => createOperationalTask({
    title: spec.title,
    description: [
      `Reuniao: ${meetingId}`,
      `Objetivo: ${goal}`,
      `Agenda:\n- ${agenda.join("\n- ")}`,
    ].join("\n\n"),
    status: index === 0 ? "todo" : "blocked",
    source: "playbook",
    sourceEventId: `${sourceEventId}:task:${index + 1}`,
    playbookJobId: meetingId,
    assignedAgentId: spec.assignedAgentId,
    priority,
    domain,
    needsHumanApproval: spec.approval,
    approvalReason: spec.approval
      ? "Reuniao pode gerar providencia sensivel; exigir aprovacao humana antes de qualquer ato externo ou entrega final."
      : "",
    notes: [spec.note],
  }));

  const meeting = {
    id: meetingId,
    sourceEventId,
    goal,
    domain,
    priority,
    status: "planned",
    createdAt,
    updatedAt: createdAt,
    participants,
    agenda,
    taskIds: createdTasks.map((task) => task.id),
    decisions: [
      "Executar apenas trabalho interno/read-only.",
      "Delegar por fila operacional para preservar budget e cooldown.",
      "Manter protocolo, envio, contato externo, cobranca e deploy destrutivo em aprovacao humana.",
    ],
  };
  meetingState = {
    version: 1,
    meetings: [meeting, ...meetingState.meetings].slice(0, 50),
  };
  recordTrace({
    kind: "meeting.start",
    status: "planned",
    meetingId,
    agentId: "jrc-maestro",
    domain,
    riskLevel: inferRiskLevel({ domain, title: goal, approval: { required: createdTasks.some((task) => task.approval?.required) } }),
    message: goal,
  });
  saveMeetingsToDisk();
  return { meeting, createdTasks };
}

function summarizeMeetings() {
  const latest = meetingState.meetings.slice(0, 5);
  return {
    total: meetingState.meetings.length,
    latest,
    maestro: {
      agentId: "jrc-maestro",
      name: agentRegistry.get("jrc-maestro")?.name || "Maestro JRC",
      role: agentRegistry.get("jrc-maestro")?.role || "Coordenacao",
    },
    room: {
      name: "Sala de Reuniao T0",
      pattern: "maestro -> especialista -> revisor -> aprovacao humana",
    },
  };
}

function getEnginePolicyStatus() {
  return {
    defaultMode: "cost_guarded_router",
    rules: [
      { domain: "triagem/resumo/marketing/comercial", preferred: "kimi-api", reason: "volume medio com custo controlado" },
      { domain: "juridico sensivel/peca/recurso", preferred: "claude-cli", reason: "qualidade critica, usar com budget" },
      { domain: "devops/codigo", preferred: "codex-cli", reason: "execucao tecnica em modo controlado/read-only" },
      { domain: "pii/vision/rag/local", preferred: "ollama-local", reason: "privacidade e fallback sem plano cloud" },
    ],
    hardLocks: [
      "Claude/Codex sempre passam por limite diario e cooldown.",
      "Auto-run global depende de JRC_AUTO_RUN_ENABLED=1.",
      "Ato externo exige aprovacao humana mesmo se a tarefa estiver concluida.",
    ],
  };
}

function getMediaOpsStatus() {
  const providers = getMediaProviders();
  const configuredCount = providers.filter((provider) => provider.configured).length;
  const missing = providers.filter((provider) => !provider.configured).map((provider) => provider.id);
  return {
    ok: missing.length === 0,
    configuredCount,
    total: providers.length,
    providers,
    pipeline: [
      { step: "roteiro", owner: "jrc-amy", tool: "Claude/Codex/Kimi", configured: true },
      { step: "voz", owner: "jrc-amy", tool: "ElevenLabs", configured: providers.some((p) => p.id === "elevenlabs" && p.configured) },
      { step: "avatar", owner: "jrc-amy", tool: "HeyGen", configured: false, note: "sem API key local detectada; usar MCP/plano externo quando disponivel" },
      { step: "b-roll", owner: "jrc-marketing", tool: "Fal/Replicate/Higgsfield", configured: providers.some((p) => (p.id === "fal" || p.id === "replicate") && p.configured) },
      { step: "edicao", owner: "jrc-marketing", tool: "Creatomate/Captions/Submagic", configured: providers.some((p) => p.id === "creatomate" && p.configured), note: "Captions/Submagic seguem como ferramenta externa sem key local" },
      { step: "publicacao", owner: "humano", tool: "aprovacao humana", configured: true },
    ],
    budgetPolicy: {
      defaultMode: "approval_first",
      paidGenerationRequiresApproval: true,
      publishRequiresApproval: true,
      highCostVideoRequiresApproval: true,
    },
    jobs: summarizeMediaJobs(),
    budget: getMediaBudgetStatus(),
    recommendedDefault: "ElevenLabs -> HeyGen/MCP -> Creatomate -> Fal/Replicate B-roll, com aprovacao antes de gastar alto ou publicar.",
    missing,
  };
}

loadMeetingsFromDisk();
loadCostModeFromDisk();
loadTracesFromDisk();
loadMediaJobsFromDisk();
loadMediaBudgetFromDisk();

function summarizeOperationalTasks() {
  const tasks = listTasks(false);
  const byStatus = {};
  const byDomain = {};
  const approval = { pending: 0, required: 0 };
  for (const task of tasks) {
    byStatus[task.status] = Number(byStatus[task.status] || 0) + 1;
    byDomain[task.domain] = Number(byDomain[task.domain] || 0) + 1;
    if (task.approval?.required) approval.required += 1;
    if (task.approval?.status === "pending") approval.pending += 1;
  }
  const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
  const next = tasks
    .filter((task) => task.status !== "done")
    .sort((left, right) => {
      const priorityDiff = (priorityRank[left.priority] ?? 9) - (priorityRank[right.priority] ?? 9);
      if (priorityDiff !== 0) return priorityDiff;
      return Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0);
    })
    .slice(0, 8);
  const approvals = tasks
    .filter((task) => task.approval?.status === "pending")
    .sort((left, right) => {
      const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
      const priorityDiff = (priorityRank[left.priority] ?? 9) - (priorityRank[right.priority] ?? 9);
      if (priorityDiff !== 0) return priorityDiff;
      return Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0);
    })
    .slice(0, 12);
  return { total: tasks.length, byStatus, byDomain, approval, next, approvals };
}

function getOpsCadenceStatus() {
  const tasks = listTasks(false);
  const pendingApproval = tasks.filter((task) => task.approval?.status === "pending").slice(0, 5);
  const ready = tasks.filter((task) => task.status === "todo").slice(0, 5);
  const blocked = tasks.filter((task) => task.status === "blocked").slice(0, 5);
  return {
    daily: [
      { label: "09:00", action: "Reuniao T0: prazos, BPC, comercial, marketing, financeiro e DevOps." },
      { label: "09:15", action: "Sincronizar JRC Hub read-only e criar tarefas sem duplicar." },
      { label: "09:30", action: "Rodar no maximo uma tarefa interna por dominio respeitando cooldown." },
      { label: "17:30", action: "Fechar ata, pendentes e bloqueios para Obsidian." },
    ],
    suggestedNext: ready[0] || null,
    approvals: pendingApproval,
    blocked,
    policy: "Nenhuma acao externa sai da fila sem aprovacao humana explicita.",
  };
}

function getTodayPanelStatus() {
  const tasks = listTasks(false);
  const countDomain = (domain) => tasks.filter((task) => task.domain === domain && task.status !== "done").length;
  const countStatus = (status) => tasks.filter((task) => task.status === status).length;
  return {
    summary: [
      { label: "Prazos/LegalMail", value: countDomain("prazos") + countDomain("legalmail") },
      { label: "BPC/LOAS", value: countDomain("bpc") },
      { label: "Marketing/Meta", value: countDomain("marketing") + countDomain("meta") },
      { label: "Comercial", value: countDomain("comercial") },
      { label: "Financeiro", value: countDomain("financeiro") },
      { label: "DevOps", value: countDomain("devops") },
    ],
    workflow: {
      ready: countStatus("todo"),
      running: countStatus("in_progress"),
      blocked: countStatus("blocked"),
      review: countStatus("review"),
      approvals: tasks.filter((task) => task.approval?.status === "pending").length,
    },
    latestMeeting: meetingState.meetings[0] || null,
  };
}

function getRiskPanelStatus(engineUsage = null, hubStatus = null) {
  const tasks = listTasks(false);
  const budget = getBudgetStatus();
  const pendingApprovals = tasks.filter((task) => task.approval?.status === "pending");
  const blockedTasks = tasks.filter((task) => task.status === "blocked");
  const reviewTasks = tasks.filter((task) => task.status === "review");
  const highRiskTasks = tasks.filter((task) => task.riskLevel === "high" || inferRiskLevel(task) === "high");
  const mediaJobs = summarizeMediaJobs();
  const blockedEngines = Array.isArray(engineUsage?.blocked) ? engineUsage.blocked.length : 0;
  const hubFailures = hubStatus?.sources
    ? Object.values(hubStatus.sources).filter((source) => !source?.ok).length
    : hubStatus?.ok === false ? 1 : 0;
  const flags = [];
  if (pendingApprovals.length) flags.push(`${pendingApprovals.length} aprovacao(oes) humana(s) pendente(s)`);
  if (mediaJobs.pendingApproval) flags.push(`${mediaJobs.pendingApproval} aprovacao(oes) de midia pendente(s)`);
  if (blockedTasks.length) flags.push(`${blockedTasks.length} tarefa(s) bloqueada(s)`);
  if (reviewTasks.length) flags.push(`${reviewTasks.length} tarefa(s) em revisao`);
  if (budget.remainingTotal <= 1) flags.push("budget diario baixo");
  if (blockedEngines) flags.push(`${blockedEngines} motor(es) bloqueado(s)`);
  if (hubFailures) flags.push(`${hubFailures} fonte(s) JRC Hub com falha`);
  const level = flags.some((flag) => /aprovacao|bloqueada|budget|motor/.test(flag))
    ? "attention"
    : "normal";
  return {
    level,
    pendingApprovals: pendingApprovals.length,
    mediaApprovals: mediaJobs.pendingApproval,
    blockedTasks: blockedTasks.length,
    reviewTasks: reviewTasks.length,
    highRiskTasks: highRiskTasks.length,
    budgetRemaining: budget.remainingTotal,
    engineBlocked: blockedEngines,
    hubFailures,
    flags,
  };
}

async function runOperationalChain(options = {}, sendEvent) {
  const maxSteps = Math.max(1, Math.min(5, Number(options.maxSteps || 3)));
  const domain = typeof options.domain === "string" ? options.domain.trim() : "";
  const dryRun = options.dryRun === true;
  const planned = [];
  const ran = [];
  for (let index = 0; index < maxSteps; index += 1) {
    const task = findNextRunnableTask({ domain });
    if (!task) return { dryRun, stopped: "no_runnable_task", planned, ran, budget: getBudgetStatus() };
    planned.push(serializeTask(task));
    if (dryRun) continue;
    const result = await runOperationalTask(task.id, sendEvent);
    ran.push(result);
    if (result?.blockedByBudget) return { dryRun, stopped: "budget", planned, ran, budget: getBudgetStatus() };
    if (result?.task?.approval?.required || result?.task?.status === "review") {
      return { dryRun, stopped: "human_approval_required", planned, ran, budget: getBudgetStatus() };
    }
  }
  return { dryRun, stopped: "max_steps", planned, ran, budget: getBudgetStatus() };
}

function buildEndOfDayReport() {
  const ops = {
    budget: getBudgetStatus(),
    tasks: summarizeOperationalTasks(),
    meetings: summarizeMeetings(),
    cadence: getOpsCadenceStatus(),
    today: getTodayPanelStatus(),
    costMode: getCostModeStatus(),
    risk: getRiskPanelStatus(),
    traces: summarizeTraces(5),
    media: getMediaOpsStatus(),
  };
  const lines = [
    `# Hermes Office - Relatorio operacional ${todayKey()}`,
    "",
    "## Resumo",
    `- Tarefas ativas: ${ops.tasks.total}`,
    `- Prontas: ${ops.today.workflow.ready}`,
    `- Bloqueadas: ${ops.today.workflow.blocked}`,
    `- Em revisao: ${ops.today.workflow.review}`,
    `- Aprovacoes pendentes: ${ops.today.workflow.approvals}`,
    `- Reunioes T0 registradas: ${ops.meetings.total}`,
    `- Execucoes internas hoje: ${ops.budget.totalRuns}/${ops.budget.limits.totalDaily}`,
    `- Modo de custo: ${ops.costMode.mode}`,
    `- Risco operacional: ${ops.risk.level} (${ops.risk.flags.join("; ") || "sem alertas"})`,
    `- Midia configurada: ${ops.media.configuredCount}/${ops.media.total}`,
    `- Jobs de midia: ${ops.media.jobs.total} (${ops.media.jobs.pendingApproval} aprovacao/oes)`,
    "",
    "## Por area",
    ...ops.today.summary.map((item) => `- ${item.label}: ${item.value}`),
    "",
    "## Proxima sugerida",
    ops.cadence.suggestedNext
      ? `- ${ops.cadence.suggestedNext.title} (${ops.cadence.suggestedNext.domain}/${ops.cadence.suggestedNext.priority})`
      : "- Nenhuma tarefa pronta.",
    "",
    "## Ultima reuniao",
    ops.meetings.latest[0]
      ? `- ${ops.meetings.latest[0].goal} (${ops.meetings.latest[0].domain})`
      : "- Nenhuma reuniao registrada.",
    "",
    "## Ultimos traces",
    ...(ops.traces.latest.length
      ? ops.traces.latest.map((trace) => `- ${trace.id}: ${trace.kind}/${trace.status} ${trace.taskId || trace.meetingId || ""}`)
      : ["- Nenhum trace registrado."]),
    "",
    "## Media Ops",
    ...ops.media.providers.map((provider) => `- ${provider.label}: ${provider.configured ? "configurado" : "faltando"} (${provider.kind})`),
    `- Preparacoes de midia hoje: ${ops.media.budget.preparedRuns}/${ops.media.budget.limits.preparedDaily}`,
    ...ops.media.jobs.latest.slice(0, 5).map((job) => `- Job ${job.id}: ${job.status} / ${job.kind} / ${job.providerId}`),
    "",
    "## Safety",
    "- Auto-run global permanece conforme .env.",
    "- Protocolo, envio, cobranca, contato externo e deploy destrutivo exigem aprovacao humana explicita.",
    "",
  ];
  return lines.join("\n");
}

function writeEndOfDayReport(options = {}) {
  const report = buildEndOfDayReport();
  const dryRun = options.dryRun === true;
  const filePath = path.join(OBSIDIAN_VAULT_DIR, "02 - Escritorio", "Sessoes", `Hermes Office Relatorio ${todayKey()}.md`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, report, "utf8");
  }
  return { dryRun, filePath, report };
}

async function getOperationsStatus() {
  const [engineUsage, hubStatus] = await Promise.all([
    fetchEngineUsage(),
    (async () => {
      try {
        const snapshot = await getJrcHubSnapshot();
        return {
          ok: true,
          baseUrl: JRC_HUB_BASE_URL,
          readOnlyKeyConfigured: Boolean(JRC_HUB_MCP_READONLY_KEY),
          sources: Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, {
            ok: Boolean(value?.ok),
            path: value?.path,
            error: value?.error,
          }])),
        };
      } catch (error) {
        return { ok: false, error: sanitizeErrorMessage(error) };
      }
    })(),
  ]);
  return {
    mode: getOpsModeStatus(),
    costMode: getCostModeStatus(),
    budget: getBudgetStatus(),
    engines: engineUsage,
    enginePolicy: getEnginePolicyStatus(),
    tasks: summarizeOperationalTasks(),
    meetings: summarizeMeetings(),
    cadence: getOpsCadenceStatus(),
    today: getTodayPanelStatus(),
    risk: getRiskPanelStatus(engineUsage, hubStatus),
    traces: summarizeTraces(12),
    media: getMediaOpsStatus(),
    jrcHub: hubStatus,
    safety: {
      externalActionsLocked: true,
      forbiddenWithoutApproval: [
        "protocolar",
        "enviar peticao",
        "contatar terceiro",
        "cobrar cliente",
        "deploy destrutivo",
      ],
    },
    updatedAtMs: Date.now(),
  };
}

loadOpsModeFromDisk();

const TASK_STATUSES = new Set(["todo", "in_progress", "blocked", "review", "done"]);
const TASK_SOURCES = new Set(["openclaw_event", "claw3d_manual", "playbook", "fallback_inferred"]);
const TASK_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const APPROVAL_STATUSES = new Set(["not_required", "pending", "approved", "rejected"]);
const JRC_HUB_READONLY_PATHS = [
  "/api/health",
  "/api/dashboard/cockpit-execucao",
  "/api/dashboard/saude",
  "/api/dashboard/rotina-dia",
  "/api/dashboard/visao-geral",
  "/api/automacoes-juridicas/contadores",
  "/api/automacoes-juridicas/diagnostico",
  "/api/automacoes-juridicas/job-runs/recent",
  "/api/automacoes-juridicas/hoje",
  "/api/inbox/resumo",
  "/api/inbox/fila-agentes-resumo",
  "/api/inbox/itens",
  "/api/inbox/count",
  "/api/processos/dashboard/criticos",
  "/api/processos/andamentos/nao-vinculados",
  "/api/processos/anomalias",
  "/api/clientes",
  "/api/meta/cockpit",
  "/api/central/ia-comercial-diagnostico",
  "/api/comercial/stats",
  "/api/comercial/leads",
];

const JRC_PLAYBOOKS = [
  {
    id: "bpc-protocolo-seguro",
    name: "BPC/LOAS - pacote seguro para protocolo",
    domain: "bpc",
    owner: "jrc-bpc",
    description: "Organiza documentos, detecta faltantes, gera minuta e manda para revisao antes de qualquer ato externo.",
    steps: [
      { title: "Conferir documentos BPC/LOAS", assignedAgentId: "jrc-bpc" },
      { title: "Gerar minuta/checklist BPC", assignedAgentId: "jrc-bpc" },
      { title: "Revisao juridica BPC 10/10", assignedAgentId: "jrc-revisor", needsHumanApproval: true },
      { title: "Pacote pronto para protocolo manual", assignedAgentId: "jrc-legalmail", needsHumanApproval: true },
    ],
  },
  {
    id: "prazo-legalmail-triagem",
    name: "Prazos/LegalMail - triagem e minuta",
    domain: "prazos",
    owner: "jrc-legalmail",
    description: "Classifica andamento, estima prazo, cria tarefa de peca e pede revisao.",
    steps: [
      { title: "Classificar andamento e risco", assignedAgentId: "jrc-legalmail" },
      { title: "Preparar estrategia/minuta", assignedAgentId: "jrc-juridico" },
      { title: "Revisao critica antes da entrega", assignedAgentId: "jrc-revisor", needsHumanApproval: true },
    ],
  },
  {
    id: "meta-ads-otimizacao",
    name: "Meta Ads - diagnostico e proximos testes",
    domain: "meta",
    owner: "jrc-marketing",
    description: "Analisa resultados, sugere pausa/duplicacao/testes e cria criativos/copy para aprovacao.",
    steps: [
      { title: "Coletar metricas Meta Ads", assignedAgentId: "jrc-marketing" },
      { title: "Diagnosticar campanha e criativos", assignedAgentId: "jrc-marketing" },
      { title: "Preparar novas copies/angulos", assignedAgentId: "jrc-marketing", needsHumanApproval: true },
    ],
  },
  {
    id: "devops-saude-vps",
    name: "DevOps - saude VPS/JRC Hub",
    domain: "devops",
    owner: "jrc-devops",
    description: "Verifica servicos, logs, fila, quotas e riscos sem alterar arquivos por padrao.",
    steps: [
      { title: "Checar saude dos servicos locais/VPS", assignedAgentId: "jrc-devops" },
      { title: "Mapear erros e gargalos", assignedAgentId: "jrc-devops" },
      { title: "Propor plano de correcao seguro", assignedAgentId: "jrc-devops", needsHumanApproval: true },
    ],
  },
];

function loadTasksFromDisk() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return;
    const raw = fs.readFileSync(TASKS_FILE, "utf8");
    const data = JSON.parse(raw);
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    for (const task of tasks) {
      if (!task || typeof task.id !== "string" || typeof task.title !== "string") continue;
      operationalTasks.set(task.id, task);
    }
  } catch (error) {
    console.warn("[hermes-adapter] Failed to load tasks:", sanitizeErrorMessage(error));
  }
}

function saveTasksToDisk() {
  clearTimeout(tasksPersistDebounceTimer);
  tasksPersistDebounceTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
      fs.writeFileSync(
        TASKS_FILE,
        JSON.stringify({ version: 1, tasks: [...operationalTasks.values()] }, null, 2),
        "utf8",
      );
    } catch (error) {
      console.warn("[hermes-adapter] Failed to save tasks:", sanitizeErrorMessage(error));
    }
  }, 150);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeTaskStatus(status) {
  return TASK_STATUSES.has(status) ? status : "todo";
}

function normalizeTaskSource(source) {
  return TASK_SOURCES.has(source) ? source : "claw3d_manual";
}

function normalizePriority(priority) {
  return TASK_PRIORITIES.has(priority) ? priority : "normal";
}

function normalizeApprovalStatus(status, needsHumanApproval) {
  if (APPROVAL_STATUSES.has(status)) return status;
  return needsHumanApproval ? "pending" : "not_required";
}

function serializeTask(task) {
  return {
    ...task,
    archived: Boolean(task.archived),
    isArchived: Boolean(task.archived),
    isInferred: task.source === "fallback_inferred",
  };
}

function listTasks(includeArchived = false) {
  return [...operationalTasks.values()]
    .filter((task) => includeArchived || !task.archived)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(serializeTask);
}

function emitTaskEvent(kind, task) {
  broadcastEvent({
    type: "event",
    event: "task",
    payload: {
      kind,
      taskId: task.id,
      task: serializeTask(task),
      occurredAt: nowIso(),
      sourceEventId: `task-${task.id}-${Date.now()}`,
    },
  });
}

function createOperationalTask(input = {}) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new Error("Task title is required");
  if (input.sourceEventId) {
    const existing = [...operationalTasks.values()].find((task) => task.sourceEventId === input.sourceEventId);
    if (existing) return serializeTask(existing);
  }
  const createdAt = nowIso();
  const needsHumanApproval = Boolean(input.needsHumanApproval);
  const task = {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : `jrc-task-${randomId()}`,
    title,
    description: typeof input.description === "string" ? input.description.trim() : "",
    status: normalizeTaskStatus(input.status),
    source: normalizeTaskSource(input.source),
    sourceEventId: typeof input.sourceEventId === "string" ? input.sourceEventId : null,
    assignedAgentId: typeof input.assignedAgentId === "string" && input.assignedAgentId.trim()
      ? input.assignedAgentId.trim()
      : null,
    createdAt,
    updatedAt: createdAt,
    playbookJobId: typeof input.playbookJobId === "string" ? input.playbookJobId : null,
    runId: typeof input.runId === "string" ? input.runId : null,
    channel: typeof input.channel === "string" ? input.channel : null,
    externalThreadId: typeof input.externalThreadId === "string" ? input.externalThreadId : null,
    lastActivityAt: createdAt,
    notes: Array.isArray(input.notes) ? input.notes.map(String).filter(Boolean) : [],
    archived: false,
    priority: normalizePriority(input.priority),
    domain: typeof input.domain === "string" && input.domain.trim() ? input.domain.trim() : "geral",
    traceId: typeof input.traceId === "string" ? input.traceId : null,
    riskLevel: typeof input.riskLevel === "string" ? input.riskLevel : null,
    handoff: input.handoff && typeof input.handoff === "object" ? input.handoff : null,
    qualityScore: input.qualityScore && typeof input.qualityScore === "object" ? input.qualityScore : null,
    approval: {
      required: needsHumanApproval,
      status: normalizeApprovalStatus(input.approvalStatus, needsHumanApproval),
      reason: typeof input.approvalReason === "string" ? input.approvalReason.trim() : "",
      resolvedAt: null,
      resolvedBy: null,
    },
  };
  operationalTasks.set(task.id, task);
  saveTasksToDisk();
  emitTaskEvent("task_created", task);
  return serializeTask(task);
}

function hasTaskForSource(sourceEventId) {
  return Boolean(sourceEventId && [...operationalTasks.values()].some((task) => task.sourceEventId === sourceEventId));
}

function updateOperationalTask(id, patch = {}) {
  const task = operationalTasks.get(id);
  if (!task) throw new Error(`Task ${id} not found`);
  const updated = { ...task, approval: { ...(task.approval || {}) } };
  if (typeof patch.title === "string") updated.title = patch.title.trim();
  if (typeof patch.description === "string") updated.description = patch.description.trim();
  if (typeof patch.status === "string") updated.status = normalizeTaskStatus(patch.status);
  if (patch.assignedAgentId !== undefined) {
    updated.assignedAgentId = typeof patch.assignedAgentId === "string" && patch.assignedAgentId.trim()
      ? patch.assignedAgentId.trim()
      : null;
  }
  if (typeof patch.playbookJobId === "string" || patch.playbookJobId === null) updated.playbookJobId = patch.playbookJobId;
  if (typeof patch.runId === "string" || patch.runId === null) updated.runId = patch.runId;
  if (typeof patch.channel === "string" || patch.channel === null) updated.channel = patch.channel;
  if (typeof patch.externalThreadId === "string" || patch.externalThreadId === null) updated.externalThreadId = patch.externalThreadId;
  if (Array.isArray(patch.notes)) updated.notes = patch.notes.map(String).filter(Boolean);
  if (typeof patch.note === "string" && patch.note.trim()) updated.notes = [...(updated.notes || []), patch.note.trim()];
  if (typeof patch.priority === "string") updated.priority = normalizePriority(patch.priority);
  if (typeof patch.domain === "string" && patch.domain.trim()) updated.domain = patch.domain.trim();
  if (typeof patch.source === "string") updated.source = normalizeTaskSource(patch.source);
  if (typeof patch.archived === "boolean") updated.archived = patch.archived;
  if (typeof patch.traceId === "string" || patch.traceId === null) updated.traceId = patch.traceId;
  if (typeof patch.riskLevel === "string" || patch.riskLevel === null) updated.riskLevel = patch.riskLevel;
  if (patch.handoff && typeof patch.handoff === "object") updated.handoff = patch.handoff;
  if (patch.qualityScore && typeof patch.qualityScore === "object") updated.qualityScore = patch.qualityScore;
  if (typeof patch.needsHumanApproval === "boolean") {
    updated.approval.required = patch.needsHumanApproval;
    updated.approval.status = normalizeApprovalStatus(patch.approvalStatus, patch.needsHumanApproval);
  }
  if (typeof patch.approvalStatus === "string") {
    updated.approval.status = normalizeApprovalStatus(patch.approvalStatus, updated.approval.required);
    if (updated.approval.status === "approved" || updated.approval.status === "rejected") {
      updated.approval.resolvedAt = nowIso();
      updated.approval.resolvedBy = "human";
      recordTrace({
        kind: "approval.resolve",
        status: updated.approval.status,
        taskId: updated.id,
        agentId: updated.assignedAgentId,
        domain: updated.domain,
        riskLevel: updated.riskLevel || inferRiskLevel(updated),
        handoff: updated.handoff || buildHandoffContract(updated),
        message: `Aprovacao humana marcada como ${updated.approval.status}.`,
      });
    }
  }
  if (typeof patch.approvalReason === "string") updated.approval.reason = patch.approvalReason.trim();
  updated.updatedAt = nowIso();
  updated.lastActivityAt = updated.updatedAt;
  operationalTasks.set(id, updated);
  saveTasksToDisk();
  emitTaskEvent("task_updated", updated);
  return serializeTask(updated);
}

function deleteOperationalTask(id) {
  const task = operationalTasks.get(id);
  if (!task) return false;
  operationalTasks.delete(id);
  saveTasksToDisk();
  emitTaskEvent("task_deleted", task);
  return true;
}

function findNextRunnableTask(filters = {}) {
  const domain = typeof filters.domain === "string" ? filters.domain.trim() : "";
  const agentId = typeof filters.agentId === "string" ? filters.agentId.trim() : "";
  const priorityRank = { urgent: 4, high: 3, normal: 2, low: 1 };
  return [...operationalTasks.values()]
    .filter((task) => !task.archived && task.status === "todo")
    .filter((task) => !domain || task.domain === domain)
    .filter((task) => !agentId || task.assignedAgentId === agentId)
    .sort((a, b) => {
      const priorityDiff = (priorityRank[b.priority] || 0) - (priorityRank[a.priority] || 0);
      if (priorityDiff) return priorityDiff;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    })[0] || null;
}

function unblockNextPlaybookTask(task) {
  if (!task.playbookJobId) return null;
  const next = [...operationalTasks.values()]
    .filter((candidate) => candidate.playbookJobId === task.playbookJobId && candidate.status === "blocked")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  if (!next) return null;
  return updateOperationalTask(next.id, {
    status: "todo",
    note: `Desbloqueada automaticamente apos conclusao de ${task.title}.`,
  });
}

function startPlaybook(playbookId, input = {}) {
  const playbook = JRC_PLAYBOOKS.find((item) => item.id === playbookId);
  if (!playbook) throw new Error(`Playbook ${playbookId} not found`);
  const jobId = `playbook-${playbook.id}-${randomId()}`;
  const caseLabel = typeof input.caseLabel === "string" && input.caseLabel.trim()
    ? ` - ${input.caseLabel.trim()}`
    : "";
  const context = typeof input.context === "string" ? input.context.trim() : "";
  const tasks = playbook.steps.map((step, index) => createOperationalTask({
    title: `${index + 1}. ${step.title}${caseLabel}`,
    description: [playbook.description, context].filter(Boolean).join("\n\n"),
    status: index === 0 ? "todo" : "blocked",
    source: "playbook",
    playbookJobId: jobId,
    assignedAgentId: step.assignedAgentId || playbook.owner,
    domain: playbook.domain,
    priority: input.priority || "high",
    needsHumanApproval: Boolean(step.needsHumanApproval),
    approvalReason: step.needsHumanApproval
      ? "Etapa exige aprovacao humana antes de ato externo ou entrega final."
      : "",
    notes: [`Playbook: ${playbook.name}`],
  }));
  return { jobId, playbook, tasks };
}

loadTasksFromDisk();

function isAllowedJrcHubPath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  if (pathname.includes("/protocolar") || pathname.includes("/enviar") || pathname.includes("/cobrar")) return false;
  return JRC_HUB_READONLY_PATHS.some((allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`));
}

function jrcHubGet(pathname, query = {}) {
  return new Promise((resolve, reject) => {
    if (!isAllowedJrcHubPath(pathname)) {
      reject(new Error(`JRC Hub path blocked by read-only allowlist: ${pathname}`));
      return;
    }
    const url = new URL(`${JRC_HUB_BASE_URL}${pathname}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = { Accept: "application/json" };
    if (JRC_HUB_MCP_READONLY_KEY) headers["X-MCP-Read-Only-Key"] = JRC_HUB_MCP_READONLY_KEY;
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, { method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = raw;
        try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep raw */ }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`JRC Hub HTTP ${res.statusCode} on ${pathname}: ${String(raw).slice(0, 240)}`));
          return;
        }
        resolve({ statusCode: res.statusCode || 0, body });
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error(`JRC Hub request timed out: ${pathname}`)));
    req.end();
  });
}

async function getJrcHubSnapshot() {
  const calls = [
    ["health", "/api/health", {}],
    ["cockpit", "/api/dashboard/cockpit-execucao", {}],
    ["inbox", "/api/inbox/resumo", {}],
    ["filaAgentes", "/api/inbox/fila-agentes-resumo", {}],
    ["automacoes", "/api/automacoes-juridicas/contadores", {}],
    ["diagnostico", "/api/automacoes-juridicas/diagnostico", {}],
    ["processosCriticos", "/api/processos/dashboard/criticos", {}],
    ["anomalias", "/api/processos/anomalias", {}],
    ["metaCockpit", "/api/meta/cockpit", { date_preset: "yesterday" }],
    ["centralComercial", "/api/central/ia-comercial-diagnostico", { dias: 30 }],
    ["comercialStats", "/api/comercial/stats", {}],
    ["comercialLeads", "/api/comercial/leads", { per_page: 25 }],
  ];
  const entries = await Promise.all(calls.map(async ([key, pathname, query]) => {
    try {
      const result = await jrcHubGet(pathname, query);
      return [key, { ok: true, path: pathname, body: result.body }];
    } catch (error) {
      return [key, { ok: false, path: pathname, error: sanitizeErrorMessage(error) }];
    }
  }));
  return Object.fromEntries(entries);
}

function createTriggeredTask(created, input) {
  if (hasTaskForSource(input.sourceEventId)) return null;
  const task = createOperationalTask({
    ...input,
    source: "openclaw_event",
  });
  created.push(task);
  return task;
}

async function syncJrcHubTriggers() {
  const snapshot = await getJrcHubSnapshot();
  const created = [];
  const cockpit = snapshot.cockpit?.body || {};
  const juridico = cockpit.juridico || {};
  if (Number(juridico.hoje || 0) > 0) {
    createTriggeredTask(created, {
      title: `Prazos de hoje no JRC Hub: ${juridico.hoje}`,
      description: `Cockpit JRC Hub aponta ${juridico.hoje} prazos hoje e ${juridico.atrasados || 0} atrasados. Triar, priorizar e preparar proximas acoes sem consultar LegalMail diretamente.`,
      status: "todo",
      assignedAgentId: "jrc-legalmail",
      priority: "urgent",
      domain: "prazos",
      sourceEventId: `jrc-hub:cockpit:prazos-hoje:${new Date().toISOString().slice(0, 10)}`,
      needsHumanApproval: true,
      approvalReason: "Prazos e atos processuais exigem revisao humana antes de baixa, protocolo ou envio.",
      notes: ["Fonte: /api/dashboard/cockpit-execucao"],
    });
  }
  if (Number(juridico.atrasados || 0) > 0) {
    createTriggeredTask(created, {
      title: `Prazos/itens atrasados no JRC Hub: ${juridico.atrasados}`,
      description: "Criar plano de ataque para itens atrasados, separando risco real, duplicidade, baixa indevida e pendencia documental.",
      status: "todo",
      assignedAgentId: "jrc-revisor",
      priority: "urgent",
      domain: "prazos",
      sourceEventId: `jrc-hub:cockpit:atrasados:${new Date().toISOString().slice(0, 10)}`,
      needsHumanApproval: true,
      approvalReason: "Ajustes em prazo e baixa operacional dependem de conferencia humana.",
      notes: ["Fonte: /api/dashboard/cockpit-execucao"],
    });
  }

  const inbox = snapshot.inbox?.body || {};
  if (Number(inbox.total_prazo_vencido || 0) > 0) {
    createTriggeredTask(created, {
      title: `Inbox com prazos vencidos: ${inbox.total_prazo_vencido}`,
      description: `Inbox operacional informa ${inbox.total_com_prazo || 0} itens com prazo e ${inbox.total_prazo_vencido} vencidos. Gerar triagem por risco e proximas acoes internas.`,
      status: "todo",
      assignedAgentId: "jrc-legalmail",
      priority: "urgent",
      domain: "legalmail",
      sourceEventId: `jrc-hub:inbox:prazos-vencidos:${new Date().toISOString().slice(0, 10)}`,
      needsHumanApproval: true,
      approvalReason: "Qualquer ato externo no processo exige aprovacao humana.",
      notes: ["Fonte: /api/inbox/resumo"],
    });
  }

  const automacoes = snapshot.automacoes?.body || {};
  if (Number(automacoes.urgentes || 0) > 0) {
    createTriggeredTask(created, {
      title: `Automações jurídicas urgentes: ${automacoes.urgentes}`,
      description: `Contadores indicam ${automacoes.urgentes} urgentes, ${automacoes.bloqueados || 0} bloqueados e ${automacoes.aguardando_revisao || 0} aguardando revisao.`,
      status: "todo",
      assignedAgentId: "jrc-juridico",
      priority: "urgent",
      domain: "prazos",
      sourceEventId: `jrc-hub:automacoes:urgentes:${new Date().toISOString().slice(0, 10)}`,
      needsHumanApproval: true,
      approvalReason: "Peças e revisões jurídicas precisam de conferência final.",
      notes: ["Fonte: /api/automacoes-juridicas/contadores"],
    });
  }
  if (Number(automacoes.rascunho_pronto || 0) > 0) {
    createTriggeredTask(created, {
      title: `Rascunhos prontos para revisão: ${automacoes.rascunho_pronto}`,
      description: "Revisar rascunhos prontos, procurar placeholders, riscos, anexos faltantes e liberar apenas como pronto para avaliação humana.",
      status: "todo",
      assignedAgentId: "jrc-revisor",
      priority: "high",
      domain: "prazos",
      sourceEventId: `jrc-hub:automacoes:rascunho-pronto:${new Date().toISOString().slice(0, 10)}`,
      needsHumanApproval: true,
      approvalReason: "Revisão final antes de uso/protocolo.",
      notes: ["Fonte: /api/automacoes-juridicas/contadores"],
    });
  }

  const fila = snapshot.filaAgentes?.body || {};
  if (Number(fila.pendentes || 0) > 20 || Number(fila.erros_24h || 0) > 0) {
    createTriggeredTask(created, {
      title: `Fila de agentes JRC Hub requer atenção: ${fila.pendentes || 0} pendentes`,
      description: `Fila informa ${fila.pendentes || 0} pendentes, ${fila.rodando || 0} rodando, ${fila.erros_24h || 0} erros 24h e ${fila.cards_bloqueados_integra || 0} bloqueados por integra.`,
      status: "todo",
      assignedAgentId: "jrc-devops",
      priority: Number(fila.erros_24h || 0) > 0 ? "urgent" : "high",
      domain: "devops",
      sourceEventId: `jrc-hub:fila-agentes:${new Date().toISOString().slice(0, 10)}`,
      needsHumanApproval: false,
      notes: ["Fonte: /api/inbox/fila-agentes-resumo"],
    });
  }

  const processosCriticos = Array.isArray(snapshot.processosCriticos?.body) ? snapshot.processosCriticos.body : [];
  for (const processo of processosCriticos.slice(0, 5)) {
    const processoId = processo.id || processo.processo_id || processo.cnj;
    if (!processoId) continue;
    createTriggeredTask(created, {
      title: `Processo crítico parado: ${processo.cnj || processoId}`,
      description: `Cliente: ${processo.cliente || "n/d"}. Dias parado: ${processo.dias_parado || "n/d"}. Prazos vencidos: ${processo.prazos_vencidos || 0}. Preparar leitura operacional e proxima acao interna.`,
      status: "todo",
      assignedAgentId: "jrc-juridico",
      priority: "high",
      domain: "prazos",
      sourceEventId: `jrc-hub:processo-critico:${processoId}`,
      needsHumanApproval: true,
      approvalReason: "Definição de providência processual exige validação humana.",
      notes: ["Fonte: /api/processos/dashboard/criticos"],
    });
  }

  const meta = snapshot.metaCockpit?.body || {};
  const metaResumo = meta.resumo || {};
  if (meta.ok && Number(metaResumo.spend || 0) > 0) {
    const campaigns = Array.isArray(meta.campanhas) ? meta.campanhas : [];
    const worstCpl = campaigns
      .filter((campaign) => Number.isFinite(Number(campaign.cpl)))
      .sort((a, b) => Number(b.cpl) - Number(a.cpl))[0];
    createTriggeredTask(created, {
      title: `Meta Ads: revisar performance de ontem - R$ ${Number(metaResumo.spend || 0).toFixed(2)}`,
      description: [
        `Periodo: ${meta.periodo || "yesterday"}. Spend: R$ ${Number(metaResumo.spend || 0).toFixed(2)}. Leads/conversas: ${metaResumo.leads || 0}. CPL: R$ ${Number(metaResumo.cpl || 0).toFixed(2)}. Campanhas ativas: ${meta.campanhas_ativas || 0}.`,
        worstCpl ? `Campanha com maior CPL na amostra: ${worstCpl.campaign_name || worstCpl.campaign_id} (CPL R$ ${Number(worstCpl.cpl || 0).toFixed(2)}).` : "",
        "Gerar diagnóstico e sugestões de teste sem pausar, editar ou criar campanha automaticamente.",
      ].filter(Boolean).join("\n"),
      status: "todo",
      assignedAgentId: "jrc-marketing",
      priority: Number(metaResumo.cpl || 0) > Number(meta.media_7d?.cpl || 999) * 1.25 ? "urgent" : "high",
      domain: "meta",
      sourceEventId: `jrc-hub:meta:cockpit:${new Date().toISOString().slice(0, 10)}`,
      needsHumanApproval: true,
      approvalReason: "Mudanças de campanha, orçamento ou criativo exigem aprovação humana.",
      notes: ["Fonte: /api/meta/cockpit"],
    });
  }

  const central = snapshot.centralComercial?.body || {};
  const centralSummary = central.summary || {};
  if (central.ok && Array.isArray(central.alerts)) {
    for (const alert of central.alerts.slice(0, 4)) {
      const tone = alert.tone || "warning";
      createTriggeredTask(created, {
        title: `Atendimento/Comercial: ${alert.title || "alerta do funil"}`,
        description: [
          alert.detail || "",
          `Resumo 30d: assinados ${centralSummary.signed || 0}, falhas ${centralSummary.failed || 0}, em andamento ${centralSummary.in_progress || 0}, abandonados ${centralSummary.abandoned || 0}, perdidos ${centralSummary.lost || 0}, p90 mensagens ${centralSummary.msg_p90 || "n/d"}.`,
          "Preparar plano de recuperação/diagnóstico. Não contatar lead, enviar WhatsApp ou acionar ZapSign sem aprovação humana.",
        ].filter(Boolean).join("\n"),
        status: "todo",
        assignedAgentId: tone === "danger" ? "jrc-comercial" : "jrc-atendimento",
        priority: tone === "danger" ? "urgent" : "high",
        domain: "comercial",
        sourceEventId: `jrc-hub:central:${String(alert.title || "alerta").toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${new Date().toISOString().slice(0, 10)}`,
        needsHumanApproval: true,
        approvalReason: "Contato externo, cobrança, follow-up e envio de link dependem de aprovação humana.",
        notes: ["Fonte: /api/central/ia-comercial-diagnostico"],
      });
    }
  }

  const comercial = snapshot.comercialStats?.body || {};
  if (Number(comercial.leads_parados || 0) > 0) {
    createTriggeredTask(created, {
      title: `Comercial: ${comercial.leads_parados} leads parados`,
      description: `Stats comerciais indicam ${comercial.total_leads || 0} leads totais, ${comercial.leads_mes || 0} no mes e taxa de conversao ${comercial.taxa_conversao || 0}%. Preparar priorizacao e scripts revisaveis.`,
      status: "todo",
      assignedAgentId: "jrc-comercial",
      priority: "high",
      domain: "comercial",
      sourceEventId: `jrc-hub:comercial:leads-parados:${new Date().toISOString().slice(0, 10)}`,
      needsHumanApproval: true,
      approvalReason: "Follow-up com lead exige aprovação humana.",
      notes: ["Fonte: /api/comercial/stats"],
    });
  }

  if (snapshot.health?.ok && !JRC_HUB_MCP_READONLY_KEY) {
    createTriggeredTask(created, {
      title: "Configurar chave read-only do JRC Hub no Hermes Office",
      description: "Health do Hub responde, mas falta JRC_HUB_MCP_READONLY_KEY no ambiente local do Hermes Office.",
      status: "todo",
      assignedAgentId: "jrc-devops",
      priority: "high",
      domain: "devops",
      sourceEventId: "jrc-hub:config:readonly-key-missing",
      needsHumanApproval: false,
    });
  }

  return { snapshot, created };
}

function ensureDefaultCronJobs() {
  if (!cronJobs.has("jrc-hub-trigger-sync")) {
    cronJobs.set("jrc-hub-trigger-sync", {
      id: "jrc-hub-trigger-sync",
      name: "JRC Hub -> fila operacional",
      agentId: AGENT_ID,
      sessionKey: MAIN_SESSION_KEY,
      description: "Lê JRC Hub em modo read-only e cria tarefas internas para prazos, inbox, automações e saúde.",
      enabled: true,
      deleteAfterRun: false,
      updatedAtMs: Date.now(),
      schedule: { kind: "every", everyMs: Math.max(5, JRC_HUB_TRIGGER_INTERVAL_MIN) * 60 * 1000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "jrcHubSync" },
      state: {},
    });
  }
}

async function runCronJob(jobId) {
  const job = cronJobs.get(jobId);
  if (!job) return { ok: false };
  cronJobs.set(jobId, { ...job, state: { ...(job.state || {}), runningAtMs: Date.now() } });
  try {
    let summary = { ok: true };
    if (job.payload?.kind === "jrcHubSync") {
      const result = await syncJrcHubTriggers();
      summary = {
        ok: true,
        createdCount: result.created.length,
        sources: Object.fromEntries(Object.entries(result.snapshot).map(([key, value]) => [key, Boolean(value?.ok)])),
      };
    }
    const current = cronJobs.get(jobId);
    if (current) {
      const done = {
        ...current,
        state: {
          ...(current.state || {}),
          runningAtMs: undefined,
          lastRunAtMs: Date.now(),
          lastStatus: "ok",
          lastSummary: summary,
        },
      };
      cronJobs.set(jobId, done);
      broadcastEvent({ type: "event", event: "cron", payload: { action: "finished", jobId, status: "ok", summary } });
    }
    return { ok: true, ran: true, summary };
  } catch (error) {
    const current = cronJobs.get(jobId);
    const message = sanitizeErrorMessage(error);
    if (current) {
      cronJobs.set(jobId, {
        ...current,
        state: {
          ...(current.state || {}),
          runningAtMs: undefined,
          lastRunAtMs: Date.now(),
          lastStatus: "error",
          lastError: message,
        },
      });
    }
    broadcastEvent({ type: "event", event: "cron", payload: { action: "finished", jobId, status: "error", error: message } });
    return { ok: false, error: message };
  }
}

function startJrcHubTriggerTimer() {
  if (jrcHubTriggerTimer || !Number.isFinite(JRC_HUB_TRIGGER_INTERVAL_MIN) || JRC_HUB_TRIGGER_INTERVAL_MIN <= 0) return;
  const intervalMs = Math.max(5, JRC_HUB_TRIGGER_INTERVAL_MIN) * 60 * 1000;
  jrcHubTriggerTimer = setInterval(() => {
    void runCronJob("jrc-hub-trigger-sync");
  }, intervalMs);
}

ensureDefaultCronJobs();
startAdapter();
