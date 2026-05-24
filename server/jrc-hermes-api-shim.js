"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");

function loadDotEnv(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // Environment loading is best-effort; defaults keep the shim usable.
  }
}

loadDotEnv(path.join(process.cwd(), ".env"));

const PORT = Number.parseInt(process.env.JRC_HERMES_SHIM_PORT || "18642", 10);
const SSH_TARGET = process.env.JRC_HERMES_SSH_TARGET || "vps";
const ENABLE_REMOTE_HERMES = process.env.JRC_ENABLE_REMOTE_HERMES === "1";
const REMOTE_HERMES =
  process.env.JRC_REMOTE_HERMES ||
  "/root/hermes-agent/venv/bin/python -m hermes_cli.main";
const MODEL = process.env.JRC_HERMES_MODEL || "hermes-remote";
const CLAUDE_MODEL = process.env.JRC_CLAUDE_MODEL || "";
const CODEX_MODEL = process.env.JRC_CODEX_MODEL || "";
const KIMI_API_KEY = process.env.JRC_KIMI_API_KEY || process.env.KIMI_API_KEY || "";
const KIMI_ENABLED = process.env.JRC_KIMI_ENABLED !== "0" && Boolean(KIMI_API_KEY);
const KIMI_BASE_URL = (
  process.env.JRC_KIMI_BASE_URL ||
  process.env.KIMI_BASE_URL ||
  "https://api.moonshot.ai/v1"
).replace(/\/$/, "");
const KIMI_MODEL =
  process.env.JRC_KIMI_MODEL ||
  process.env.KIMI_MODEL_COMPLEX ||
  process.env.KIMI_MODEL ||
  "kimi-k2";
const OLLAMA_URL = (process.env.JRC_OLLAMA_URL || "http://127.0.0.1:11434").replace(
  /\/$/,
  "",
);
const OLLAMA_MODEL = process.env.JRC_OLLAMA_MODEL || "phi4:14b";
const MAX_BODY_BYTES = 1024 * 1024;
const HOME = os.homedir();
const ENGINE_USAGE_FILE = path.join(HOME, ".hermes", "jrc-engine-usage.json");
const CLAUDE_DAILY_LIMIT = Number.parseInt(process.env.JRC_CLAUDE_DAILY_LIMIT || "20", 10);
const CODEX_DAILY_LIMIT = Number.parseInt(process.env.JRC_CODEX_DAILY_LIMIT || "10", 10);
const KIMI_DAILY_LIMIT = Number.parseInt(process.env.JRC_KIMI_DAILY_LIMIT || "40", 10);
const ENGINE_COOLDOWN_MS = Number.parseInt(process.env.JRC_ENGINE_COOLDOWN_MS || "60000", 10);
const KIMI_TIMEOUT_MS = Number.parseInt(process.env.JRC_KIMI_TIMEOUT_MS || "90000", 10);

const SAFETY_SYSTEM_PROMPT =
  "Voce integra o escritorio 3D JRC como membro de equipe. Responda em PT-BR, seja objetivo e aja como uma pessoa da equipe. Hard locks: nao protocolar, enviar peticao, submeter, agendar protocolo, cobrar, contatar terceiros ou executar acao externa sem aprovacao humana explicita. Nao exponha credenciais, tokens, cookies, certificados ou dados sensiveis.";

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

const todayKey = () => new Date().toISOString().slice(0, 10);

let engineUsage = {
  date: todayKey(),
  engines: {},
  lastCallAtMs: {},
  blocked: [],
};

