import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const HOME = os.homedir();
const TASKS_FILE = path.join(HOME, ".hermes", "jrc-operational-tasks.json");
const BUDGET_FILE = path.join(HOME, ".hermes", "jrc-agent-budget.json");
const OPS_MODE_FILE = path.join(HOME, ".hermes", "jrc-office-ops-mode.json");
const COST_MODE_FILE = path.join(HOME, ".hermes", "jrc-office-cost-mode.json");
const MEETINGS_FILE = path.join(HOME, ".hermes", "jrc-office-meetings.json");
const TRACES_FILE = path.join(HOME, ".hermes", "jrc-office-traces.json");
const MEDIA_JOBS_FILE = path.join(HOME, ".hermes", "jrc-media-jobs.json");
const MEDIA_BUDGET_FILE = path.join(HOME, ".hermes", "jrc-media-budget.json");
const SECOND_BRAIN_FILE = path.join(HOME, ".hermes", "jrc-second-brain-inbox.json");
const OBSIDIAN_VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR || path.join(HOME, "Documents", "Obsidian Vault");

const HERMES_API_URL = (process.env.HERMES_API_URL || "http://127.0.0.1:18642").replace(/\/$/, "");
const JRC_TASK_RUN_DAILY_LIMIT = Number.parseInt(process.env.JRC_TASK_RUN_DAILY_LIMIT || "6", 10);
const JRC_TASK_RUN_DOMAIN_DAILY_LIMIT = Number.parseInt(process.env.JRC_TASK_RUN_DOMAIN_DAILY_LIMIT || "2", 10);
const JRC_TASK_RUN_COOLDOWN_MS = Number.parseInt(process.env.JRC_TASK_RUN_COOLDOWN_MS || "180000", 10);
const JRC_MEDIA_PREP_DAILY_LIMIT = Number.parseInt(process.env.JRC_MEDIA_PREP_DAILY_LIMIT || "12", 10);
const JRC_AUTO_RUN_ENABLED = process.env.JRC_AUTO_RUN_ENABLED === "1";
const JRC_HUB_BASE_URL = (process.env.JRC_HUB_BASE_URL || "http://127.0.0.1:8150").replace(/\/$/, "");
const JRC_HUB_MCP_READONLY_KEY = process.env.JRC_HUB_MCP_READONLY_KEY || "";

const OPS_MODES = new Set(["manual", "assisted", "auto_safe"]);
const COST_MODES = new Set(["economy", "balanced", "critical"]);

type JsonRecord = Record<string, unknown>;

const todayKey = () => new Date().toISOString().slice(0, 10);

const readJsonFile = (filePath: string): JsonRecord | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
};

const writeJsonFile = (filePath: string, payload: JsonRecord) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
};

const normalizeMode = (value: unknown) =>
  typeof value === "string" && OPS_MODES.has(value) ? value : "assisted";

const normalizeCostMode = (value: unknown) =>
  typeof value === "string" && COST_MODES.has(value) ? value : "balanced";

const loadOpsMode = () => {
  const parsed = readJsonFile(OPS_MODE_FILE);
  return {
    mode: normalizeMode(parsed?.mode),
    updatedAtMs: typeof parsed?.updatedAtMs === "number" ? parsed.updatedAtMs : 0,
    updatedBy: typeof parsed?.updatedBy === "string" ? parsed.updatedBy : "system",
  };
};

const buildOpsModeStatus = () => ({
  ...loadOpsMode(),
  labels: {
    manual: "Manual",
    assisted: "Assistido",
    auto_safe: "Automatico seguro",
  },
  externalActionsLocked: true,
  autoRunEnabled: JRC_AUTO_RUN_ENABLED,
  note:
    loadOpsMode().mode === "auto_safe" && !JRC_AUTO_RUN_ENABLED
      ? "Modo visual em automatico seguro, mas auto-run global segue desligado no .env."
      : "",
});

const loadCostMode = () => {
  const parsed = readJsonFile(COST_MODE_FILE);
  const mode = normalizeCostMode(parsed?.mode);
  return {
    mode,
    updatedAtMs: typeof parsed?.updatedAtMs === "number" ? parsed.updatedAtMs : 0,
    updatedBy: typeof parsed?.updatedBy === "string" ? parsed.updatedBy : "system",
    labels: {
      economy: "Economia",
      balanced: "Balanceado",
      critical: "Critico",
    },
    routing: {
      economy: "Prioriza Kimi/Ollama e evita Claude/Codex salvo pedido humano.",
      balanced: "Usa Kimi para volume e Claude/Codex apenas em tarefas criticas do dominio.",
      critical: "Permite motor forte para juridico sensivel, arquitetura e incidentes, sempre com budget.",
    }[mode],
    hardLocks: [
      "Nao remove limite diario, cooldown ou aprovacao humana.",
      "Nao autoriza protocolo/envio/contato/cobranca/deploy destrutivo.",
    ],
  };
};

const loadBudget = () => {
  const parsed = readJsonFile(BUDGET_FILE);
  const date = typeof parsed?.date === "string" ? parsed.date : todayKey();
  const sameDay = date === todayKey();
  return {
    date: sameDay ? date : todayKey(),
    totalRuns: sameDay && typeof parsed?.totalRuns === "number" ? parsed.totalRuns : 0,
    byDomain:
      sameDay && parsed?.byDomain && typeof parsed.byDomain === "object" && !Array.isArray(parsed.byDomain)
        ? parsed.byDomain
        : {},
    byAgent:
      sameDay && parsed?.byAgent && typeof parsed.byAgent === "object" && !Array.isArray(parsed.byAgent)
        ? parsed.byAgent
        : {},
    lastRunAtMs: sameDay && typeof parsed?.lastRunAtMs === "number" ? parsed.lastRunAtMs : 0,
    blocked: sameDay && Array.isArray(parsed?.blocked) ? parsed.blocked.slice(0, 40) : [],
    limits: {
      totalDaily: JRC_TASK_RUN_DAILY_LIMIT,
      perDomainDaily: JRC_TASK_RUN_DOMAIN_DAILY_LIMIT,
      cooldownMs: JRC_TASK_RUN_COOLDOWN_MS,
      autoRunEnabled: JRC_AUTO_RUN_ENABLED,
    },
    remainingTotal: Math.max(
      0,
      JRC_TASK_RUN_DAILY_LIMIT - (sameDay && typeof parsed?.totalRuns === "number" ? parsed.totalRuns : 0),
    ),
  };
};

const loadTasks = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const activeTasks = tasks.filter((task): task is JsonRecord =>
    Boolean(task && typeof task === "object" && !(task as JsonRecord).archived),
  );
  const byStatus: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  const approval = { pending: 0, required: 0 };
  for (const task of activeTasks) {
    const status = typeof task.status === "string" ? task.status : "todo";
    const domain = typeof task.domain === "string" ? task.domain : "geral";
    byStatus[status] = (byStatus[status] || 0) + 1;
    byDomain[domain] = (byDomain[domain] || 0) + 1;
    const approvalInfo =
      task.approval && typeof task.approval === "object" && !Array.isArray(task.approval)
        ? (task.approval as JsonRecord)
        : null;
    if (approvalInfo?.required) approval.required += 1;
    if (approvalInfo?.status === "pending") approval.pending += 1;
  }
  const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const next = activeTasks
    .filter((task) => task.status !== "done")
    .sort((left, right) => {
      const leftPriority = typeof left.priority === "string" ? left.priority : "normal";
      const rightPriority = typeof right.priority === "string" ? right.priority : "normal";
      const priorityDiff = (priorityRank[leftPriority] ?? 9) - (priorityRank[rightPriority] ?? 9);
      if (priorityDiff !== 0) return priorityDiff;
      return Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0);
    })
    .slice(0, 8);
  const approvals = activeTasks
    .filter((task) => {
      const approvalInfo =
        task.approval && typeof task.approval === "object" && !Array.isArray(task.approval)
          ? (task.approval as JsonRecord)
          : null;
      return approvalInfo?.status === "pending";
    })
    .slice(0, 12);
  return { total: activeTasks.length, byStatus, byDomain, approval, next, approvals };
};

const loadTraces = () => {
  const parsed = readJsonFile(TRACES_FILE);
  const traces = Array.isArray(parsed?.traces)
    ? parsed.traces.filter((trace): trace is JsonRecord =>
        Boolean(trace && typeof trace === "object" && !Array.isArray(trace)),
      )
    : [];
  return {
    total: traces.length,
    latest: traces.slice(0, 12),
  };
};

const normalizeMediaKind = (kind: unknown) =>
  typeof kind === "string" && ["image", "video", "voice", "avatar", "edit", "carousel", "ad_creative"].includes(kind)
    ? kind
    : "ad_creative";

const normalizeMediaProvider = (providerId: unknown, kind: string) => {
  const value = typeof providerId === "string" ? providerId : "";
  if (["elevenlabs", "google-gemini", "gemini-omni", "qwen3-tts", "openai", "fal", "replicate", "ideogram", "creatomate"].includes(value)) {
    return value;
  }
  if (kind === "voice") return "elevenlabs";
  if (kind === "video" || kind === "avatar" || kind === "edit") return "creatomate";
  if (kind === "carousel" || kind === "ad_creative") return "ideogram";
  return "google-gemini";
};

