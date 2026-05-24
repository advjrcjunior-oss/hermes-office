"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayClient, GatewayStatus } from "@/lib/gateway/GatewayClient";

type OpsMode = "manual" | "assisted" | "auto_safe";
type CostMode = "economy" | "balanced" | "critical";

type OpsStatus = {
  mode?: {
    mode?: OpsMode;
    labels?: Record<string, string>;
    externalActionsLocked?: boolean;
    autoRunEnabled?: boolean;
    note?: string;
  };
  costMode?: {
    mode?: CostMode;
    labels?: Record<string, string>;
    routing?: string;
    hardLocks?: string[];
  };
  budget?: {
    totalRuns?: number;
    remainingTotal?: number;
    byDomain?: Record<string, number>;
    blocked?: Array<{ reason?: string; title?: string; domain?: string }>;
    limits?: {
      totalDaily?: number;
      perDomainDaily?: number;
      cooldownMs?: number;
      autoRunEnabled?: boolean;
    };
  };
  engines?: {
    ok?: boolean;
    engines?: Record<string, number>;
    limits?: Record<string, number>;
    enabled?: Record<string, boolean>;
    blocked?: Array<{ engine?: string; reason?: string }>;
    error?: string;
  };
  enginePolicy?: {
    rules?: Array<{ domain?: string; preferred?: string; reason?: string }>;
    hardLocks?: string[];
  };
  tasks?: {
    total?: number;
    byStatus?: Record<string, number>;
    byDomain?: Record<string, number>;
    approval?: { pending?: number; required?: number };
    next?: Array<{
      id: string;
      title: string;
      status: string;
      priority: string;
      domain: string;
      assignedAgentId?: string;
      riskLevel?: string;
      traceId?: string | null;
      qualityScore?: { score?: number; verdict?: string; checks?: string[] };
      approval?: { status?: string; reason?: string; required?: boolean };
    }>;
    approvals?: Array<{
      id: string;
      title: string;
      status?: string;
      priority: string;
      domain: string;
      assignedAgentId?: string;
      riskLevel?: string;
      traceId?: string | null;
      qualityScore?: { score?: number; verdict?: string; checks?: string[] };
      approval?: { status?: string; reason?: string; required?: boolean };
    }>;
  };
  risk?: {
    level?: string;
    pendingApprovals?: number;
    blockedTasks?: number;
    reviewTasks?: number;
    highRiskTasks?: number;
    budgetRemaining?: number;
    engineBlocked?: number;
    hubFailures?: number;
    flags?: string[];
  };
  traces?: {
    total?: number;
    latest?: Array<{
      id?: string;
      kind?: string;
      status?: string;
      taskId?: string | null;
      meetingId?: string | null;
      agentId?: string | null;
      domain?: string | null;
      engine?: string | null;
      riskLevel?: string | null;
      qualityScore?: { score?: number; verdict?: string; checks?: string[] } | null;
      message?: string;
    }>;
  };
  meetings?: {
    total?: number;
    latest?: Array<{
      id?: string;
      goal?: string;
      domain?: string;
      status?: string;
      taskIds?: string[];
      agenda?: string[];
      decisions?: string[];
      participants?: Array<{ agentId?: string; name?: string; role?: string }>;
    }>;
    maestro?: { agentId?: string; name?: string; role?: string };
    room?: { name?: string; pattern?: string };
  };
  cadence?: {
    daily?: Array<{ label?: string; action?: string }>;
    suggestedNext?: {
      id?: string;
      title?: string;
      domain?: string;
      priority?: string;
      assignedAgentId?: string;
    } | null;
    approvals?: Array<{ id?: string; title?: string; domain?: string; priority?: string }>;
    blocked?: Array<{ id?: string; title?: string; domain?: string; priority?: string }>;
    policy?: string;
  };
  today?: {
    summary?: Array<{ label?: string; value?: number }>;
    workflow?: {
      ready?: number;
      running?: number;
      blocked?: number;
      review?: number;
      approvals?: number;
    };
    latestMeeting?: {
      id?: string;
      goal?: string;
      domain?: string;
      status?: string;
    } | null;
  };
  media?: {
    ok?: boolean;
    configuredCount?: number;
    total?: number;
    providers?: Array<{
      id?: string;
      label?: string;
      kind?: string;
      configured?: boolean;
      role?: string;
      defaultUse?: string;
      approval?: string;
    }>;
    pipeline?: Array<{
      step?: string;
      owner?: string;
      tool?: string;
      configured?: boolean;
      note?: string;
    }>;
    budgetPolicy?: {
      paidGenerationRequiresApproval?: boolean;
      publishRequiresApproval?: boolean;
      highCostVideoRequiresApproval?: boolean;
    };
    recommendedDefault?: string;
    missing?: string[];
  };
  jrcHub?: {
    ok?: boolean;
    readOnlyKeyConfigured?: boolean;
    sources?: Record<string, { ok?: boolean; path?: string; error?: string }>;
    error?: string;
  };
  safety?: {
    externalActionsLocked?: boolean;
    forbiddenWithoutApproval?: string[];
  };
  updatedAtMs?: number;
};