function loadEngineUsage() {
  try {
    if (!fs.existsSync(ENGINE_USAGE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(ENGINE_USAGE_FILE, "utf8"));
    if (parsed && typeof parsed === "object") engineUsage = { ...engineUsage, ...parsed };
  } catch {
    // Start fresh if usage file is corrupt.
  }
}

function saveEngineUsage() {
  try {
    fs.mkdirSync(path.dirname(ENGINE_USAGE_FILE), { recursive: true });
    fs.writeFileSync(ENGINE_USAGE_FILE, JSON.stringify({ version: 1, ...engineUsage }, null, 2), "utf8");
  } catch {
    // Usage accounting must not leak secrets or crash the shim.
  }
}

function ensureEngineUsageDate() {
  const current = todayKey();
  if (engineUsage.date === current) return;
  engineUsage = { date: current, engines: {}, lastCallAtMs: {}, blocked: [] };
  saveEngineUsage();
}

function engineLimit(engine) {
  if (engine === "claude-cli") return CLAUDE_DAILY_LIMIT;
  if (engine === "codex-cli") return CODEX_DAILY_LIMIT;
  if (engine === "kimi-api") return KIMI_DAILY_LIMIT;
  return Number.POSITIVE_INFINITY;
}

function checkEngineBudget(engine) {
  ensureEngineUsageDate();
  const limit = engineLimit(engine);
  if (!Number.isFinite(limit)) return { ok: true };
  const used = Number(engineUsage.engines?.[engine] || 0);
  if (used >= limit) return { ok: false, reason: "daily_engine_limit", used, limit };
  const last = Number(engineUsage.lastCallAtMs?.[engine] || 0);
  const elapsed = Date.now() - last;
  if (last && elapsed < ENGINE_COOLDOWN_MS) {
    return { ok: false, reason: "engine_cooldown", retryAfterMs: ENGINE_COOLDOWN_MS - elapsed, used, limit };
  }
  return { ok: true, used, limit };
}

function recordEngineUsage(engine, status, detail = "") {
  ensureEngineUsageDate();
  if (status === "started") {
    engineUsage.engines = {
      ...(engineUsage.engines || {}),
      [engine]: Number(engineUsage.engines?.[engine] || 0) + 1,
    };
    engineUsage.lastCallAtMs = {
      ...(engineUsage.lastCallAtMs || {}),
      [engine]: Date.now(),
    };
  } else if (status === "blocked") {
    engineUsage.blocked = [
      { atMs: Date.now(), engine, reason: detail },
      ...(engineUsage.blocked || []),
    ].slice(0, 80);
  }
  saveEngineUsage();
}

loadEngineUsage();

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 90000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || HOME,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const cleanStdout = stripAnsi(stdout);
      const cleanStderr = stripAnsi(stderr);
      if (code === 0 && cleanStdout) {
        resolve(cleanStdout);
        return;
      }
      reject(new Error(cleanStderr || `${command} exited with ${code}`));
    });
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function promptFromMessages(messages) {
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message?.role === "string" ? message.role : "user";
    const text = normalizeContent(message?.content).trim();
    if (!text) continue;
    lines.push(`${role.toUpperCase()}: ${text}`);
  }
  return lines.join("\n\n").trim() || "Responda em PT-BR.";
}