const estimateMediaCost = (kind: string, providerId: string) => {
  if (providerId === "qwen3-tts") {
    return { costUsdMin: 0, costUsdMax: 0.05, tier: "low", credits: "local_compute" };
  }
  if (providerId === "gemini-omni") {
    return { costUsdMin: 1, costUsdMax: 6, tier: "high", credits: "paid_video" };
  }
  if (providerId === "fal" || providerId === "replicate" || kind === "video" || kind === "avatar") {
    return { costUsdMin: 1, costUsdMax: 5, tier: "high", credits: "paid_video" };
  }
  if (providerId === "creatomate" || kind === "edit" || providerId === "elevenlabs" || kind === "voice") {
    return { costUsdMin: 0.05, costUsdMax: 0.5, tier: "medium", credits: "render_or_voice" };
  }
  return { costUsdMin: 0.02, costUsdMax: 0.2, tier: "low", credits: "image" };
};

const loadMediaJobs = () => {
  const parsed = readJsonFile(MEDIA_JOBS_FILE);
  const jobs = Array.isArray(parsed?.jobs)
    ? parsed.jobs.filter((job): job is JsonRecord =>
        Boolean(job && typeof job === "object" && !Array.isArray(job) && typeof (job as JsonRecord).id === "string" && !(job as JsonRecord).archived),
      )
    : [];
  const byStatus: Record<string, number> = {};
  for (const job of jobs) {
    const status = typeof job.status === "string" ? job.status : "draft";
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return {
    total: jobs.length,
    byStatus,
    pendingApproval: jobs.filter((job) => {
      const approval = job.approval && typeof job.approval === "object" && !Array.isArray(job.approval)
        ? (job.approval as JsonRecord)
        : null;
      return approval?.status === "pending";
    }).length,
    latest: jobs
      .sort((left, right) => Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0))
      .slice(0, 6),
  };
};

const loadMediaBudget = () => {
  const parsed = readJsonFile(MEDIA_BUDGET_FILE);
  const date = typeof parsed?.date === "string" ? parsed.date : todayKey();
  const sameDay = date === todayKey();
  const preparedRuns = sameDay && typeof parsed?.preparedRuns === "number" ? parsed.preparedRuns : 0;
  return {
    date: sameDay ? date : todayKey(),
    preparedRuns,
    byProvider:
      sameDay && parsed?.byProvider && typeof parsed.byProvider === "object" && !Array.isArray(parsed.byProvider)
        ? parsed.byProvider
        : {},
    blocked: sameDay && Array.isArray(parsed?.blocked) ? parsed.blocked.slice(0, 40) : [],
    limits: {
      preparedDaily: JRC_MEDIA_PREP_DAILY_LIMIT,
      externalSpendRequiresApproval: true,
      publishRequiresApproval: true,
      actualProviderCallsEnabled: false,
    },
    remainingTotal: Math.max(0, JRC_MEDIA_PREP_DAILY_LIMIT - preparedRuns),
  };
};

const createMediaJob = (input: JsonRecord) => {
  const kind = normalizeMediaKind(input.kind);
  const providerId = normalizeMediaProvider(input.providerId, kind);
  const prompt = typeof input.prompt === "string" && input.prompt.trim()
    ? input.prompt.trim()
    : "Criativo educativo BPC/LOAS para Instagram, sem publicar.";
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : `Midia JRC - ${kind} via ${providerId}`;
  const now = new Date().toISOString();
  const job = {
    id: `media-job-${todayKey()}-${Math.random().toString(16).slice(2, 14)}`,
    kind,
    providerId,
    title,
    prompt,
    domain: "marketing",
    priority: typeof input.priority === "string" ? input.priority : "normal",
    status: "pending_approval",
    createdAt: now,
    updatedAt: now,
    updatedAtMs: Date.now(),
    estimate: estimateMediaCost(kind, providerId),
    approval: {
      required: true,
      status: "pending",
      reason: "Geracao de midia pode consumir creditos ou ser usada externamente; exige aprovacao humana.",
      resolvedAt: null,
      resolvedBy: null,
    },
    providerPayload: null,
    outputs: [],
    notes: ["Criado pelo fallback HTTP. Nenhuma chamada externa foi executada."],
    archived: false,
  };
  const parsed = readJsonFile(MEDIA_JOBS_FILE);
  const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  writeJsonFile(MEDIA_JOBS_FILE, { version: 1, jobs: [job, ...jobs].slice(0, 200) });
  return job;
};

const inferRiskLevel = (task: JsonRecord) => {
  const approval = task.approval && typeof task.approval === "object" && !Array.isArray(task.approval)
    ? (task.approval as JsonRecord)
    : null;
  const text = `${String(task.domain ?? "")} ${String(task.title ?? "")} ${String(task.description ?? "")}`.toLowerCase();
  if (approval?.required || /protocol|enviar|peti|prazo|legalmail|cobran|contato|deploy destrutivo/.test(text)) {
    return "high";
  }
  if (/marketing|meta|comercial|financeiro|cliente|lead|devops|vps|codigo/.test(text)) return "medium";
  return "low";
};

const buildRiskStatus = (tasksStatus: ReturnType<typeof loadTasks>, budget: ReturnType<typeof loadBudget>, engines: JsonRecord) => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks.filter((task): task is JsonRecord =>
        Boolean(task && typeof task === "object" && !(task as JsonRecord).archived),
      )
    : [];
  const highRiskTasks = tasks.filter((task) => task.riskLevel === "high" || inferRiskLevel(task) === "high");
  const mediaJobs = loadMediaJobs();
  const engineBlocked = Array.isArray(engines.blocked) ? engines.blocked.length : 0;
  const flags = [];
  if (tasksStatus.approval.pending) flags.push(`${tasksStatus.approval.pending} aprovacao(oes) humana(s) pendente(s)`);
  if (mediaJobs.pendingApproval) flags.push(`${mediaJobs.pendingApproval} aprovacao(oes) de midia pendente(s)`);
  if (tasksStatus.byStatus.blocked) flags.push(`${tasksStatus.byStatus.blocked} tarefa(s) bloqueada(s)`);
  if (tasksStatus.byStatus.review) flags.push(`${tasksStatus.byStatus.review} tarefa(s) em revisao`);
  if (budget.remainingTotal <= 1) flags.push("budget diario baixo");
  if (engineBlocked) flags.push(`${engineBlocked} motor(es) bloqueado(s)`);
  return {
    level: flags.length ? "attention" : "normal",
    pendingApprovals: tasksStatus.approval.pending,
    mediaApprovals: mediaJobs.pendingApproval,
    blockedTasks: tasksStatus.byStatus.blocked || 0,
    reviewTasks: tasksStatus.byStatus.review || 0,
    highRiskTasks: highRiskTasks.length,
    budgetRemaining: budget.remainingTotal,
    engineBlocked,
    hubFailures: 0,
    flags,
  };
};

const loadCadence = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks.filter((task): task is JsonRecord =>
        Boolean(task && typeof task === "object" && !(task as JsonRecord).archived),
      )
    : [];
  const ready = tasks.filter((task) => task.status === "todo").slice(0, 5);
  const approvals = tasks
    .filter((task) => {
      const approval = task.approval && typeof task.approval === "object" && !Array.isArray(task.approval)
        ? (task.approval as JsonRecord)
        : null;
      return approval?.status === "pending";
    })
    .slice(0, 5);
  const blocked = tasks.filter((task) => task.status === "blocked").slice(0, 5);
  return {
    daily: [
      { label: "09:00", action: "Reuniao T0: prazos, BPC, comercial, marketing, financeiro e DevOps." },
      { label: "09:15", action: "Sincronizar JRC Hub read-only e criar tarefas sem duplicar." },
      { label: "09:30", action: "Rodar no maximo uma tarefa interna por dominio respeitando cooldown." },
      { label: "17:30", action: "Fechar ata, pendentes e bloqueios para Obsidian." },
    ],
    suggestedNext: ready[0] ?? null,
    approvals,
    blocked,
    policy: "Nenhuma acao externa sai da fila sem aprovacao humana explicita.",
  };
};

const loadToday = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks.filter((task): task is JsonRecord =>
        Boolean(task && typeof task === "object" && !(task as JsonRecord).archived),
      )
    : [];
  const meetings = loadMeetings();
  const countDomain = (domain: string) =>
    tasks.filter((task) => task.domain === domain && task.status !== "done").length;
  const countStatus = (status: string) => tasks.filter((task) => task.status === status).length;
  const countApproval = () =>
    tasks.filter((task) => {
      const approval = task.approval && typeof task.approval === "object" && !Array.isArray(task.approval)
        ? (task.approval as JsonRecord)
        : null;
      return approval?.status === "pending";
    }).length;
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
      approvals: countApproval(),
    },
    latestMeeting: meetings.latest?.[0] ?? null,
  };
};

