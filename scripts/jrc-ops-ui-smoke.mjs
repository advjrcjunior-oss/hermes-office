import { chromium } from "playwright";

const baseUrl = (process.env.JRC_OFFICE_URL || "http://127.0.0.1:3050").replace(
  /\/$/,
  "",
);

const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || "chrome",
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto(`${baseUrl}/office?hqOpen=1&hq=ops`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(8_000);

  const text = await page.locator("body").innerText({ timeout: 5_000 });
  const maxUpdateErrors = errors.filter((error) =>
    error.includes("Maximum update depth"),
  );
  const failures = [];

if (!text.includes("OPERATIONS")) failures.push("missing Operations panel");
if (!text.includes("KIMI-API")) failures.push("missing Kimi engine");
if (!/\b\d+\s+tarefas\b/.test(text)) failures.push("missing JRC task total");
if (!text.includes("SAFETY LOCKS")) failures.push("missing safety locks");
if (!/sala de reuniao t0/i.test(text)) failures.push("missing meeting room");
if (!/reunir equipe/i.test(text)) failures.push("missing team meeting action");
if (!/\bhoje\b/i.test(text)) failures.push("missing today panel");
if (!/aprovacoes humanas/i.test(text)) failures.push("missing approvals inbox");
if (!/cadeia segura/i.test(text)) failures.push("missing safe chain action");
if (!/salvar resumo do dia/i.test(text)) failures.push("missing end-of-day report action");
if (!/modo de custo/i.test(text)) failures.push("missing cost mode");
if (!/risco operacional/i.test(text)) failures.push("missing risk panel");
if (!/auditoria e traces/i.test(text)) failures.push("missing trace audit");
if (!/media ops/i.test(text)) failures.push("missing media ops");
if (!/criar imagem/i.test(text)) failures.push("missing media image action");
if (!/dry-run/i.test(text)) failures.push("missing media dry-run action");
if (!/escritorio virtual/i.test(text)) failures.push("missing virtual office");
if (!/assumir rotinas humanas/i.test(text)) failures.push("missing virtual office seed action");
if (!/second brain/i.test(text)) failures.push("missing second brain");
if (!/absorver links/i.test(text)) failures.push("missing second brain ingest action");
if (!/pilotos top 4/i.test(text)) failures.push("missing strategic pilots");
if (!/ativar top 4/i.test(text)) failures.push("missing strategic pilots action");
if (!/ai radar/i.test(text)) failures.push("missing AI radar");
if (!/semear radar/i.test(text)) failures.push("missing AI radar seed action");
  if (maxUpdateErrors.length > 0) failures.push("React maximum update loop");
  if (errors.length > maxUpdateErrors.length) failures.push("console errors");

  if (failures.length > 0) {
    throw new Error(
      `Ops UI smoke failed: ${failures.join(", ")}\n${errors
        .slice(0, 5)
        .join("\n")}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: `${baseUrl}/office?hqOpen=1&hq=ops`,
        status: text.match(/HERMES • [A-Z]+/)?.[0] ?? null,
        hasOperations: true,
        hasKimi: true,
        hasTaskTotal: true,
        hasSafety: true,
        hasMeetingRoom: true,
        hasToday: true,
        hasApprovals: true,
        hasCostMode: true,
        hasRisk: true,
        hasTraces: true,
        hasMediaOps: true,
        hasMediaJobs: true,
        hasVirtualOffice: true,
        hasSecondBrain: true,
        hasStrategicPilots: true,
        hasAiRadar: true,
        maxUpdateErrors: 0,
        consoleErrors: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
