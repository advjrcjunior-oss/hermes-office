import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const HOME = os.homedir();
const TASKS_FILE = path.join(HOME, ".hermes", "jrc-operational-tasks.json");
const BUDGET_FILE = path.join(HOME, ".hermes", "jrc-agent-budget.json");
const OPS_MODE_FILE = path.join(HOME, ".hermes", "jrc-office-ops-mode.json");
const MEETINGS_FILE = path.join(HOME, ".hermes", "jrc-office-meetings.json");

const HERMES_API_URL = (process.env.HERMES_API_URL || "http://127.0.0.1:18642").replace(/\/$/, "");
const JRC_TASK_RUN_DAILY_LIMIT = Number.parseInt(process.env.JRC_TASK_RUN_DAILY_LIMIT || "6", 10);
const JRC_TASK_RUN_DOMAIN_DAILY_LIMIT = Number.parseInt(process.env.JRC_TASK_RUN_DOMAIN_DAILY_LIMIT || "2", 10);
const JRC_TASK_RUN_COOLDOWN_MS = Number.parseInt(process.env.JRC_TASK_RUN_COOLDOWN_MS || "180000", 10);
const JRC_AUTO_RUN_ENABLED = process.env.JRC_AUTO_RUN_ENABLED === "1";
const JRC_HUB_BASE_URL = (process.env.JRC_HUB_BASE_URL || "http://127.0.0.1:8150").replace(/\/$/, "");
const JRC_HUB_MCP_READONLY_KEY = process.env.JRC_HUB_MCP_READONLY_KEY || "";

const OPS_MODES = new Set(["manual", "assisted", "auto_safe"]);

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

const buildOpsStatus = async () => ({
  mode: buildOpsModeStatus(),
  budget: loadBudget(),
  engines: await fetchEngineUsage(),
  enginePolicy: buildEnginePolicy(),
  tasks: loadTasks(),
  meetings: loadMeetings(),
  cadence: loadCadence(),
  today: loadToday(),
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
});

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
    const body = (await request.json()) as { action?: unknown; mode?: unknown };
    const action = typeof body.action === "string" ? body.action : "mode.set";
    if (action !== "mode.set") {
      return NextResponse.json({ error: "Fallback HTTP only supports mode.set. Connect gateway for team meetings." }, { status: 400 });
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