const fetchEngineUsage = async () => {
  try {
    const response = await fetch(`${HERMES_API_URL}/usage`, { cache: "no-store" });
    const payload = (await response.json()) as JsonRecord;
    if (!response.ok) {
      throw new Error(`Hermes usage HTTP ${response.status}`);
    }
    return { ok: true, ...payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Hermes usage unavailable." };
  }
};

const buildJrcHubStatus = () => ({
  ok: Boolean(JRC_HUB_BASE_URL),
  baseUrl: JRC_HUB_BASE_URL,
  readOnlyKeyConfigured: Boolean(JRC_HUB_MCP_READONLY_KEY),
});

const loadMeetings = () => {
  const parsed = readJsonFile(MEETINGS_FILE);
  const meetings = Array.isArray(parsed?.meetings)
    ? parsed.meetings.filter((meeting): meeting is JsonRecord =>
        Boolean(meeting && typeof meeting === "object" && !Array.isArray(meeting)),
      )
    : [];
  return {
    total: meetings.length,
    latest: meetings.slice(0, 5),
    maestro: {
      agentId: "jrc-maestro",
      name: "Maestro JRC",
      role: "Coordenacao de reunioes, delegacao e governanca",
    },
    room: {
      name: "Sala de Reuniao T0",
      pattern: "maestro -> especialista -> revisor -> aprovacao humana",
    },
  };
};

const buildEnginePolicy = () => ({
  defaultMode: "cost_guarded_router",
  rules: [
    { domain: "triagem/resumo/marketing/comercial", preferred: "kimi-api" },
    { domain: "juridico sensivel/peca/recurso", preferred: "claude-cli" },
    { domain: "devops/codigo", preferred: "codex-cli" },
    { domain: "pii/vision/rag/local", preferred: "ollama-local" },
  ],
  hardLocks: [
    "Claude/Codex sempre passam por limite diario e cooldown.",
    "Auto-run global depende de JRC_AUTO_RUN_ENABLED=1.",
    "Ato externo exige aprovacao humana.",
  ],
});

const VIRTUAL_OFFICE_ROLES = [
  {
    id: "legalmail-triage",
    department: "juridico",
    humanRole: "Assistente de prazos/LegalMail",
    agentId: "jrc-legalmail",
    autonomyLevel: "assisted",
    takeover: ["classificar andamentos", "criar tarefas de prazo", "preparar resumo e minuta interna", "separar itens que precisam do Dr."],
    approvalRequiredFor: ["protocolo", "envio de peticao", "peticao final", "contato externo"],
  },
  {
    id: "bpc-docs",
    department: "bpc",
    humanRole: "Organizador documental BPC/LOAS",
    agentId: "jrc-bpc",
    autonomyLevel: "assisted",
    takeover: ["checklist documental", "detectar faltantes", "preparar pacote para revisao", "gerar pendencias internas"],
    approvalRequiredFor: ["protocolo", "conclusao juridica sensivel", "uso de documento divergente"],
  },
  {
    id: "legal-draft",
    department: "juridico",
    humanRole: "Advogado junior de minuta",
    agentId: "jrc-juridico",
    autonomyLevel: "review_required",
    takeover: ["rascunhar peca", "montar tese inicial", "resumir autos", "apontar pedidos e provas"],
    approvalRequiredFor: ["entrega final", "recurso", "peticao de merito", "tese nova"],
  },
  {
    id: "quality-review",
    department: "juridico",
    humanRole: "Revisor/Conferente",
    agentId: "jrc-revisor",
    autonomyLevel: "assisted",
    takeover: ["auditar coerencia", "buscar falhas", "dar score de qualidade", "bloquear ato externo fragil"],
    approvalRequiredFor: ["liberar protocolo", "derrubar bloqueio de risco alto"],
  },
  {
    id: "commercial-triage",
    department: "comercial",
    humanRole: "Atendente/comercial interno",
    agentId: "jrc-comercial",
    autonomyLevel: "assisted",
    takeover: ["classificar lead", "resumir conversa", "criar briefing", "sugerir follow-up"],
    approvalRequiredFor: ["contatar lead", "enviar contrato", "cobrar retorno"],
  },
  {
    id: "client-support",
    department: "atendimento",
    humanRole: "Suporte de atendimento",
    agentId: "jrc-atendimento",
    autonomyLevel: "assisted",
    takeover: ["detectar conversa parada", "identificar objecao", "preparar resposta sugerida", "pedir dado faltante internamente"],
    approvalRequiredFor: ["mensagem ao cliente", "promessa de resultado", "orientacao juridica final"],
  },
  {
    id: "marketing-ops",
    department: "marketing",
    humanRole: "Social media/performance",
    agentId: "jrc-marketing",
    autonomyLevel: "assisted",
    takeover: ["diagnosticar campanha", "criar briefing de criativo", "gerar copy", "enfileirar job de midia"],
    approvalRequiredFor: ["publicacao", "criativo pago", "alteracao de campanha", "promessa publicitaria"],
  },
  {
    id: "finance-ops",
    department: "financeiro",
    humanRole: "Assistente financeiro",
    agentId: "jrc-financeiro",
    autonomyLevel: "assisted",
    takeover: ["resumir recebiveis", "detectar anomalias", "preparar relatorio", "sugerir cobranca interna"],
    approvalRequiredFor: ["cobranca externa", "negociacao", "alterar contrato", "baixa financeira"],
  },
  {
    id: "devops-ops",
    department: "devops",
    humanRole: "DevOps/infra interno",
    agentId: "jrc-devops",
    autonomyLevel: "safe_readonly",
    takeover: ["healthcheck", "ler logs", "mapear incidentes", "preparar plano de correcao"],
    approvalRequiredFor: ["deploy destrutivo", "apagar dados", "alterar producao", "rotacionar credenciais"],
  },
  {
    id: "chief-of-staff",
    department: "gestao",
    humanRole: "Chefe de gabinete operacional",
    agentId: "jrc-maestro",
    autonomyLevel: "safe_internal",
    takeover: ["priorizar o dia", "delegar tarefas", "cobrar pendencias internas", "fechar ata e resumo"],
    approvalRequiredFor: ["mudar prioridade critica", "executar ato externo", "liberar excecao de safety"],
  },
];

const STRATEGIC_PILOTS = [
  {
    id: "notebooklm-case-pilot",
    rank: 1,
    title: "NotebookLM case pilot",
    domain: "juridico",
    ownerAgentId: "jrc-pesquisador",
    status: "planned",
    integrationMode: "manual_bridge",
    why: "Leitura source-grounded de casos: autos, PDFs, linha do tempo, perguntas e riscos antes de peca.",
    capabilities: ["Resumo ancorado em fontes", "Linha do tempo do caso", "Perguntas ao acervo", "Checklist de risco juridico"],
    nextActions: ["Criar playbook de corpus por caso.", "Definir checklist de exportacao.", "Testar em BPC e trabalhista."],
    hardLocks: ["Sem upload de documento de cliente sem revisao LGPD.", "Sem peca final sem revisao JRC."],
  },
  {
    id: "agent-os-hardening",
    rank: 2,
    title: "Hermes + OpenClaw Agent OS hardening",
    domain: "devops",
    ownerAgentId: "jrc-maestro",
    status: "in_progress",
    integrationMode: "native",
    why: "Transforma o escritorio 3D em central operacional com salas, filas, budget, trace e aprovacoes.",
    capabilities: ["Delegacao por sala", "Fila de tarefas", "Trava de atos externos", "Budget por dominio"],
    nextActions: ["Mapear lacunas de seguranca.", "Criar healthcheck das salas.", "Exigir trace por tarefa."],
    hardLocks: ["Sem bypass de budget.", "Sem protocolo/envio/publicacao/contato externo sem aprovacao humana."],
  },
  {
    id: "gemini-omni-media-pilot",
    rank: 3,
    title: "Gemini Omni conversational video pilot",
    domain: "marketing",
    ownerAgentId: "jrc-marketing",
    status: "watch_api",
    integrationMode: "media_ops_payload",
    why: "Pode reduzir trabalho humano em variacoes de video e criativos, mas deve entrar como rascunho controlado.",
    capabilities: ["Edicao conversacional", "Variacoes de cena", "Video educativo", "Briefing para Reels/Ads"],
    nextActions: ["Manter payload Media Ops pronto.", "Criar roteiro educativo BPC.", "Validar custo e qualidade."],
    hardLocks: ["Sem geracao paga automatica.", "Sem publicacao ou anuncio sem aprovacao humana/OAB."],
  },
  {
    id: "qwen3-tts-local-pilot",
    rank: 4,
    title: "Qwen3-TTS local voice pilot",
    domain: "marketing",
    ownerAgentId: "jrc-amy",
    status: "planned",
    integrationMode: "local_tts",
    why: "Voz local/barata para narracoes internas e prototipos, reduzindo consumo de plano/API.",
    capabilities: ["Narracao local", "Prototipo de audio", "Fallback barato", "Teste antes de ElevenLabs"],
    nextActions: ["Verificar modelo local.", "Criar roteiro curto BPC.", "Comparar custo/qualidade com ElevenLabs."],
    hardLocks: ["Sem clone de voz sem autorizacao.", "Sem publicacao de audio sem aprovacao humana."],
  },
];

const AI_TECH_RADAR = [
  {
    id: "litellm-gateway",
    rank: 1,
    title: "LiteLLM gateway de custo e fallback",
    category: "model_gateway",
    ownerAgentId: "jrc-devops",
    status: "adopt_now",
    impact: "Corta risco de consumo invisivel ao centralizar modelos, limites, logs, fallback e chaves virtuais.",
    fit: "Hermes shim pode continuar existindo, mas LiteLLM vira camada padrao para custo e roteamento multi-modelo.",
    repos: ["https://github.com/BerriAI/litellm"],
    systems: ["Kimi", "Claude", "Codex/OpenAI", "Gemini", "DeepSeek", "Qwen", "Ollama"],
    nextActions: ["Subir proxy local em modo dry-run.", "Mapear modelos por dominio.", "Bloquear gasto sem budget por virtual key."],
    hardLocks: ["Nao migrar trafego juridico sensivel sem teste.", "Nao registrar secrets em log."],
  },
  {
    id: "langfuse-observability",
    rank: 2,
    title: "Langfuse observabilidade e evals",
    category: "observability",
    ownerAgentId: "jrc-auditor",
    status: "adopt_now",
    impact: "Mostra quem chamou qual modelo, custo, prompt, resposta, erro, latencia e qualidade.",
    fit: "Transforma a equipe virtual em operacao auditavel com score por agente e por rotina.",
    repos: ["https://github.com/langfuse/langfuse"],
    systems: ["Hermes Office", "JRC Hub", "LiteLLM"],
    nextActions: ["Adicionar tracing por taskId.", "Criar score semanal por agente.", "Ligar dashboard de custo por dominio."],
    hardLocks: ["Sanitizar PII antes de trace cloud.", "Preferir self-host para dados juridicos."],
  },
  {
    id: "playwright-mcp",
    rank: 3,
    title: "Playwright MCP para sistemas web",
    category: "tooling",
    ownerAgentId: "jrc-devops",
    status: "adopt_now",
    impact: "Permite agentes navegarem, testarem e extrairem dados de sistemas internos com ferramenta padronizada.",
    fit: "Bom para JRC Hub, paineis, conferencias e testes UI. Mais controlavel que browser agents soltos.",
    repos: ["https://github.com/microsoft/playwright-mcp"],
    systems: ["Codex", "Claude Code", "Hermes Office"],
    nextActions: ["Criar allowlist de dominios.", "Separar browser read-only de browser executor.", "Logar screenshot e passo."],
    hardLocks: ["Sem clicar Enviar/Protocolar/Cobrar.", "Sem cookies/sessao em log."],
  },
  {
    id: "nemo-guardrails",
    rank: 4,
    title: "NeMo Guardrails para hard locks",
    category: "safety",
    ownerAgentId: "jrc-auditor",
    status: "adopt_now",
    impact: "Cria rails programaveis de entrada, saida e tool calls para impedir bypass por prompt.",
    fit: "Camada obrigatoria antes de liberar MCP amplo ou automacao web em LegalMail/JRC Hub.",
    repos: ["https://github.com/NVIDIA-NeMo/Guardrails", "https://github.com/guardrails-ai/guardrails"],
    systems: ["LegalMail", "BPC", "JRC Hub", "MCP"],
    nextActions: ["Formalizar rails de ato externo.", "Criar filtro PII local.", "Adicionar teste de prompt injection."],
    hardLocks: ["Sem rail, sem ferramenta sensivel.", "Aprovacao humana vence qualquer agente."],
  },
  {
    id: "pipecat-voice-agents",
    rank: 5,
    title: "Pipecat para agentes por voz",
    category: "voice_multimodal",
    ownerAgentId: "jrc-amy",
    status: "pilot",
    impact: "Permite conversar com agentes por audio em tempo real, com STT/TTS e subagentes.",
    fit: "Pode virar recepcao interna, reuniao T0 falada, sala Claw3D com vozes e atendimento assistido.",
    repos: ["https://github.com/pipecat-ai/pipecat"],
    systems: ["Qwen3-TTS", "Whisper local", "Gemini Live", "OpenAI Realtime"],
    nextActions: ["Prototipar sala T0 por WebSocket.", "Usar Qwen/Whisper local primeiro.", "Medir latencia e custo."],
    hardLocks: ["Sem atendimento externo automatico.", "Sem gravar audio sensivel sem consentimento."],
  },
  {
    id: "firecrawl-crawl4ai-second-brain",
    rank: 6,
    title: "Firecrawl/Crawl4AI para Second Brain",
    category: "research_ingest",
    ownerAgentId: "jrc-pesquisador",
    status: "adopt_now",
    impact: "Transforma paginas, repos e noticias em markdown limpo para triagem e tarefas.",
    fit: "Alimenta Obsidian e Hermes com pesquisa recorrente sem copiar manualmente links.",
    repos: ["https://github.com/firecrawl/firecrawl", "https://github.com/unclecode/crawl4ai"],
    systems: ["Obsidian", "Second Brain", "Marketing", "Juridico"],
    nextActions: ["Criar crawler com allowlist.", "Salvar snapshot no Obsidian.", "Gerar tarefas com score e fonte."],
    hardLocks: ["Respeitar robots/termos.", "Nao capturar portal autenticado sem aprovacao."],
  },
  {
    id: "mem0-zep-long-memory",
    rank: 7,
    title: "Mem0/Zep para memoria longa",
    category: "memory",
    ownerAgentId: "jrc-maestro",
    status: "pilot",
    impact: "Da memoria operacional aos agentes sem depender de contexto gigante a cada conversa.",
    fit: "Obsidian segue fonte de verdade; memoria vira indice/lembranca operacional por agente.",
    repos: ["https://github.com/mem0ai/mem0", "https://github.com/getzep/zep"],
    systems: ["Obsidian", "Hermes Office", "Agentes JRC"],
    nextActions: ["Definir esquema de memoria por cliente/caso/agente.", "Criar TTL para lembrancas fracas.", "Testar recall auditavel."],
    hardLocks: ["PII juridica so local/self-host.", "Memoria deve citar fonte."],
  },
  {
    id: "openadapt-rpa",
    rank: 8,
    title: "OpenAdapt para RPA por demonstracao",
    category: "desktop_rpa",
    ownerAgentId: "jrc-devops",
    status: "watch",
    impact: "Grava demonstracoes humanas e transforma em automacao de GUI desktop/web.",
    fit: "Interessante para rotinas repetitivas que hoje alguem faz olhando tela, mas exige governanca forte.",
    repos: ["https://github.com/OpenAdaptAI/OpenAdapt"],
    systems: ["JRC Hub", "LegalMail", "rotinas administrativas"],
    nextActions: ["Mapear uma rotina interna nao sensivel.", "Testar captura com PII scrub.", "Comparar contra Playwright MCP."],
    hardLocks: ["Nao usar em protocolo real sem aprovacao.", "Nao gravar tela com dados sensiveis sem mascara."],
  },
  {
    id: "agent-browser-protocol",
    rank: 9,
    title: "Agent Browser Protocol",
    category: "browser_automation",
    ownerAgentId: "jrc-devops",
    status: "watch",
    impact: "Browser deterministico com MCP/REST, prometendo menos tokens e execucao mais estavel.",
    fit: "Pode substituir parte do Playwright MCP se provar mais previsivel em fluxos longos.",
    repos: ["https://github.com/theredsix/agent-browser-protocol"],
    systems: ["Codex", "Claude Code", "Hermes Office"],
    nextActions: ["Rodar benchmark local contra Playwright MCP.", "Testar fluxo JRC Hub read-only.", "Avaliar maturidade/licenca."],
    hardLocks: ["Somente read-only no piloto.", "Sem credenciais fora do cofre local."],
  },
  {
    id: "mova-video-audio",
    rank: 10,
    title: "MOVA video+audio open-source",
    category: "media",
    ownerAgentId: "jrc-marketing",
    status: "watch",
    impact: "Gera video e audio sincronizados, possivel alternativa open-source para criativos futuros.",
    fit: "Pode reduzir custo de video educativo se API/local amadurecer.",
    repos: ["https://github.com/OpenMOSS/MOVA"],
    systems: ["Media Ops", "Marketing JRC", "Qwen voice"],
    nextActions: ["Monitorar API e ComfyUI.", "Criar job Media Ops watchlist.", "Comparar contra Veo/Kling/Sora quando houver custo."],
    hardLocks: ["Sem publicacao sem aprovacao OAB.", "Sem deepfake/clone nao autorizado."],
  },
  {
    id: "a2a-protocol",
    rank: 11,
    title: "A2A para comunicacao entre agentes",
    category: "agent_protocol",
    ownerAgentId: "jrc-maestro",
    status: "watch",
    impact: "Padroniza delegacao entre agentes/sistemas diferentes sem acoplamento direto.",
    fit: "Util para Hermes, OpenClaw, n8n, Maestri e futuros workers se precisarem conversar entre si.",
    repos: ["https://github.com/google-a2a/A2A"],
    systems: ["Hermes", "OpenClaw", "n8n", "Maestri"],
    nextActions: ["Criar adapter interno simples.", "Mapear envelope de tarefa JRC.", "Nao expor externo ainda."],
    hardLocks: ["Sem A2A publico sem auth forte.", "Toda delegacao sensivel passa por policy."],
  },
  {
    id: "mcp-registry-allowlist",
    rank: 12,
    title: "MCP Registry com allowlist JRC",
    category: "tooling",
    ownerAgentId: "jrc-auditor",
    status: "adopt_pattern",
    impact: "Abre universo de ferramentas, mas tambem aumenta superficie de ataque.",
    fit: "Usar catalogo oficial somente como descoberta; instalacao deve passar por auditoria JRC.",
    repos: ["https://github.com/modelcontextprotocol/servers", "https://github.com/modelcontextprotocol/registry"],
    systems: ["Codex", "Claude", "Hermes Office"],
    nextActions: ["Criar allowlist.", "Bloquear stdio arbitrario.", "Registrar risco por servidor MCP."],
    hardLocks: ["Nao instalar MCP aleatorio.", "Sem servidor com shell amplo sem sandbox."],
  },
];

const loadAiRadar = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks.filter((task): task is JsonRecord => Boolean(task && typeof task === "object" && !(task as JsonRecord).archived))
    : [];
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const latest = AI_TECH_RADAR.map((item) => {
    const itemTasks = tasks.filter((task) => String(task.sourceEventId || "").startsWith(`ai-radar:${item.id}:`));
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    return {
      ...item,
      activeTasks: itemTasks.filter((task) => task.status !== "done").length,
      pendingApprovals: itemTasks.filter((task) => {
        const approval = task.approval && typeof task.approval === "object" && !Array.isArray(task.approval)
          ? (task.approval as JsonRecord)
          : null;
        return approval?.status === "pending";
      }).length,
      readyNow: item.status === "adopt_now",
    };
  }).sort((left, right) => left.rank - right.rank);
  return {
    total: latest.length,
    readyNow: latest.filter((item) => item.readyNow).length,
    byStatus,
    byCategory,
    latest,
    hardLocks: [
      "Radar cria apenas tarefas internas, pesquisas e checklists.",
      "Instalacao de ferramenta, MCP amplo, chamada paga e acesso a sistema autenticado exigem aprovacao humana.",
      "Prioridade e reduzir custo, aumentar auditoria e dar ferramentas seguras aos agentes atuais.",
    ],
  };
};

