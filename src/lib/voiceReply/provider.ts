export type VoiceReplyProvider = "qwen3-tts" | "elevenlabs";

export type VoiceReplySynthesisRequest = {
  text: string;
  provider?: VoiceReplyProvider;
  voiceId?: string | null;
  speed?: number;
};

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_REPLY_PROVIDER: VoiceReplyProvider = "qwen3-tts";
const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5";
const DEFAULT_QWEN3_TTS_VOICE = process.env.QWEN3_TTS_VOICE?.trim() || "neutral";
const QWEN_REPLICATE_MODEL = "qwen/qwen3-tts";

const normalizeVoiceSpeed = (value: number | null | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1.2, Math.max(0.7, value));
};

const normalizeVoiceId = (value: string | null | undefined): string => {
  const explicit = value?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_ELEVENLABS_VOICE_ID;
};

const synthesizeWithElevenLabs = async (
  request: VoiceReplySynthesisRequest
): Promise<Response> => {
  // TODO: Create Claw3D voice and text skill.
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY.");
  }
  const voiceId = normalizeVoiceId(request.voiceId);
  const speed = normalizeVoiceSpeed(request.speed);
  const response = await fetch(
    `${ELEVENLABS_API_URL}/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text: request.text,
        model_id: DEFAULT_ELEVENLABS_MODEL_ID,
        voice_settings: {
          stability: 0.42,
          similarity_boost: 0.88,
          style: 0.2,
          use_speaker_boost: true,
          speed,
        },
      }),
      cache: "no-store",
    }
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(detail || "ElevenLabs voice synthesis failed.");
  }
  return response;
};

const normalizeQwenVoice = (value: string | null | undefined): string => {
  const explicit = value?.trim();
  return explicit || DEFAULT_QWEN3_TTS_VOICE;
};

const synthesizeWithQwen3Tts = async (
  request: VoiceReplySynthesisRequest
): Promise<Response> => {
  const endpoint = process.env.QWEN3_TTS_ENDPOINT?.trim();
  if (!endpoint) return synthesizeWithReplicateQwen3Tts(request);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "audio/mpeg, audio/wav, audio/*",
      "Content-Type": "application/json",
      ...(process.env.QWEN3_TTS_API_KEY?.trim()
        ? { Authorization: `Bearer ${process.env.QWEN3_TTS_API_KEY.trim()}` }
        : {}),
    },
    body: JSON.stringify({
      text: request.text,
      voice: normalizeQwenVoice(request.voiceId),
      speed: normalizeVoiceSpeed(request.speed),
      format: "mp3",
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(detail || "Qwen3-TTS voice synthesis failed.");
  }
  return response;
};

const resolveQwenSpeaker = (voiceId: string): string => {
  const normalized = voiceId.toLowerCase();
  if (normalized.includes("director") || normalized.includes("auditor")) return "Aiden";
  if (normalized.includes("care") || normalized.includes("reception")) return "Serena";
  if (normalized.includes("creative") || normalized.includes("amy")) return "Dylan";
  if (normalized.includes("sales") || normalized.includes("ops")) return "Ethan";
  if (normalized.includes("legal") || normalized.includes("counsel") || normalized.includes("finance")) return "Aiden";
  return "Serena";
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const synthesizeWithReplicateQwen3Tts = async (
  request: VoiceReplySynthesisRequest
): Promise<Response> => {
  const token = process.env.REPLICATE_API_TOKEN?.trim() || process.env.REPLICATE_API_KEY?.trim();
  if (!token) {
    throw new Error("Missing QWEN3_TTS_ENDPOINT or REPLICATE_API_TOKEN/REPLICATE_API_KEY.");
  }
  const createResponse = await fetch(
    `https://api.replicate.com/v1/models/${QWEN_REPLICATE_MODEL}/predictions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait=5",
      },
      body: JSON.stringify({
        input: {
          mode: "custom_voice",
          text: request.text,
          speaker: resolveQwenSpeaker(normalizeQwenVoice(request.voiceId)),
          language: "auto",
        },
      }),
      cache: "no-store",
    }
  );
  if (!createResponse.ok) {
    const detail = (await createResponse.text().catch(() => "")).trim();
    try {
      const parsed = JSON.parse(detail) as { title?: unknown; detail?: unknown; status?: unknown };
      const title = typeof parsed.title === "string" ? parsed.title : "Replicate Qwen3-TTS prediction failed";
      const message = typeof parsed.detail === "string" ? parsed.detail : "";
      const status = typeof parsed.status === "number" ? `status ${parsed.status}` : "";
      throw new Error([title, message, status].filter(Boolean).join(": "));
    } catch (error) {
      if (error instanceof Error && !error.message.startsWith("{")) throw error;
      throw new Error(detail || "Replicate Qwen3-TTS prediction failed.");
    }
  }
  let prediction = (await createResponse.json()) as {
    status?: string;
    output?: unknown;
    error?: unknown;
    urls?: { get?: string };
  };
  for (let index = 0; index < 18 && prediction.status !== "succeeded"; index += 1) {
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new Error(String(prediction.error || "Replicate Qwen3-TTS prediction failed."));
    }
    const getUrl = prediction.urls?.get;
    if (!getUrl) break;
    await wait(1000);
    const pollResponse = await fetch(getUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!pollResponse.ok) break;
    prediction = (await pollResponse.json()) as typeof prediction;
  }
  const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  const audioUrl = typeof output === "string" ? output : null;
  if (!audioUrl) {
    throw new Error("Replicate Qwen3-TTS did not return an audio URL.");
  }
  const audioResponse = await fetch(audioUrl, { cache: "no-store" });
  if (!audioResponse.ok || !audioResponse.body) {
    throw new Error("Failed to fetch Replicate Qwen3-TTS audio output.");
  }
  return audioResponse;
};

export const synthesizeVoiceReply = async (
  request: VoiceReplySynthesisRequest
): Promise<Response> => {
  const provider = request.provider ?? DEFAULT_VOICE_REPLY_PROVIDER;
  switch (provider) {
    case "qwen3-tts":
      return synthesizeWithQwen3Tts(request);
    case "elevenlabs":
      return synthesizeWithElevenLabs(request);
    default:
      throw new Error("Unsupported voice reply provider.");
  }
};
