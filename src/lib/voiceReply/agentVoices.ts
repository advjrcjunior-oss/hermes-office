export type AgentVoiceProfile = {
  agentId: string;
  label: string;
  qwenVoice: string;
  elevenLabsVoiceId: string | null;
  speed: number;
  tone: string;
};

export type AgentVoiceRequest = {
  voiceId: string | null;
  speed: number;
};

export type QwenVoiceOption = {
  id: string;
  label: string;
  description: string;
};

export const QWEN_VOICE_OPTIONS: QwenVoiceOption[] = [
  { id: "neutral", label: "Qwen Neutral", description: "Equilibrada para respostas gerais." },
  { id: "director", label: "Qwen Director", description: "Firme para coordenacao e decisoes." },
  { id: "legal", label: "Qwen Legal", description: "Cautelosa para prazos e juridico." },
  { id: "care", label: "Qwen Care", description: "Acolhedora para BPC e atendimento." },
  { id: "auditor", label: "Qwen Auditor", description: "Pausada para revisao critica." },
  { id: "creative", label: "Qwen Creative", description: "Dinamica para marketing." },
  { id: "sales", label: "Qwen Sales", description: "Consultiva para comercial." },
  { id: "ops", label: "Qwen Ops", description: "Objetiva para DevOps e execucao." },
];

const AGENT_VOICE_PROFILES: Record<string, AgentVoiceProfile> = {
  hermes: {
    agentId: "hermes",
    label: "Qwen Neutral",
    qwenVoice: "neutral",
    elevenLabsVoiceId: null,
    speed: 1,
    tone: "maestro equilibrado",
  },
  "jrc-maestro": {
    agentId: "jrc-maestro",
    label: "Qwen Director",
    qwenVoice: "director",
    elevenLabsVoiceId: "pNInz6obpgDQGcFmaJgB",
    speed: 0.95,
    tone: "diretor firme",
  },
  "jrc-legalmail": {
    agentId: "jrc-legalmail",
    label: "Qwen Legal",
    qwenVoice: "legal",
    elevenLabsVoiceId: "ErXwobaYiN019PkySvjV",
    speed: 0.95,
    tone: "preciso e cauteloso",
  },
  "jrc-bpc": {
    agentId: "jrc-bpc",
    label: "Qwen Care",
    qwenVoice: "care",
    elevenLabsVoiceId: "EXAVITQu4vr4xnSDxMaL",
    speed: 0.95,
    tone: "acolhedor e organizado",
  },
  "jrc-juridico": {
    agentId: "jrc-juridico",
    label: "Qwen Counsel",
    qwenVoice: "counsel",
    elevenLabsVoiceId: "ErXwobaYiN019PkySvjV",
    speed: 0.9,
    tone: "juridico tecnico",
  },
  "jrc-revisor": {
    agentId: "jrc-revisor",
    label: "Qwen Auditor",
    qwenVoice: "auditor",
    elevenLabsVoiceId: "pNInz6obpgDQGcFmaJgB",
    speed: 0.9,
    tone: "critico e pausado",
  },
  "jrc-marketing": {
    agentId: "jrc-marketing",
    label: "Qwen Creative",
    qwenVoice: "creative",
    elevenLabsVoiceId: "MF3mGyEYCl7XYWbV9V6O",
    speed: 1.05,
    tone: "criativo e dinamico",
  },
  "jrc-comercial": {
    agentId: "jrc-comercial",
    label: "Qwen Sales",
    qwenVoice: "sales",
    elevenLabsVoiceId: "TxGEqnHWrfWFTfGW9XjX",
    speed: 1,
    tone: "consultivo e confiante",
  },
  "jrc-atendimento": {
    agentId: "jrc-atendimento",
    label: "Qwen Reception",
    qwenVoice: "reception",
    elevenLabsVoiceId: "EXAVITQu4vr4xnSDxMaL",
    speed: 1,
    tone: "claro e receptivo",
  },
  "jrc-financeiro": {
    agentId: "jrc-financeiro",
    label: "Qwen Finance",
    qwenVoice: "finance",
    elevenLabsVoiceId: "ErXwobaYiN019PkySvjV",
    speed: 0.95,
    tone: "calmo e analitico",
  },
  "jrc-devops": {
    agentId: "jrc-devops",
    label: "Qwen Ops",
    qwenVoice: "ops",
    elevenLabsVoiceId: "TxGEqnHWrfWFTfGW9XjX",
    speed: 1.05,
    tone: "objetivo e tecnico",
  },
  "jrc-amy": {
    agentId: "jrc-amy",
    label: "Qwen Amy",
    qwenVoice: "amy",
    elevenLabsVoiceId: "MF3mGyEYCl7XYWbV9V6O",
    speed: 1.05,
    tone: "social media expressiva",
  },
};

export const listAgentVoiceProfiles = (): AgentVoiceProfile[] =>
  Object.values(AGENT_VOICE_PROFILES);

export const resolveAgentVoiceProfile = (
  agentId: string | null | undefined
): AgentVoiceProfile | null => {
  const normalized = agentId?.trim();
  if (!normalized) return null;
  return AGENT_VOICE_PROFILES[normalized] ?? null;
};

export const resolveAgentVoiceRequest = (
  agentId: string | null | undefined,
  provider: string,
  fallbackVoiceId: string | null,
  fallbackSpeed: number
): AgentVoiceRequest => {
  const profile = resolveAgentVoiceProfile(agentId);
  if (!profile) return { voiceId: fallbackVoiceId, speed: fallbackSpeed };
  return {
    voiceId: provider === "qwen3-tts" ? profile.qwenVoice : profile.elevenLabsVoiceId,
    speed: profile.speed,
  };
};