const createAiRadarSeedTasks = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const now = new Date().toISOString();
  const created = [];
  for (const item of AI_TECH_RADAR) {
    const specs = [
      { suffix: "fit", agentId: item.ownerAgentId, approval: false, priority: item.rank <= 6 ? "high" : "normal" },
      { suffix: "risk", agentId: "jrc-auditor", approval: true, priority: item.rank <= 4 ? "high" : "normal" },
    ];
    for (const spec of specs) {
      const sourceEventId = `ai-radar:${item.id}:${spec.suffix}`;
      if (hasTaskForSource(tasks, sourceEventId)) continue;
      const task = {
        id: `jrc-task-${Math.random().toString(16).slice(2, 14)}`,
        title: `AI Radar #${item.rank} - ${spec.suffix}: ${item.title}`,
        description: [
          `Categoria: ${item.category}`,
          `Status: ${item.status}`,
          `Impacto: ${item.impact}`,
          `Encaixe JRC: ${item.fit}`,
          `Repos:\n- ${item.repos.join("\n- ")}`,
          `Sistemas relacionados:\n- ${item.systems.join("\n- ")}`,
          `Proximas acoes:\n- ${item.nextActions.join("\n- ")}`,
          `Travas:\n- ${item.hardLocks.join("\n- ")}`,
        ].join("\n\n"),
        status: "todo",
        source: "playbook",
        sourceEventId,
        assignedAgentId: spec.agentId,
        createdAt: now,
        updatedAt: now,
        updatedAtMs: Date.now(),
        lastActivityAt: now,
        priority: spec.priority,
        domain: item.category,
        notes: ["Criado pelo AI Radar. Nenhuma instalacao, chamada externa ou gasto foi executado."],
        archived: false,
        approval: {
          required: spec.approval,
          status: spec.approval ? "pending" : "not_required",
          reason: spec.approval ? "Nova ferramenta/automacao pode afetar custo, seguranca, PII ou ato externo." : "",
          resolvedAt: null,
          resolvedBy: null,
        },
      };
      tasks.unshift(task);
      created.push(task);
    }
  }
  writeJsonFile(TASKS_FILE, { version: 1, tasks });
  return created;
};