function postJson(url, payload, headers = {}, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`POST ${target.origin}${target.pathname} timed out`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function runLocalOllama(prompt) {
  const response = await postJson(`${OLLAMA_URL}/api/chat`, {
    model: OLLAMA_MODEL,
    stream: false,
    messages: [
      {
        role: "system",
        content: SAFETY_SYSTEM_PROMPT,
      },
      { role: "user", content: prompt },
    ],
  });
  return response?.message?.content?.trim() || "";
}

async function runKimi(prompt) {
  if (!KIMI_ENABLED) throw new Error("kimi-api disabled or missing key");
  const budget = checkEngineBudget("kimi-api");
  if (!budget.ok) {
    recordEngineUsage("kimi-api", "blocked", budget.reason);
    throw new Error(`kimi-api budget blocked: ${budget.reason}`);
  }
  recordEngineUsage("kimi-api", "started");
  const response = await postJson(
    `${KIMI_BASE_URL}/chat/completions`,
    {
      model: KIMI_MODEL,
      messages: [
        { role: "system", content: SAFETY_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: KIMI_MODEL.toLowerCase().startsWith("kimi-k2") ? 1 : 0.2,
      max_tokens: 1600,
    },
    { authorization: `Bearer ${KIMI_API_KEY}` },
    KIMI_TIMEOUT_MS,
  );
  return response?.choices?.[0]?.message?.content?.trim() || "";
}

function runClaude(prompt) {
  const budget = checkEngineBudget("claude-cli");
  if (!budget.ok) {
    recordEngineUsage("claude-cli", "blocked", budget.reason);
    throw new Error(`claude-cli budget blocked: ${budget.reason}`);
  }
  recordEngineUsage("claude-cli", "started");
  const args = [
    "-p",
    prompt,
    "--system-prompt",
    SAFETY_SYSTEM_PROMPT,
    "--permission-mode",
    "default",
  ];
  if (CLAUDE_MODEL) args.push("--model", CLAUDE_MODEL);
  return runProcess("claude", args, { timeoutMs: 90000 });
}

async function runCodex(prompt) {
  const budget = checkEngineBudget("codex-cli");
  if (!budget.ok) {
    recordEngineUsage("codex-cli", "blocked", budget.reason);
    throw new Error(`codex-cli budget blocked: ${budget.reason}`);
  }
  recordEngineUsage("codex-cli", "started");
  const outputFile = path.join(os.tmpdir(), `jrc-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile,
    "-C",
    HOME,
  ];
  if (CODEX_MODEL) args.push("-m", CODEX_MODEL);
  args.push(`${SAFETY_SYSTEM_PROMPT}\n\n${prompt}`);
  try {
    await runProcess("codex", args, { timeoutMs: 90000 });
    if (fs.existsSync(outputFile)) {
      const content = fs.readFileSync(outputFile, "utf8").trim();
      if (content) return content;
    }
    return "";
  } finally {
    try {
      fs.rmSync(outputFile, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function runRemoteHermes(prompt) {
  return new Promise((resolve, reject) => {
    const command = `${REMOTE_HERMES} chat -Q --source tool -q ${JSON.stringify(prompt)}`;
    const child = spawn("ssh", [SSH_TARGET, command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Remote Hermes timed out"));
    }, 25000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `Remote Hermes exited with ${code}`));
    });
  });
}

function selectEngine(prompt, requestedModel) {
  const text = `${requestedModel || ""}\n${prompt}`.toLowerCase();
  if (text.includes("kimi") || text.includes("moonshot")) {
    return "kimi";
  }
  if (text.includes("ollama") || text.includes("local-only") || text.includes("pii")) {
    return "ollama";
  }
  if (
    text.includes("devops") ||
    text.includes("vps") ||
    text.includes("deploy") ||
    text.includes("codigo") ||
    text.includes("código") ||
    text.includes("code") ||
    text.includes("api") ||
    text.includes("n8n") ||
    text.includes("jrc hub")
  ) {
    return "codex";
  }
  if (
    text.includes("juridico") ||
    text.includes("jurídico") ||
    text.includes("peticao") ||
    text.includes("petição") ||
    text.includes("recurso") ||
    text.includes("revisão 10/10") ||
    text.includes("revisao 10/10") ||
    text.includes("desembargador") ||
    text.includes("juiz") ||
    text.includes("sentenca") ||
    text.includes("sentença") ||
    text.includes("merito") ||
    text.includes("mérito") ||
    text.includes("revisor")
  ) {
    return "claude";
  }
  if (
    text.includes("legalmail") ||
    text.includes("bpc") ||
    text.includes("loas") ||
    text.includes("marketing") ||
    text.includes("comercial") ||
    text.includes("financeiro") ||
    text.includes("prazos") ||
    text.includes("inbox") ||
    text.includes("triagem") ||
    text.includes("sintese") ||
    text.includes("síntese") ||
    text.includes("resumo longo") ||
    text.includes("analise longa") ||
    text.includes("análise longa") ||
    text.includes("estrategia inicial") ||
    text.includes("estratégia inicial")
  ) {
    return KIMI_ENABLED ? "kimi" : "claude";
  }
  return KIMI_ENABLED ? "kimi" : "claude";
}

async function runSelectedEngine(prompt, requestedModel) {
  const engine = selectEngine(prompt, requestedModel);
  const attempts = [];
  const tryEngine = async (name, runner) => {
    try {
      const content = await runner();
      if (content) return { engine: name, content };
    } catch (error) {
      attempts.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  };

  const fallbackOrder =
    engine === "codex"
      ? ["codex-cli", "kimi-api", "ollama"]
      : engine === "claude"
        ? ["claude-cli", "kimi-api", "ollama"]
        : engine === "ollama"
          ? ["ollama"]
          : ["kimi-api", "ollama"];

  for (const name of fallbackOrder) {
    const result =
      name === "codex-cli"
        ? await tryEngine(name, () => runCodex(prompt))
        : name === "claude-cli"
          ? await tryEngine(name, () => runClaude(prompt))
          : name === "kimi-api"
            ? await tryEngine(name, () => runKimi(prompt))
            : await tryEngine(name, () => runLocalOllama(prompt));
    if (result) return result;
  }

  if (ENABLE_REMOTE_HERMES) {
    const remote = await tryEngine("hermes-remote", () => runRemoteHermes(prompt));
    if (remote) return remote;
  }

  const local = await tryEngine("ollama", () => runLocalOllama(prompt));
  if (local) return local;
  return {
    engine: "error",
    content: `Nao consegui obter resposta dos motores configurados. Tentativas: ${attempts.join(" | ")}`,
  };
}

async function handleChat(req, res) {
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const prompt = promptFromMessages(body.messages);
    const result = await runSelectedEngine(prompt, body.model);
    sendJson(res, 200, {
      id: `chatcmpl-jrc-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: result.engine || body.model || MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.content },
          finish_reason: "stop",
        },
      ],
    });
  } catch (error) {
    sendJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "jrc_hermes_shim_error",
      },
    });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", service: "jrc-hermes-api-shim" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/usage") {
    ensureEngineUsageDate();
    sendJson(res, 200, {
      ...engineUsage,
      limits: {
        "claude-cli": CLAUDE_DAILY_LIMIT,
        "codex-cli": CODEX_DAILY_LIMIT,
        "kimi-api": KIMI_DAILY_LIMIT,
        engineCooldownMs: ENGINE_COOLDOWN_MS,
      },
      enabled: {
        "kimi-api": KIMI_ENABLED,
      },
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: [
        { id: MODEL, object: "model", owned_by: "jrc" },
        { id: "claude-cli", object: "model", owned_by: "anthropic-plan" },
        { id: "codex-cli", object: "model", owned_by: "openai-plan" },
        { id: "kimi-api", object: "model", owned_by: "moonshot-kimi" },
        { id: OLLAMA_MODEL, object: "model", owned_by: "local-ollama" },
      ],
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    void handleChat(req, res);
    return;
  }
  sendJson(res, 404, { error: { message: "Not found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[jrc-hermes-api-shim] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[jrc-hermes-api-shim] Engines: claude-cli, codex-cli, kimi-api=${KIMI_ENABLED ? "enabled" : "disabled"}, ${OLLAMA_MODEL}`);
  console.log(`[jrc-hermes-api-shim] Remote target: ${SSH_TARGET} (${ENABLE_REMOTE_HERMES ? "enabled" : "disabled"})`);
});