const MODE_OPTIONS: Array<{ id: OpsMode; label: string; description: string }> = [
  {
    id: "manual",
    label: "Manual",
    description: "A equipe conversa e organiza. Execucao automatica permanece travada.",
  },
  {
    id: "assisted",
    label: "Assistido",
    description: "Prepara tarefas, recomenda proximos passos e pede aprovacao.",
  },
  {
    id: "auto_safe",
    label: "Auto seguro",
    description: "Somente baixo risco/read-only. Auto-run global continua respeitando o .env.",
  },
];

const COST_MODE_OPTIONS: Array<{ id: CostMode; label: string; description: string }> = [
  {
    id: "economy",
    label: "Economia",
    description: "Volume e triagem em Kimi/Ollama; motores fortes so quando voce pedir.",
  },
  {
    id: "balanced",
    label: "Balanceado",
    description: "Roteamento normal: custo baixo no volume, Claude/Codex para tarefas criticas.",
  },
  {
    id: "critical",
    label: "Critico",
    description: "Prioriza qualidade para incidentes, arquitetura e juridico sensivel, ainda com budget.",
  },
];

const formatNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : "0";

const formatCooldown = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0s";
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60_000)}min`;
};

const sortRecordEntries = (record?: Record<string, number>) =>
  Object.entries(record ?? {}).sort((left, right) => right[1] - left[1]);

export function OperationsPanel({
  client,
  status,
}: {
  client: GatewayClient;
  status: GatewayStatus;
}) {
  const clientRef = useRef(client);
  const statusRef = useRef(status);
  const [snapshot, setSnapshot] = useState<OpsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingMode, setSavingMode] = useState<OpsMode | null>(null);
  const [savingCostMode, setSavingCostMode] = useState<CostMode | null>(null);
  const [meetingGoal, setMeetingGoal] = useState("Priorizar o dia da JRC e delegar proximas tarefas com safety locks.");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    clientRef.current = client;
    statusRef.current = status;
  }, [client, status]);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const currentStatus = statusRef.current;
      const currentClient = clientRef.current;
      const result =
        currentStatus === "connected"
          ? await currentClient.call<OpsStatus>("ops.status", {})
          : await fetch("/api/office/ops", { cache: "no-store" }).then(async (response) => {
              const payload = (await response.json()) as OpsStatus & { error?: string };
              if (!response.ok) throw new Error(payload.error || "Failed to load operations status.");
              return payload;
            });
      setSnapshot(result);
    } catch (err) {
      try {
        const fallback = await fetch("/api/office/ops", { cache: "no-store" }).then(async (response) => {
          const payload = (await response.json()) as OpsStatus & { error?: string };
          if (!response.ok) throw new Error(payload.error || "Failed to load operations status.");
          return payload;
        });
        setSnapshot(fallback);
        setError(null);
      } catch (fallbackErr) {
        setError(fallbackErr instanceof Error ? fallbackErr.message : "Failed to load operations status.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (status !== "connected") return;
    const timer = window.setInterval(() => {
      void loadStatus();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [loadStatus, status]);

  const handleModeChange = useCallback(
    async (mode: OpsMode) => {
      setSavingMode(mode);
      setError(null);
      try {
        const result =
          status === "connected"
            ? await client.call<OpsStatus>("ops.mode.set", { mode })
              : await fetch("/api/office/ops", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "mode.set", mode }),
              }).then(async (response) => {
                const payload = (await response.json()) as OpsStatus & { error?: string };
                if (!response.ok) throw new Error(payload.error || "Failed to save mode.");
                return payload;
              });
        setSnapshot(result);
      } catch (err) {
        try {
            const fallback = await fetch("/api/office/ops", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "mode.set", mode }),
          }).then(async (response) => {
            const payload = (await response.json()) as OpsStatus & { error?: string };
            if (!response.ok) throw new Error(payload.error || "Failed to save mode.");
            return payload;
          });
          setSnapshot(fallback);
          setError(null);
        } catch (fallbackErr) {
          setError(fallbackErr instanceof Error ? fallbackErr.message : "Failed to save mode.");
        }
      } finally {
        setSavingMode(null);
      }
    },
    [client, loadStatus, status],
  );

  const handleCostModeChange = useCallback(
    async (mode: CostMode) => {
      setSavingCostMode(mode);
      setError(null);
      try {
        const result =
          status === "connected"
            ? await client.call<OpsStatus>("ops.costMode.set", { mode }).then(async () => client.call<OpsStatus>("ops.status", {}))
            : await fetch("/api/office/ops", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "costMode.set", mode }),
              }).then(async (response) => {
                const payload = (await response.json()) as OpsStatus & { error?: string };
                if (!response.ok) throw new Error(payload.error || "Failed to save cost mode.");
                return payload;
              });
        setSnapshot(result);
      } catch (err) {
        try {
          const fallback = await fetch("/api/office/ops", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "costMode.set", mode }),
          }).then(async (response) => {
            const payload = (await response.json()) as OpsStatus & { error?: string };
            if (!response.ok) throw new Error(payload.error || "Failed to save cost mode.");
            return payload;
          });
          setSnapshot(fallback);
          setError(null);
        } catch (fallbackErr) {
          setError(fallbackErr instanceof Error ? fallbackErr.message : "Failed to save cost mode.");
        }
      } finally {
        setSavingCostMode(null);
      }
    },
    [client, status],
  );

  const runGatewayAction = useCallback(
    async (action: string, callback: () => Promise<unknown>) => {
      if (status !== "connected") {
        setError("Conecte o gateway para executar reunioes, sync ou fila. O snapshot HTTP continua read-only.");
        return;
      }
      setActionBusy(action);
      setError(null);
      try {
        await callback();
        await loadStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Falha ao executar ${action}.`);
      } finally {
        setActionBusy(null);
      }
    },
    [loadStatus, status],
  );

  const handleStartMeeting = useCallback(() => {
    void runGatewayAction("meeting", async () => {
      const goal = meetingGoal.trim();
      if (!goal) throw new Error("Informe um objetivo para a reuniao.");
      return client.call("meetings.start", { goal, priority: "high" });
    });
  }, [client, meetingGoal, runGatewayAction]);

  const handleRunNext = useCallback(() => {
    void runGatewayAction("runNext", async () => client.call("tasks.runNext", {}));
  }, [client, runGatewayAction]);

  const handleRunChain = useCallback(() => {
    void runGatewayAction("runChain", async () => client.call("tasks.runChain", { maxSteps: 3 }));
  }, [client, runGatewayAction]);

  const handleSyncHub = useCallback(() => {
    void runGatewayAction("syncHub", async () => client.call("jrcHub.syncTriggers", {}));
  }, [client, runGatewayAction]);

  const handleWriteReport = useCallback(() => {
    void runGatewayAction("report", async () => client.call("ops.report.write", {}));
  }, [client, runGatewayAction]);

  const handleApproval = useCallback(
    (taskId: string, approved: boolean) => {
      void runGatewayAction(approved ? "approve" : "reject", async () =>
        client.call("tasks.approval.resolve", {
          id: taskId,
          approved,
          note: approved
            ? "Aprovado visualmente no painel Ops."
            : "Rejeitado visualmente no painel Ops.",
        }),
      );
    },
    [client, runGatewayAction],
  );

  const handleRequestReview = useCallback(
    (taskId: string) => {
      void runGatewayAction("review", async () =>
        client.call("tasks.update", {
          id: taskId,
          status: "review",
          note: "Revisao solicitada visualmente no painel Ops.",
        }),
      );
    },
    [client, runGatewayAction],
  );

  const currentMode = snapshot?.mode?.mode ?? "assisted";
  const currentCostMode = snapshot?.costMode?.mode ?? "balanced";
  const engineEntries = useMemo(
    () => sortRecordEntries(snapshot?.engines?.engines),
    [snapshot?.engines?.engines],
  );
  const domainEntries = useMemo(
    () => sortRecordEntries(snapshot?.tasks?.byDomain),
    [snapshot?.tasks?.byDomain],
  );
  const hubSources = useMemo(
    () => Object.entries(snapshot?.jrcHub?.sources ?? {}),
    [snapshot?.jrcHub?.sources],
  );
  const latestMeeting = snapshot?.meetings?.latest?.[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#05070a] text-white">
      <div className="border-b border-cyan-500/15 px-4 py-3">
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-300/80">
          Operations
        </div>
        <div className="mt-1 font-mono text-[11px] text-white/45">
          Motores, fila, safety locks e JRC Hub.
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {status !== "connected" ? (
          <div className="rounded border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            Gateway ainda nao conectou; exibindo snapshot local seguro.
          </div>
        ) : null}
        {error ? (
          <div className="mb-3 rounded border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-100">
            {error}
          </div>
        ) : null}

        <section className="rounded border border-cyan-500/15 bg-cyan-950/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200/80">
              Modo operacional
            </div>
            <button
              type="button"
              onClick={() => void loadStatus()}
              className="rounded border border-cyan-500/20 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-100/70 transition hover:border-cyan-400/40 hover:text-cyan-50"
            >
              {loading ? "Atualizando" : "Atualizar"}
            </button>
          </div>
          <div className="mt-3 grid gap-2">
            {MODE_OPTIONS.map((mode) => {
              const active = currentMode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => void handleModeChange(mode.id)}
                  disabled={savingMode !== null}
                  className={`rounded border px-3 py-2 text-left transition ${
                    active
                      ? "border-cyan-300/40 bg-cyan-500/12 text-cyan-50"
                      : "border-white/10 bg-black/20 text-white/65 hover:border-cyan-400/25 hover:text-white"
                  }`}
                >
                  <div className="font-mono text-[11px] uppercase tracking-[0.14em]">
                    {savingMode === mode.id ? "Salvando..." : mode.label}
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-white/45">{mode.description}</div>
                </button>
              );
            })}
          </div>
          {snapshot?.mode?.note ? (
            <div className="mt-3 rounded border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100/85">
              {snapshot.mode.note}
            </div>
          ) : null}
        </section>

        <section className="mt-3 rounded border border-emerald-400/15 bg-emerald-950/10 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-100/75">
            Modo de custo
          </div>
          <div className="mt-3 grid gap-2">
            {COST_MODE_OPTIONS.map((mode) => {
              const active = currentCostMode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => void handleCostModeChange(mode.id)}
                  disabled={savingCostMode !== null}
                  className={`rounded border px-3 py-2 text-left transition ${
                    active
                      ? "border-emerald-300/40 bg-emerald-500/12 text-emerald-50"
                      : "border-white/10 bg-black/20 text-white/65 hover:border-emerald-400/25 hover:text-white"
                  }`}
                >
                  <div className="font-mono text-[11px] uppercase tracking-[0.14em]">
                    {savingCostMode === mode.id ? "Salvando..." : mode.label}
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-white/45">{mode.description}</div>
                </button>
              );
            })}
          </div>
          {snapshot?.costMode?.routing ? (
            <div className="mt-3 rounded border border-white/10 bg-black/20 px-2 py-2 text-[11px] leading-4 text-white/55">
              {snapshot.costMode.routing}
            </div>
          ) : null}
        </section>

        <section className="mt-3 rounded border border-amber-400/20 bg-amber-500/8 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-100/80">
              Risco operacional
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber-100/55">
              {snapshot?.risk?.level ?? "normal"}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1.5">
            {[
              ["OK?", snapshot?.risk?.pendingApprovals],
              ["Block", snapshot?.risk?.blockedTasks],
              ["Review", snapshot?.risk?.reviewTasks],
              ["Alto", snapshot?.risk?.highRiskTasks],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded border border-amber-300/15 bg-black/20 px-1.5 py-1.5 text-center">
                <div className="font-mono text-[8px] uppercase text-amber-100/40">{label}</div>
                <div className="mt-0.5 text-sm font-semibold text-white">{formatNumber(value)}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(snapshot?.risk?.flags ?? []).slice(0, 5).map((flag) => (
              <span key={flag} className="rounded border border-amber-300/15 bg-black/20 px-2 py-1 text-[10px] text-amber-100/70">
                {flag}
              </span>
            ))}
            {(snapshot?.risk?.flags ?? []).length === 0 ? (
              <span className="text-[11px] text-white/35">Sem alertas criticos no snapshot atual.</span>
            ) : null}
          </div>
        </section>

        <section className="mt-3 rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
              Hoje
            </div>
            <div className="font-mono text-[10px] text-white/35">
              {formatNumber(snapshot?.today?.workflow?.ready)} prontas
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(snapshot?.today?.summary ?? []).map((item) => (
              <div key={item.label} className="rounded border border-white/10 bg-black/20 px-2 py-2">
                <div className="truncate font-mono text-[9px] uppercase tracking-[0.08em] text-white/40">
                  {item.label}
                </div>
                <div className="mt-1 text-lg font-semibold text-white">{formatNumber(item.value)}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-5 gap-1.5">
            {[
              ["Todo", snapshot?.today?.workflow?.ready],
              ["Run", snapshot?.today?.workflow?.running],
              ["Block", snapshot?.today?.workflow?.blocked],
              ["Review", snapshot?.today?.workflow?.review],
              ["OK?", snapshot?.today?.workflow?.approvals],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded border border-white/10 bg-black/20 px-1.5 py-1.5 text-center">
                <div className="font-mono text-[8px] uppercase text-white/35">{label}</div>
                <div className="mt-0.5 text-sm font-semibold text-white">{formatNumber(value)}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-3 rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
            Sala de reuniao T0
          </div>
          <div className="mt-2 text-[11px] leading-4 text-white/45">
            {snapshot?.meetings?.maestro?.name ?? "Maestro JRC"} coordena; {snapshot?.meetings?.room?.pattern ?? "especialistas revisam antes de aprovacao"}.
          </div>
          <textarea
            value={meetingGoal}
            onChange={(event) => setMeetingGoal(event.target.value)}
            rows={3}
            className="mt-3 w-full resize-none rounded border border-white/10 bg-black/30 px-2 py-2 text-xs text-white outline-none transition placeholder:text-white/25 focus:border-cyan-300/45"
            placeholder="Objetivo da reuniao da equipe"
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleStartMeeting}
              disabled={actionBusy !== null}
              className="rounded border border-cyan-400/25 bg-cyan-500/10 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan-50 transition hover:border-cyan-300/45 disabled:opacity-45"
            >
              {actionBusy === "meeting" ? "Criando" : "Reunir equipe"}
            </button>
            <button
              type="button"
              onClick={handleRunNext}
              disabled={actionBusy !== null}
              className="rounded border border-emerald-400/25 bg-emerald-500/10 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-50 transition hover:border-emerald-300/45 disabled:opacity-45"
            >
              {actionBusy === "runNext" ? "Rodando" : "Rodar proxima"}
            </button>
          </div>
          {latestMeeting ? (
            <div className="mt-3 rounded border border-white/10 bg-black/20 px-2 py-2">
              <div className="line-clamp-2 text-xs text-white/85">{latestMeeting.goal}</div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-white/35">
                {latestMeeting.domain} / {latestMeeting.status} / {latestMeeting.taskIds?.length ?? 0} tarefas
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(latestMeeting.participants ?? []).map((participant) => (
                  <span key={participant.agentId} className="rounded border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.08em] text-white/50">
                    {participant.name ?? participant.agentId}
                  </span>
                ))}
              </div>
              <div className="mt-2 space-y-1">
                {(latestMeeting.agenda ?? []).slice(0, 5).map((item) => (
                  <div key={item} className="text-[11px] leading-4 text-white/45">
                    {item}
                  </div>
                ))}
              </div>
              <div className="mt-2 rounded border border-amber-400/15 bg-amber-500/8 px-2 py-2">
                {(latestMeeting.decisions ?? []).slice(0, 3).map((item) => (
                  <div key={item} className="text-[11px] leading-4 text-amber-100/75">
                    {item}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-3 text-[11px] text-white/35">Nenhuma reuniao registrada ainda.</div>
          )}
        </section>

        <section className="mt-3 rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
            Cadencia diaria
          </div>
          <div className="mt-3 grid gap-1.5">
            {(snapshot?.cadence?.daily ?? []).map((item) => (
              <div key={`${item.label}-${item.action}`} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                <div className="font-mono text-[10px] text-cyan-100/70">{item.label}</div>
                <div className="mt-0.5 text-[11px] leading-4 text-white/55">{item.action}</div>
              </div>
            ))}
          </div>
          {snapshot?.cadence?.suggestedNext ? (
            <div className="mt-3 rounded border border-emerald-400/20 bg-emerald-500/8 px-2 py-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-100/70">
                Proxima sugerida
              </div>
              <div className="mt-1 line-clamp-2 text-xs text-white/85">{snapshot.cadence.suggestedNext.title}</div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-white/35">
                {snapshot.cadence.suggestedNext.priority} / {snapshot.cadence.suggestedNext.domain} /{" "}
                {snapshot.cadence.suggestedNext.assignedAgentId}
              </div>
            </div>
          ) : null}
          <div className="mt-3 text-[11px] leading-4 text-amber-100/75">
            {snapshot?.cadence?.policy}
          </div>
        </section>

        <section className="mt-3 rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
            Consumo de motores
          </div>
          {snapshot?.engines?.ok === false ? (
            <div className="mt-2 text-[11px] text-red-200">{snapshot.engines.error}</div>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {engineEntries.length === 0 ? (
              <div className="col-span-2 text-[11px] text-white/35">Sem uso registrado hoje.</div>
            ) : (
              engineEntries.map(([engine, used]) => {
                const limit = snapshot?.engines?.limits?.[engine];
                return (
                  <div key={engine} className="rounded border border-white/10 bg-black/20 px-2 py-2">
                    <div className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-white/55">
                      {engine}
                    </div>
                    <div className="mt-1 text-lg font-semibold text-white">
                      {used}
                      {typeof limit === "number" && Number.isFinite(limit) ? (
                        <span className="text-xs font-normal text-white/35"> / {limit}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {snapshot?.engines?.blocked?.length ? (
            <div className="mt-3 text-[11px] text-amber-100/75">
              Ultimo bloqueio: {snapshot.engines.blocked[0]?.engine} / {snapshot.engines.blocked[0]?.reason}
            </div>
          ) : null}
          <div className="mt-3 grid gap-1.5">
            {(snapshot?.enginePolicy?.rules ?? []).slice(0, 4).map((rule) => (
              <div key={`${rule.domain}-${rule.preferred}`} className="flex items-center justify-between gap-2 rounded border border-white/10 bg-black/20 px-2 py-1.5">
                <span className="truncate text-[11px] text-white/45">{rule.domain}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-cyan-100/75">{rule.preferred}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-3 rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
            Budget de execucao
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="rounded border border-white/10 bg-black/20 px-2 py-2">
              <div className="font-mono text-[9px] uppercase text-white/40">Hoje</div>
              <div className="mt-1 text-lg font-semibold">
                {formatNumber(snapshot?.budget?.totalRuns)}
                <span className="text-xs font-normal text-white/35">
                  {" "}/ {formatNumber(snapshot?.budget?.limits?.totalDaily)}
                </span>
              </div>
            </div>
            <div className="rounded border border-white/10 bg-black/20 px-2 py-2">
              <div className="font-mono text-[9px] uppercase text-white/40">Restante</div>
              <div className="mt-1 text-lg font-semibold">{formatNumber(snapshot?.budget?.remainingTotal)}</div>
            </div>
            <div className="rounded border border-white/10 bg-black/20 px-2 py-2">
              <div className="font-mono text-[9px] uppercase text-white/40">Cooldown</div>
              <div className="mt-1 text-lg font-semibold">{formatCooldown(snapshot?.budget?.limits?.cooldownMs)}</div>
            </div>
          </div>
          <div className="mt-2 text-[11px] text-white/45">
            Auto-run global: {snapshot?.budget?.limits?.autoRunEnabled ? "ligado" : "desligado"}
          </div>
        </section>

        <section className="mt-3 rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
              Fila operacional
            </div>
            <div className="font-mono text-[10px] text-white/35">
              {formatNumber(snapshot?.tasks?.total)} tarefas
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleSyncHub}
              disabled={actionBusy !== null}
              className="rounded border border-white/10 bg-black/20 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-white/65 transition hover:border-cyan-400/30 hover:text-white disabled:opacity-45"
            >
              {actionBusy === "syncHub" ? "Sincronizando" : "Sync JRC Hub"}
            </button>
            <button
              type="button"
              onClick={handleRunNext}
              disabled={actionBusy !== null}
              className="rounded border border-white/10 bg-black/20 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-white/65 transition hover:border-emerald-400/30 hover:text-white disabled:opacity-45"
            >
              {actionBusy === "runNext" ? "Rodando" : "Proxima tarefa"}
            </button>
          </div>
          <button
            type="button"
            onClick={handleRunChain}
            disabled={actionBusy !== null}
            className="mt-2 w-full rounded border border-emerald-400/20 bg-emerald-500/8 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-50 transition hover:border-emerald-300/45 disabled:opacity-45"
          >
            {actionBusy === "runChain" ? "Executando cadeia" : "Cadeia segura ate aprovacao"}
          </button>
          <button
            type="button"
            onClick={handleWriteReport}
            disabled={actionBusy !== null}
            className="mt-2 w-full rounded border border-cyan-400/20 bg-cyan-500/8 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan-50 transition hover:border-cyan-300/45 disabled:opacity-45"
          >
            {actionBusy === "report" ? "Salvando resumo" : "Salvar resumo do dia"}
          </button>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {domainEntries.map(([domain, count]) => (
              <span key={domain} className="rounded border border-white/10 bg-black/20 px-2 py-1 font-mono text-[10px] text-white/65">
                {domain}: {count}
              </span>
            ))}
          </div>
          <div className="mt-3 text-[11px] text-white/45">
            Aprovacoes pendentes: {formatNumber(snapshot?.tasks?.approval?.pending)} / obrigatorias:{" "}
            {formatNumber(snapshot?.tasks?.approval?.required)}
          </div>
          <div className="mt-3 space-y-2">
            {(snapshot?.tasks?.next ?? []).slice(0, 5).map((task) => (
              <div key={task.id} className="rounded border border-white/10 bg-black/20 px-2 py-2">
                <div className="max-h-10 overflow-hidden text-xs text-white/85">{task.title}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-white/35">
                  {task.priority} / {task.domain} / {task.status}
                </div>
                {task.qualityScore?.score !== undefined || task.traceId ? (
                  <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-cyan-100/55">
                    {task.qualityScore?.score !== undefined ? `Score ${task.qualityScore.score}` : "Sem score"} /{" "}
                    {task.traceId ?? "sem trace"}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-3 rounded border border-amber-400/20 bg-amber-500/8 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-100/80">
              Aprovacoes humanas
            </div>
            <div className="font-mono text-[10px] text-amber-100/45">
              {formatNumber(snapshot?.tasks?.approval?.pending)} pendentes
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {(snapshot?.tasks?.approvals ?? []).slice(0, 6).map((task) => (
              <div key={task.id} className="rounded border border-amber-300/15 bg-black/25 px-2 py-2">
                <div className="line-clamp-2 text-xs text-white/85">{task.title}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-white/35">
                  {task.priority} / {task.domain} / {task.assignedAgentId ?? "sem agente"}
                </div>
                {task.qualityScore?.score !== undefined || task.riskLevel ? (
                  <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-amber-100/50">
                    Score {task.qualityScore?.score ?? "--"} / risco {task.riskLevel ?? "n/a"}
                  </div>
                ) : null}
                {task.approval?.reason ? (
                  <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-amber-100/65">{task.approval.reason}</div>
                ) : null}
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleApproval(task.id, true)}
                    disabled={actionBusy !== null}
                    className="rounded border border-emerald-400/20 bg-emerald-500/10 px-1.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-emerald-50 disabled:opacity-45"
                  >
                    Aprovar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApproval(task.id, false)}
                    disabled={actionBusy !== null}
                    className="rounded border border-red-400/20 bg-red-500/10 px-1.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-red-50 disabled:opacity-45"
                  >
                    Rejeitar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRequestReview(task.id)}
                    disabled={actionBusy !== null}
                    className="rounded border border-white/10 bg-black/20 px-1.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-white/65 disabled:opacity-45"
                  >
                    Revisao
                  </button>
                </div>
              </div>
            ))}
            {(snapshot?.tasks?.approvals ?? []).length === 0 ? (
              <div className="text-[11px] text-white/35">Nenhuma aprovacao pendente.</div>
            ) : null}
          </div>
        </section>

        <section className="mt-3 rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
              Auditoria e traces
            </div>
            <div className="font-mono text-[10px] text-white/35">
              {formatNumber(snapshot?.traces?.total)} eventos
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {(snapshot?.traces?.latest ?? []).slice(0, 6).map((trace) => (
              <div key={trace.id} className="rounded border border-white/10 bg-black/20 px-2 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate font-mono text-[10px] uppercase tracking-[0.1em] text-cyan-100/70">
                    {trace.kind} / {trace.status}
                  </div>
                  <div className="font-mono text-[10px] text-white/35">
                    {trace.qualityScore?.score !== undefined ? `score ${trace.qualityScore.score}` : trace.riskLevel ?? "trace"}
                  </div>
                </div>
                <div className="mt-1 truncate text-[11px] text-white/45">
                  {trace.agentId ?? "sistema"} / {trace.domain ?? "geral"} / {trace.taskId ?? trace.meetingId ?? trace.id}
                </div>
                {trace.message ? (
                  <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-white/35">{trace.message}</div>
                ) : null}
              </div>
            ))}
            {(snapshot?.traces?.latest ?? []).length === 0 ? (
              <div className="text-[11px] text-white/35">Nenhum trace registrado ainda.</div>
            ) : null}
          </div>
        </section>

        <section className="mt-3 rounded border border-fuchsia-400/15 bg-fuchsia-950/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-100/75">
              Media Ops
            </div>
            <div className="font-mono text-[10px] text-fuchsia-100/50">
              {formatNumber(snapshot?.media?.configuredCount)} / {formatNumber(snapshot?.media?.total)}
            </div>
          </div>
          <div className="mt-2 text-[11px] leading-4 text-white/45">
            {snapshot?.media?.recommendedDefault ?? "Pipeline de midia ainda nao carregado."}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(snapshot?.media?.providers ?? []).map((provider) => (
              <div key={provider.id ?? provider.label} className="rounded border border-white/10 bg-black/20 px-2 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate font-mono text-[10px] uppercase tracking-[0.1em] text-white/60">
                    {provider.label ?? provider.id}
                  </div>
                  <div className={provider.configured ? "text-[10px] text-emerald-200" : "text-[10px] text-amber-200"}>
                    {provider.configured ? "ok" : "falta"}
                  </div>
                </div>
                <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-fuchsia-100/45">
                  {provider.kind}
                </div>
                <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-white/40">{provider.defaultUse}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-1.5">
            {(snapshot?.media?.pipeline ?? []).map((step) => (
              <div key={`${step.step}-${step.tool}`} className="flex items-center justify-between gap-2 rounded border border-white/10 bg-black/20 px-2 py-1.5">
                <span className="truncate text-[11px] text-white/50">
                  {step.step} / {step.tool}
                </span>
                <span className={step.configured ? "font-mono text-[10px] text-emerald-200" : "font-mono text-[10px] text-amber-200"}>
                  {step.configured ? "ok" : "manual"}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded border border-amber-300/15 bg-amber-500/8 px-2 py-2 text-[11px] leading-4 text-amber-100/75">
            Geracao paga, publicacao e video de alto custo continuam exigindo aprovacao humana.
          </div>
        </section>

        <section className="mt-3 rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
            JRC Hub
          </div>
          <div className="mt-2 text-[11px] text-white/45">
            Read-only key: {snapshot?.jrcHub?.readOnlyKeyConfigured ? "configurada" : "ausente"}
          </div>
          <div className="mt-2 grid gap-1.5">
            {hubSources.length === 0 ? (
              <div className="text-[11px] text-white/35">Sem snapshot carregado.</div>
            ) : (
              hubSources.map(([name, source]) => (
                <div key={name} className="flex items-center justify-between gap-3 rounded border border-white/10 bg-black/20 px-2 py-1.5">
                  <span className="truncate font-mono text-[10px] text-white/55">{name}</span>
                  <span className={source.ok ? "text-[11px] text-emerald-200" : "text-[11px] text-red-200"}>
                    {source.ok ? "ok" : "falha"}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="mt-3 rounded border border-red-400/20 bg-red-500/8 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-100/80">
            Safety locks
          </div>
          <div className="mt-2 text-[11px] leading-4 text-red-50/75">
            Acoes externas seguem travadas sem aprovacao humana explicita.
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(snapshot?.safety?.forbiddenWithoutApproval ?? []).map((item) => (
              <span key={item} className="rounded border border-red-300/15 bg-black/20 px-2 py-1 font-mono text-[10px] text-red-100/70">
                {item}
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