const AI_STACK_CONNECTORS = [
  {
    id: "litellm",
    radarId: "litellm-gateway",
    label: "LiteLLM",
    layer: "model_gateway",
    ownerAgentId: "jrc-devops",
    activationMode: "local_proxy_with_budget",
    env: ["JRC_LITELLM_BASE_URL", "LITELLM_MASTER_KEY"],
    defaultEndpoint: "http://127.0.0.1:4000",
    setupCommand: "litellm --config ~/.hermes/litellm-jrc.yaml --port 4000",
    safetyLevel: "high",
    nextStep: "Criar config LiteLLM com virtual keys por dominio e fallback Kimi/Ollama antes de Claude/Codex.",
  },
  {
    id: "langfuse",
    radarId: "langfuse-observability",
    label: "Langfuse",
    layer: "observability",
    ownerAgentId: "jrc-auditor",
    activationMode: "self_host_or_sanitized_cloud",
    env: ["LANGFUSE_HOST", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
    defaultEndpoint: "http://127.0.0.1:3001",
    setupCommand: "docker compose up -d langfuse",
    safetyLevel: "high",
    nextStep: "Ligar traces por taskId, agentId e domain com PII redaction antes de envio cloud.",
  },
  {
    id: "playwright-mcp",
    radarId: "playwright-mcp",
    label: "Playwright MCP",
    layer: "browser_tooling",
    ownerAgentId: "jrc-devops",
    activationMode: "mcp_allowlist_readonly_first",
    env: ["JRC_BROWSER_ALLOWLIST"],
    defaultEndpoint: "stdio:npx @playwright/mcp@latest",
    setupCommand: "codex mcp add playwright npx \"@playwright/mcp@latest\"",
    safetyLevel: "critical",
    nextStep: "Criar allowlist JRC Hub/localhost e negar botoes de envio, protocolo, cobranca e publicacao.",
  },
  {
    id: "guardrails",
    radarId: "nemo-guardrails",
    label: "NeMo/Guardrails",
    layer: "safety",
    ownerAgentId: "jrc-auditor",
    activationMode: "policy_engine_required_before_tools",
    env: ["JRC_GUARDRAILS_CONFIG_DIR", "NEMO_GUARDRAILS_SERVER_URL"],
    defaultEndpoint: "local policy files",
    setupCommand: "nemoguardrails server --config ~/.hermes/guardrails/jrc",
    safetyLevel: "critical",
    nextStep: "Formalizar rails para PII, prompt injection, tool calls e atos externos.",
  },
  {
    id: "pipecat",
    radarId: "pipecat-voice-agents",
    label: "Pipecat",
    layer: "voice_multimodal",
    ownerAgentId: "jrc-amy",
    activationMode: "internal_voice_room",
    env: ["PIPECAT_BASE_URL", "QWEN3_TTS_ENDPOINT"],
    defaultEndpoint: "http://127.0.0.1:7860",
    setupCommand: "pipecat init jrc-voice-office",
    safetyLevel: "medium",
    nextStep: "Prototipar sala T0 falada usando Whisper local e Qwen3-TTS.",
  },
  {
    id: "firecrawl-crawl4ai",
    radarId: "firecrawl-crawl4ai-second-brain",
    label: "Firecrawl/Crawl4AI",
    layer: "research_ingest",
    ownerAgentId: "jrc-pesquisador",
    activationMode: "allowlisted_ingest",
    env: ["FIRECRAWL_API_KEY", "CRAWL4AI_BASE_URL"],
    defaultEndpoint: "http://127.0.0.1:11235",
    setupCommand: "crawl4ai-server --host 127.0.0.1 --port 11235",
    safetyLevel: "medium",
    nextStep: "Criar crawler de repos/noticias com snapshot Obsidian e score Second Brain.",
  },
  {
    id: "memory",
    radarId: "mem0-zep-long-memory",
    label: "Mem0/Zep",
    layer: "memory",
    ownerAgentId: "jrc-maestro",
    activationMode: "local_memory_index",
    env: ["MEM0_API_KEY", "MEM0_BASE_URL", "ZEP_API_URL", "ZEP_API_KEY"],
    defaultEndpoint: "local/self-host",
    setupCommand: "docker compose up -d zep",
    safetyLevel: "high",
    nextStep: "Definir memoria por agente com fonte Obsidian e TTL para lembrancas fracas.",
  },
  {
    id: "openadapt",
    radarId: "openadapt-rpa",
    label: "OpenAdapt",
    layer: "desktop_rpa",
    ownerAgentId: "jrc-devops",
    activationMode: "recorded_demo_sandbox",
    env: ["OPENADAPT_HOME"],
    defaultEndpoint: "~/.openadapt",
    setupCommand: "pip install 'openadapt[privacy,evals]'",
    safetyLevel: "critical",
    nextStep: "Testar somente em rotina interna nao sensivel com PII scrub ativo.",
  },
  {
    id: "agent-browser-protocol",
    radarId: "agent-browser-protocol",
    label: "Agent Browser Protocol",
    layer: "browser_automation",
    ownerAgentId: "jrc-devops",
    activationMode: "readonly_benchmark",
    env: ["ABP_BASE_URL"],
    defaultEndpoint: "http://127.0.0.1:8222",
    setupCommand: "npx -y agent-browser-protocol --mcp",
    safetyLevel: "high",
    nextStep: "Comparar contra Playwright MCP em fluxo read-only do JRC Hub.",
  },
  {
    id: "mova",
    radarId: "mova-video-audio",
    label: "MOVA",
    layer: "media",
    ownerAgentId: "jrc-marketing",
    activationMode: "media_ops_watchlist",
    env: ["MOVA_API_KEY", "MOVA_BASE_URL"],
    defaultEndpoint: "provider/API when available",
    setupCommand: "Criar job Media Ops de avaliacao; sem render automatico.",
    safetyLevel: "medium",
    nextStep: "Monitorar API/ComfyUI e comparar custo com Veo/Kling/Sora.",
  },
  {
    id: "a2a",
    radarId: "a2a-protocol",
    label: "A2A",
    layer: "agent_protocol",
    ownerAgentId: "jrc-maestro",
    activationMode: "internal_adapter_only",
    env: ["JRC_A2A_BASE_URL", "JRC_A2A_TOKEN"],
    defaultEndpoint: "http://127.0.0.1:8899",
    setupCommand: "Criar adapter interno Hermes<->OpenClaw; nao expor publico.",
    safetyLevel: "high",
    nextStep: "Padronizar envelope de tarefa, handoff, status e aprovacao.",
  },
  {
    id: "mcp-registry",
    radarId: "mcp-registry-allowlist",
    label: "MCP Registry Allowlist",
    layer: "tool_registry",
    ownerAgentId: "jrc-auditor",
    activationMode: "curated_allowlist_only",
    env: ["JRC_MCP_ALLOWLIST_PATH"],
    defaultEndpoint: "~/.hermes/mcp-allowlist.json",
    setupCommand: "Criar allowlist assinada; negar stdio/shell amplo por padrao.",
    safetyLevel: "critical",
    nextStep: "Auditar servidores MCP antes de habilitar para agentes JRC.",
  },
];

const isConnectorConfigured = (connector: { env: string[] }) =>
  connector.env.some((name) => Boolean(process.env[name]?.trim()));

const loadAiStack = () => {
  const radar = loadAiRadar();
  const radarById = new Map(radar.latest.map((item) => [item.id, item]));
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks.filter((task): task is JsonRecord => Boolean(task && typeof task === "object" && !(task as JsonRecord).archived))
    : [];
  const latest = AI_STACK_CONNECTORS.map((connector) => {
    const stackTasks = tasks.filter((task) => String(task.sourceEventId || "").startsWith(`ai-stack:${connector.id}:`));
    const configured = isConnectorConfigured(connector);
    return {
      ...connector,
      configured,
      missingEnv: connector.env.filter((name) => !process.env[name]?.trim()),
      radarStatus: radarById.get(connector.radarId)?.status || "unknown",
      activeTasks: stackTasks.filter((task) => task.status !== "done").length,
      pendingApprovals: stackTasks.filter((task) => {
        const approval = task.approval && typeof task.approval === "object" && !Array.isArray(task.approval)
          ? (task.approval as JsonRecord)
          : null;
        return approval?.status === "pending";
      }).length,
      readyForDryRun: configured || ["playwright-mcp", "mcp-registry"].includes(connector.id),
    };
  });
  return {
    total: latest.length,
    configured: latest.filter((connector) => connector.configured).length,
    readyForDryRun: latest.filter((connector) => connector.readyForDryRun).length,
    critical: latest.filter((connector) => connector.safetyLevel === "critical").length,
    latest,
    policy: {
      defaultMode: "prepared_not_activated",
      externalActivationRequiresApproval: true,
      paidCallsRequireApproval: true,
      authenticatedSystemsRequireApproval: true,
      mcpRequiresAllowlist: true,
    },
  };
};

const createAiStackSeedTasks = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const now = new Date().toISOString();
  const created = [];
  for (const connector of AI_STACK_CONNECTORS) {
    const specs = [
      { suffix: "configure", agentId: connector.ownerAgentId, approval: false, priority: connector.safetyLevel === "critical" ? "high" : "normal" },
      { suffix: "verify", agentId: connector.ownerAgentId, approval: false, priority: "normal" },
      { suffix: "safety", agentId: "jrc-auditor", approval: true, priority: connector.safetyLevel === "critical" ? "high" : "normal" },
    ];
    for (const spec of specs) {
      const sourceEventId = `ai-stack:${connector.id}:${spec.suffix}`;
      if (hasTaskForSource(tasks, sourceEventId)) continue;
      const task = {
        id: `jrc-task-${Math.random().toString(16).slice(2, 14)}`,
        title: `AI Stack - ${spec.suffix}: ${connector.label}`,
        description: [
          `Camada: ${connector.layer}`,
          `Modo de ativacao: ${connector.activationMode}`,
          `Endpoint padrao: ${connector.defaultEndpoint}`,
          `Env esperadas:\n- ${connector.env.join("\n- ")}`,
          `Comando/plano seguro:\n${connector.setupCommand}`,
          `Proximo passo: ${connector.nextStep}`,
          "Regra: preparar e validar; nao ativar acesso externo, API paga, MCP amplo ou sistema autenticado sem aprovacao humana.",
        ].join("\n\n"),
        status: "todo",
        source: "playbook",
        sourceEventId,
        assignedAgentId: spec.agentId,
        createdAt: now,
        updatedAt: now,
        updatedAtMs: Date.now(),
        lastActivityAt: now,
        priority: spec.priority,
        domain: connector.layer,
        notes: ["Criado pelo AI Stack Hub. Nenhuma instalacao, chamada externa ou gasto foi executado."],
        archived: false,
        approval: {
          required: spec.approval,
          status: spec.approval ? "pending" : "not_required",
          reason: spec.approval ? "Conector pode ampliar ferramenta, custo, PII ou automacao; exige revisao humana." : "",
          resolvedAt: null,
          resolvedBy: null,
        },
      };
      tasks.unshift(task);
      created.push(task);
    }
  }
  writeJsonFile(TASKS_FILE, { version: 1, tasks });
  return created;
};

