import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const settingsPath = path.join(os.homedir(), ".openclaw", "claw3d", "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const profile = settings?.gateway?.profiles?.hermes ?? {};
const gatewayUrl = process.env.JRC_GATEWAY_URL || profile.url || "ws://localhost:18789";

const ws = new WebSocket(gatewayUrl);
let nextId = 1;
const calls = new Map();

const call = (method, params = {}) => {
  const id = `meeting-smoke-${nextId++}`;
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 15_000);
    calls.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject,
    });
  });
};

ws.on("message", (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.type === "event") return;
  if (!frame.id || !calls.has(frame.id)) return;
  const pending = calls.get(frame.id);
  calls.delete(frame.id);
  if (frame.ok === false) {
    pending.reject(new Error(frame.error?.message || JSON.stringify(frame.error)));
    return;
  }
  pending.resolve(frame.payload);
});

ws.on("open", async () => {
  try {
    await call("connect", { token: profile.token });
    const meeting = await call("meetings.start", {
      goal: "Smoke: alinhar equipe JRC sem acao externa.",
      priority: "normal",
    });
    const status = await call("ops.status", {});
    const failures = [];
    if (!meeting?.meeting?.id) failures.push("missing meeting id");
    if (!status?.meetings?.maestro?.agentId) failures.push("missing maestro");
    if (!status?.meetings?.room?.pattern) failures.push("missing meeting pattern");
    if (!Array.isArray(status?.tasks?.approvals)) failures.push("missing approval inbox");
    if (!Array.isArray(status?.today?.summary)) failures.push("missing today panel");
    if (!status?.costMode?.mode) failures.push("missing cost mode");
    if (!status?.risk?.level) failures.push("missing risk panel");
    if (!Array.isArray(status?.traces?.latest)) failures.push("missing traces");
    if (!status?.cadence?.suggestedNext && !Array.isArray(status?.cadence?.daily)) {
      failures.push("missing cadence");
    }
    const traces = await call("ops.traces.list", { limit: 5 });
    if (!Array.isArray(traces?.latest)) failures.push("missing traces method");
    const dryRun = await call("tasks.runChain", { maxSteps: 2, dryRun: true });
    if (!Array.isArray(dryRun?.planned)) failures.push("missing safe chain dry run");
    const report = await call("ops.report.write", { dryRun: true });
    if (!report?.report?.includes("Relatorio operacional")) failures.push("missing end-of-day report dry run");
    if (!status?.safety?.externalActionsLocked) failures.push("safety lock disabled");

    if (failures.length > 0) {
      throw new Error(`Meeting smoke failed: ${failures.join(", ")}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          meetingId: meeting.meeting.id,
          createdTasks: meeting.createdTasks?.length ?? 0,
          meetingTotal: status.meetings.total,
          maestro: status.meetings.maestro.agentId,
          plannedChainTasks: dryRun.planned.length,
          reportDryRun: report.dryRun,
          costMode: status.costMode.mode,
          risk: status.risk.level,
          traces: status.traces.total ?? 0,
          approvals: status.tasks.approval?.pending ?? 0,
          externalActionsLocked: status.safety.externalActionsLocked,
        },
        null,
        2,
      ),
    );
    ws.close();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    ws.close();
    process.exitCode = 1;
  }
});

ws.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
