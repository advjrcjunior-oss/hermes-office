const baseUrl = process.env.JRC_OFFICE_URL || "http://127.0.0.1:3050";

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/office/ops`, {
  cache: "no-store",
});

if (!response.ok) {
  throw new Error(`Ops API returned HTTP ${response.status}`);
}

const payload = await response.json();
const failures = [];

if (!payload?.mode?.mode) failures.push("missing mode");
if (!payload?.budget?.limits) failures.push("missing budget limits");
if (!payload?.engines?.limits) failures.push("missing engine limits");
if (typeof payload?.tasks?.total !== "number") failures.push("missing task total");
if (!payload?.meetings?.maestro?.agentId) failures.push("missing maestro meeting status");
if (!Array.isArray(payload?.cadence?.daily)) failures.push("missing cadence");
if (!Array.isArray(payload?.today?.summary)) failures.push("missing today summary");
if (!payload?.safety?.externalActionsLocked) failures.push("safety lock is not enabled");

if (failures.length > 0) {
  throw new Error(`Ops smoke failed: ${failures.join(", ")}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      source: payload.source,
      mode: payload.mode.mode,
      taskTotal: payload.tasks.total,
      engines: payload.engines.engines ?? {},
      limits: payload.engines.limits ?? {},
      meetings: payload.meetings.total ?? 0,
      approvals: payload.tasks.approval?.pending ?? 0,
      todayReady: payload.today.workflow?.ready ?? 0,
      autoRunEnabled: payload.budget.limits.autoRunEnabled,
      externalActionsLocked: payload.safety.externalActionsLocked,
    },
    null,
    2,
  ),
);