const buildVirtualOfficeStatus = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks.filter((task): task is JsonRecord =>
        Boolean(task && typeof task === "object" && !(task as JsonRecord).archived),
      )
    : [];
  const byDepartment: Record<string, number> = {};
  const roles = VIRTUAL_OFFICE_ROLES.map((role) => {
    const activeTasks = tasks.filter((task) => task.assignedAgentId === role.agentId && task.status !== "done");
    const pendingApprovals = activeTasks.filter((task) => {
      const approval = task.approval && typeof task.approval === "object" && !Array.isArray(task.approval)
        ? (task.approval as JsonRecord)
        : null;
      return approval?.status === "pending";
    }).length;
    byDepartment[role.department] = (byDepartment[role.department] || 0) + 1;
    return {
      ...role,
      agentName: role.agentId,
      activeTasks: activeTasks.length,
      pendingApprovals,
      readyForAutonomy: ["safe_internal", "safe_readonly", "assisted"].includes(role.autonomyLevel),
    };
  });
  const replaceableNow = roles.filter((role) => role.readyForAutonomy).length;
  return {
    target: "escritorio_100_virtual_com_aprovacao_humana_para_ato_externo",
    replaceableNow,
    totalRoles: roles.length,
    coveragePct: Math.round((replaceableNow / Math.max(1, roles.length)) * 100),
    byDepartment,
    roles,
    hardLocks: [
      "Nada de protocolo/envio/publicacao/contato/cobranca sem aprovacao humana explicita.",
      "Agentes podem preparar, revisar, classificar, resumir, auditar e enfileirar.",
      "Toda substituicao humana vira fila, trace, budget e aprovacao quando sensivel.",
    ],
  };
};

const hasTaskForSource = (tasks: unknown[], sourceEventId: string) =>
  tasks.some((task) => task && typeof task === "object" && (task as JsonRecord).sourceEventId === sourceEventId);

const createVirtualOfficeSeedTasks = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const now = new Date().toISOString();
  const created = [];
  for (const role of VIRTUAL_OFFICE_ROLES) {
    const sourceEventId = `virtual-office:${role.id}:${todayKey()}`;
    if (hasTaskForSource(tasks, sourceEventId)) continue;
    const needsHumanApproval = role.autonomyLevel === "review_required";
    const task = {
      id: `jrc-task-${Math.random().toString(16).slice(2, 14)}`,
      title: `Escritorio virtual - assumir rotina: ${role.humanRole}`,
      description: [
        `Departamento: ${role.department}`,
        `Agente responsavel: ${role.agentId}`,
        `Funcoes que pode assumir:\n- ${role.takeover.join("\n- ")}`,
        `Exige aprovacao para:\n- ${role.approvalRequiredFor.join("\n- ")}`,
      ].join("\n\n"),
      status: "todo",
      source: "playbook",
      sourceEventId,
      assignedAgentId: role.agentId,
      createdAt: now,
      updatedAt: now,
      updatedAtMs: Date.now(),
      lastActivityAt: now,
      priority: role.department === "juridico" || role.department === "bpc" ? "high" : "normal",
      domain: role.department,
      notes: ["Seed de substituicao de trabalho humano interno. Ato externo permanece bloqueado."],
      archived: false,
      approval: {
        required: needsHumanApproval,
        status: needsHumanApproval ? "pending" : "not_required",
        reason: needsHumanApproval ? "Funcao juridica sensivel; resultado deve ir para revisao antes de uso final." : "",
        resolvedAt: null,
        resolvedBy: null,
      },
    };
    tasks.unshift(task);
    created.push(task);
  }
  writeJsonFile(TASKS_FILE, { version: 1, tasks });
  return created;
};

const loadStrategicPilots = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks.filter((task): task is JsonRecord => Boolean(task && typeof task === "object" && !(task as JsonRecord).archived))
    : [];
  const byStatus: Record<string, number> = {};
  const latest = STRATEGIC_PILOTS.map((pilot) => {
    const pilotTasks = tasks.filter((task) => String(task.sourceEventId || "").startsWith(`strategic-pilot:${pilot.id}:`));
    byStatus[pilot.status] = (byStatus[pilot.status] || 0) + 1;
    return {
      ...pilot,
      activeTasks: pilotTasks.filter((task) => task.status !== "done").length,
      pendingApprovals: pilotTasks.filter((task) => {
        const approval = task.approval && typeof task.approval === "object" && !Array.isArray(task.approval)
          ? (task.approval as JsonRecord)
          : null;
        return approval?.status === "pending";
      }).length,
      readyNow: ["manual_bridge", "native", "local_tts"].includes(pilot.integrationMode),
    };
  }).sort((left, right) => left.rank - right.rank);
  return {
    total: latest.length,
    readyNow: latest.filter((pilot) => pilot.readyNow).length,
    byStatus,
    latest,
    hardLocks: [
      "Pilotos criam tarefas e rascunhos internos.",
      "Nenhuma chamada paga, upload sensivel, publicacao ou ato externo sem aprovacao humana explicita.",
      "Prioridade: reduzir consumo de planos usando local/Kimi quando a qualidade bastar.",
    ],
  };
};

const createStrategicPilotSeedTasks = () => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const now = new Date().toISOString();
  const created = [];
  for (const pilot of STRATEGIC_PILOTS) {
    const specs = [
      { suffix: "research", agentId: pilot.domain === "marketing" ? "jrc-marketing" : pilot.domain === "devops" ? "jrc-devops" : "jrc-pesquisador", approval: false },
      { suffix: "implementation", agentId: pilot.ownerAgentId, approval: pilot.rank >= 3 },
      { suffix: "review", agentId: "jrc-revisor", approval: true },
    ];
    for (const spec of specs) {
      const sourceEventId = `strategic-pilot:${pilot.id}:${spec.suffix}`;
      if (hasTaskForSource(tasks, sourceEventId)) continue;
      const task = {
        id: `jrc-task-${Math.random().toString(16).slice(2, 14)}`,
        title: `Piloto top ${pilot.rank} - ${spec.suffix}: ${pilot.title}`,
        description: [
          `Ranking: ${pilot.rank}`,
          `Dominio: ${pilot.domain}`,
          `Modo: ${pilot.integrationMode}`,
          `Por que importa: ${pilot.why}`,
          `Capacidades:\n- ${pilot.capabilities.join("\n- ")}`,
          `Proximas acoes:\n- ${pilot.nextActions.join("\n- ")}`,
          `Travas:\n- ${pilot.hardLocks.join("\n- ")}`,
        ].join("\n\n"),
        status: "todo",
        source: "playbook",
        sourceEventId,
        assignedAgentId: spec.agentId,
        createdAt: now,
        updatedAt: now,
        updatedAtMs: Date.now(),
        lastActivityAt: now,
        priority: pilot.rank <= 2 ? "high" : "normal",
        domain: pilot.domain,
        notes: ["Seed ranking 1-4. Nenhuma chamada externa ou gasto foi executado."],
        archived: false,
        approval: {
          required: spec.approval,
          status: spec.approval ? "pending" : "not_required",
          reason: spec.approval ? "Piloto estrategico pode afetar custo, dados ou uso externo; exige aprovacao humana." : "",
          resolvedAt: null,
          resolvedBy: null,
        },
      };
      tasks.unshift(task);
      created.push(task);
    }
  }
  writeJsonFile(TASKS_FILE, { version: 1, tasks });
  return created;
};

const stableKey = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
};

const inferSecondBrainSourceType = (value: string) => {
  const text = value.toLowerCase();
  if (/tiktok|vt\.tiktok/.test(text)) return "tiktok";
  if (/github\.com/.test(text)) return "repo";
  if (/docs|documentation|\/doc/.test(text)) return "doc";
  if (/http/.test(text)) return "article";
  return "idea";
};

const analyzeSecondBrainSource = (input: { title: string; url?: string; summary: string }) => {
  const sourceText = `${input.title} ${input.url ?? ""} ${input.summary}`.toLowerCase();
  const tags: string[] = [];
  const actions: string[] = [];
  let verdict = "watch";
  let score = 60;
  let domain = "gestao";
  if (/antigravity|agent os|openclaw|hermes|multi.agent|multi-agent|gemini/.test(sourceText)) {
    tags.push("agent-os", "orquestracao", "devops");
    actions.push("Comparar com Hermes Office antes de trocar stack.");
    actions.push("Criar tarefa de integracao apenas se houver ganho claro sobre fila atual.");
    verdict = "adopt_pattern";
    score += 18;
    domain = "devops";
  }
  if (/obsidian|second brain|claude code|memoria|memory/.test(sourceText)) {
    tags.push("second-brain", "obsidian", "memoria");
    actions.push("Salvar insight no vault e conectar ao fluxo de sessao dos agentes.");
    actions.push("Criar tarefa para transformar conhecimento em playbook ou discovery.");
    verdict = "adopt_now";
    score += 20;
    domain = "gestao";
  }
  if (/marketing|tiktok|reels|creative|criativo|ads/.test(sourceText)) {
    tags.push("marketing", "midia");
    actions.push("Transformar em job de midia ou pauta editorial somente apos revisao.");
    score += 8;
    domain = domain === "gestao" ? "marketing" : domain;
  }
  if (tags.length === 0) {
    tags.push("triagem");
    actions.push("Analisar manualmente antes de virar implementacao.");
  }
  return {
    verdict,
    score: Math.max(0, Math.min(100, score)),
    domain,
    tags: [...new Set(tags)],
    impact: verdict === "adopt_now"
      ? "Aplicar como camada operacional do Hermes/JRC: memoria persistente, fila e tarefas."
      : verdict === "adopt_pattern"
        ? "Usar como padrao de produto, sem substituir stack atual sem prova."
        : "Acompanhar; ainda nao justifica mudanca operacional.",
    recommendedActions: actions,
    risks: [
      "Videos curtos podem exagerar capacidade real.",
      "Nao conectar ferramenta nova a dados juridicos sem teste, sandbox e aprovacao.",
      "Nao aumentar consumo de planos sem budget.",
    ],
  };
};

const loadSecondBrain = () => {
  const parsed = readJsonFile(SECOND_BRAIN_FILE);
  const insights = Array.isArray(parsed?.insights)
    ? parsed.insights.filter((insight): insight is JsonRecord =>
        Boolean(insight && typeof insight === "object" && !Array.isArray(insight) && typeof (insight as JsonRecord).id === "string" && !(insight as JsonRecord).archived),
      )
    : [];
  const byStatus: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  for (const insight of insights) {
    const status = typeof insight.status === "string" ? insight.status : "triaged";
    const verdict = typeof insight.verdict === "string" ? insight.verdict : "watch";
    byStatus[status] = (byStatus[status] || 0) + 1;
    byVerdict[verdict] = (byVerdict[verdict] || 0) + 1;
  }
  return {
    total: insights.length,
    byStatus,
    byVerdict,
    latest: insights
      .sort((left, right) => Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0))
      .slice(0, 8),
  };
};

const writeSecondBrainNote = (insight: JsonRecord) => {
  const safeTitle = String(insight.title || insight.id)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 -]/g, "")
    .trim()
    .slice(0, 80) || String(insight.id);
  const filePath = path.join(OBSIDIAN_VAULT_DIR, "02 - Escritorio", "Dicas IA", `${todayKey()} ${safeTitle}.md`);
  const actions = Array.isArray(insight.recommendedActions) ? insight.recommendedActions.map(String) : [];
  const risks = Array.isArray(insight.risks) ? insight.risks.map(String) : [];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    `# ${String(insight.title || insight.id)}`,
    "",
    `Fonte: ${String(insight.url || insight.sourceType || "")}`,
    `Tipo: ${String(insight.sourceType || "")}`,
    `Veredito: ${String(insight.verdict || "")}`,
    `Score: ${String(insight.score || "")}`,
    "",
    "## Resumo",
    String(insight.summary || "Insight capturado pelo Hermes Office."),
    "",
    "## Impacto JRC",
    String(insight.impact || ""),
    "",
    "## Acoes recomendadas",
    ...actions.map((action) => `- ${action}`),
    "",
    "## Riscos",
    ...risks.map((risk) => `- ${risk}`),
    "",
  ].join("\n"), "utf8");
  return filePath;
};

const createSecondBrainTasks = (insight: JsonRecord) => {
  const parsed = readJsonFile(TASKS_FILE);
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const baseSource = `second-brain:${String(insight.id)}`;
  const now = new Date().toISOString();
  const specs = [
    ["research", "jrc-pesquisador", "gestao", false, "Validar claims, fonte primaria, riscos e redundancia com stack JRC."],
    ["implement", insight.domain === "marketing" ? "jrc-marketing" : "jrc-devops", String(insight.domain || "gestao"), insight.verdict !== "adopt_now", "Converter insight em proposta operacional, PRD pequeno ou tarefa tecnica interna."],
    ["skeptic", "jrc-revisor", "gestao", true, "Procurar exagero, risco juridico, custo, lock-in e conflito com o que ja existe."],
  ] as const;
  const created = [];
  for (const [suffix, agentId, domain, approval, description] of specs) {
    const sourceEventId = `${baseSource}:${suffix}`;
    if (hasTaskForSource(tasks, sourceEventId)) continue;
    const task = {
      id: `jrc-task-${Math.random().toString(16).slice(2, 14)}`,
      title: `Second Brain - ${suffix}: ${String(insight.title || insight.id)}`,
      description: [
        description,
        `Fonte: ${String(insight.url || insight.sourceType || "")}`,
        `Resumo: ${String(insight.summary || "")}`,
        `Impacto: ${String(insight.impact || "")}`,
      ].join("\n\n"),
      status: "todo",
      source: "playbook",
      sourceEventId,
      assignedAgentId: agentId,
      createdAt: now,
      updatedAt: now,
      updatedAtMs: Date.now(),
      lastActivityAt: now,
      priority: Number(insight.score || 0) >= 80 ? "high" : "normal",
      domain,
      notes: ["Criado pela fila Second Brain. Nenhum ato externo foi executado."],
      archived: false,
      approval: {
        required: approval,
        status: approval ? "pending" : "not_required",
        reason: approval ? "Insight externo precisa revisao humana/cetica antes de virar execucao final." : "",
        resolvedAt: null,
        resolvedBy: null,
      },
    };
    tasks.unshift(task);
    created.push(task);
  }
  writeJsonFile(TASKS_FILE, { version: 1, tasks });
  return created;
};

const ingestSecondBrain = (input: JsonRecord) => {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : (url ? `Insight ${url}` : "Insight manual JRC");
  const summary = typeof input.summary === "string" && input.summary.trim() ? input.summary.trim() : "Insight capturado para triagem operacional do JRC.";
  const sourceType = typeof input.sourceType === "string" ? input.sourceType : inferSecondBrainSourceType(`${url} ${summary}`);
  const sourceKey = stableKey(`${sourceType}:${url || title}:${summary}`);
  const parsed = readJsonFile(SECOND_BRAIN_FILE);
  const insights = Array.isArray(parsed?.insights) ? parsed.insights : [];
  const existing = insights.find((insight) => insight && typeof insight === "object" && (insight as JsonRecord).sourceKey === sourceKey && !(insight as JsonRecord).archived);
  if (existing && typeof existing === "object") return { insight: existing, createdTasks: [], duplicate: true, summary: loadSecondBrain() };
  const analysis = analyzeSecondBrainSource({ title, url, summary });
  const now = new Date().toISOString();
  const insight = {
    id: `second-brain-${todayKey()}-${Math.random().toString(16).slice(2, 14)}`,
    sourceKey,
    sourceType,
    url: url || null,
    title,
    summary,
    status: "triaged",
    createdAt: now,
    updatedAt: now,
    updatedAtMs: Date.now(),
    archived: false,
    ...analysis,
    obsidianPath: null as string | null,
  };
  if (input.writeNote !== false) {
    insight.obsidianPath = writeSecondBrainNote(insight);
  }
  writeJsonFile(SECOND_BRAIN_FILE, { version: 1, insights: [insight, ...insights].slice(0, 300) });
  const createdTasks = input.createTasks === false ? [] : createSecondBrainTasks(insight);
  return { insight, createdTasks, duplicate: false, summary: loadSecondBrain() };
};

const seedSecondBrainRecent = () => [
  ingestSecondBrain({
    url: "https://www.tiktok.com/@future.with.ai98/video/7642315371072081159",
    title: "Google Antigravity 2.0 + Agent OS",
    sourceType: "tiktok",
    summary: "Video mostra Google Antigravity 2.0 conectado a Agent OS com Gemini, Hermes, OpenClaw e Claude para orquestrar multiplos agentes e automatizar workflows.",
  }),
  ingestSecondBrain({
    url: "https://www.tiktok.com/@itstaayjus/video/7642411871307451678",
    title: "Obsidian + Claude Code Second Brain",
    sourceType: "tiktok",
    summary: "Video reforca Obsidian como second brain para Claude/Claude Code, usando memoria persistente para agentes trabalharem sem recomecar do zero.",
  }),
];

const buildMediaOpsStatus = () => {
  const providers = [
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
      id: "gemini-omni",
      label: "Gemini Omni/Flow",
      kind: "video_edit",
      env: "GOOGLE_API_KEY",
      role: "piloto de video conversacional e edicao por prompt quando disponivel",
      defaultUse: "roteiro -> variacao de cena/video educativo, sempre em rascunho",
      approval: "required_for_paid_generation",
    },
    {
      id: "qwen3-tts",
      label: "Qwen3-TTS",
      kind: "voice_local",
      env: null,
      role: "voz local/barata para narracao e prototipos sem consumir plano cloud",
      defaultUse: "roteiro -> voz PT-BR/EN local quando modelo estiver instalado",
      approval: "required_for_voice_clone_or_publish",
      configured: Boolean(
        process.env.QWEN3_TTS_ENDPOINT?.trim() ||
          process.env.REPLICATE_API_TOKEN?.trim() ||
          process.env.REPLICATE_API_KEY?.trim() ||
          process.env.QWEN3_TTS_ENABLED === "1" ||
          process.env.QWEN3_TTS_MODEL_PATH?.trim(),
      ),
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
      env: "REPLICATE_API_TOKEN",
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
    configured: provider.env ? Boolean(process.env[provider.env]?.trim()) : Boolean(provider.configured),
  }));
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
    jobs: loadMediaJobs(),
    budget: loadMediaBudget(),
    recommendedDefault: "ElevenLabs -> HeyGen/MCP -> Creatomate -> Fal/Replicate B-roll, com aprovacao antes de gastar alto ou publicar.",
    missing,
  };
};

const buildOpsStatus = async () => {
  const budget = loadBudget();
  const engines = await fetchEngineUsage();
  const tasks = loadTasks();
  return {
    mode: buildOpsModeStatus(),
    costMode: loadCostMode(),
    budget,
    engines,
    enginePolicy: buildEnginePolicy(),
    tasks,
    meetings: loadMeetings(),
    cadence: loadCadence(),
    today: loadToday(),
    risk: buildRiskStatus(tasks, budget, engines),
    traces: loadTraces(),
    media: buildMediaOpsStatus(),
    virtualOffice: buildVirtualOfficeStatus(),
    secondBrain: loadSecondBrain(),
    strategicPilots: loadStrategicPilots(),
    aiRadar: loadAiRadar(),
    aiStack: loadAiStack(),
    jrcHub: buildJrcHubStatus(),
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
    source: "next-api",
    updatedAtMs: Date.now(),
  };
};

export async function GET() {
  try {
    return NextResponse.json(await buildOpsStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load operations status." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as JsonRecord & { action?: unknown; mode?: unknown };
    const action = typeof body.action === "string" ? body.action : "mode.set";
    if (action !== "mode.set" && action !== "costMode.set" && action !== "media.jobs.create" && action !== "virtualOffice.seed" && action !== "secondBrain.ingest" && action !== "secondBrain.seedRecent" && action !== "strategicPilots.seedTop4" && action !== "aiRadar.seed" && action !== "aiStack.seed") {
      return NextResponse.json({ error: "Fallback HTTP only supports safe local Ops actions. Connect gateway for execution actions." }, { status: 400 });
    }
    if (action === "aiStack.seed") {
      createAiStackSeedTasks();
      return NextResponse.json(await buildOpsStatus(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (action === "aiRadar.seed") {
      createAiRadarSeedTasks();
      return NextResponse.json(await buildOpsStatus(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (action === "strategicPilots.seedTop4") {
      createStrategicPilotSeedTasks();
      return NextResponse.json(await buildOpsStatus(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (action === "secondBrain.ingest") {
      ingestSecondBrain(body);
      return NextResponse.json(await buildOpsStatus(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (action === "secondBrain.seedRecent") {
      seedSecondBrainRecent();
      return NextResponse.json(await buildOpsStatus(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (action === "virtualOffice.seed") {
      createVirtualOfficeSeedTasks();
      return NextResponse.json(await buildOpsStatus(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (action === "media.jobs.create") {
      createMediaJob(body);
      return NextResponse.json(await buildOpsStatus(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (action === "costMode.set") {
      const mode = normalizeCostMode(body.mode);
      if (body.mode !== mode) {
        return NextResponse.json({ error: "Cost mode must be economy, balanced or critical." }, { status: 400 });
      }
      writeJsonFile(COST_MODE_FILE, {
        version: 1,
        mode,
        updatedAtMs: Date.now(),
        updatedBy: "operator",
      });
      return NextResponse.json(await buildOpsStatus(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const mode = normalizeMode(body.mode);
    if (body.mode !== mode) {
      return NextResponse.json({ error: "Mode must be manual, assisted or auto_safe." }, { status: 400 });
    }
    writeJsonFile(OPS_MODE_FILE, {
      version: 1,
      mode,
      updatedAtMs: Date.now(),
      updatedBy: "operator",
    });
    return NextResponse.json(await buildOpsStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save operations mode." },
      { status: 500 },
    );
  }
}
