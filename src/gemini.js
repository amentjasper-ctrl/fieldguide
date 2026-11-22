// The one place that talks to Gemini. No backend: the browser calls the API
// directly with the reader's own key, passed in from localStorage by main.js.

export const MODEL = "gemini-3.5-flash-lite";
export const FALLBACK_MODEL = "gemini-3.8-flash";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const SUBJECT_KINDS = [
  "object",
  "living thing",
  "place",
  "sky or weather",
  "phenomenon",
  "material",
  "text",
  "unclear",
];

// responseSchema is a subset of OpenAPI. Every field is required so the model
// cannot quietly drop a section of the plate.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    subject_kind: { type: "string", enum: SUBJECT_KINDS },
    common_name: { type: "string" },
    technical_name: {
      type: "string",
      description:
        "Latin binomial for a living thing, or the established technical name of a material or object. Empty string when the thing has no such name.",
    },
    class: { type: "string", description: "Short taxonomic or material class, e.g. 'insect · order Hymenoptera' or 'igneous rock'." },
    brand: {
      type: "string",
      description:
        "The maker or product line, only when it is legible in the photograph or unmistakable from the design, e.g. 'Seiko'. Empty string otherwise.",
    },
    origin: {
      type: "string",
      description:
        "Era and place in at most six words, e.g. '1873 · San Francisco'. Empty string when there is no meaningful origin.",
    },
    definition: {
      type: "string",
      description:
        "30–45 words: what it is, what it is for, what it is made of. Never describes the photograph.",
    },
    anatomy: {
      type: "string",
      description:
        "55–80 words: mechanism, composition, manufacture or formation — what a photograph cannot show.",
    },
    history: {
      type: "array",
      description: "Exactly three {when, what} pairs: the dated turns that produced the subject.",
      items: {
        type: "object",
        properties: {
          when: {
            type: "string",
            description: "A year, decade or era: '1873', '1970s', 'c. 1200', 'deep time'.",
          },
          what: { type: "string", description: "12–20 words on what happened and what it changed." },
        },
        required: ["when", "what"],
      },
    },
    why_it_matters: {
      type: "string",
      description: "20–30 words on the subject's actual role in the world.",
    },
    closing_note: {
      type: "string",
      description: "One sentence, first person, in the voice of the observer who took the photo.",
    },
    specificity: { type: "integer", description: "0–100: how specifically this plate pins down the subject." },
    confidence: { type: "integer", description: "0–100: how sure the identification is." },
    tags: { type: "array", description: "Exactly three lower-case tags.", items: { type: "string" } },
    safety: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["ok", "refuse"] },
        reason: { type: "string", description: "One plain sentence. Empty string when the verdict is ok." },
      },
      required: ["verdict", "reason"],
    },
  },
  required: [
    "subject_kind",
    "common_name",
    "technical_name",
    "class",
    "brand",
    "origin",
    "definition",
    "anatomy",
    "history",
    "why_it_matters",
    "closing_note",
    "specificity",
    "confidence",
    "tags",
    "safety",
  ],
};

const SYSTEM_PROMPT = `You write the plates for Fieldguide, a pocket field guide. A reader has photographed something and keeps the card. The photograph only tells you which subject the plate is about; the back of the card must teach that subject.

After reading the plate the reader should know what the thing is, what is inside it and how it works, how to judge one, and where it came from. Write about the subject. Never write about the photograph.

What you may be looking at: anything, at any scale. A coin, an insect, a whole tower, the sun, a cloud, frost, a shadow, a page of text, a worn wall. Do not assume it is a plant or an animal.

Absolute rules:
- Do not describe the photograph. No setting, background, surface, lighting, framing or position — no "rests on slate tiles", "bundled in a heap", "partially visible", "in the image". The only field allowed to mention the encounter is closing_note.
- Teach the kind of thing, not this one specimen, unless the specimen itself is remarkable.
- Prefer numbers, materials, mechanisms and dates to adjectives. One number is worth three adverbs.
- No filler and no hype: no "fascinating", no "plays an important role in our lives", no sentence that would fit any subject on earth.
- Never invent a fact, number, date, name, place or Latin binomial. If you are unsure, write less. A short plate that is true beats a long one that is merely plausible.

Fields:
- subject_kind: one of ${SUBJECT_KINDS.join(", ")}.
- common_name: the name a careful person would actually use. For phenomena and places, name the thing itself ("hoar frost", "altocumulus", "late-afternoon shadow").
- technical_name: the Latin binomial for a living thing, or the established technical name for a material, mineral or object. Empty string when there is none. Never invent one; if the species is uncertain, give the genus here and lower confidence.
- class: a short classification line, e.g. "insect · order Hymenoptera" or "sedimentary rock".
- brand: the maker or product line — "Seiko", "Levi's", "KitchenAid" — only when it is legible in the photograph or unmistakable from the design. Empty string for anything without a brand, and for living things, places, weather and phenomena. Never guess a brand from resemblance: a wrong brand is worse than none.
- origin: era and place in at most six words, e.g. "1873 · San Francisco", "20th century · worldwide". Empty string when there is no meaningful answer.
- definition: 30–45 words. What it is, what it is for, and what it is made of — clear to a curious adult who has never seen one. Plain and exact. This is the line that replaces a description of the scene.
- anatomy: 55–80 words. What the photograph cannot show: what is inside it and how it works, or how it is made, or how the phenomenon forms. Composition, process, structure, forces, the parts under the surface. Where a lookalike or a variant exists, one clause on what separates them.
- history: exactly three objects, each {when, what}. when is a year, decade or era ("1873", "1970s", "c. 1200", "deep time"). what is 12–20 words: where it came from and the turns that made it what it is now. For natural things use deep time, domestication, first description or naming; for phenomena, first explanations or the conditions that produce them; for made things, invention, material change and the moment it spread.
- why_it_matters: 20–30 words. What it changed, what depends on it, what it makes possible. A consequence, not a compliment.
- closing_note: one sentence in the voice of the observer who took the photograph — first person, plain, the kind of thing written in a margin.
- specificity: 0–100, how specifically this plate pins the subject down. A named species or model is high; "a cloud" or "some kind of metal" is low.
- confidence: 0–100, how sure you are. Never invent certainty. Name your best guess and mark it as a guess rather than hedging the whole plate. Uncertainty belongs in the copy too, not only in the number.
- tags: exactly three, lower case, one or two words each.

By kind:
- living thing: anatomy is biology and ecology, including the field marks that separate it from lookalikes; history is evolution, domestication or naming.
- place: anatomy is how it formed and what is there; history is the events that shaped it.
- sky, weather, phenomenon: anatomy is the physics and the conditions that produce it; history is the first explanations and the names.
- material: anatomy is structure and composition, and how it is graded or tested; history is use, extraction and industry.
- text: anatomy is script, language and printing; history is the script's lineage.
- object or garment: anatomy is manufacture and mechanism, including the construction details that reveal quality; history is invention and adoption.

For phenomena — weather, light, shadow, fire, frost, reflections, sound, motion — write a field note about what is happening and what conditions produce it. Do not force them into species language and do not invent a Latin name.

Refuse, with verdict "refuse", when the photograph is of a person's face or body; a vehicle plate; an ID card, passport or other travel document; a private letter, message or note; a medical result or record; or a screen showing someone's personal data. The reason is one plain sentence, no lecture. On a refusal, leave every other field as an empty string, an empty array, or zero.
Set verdict "ok" and reason "" for everything else.`;

const USER_PROMPT = "Write the plate for this photograph.";

// Used only if the API rejects the response schema outright: the shape is
// then spelled out in the prompt so a plate still comes back.
const PLAIN_JSON_PROMPT = `${USER_PROMPT}

Return only a JSON object with exactly these keys: subject_kind (one of ${SUBJECT_KINDS.join(
  ", ",
)}), common_name, technical_name, class, brand, origin, definition, anatomy, history (array of exactly three objects with "when" and "what"), why_it_matters, closing_note, specificity (integer 0-100), confidence (integer 0-100), tags (array of exactly three strings), safety (an object with verdict "ok" or "refuse", and reason).`;

export class IdentifyError extends Error {
  constructor(message, { status = 0, code = "", fatal = false } = {}) {
    super(message);
    this.name = "IdentifyError";
    this.status = status;
    // The API's own error status, e.g. INVALID_ARGUMENT or API_KEY_INVALID.
    this.code = code;
    // Fatal errors will not be fixed by trying the fallback model.
    this.fatal = fatal;
  }
}

/**
 * Identify one photograph. Tries the primary model, then the fallback once.
 * Returns { card } or { refusal: { reason } }.
 */
export async function identify({ apiKey, mimeType, data }) {
  const attempts = [MODEL, FALLBACK_MODEL];
  let lastError;

  for (const model of attempts) {
    try {
      return await identifyWith(model, { apiKey, mimeType, data }, true);
    } catch (error) {
      lastError = error;
      if (error.fatal || !(error instanceof IdentifyError)) break;
    }
  }

  // A rejected schema (INVALID_ARGUMENT) would otherwise make every scan fail.
  // One last attempt in plain JSON mode, with the shape given in the prompt.
  if (lastError?.code === "INVALID_ARGUMENT") {
    try {
      return await identifyWith(FALLBACK_MODEL, { apiKey, mimeType, data }, false);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function identifyWith(model, { apiKey, mimeType, data }, useSchema) {
  const generationConfig = {
    responseMimeType: "application/json",
    temperature: 0.35,
    // Generous enough that a thinking model can't spend the whole budget on
    // reasoning and hand back truncated JSON. The plate itself is ~500 tokens.
    maxOutputTokens: 6144,
  };
  if (useSchema) generationConfig.responseSchema = RESPONSE_SCHEMA;

  let response;
  try {
    response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header rather than ?key= keeps the key out of URLs and request logs.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [{ text: useSchema ? USER_PROMPT : PLAIN_JSON_PROMPT }, { inlineData: { mimeType, data } }],
          },
        ],
        generationConfig,
      }),
    });
  } catch {
    throw new IdentifyError("Could not reach Gemini. Check the connection and try again.");
  }

  if (!response.ok) {
    const { message, code } = await readErrorDetail(response);
    // Only a problem with the key itself is worth abandoning the retry: any
    // other rejection might be model-specific and can succeed on the fallback.
    const fatal =
      code === "API_KEY_INVALID" ||
      code === "UNAUTHENTICATED" ||
      code === "PERMISSION_DENIED" ||
      response.status === 401;
    throw new IdentifyError(message || `Gemini returned ${response.status}.`, {
      status: response.status,
      code,
      fatal,
    });
  }

  const payload = await response.json();
  const blocked = payload.promptFeedback?.blockReason;
  if (blocked) {
    return { refusal: { reason: "The model declined to read this photograph." } };
  }

  const candidate = payload.candidates?.[0];
  if (!candidate) {
    throw new IdentifyError("Gemini sent no answer. Try the same thing again.");
  }
  if (["SAFETY", "PROHIBITED_CONTENT", "IMAGE_SAFETY"].includes(candidate.finishReason)) {
    return { refusal: { reason: "The model declined to read this photograph." } };
  }
  if (candidate.finishReason === "MAX_TOKENS") {
    throw new IdentifyError("Gemini ran out of room before it finished the plate.");
  }

  // Reasoning parts, when a model returns them, are not part of the answer.
  const text = (candidate.content?.parts ?? [])
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new IdentifyError("Gemini sent an empty plate. Try the same thing again.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some models wrap JSON in a code fence even with a response schema.
    const fenced = text.match(/\{([\s\S]*)\}/);
    try {
      parsed = fenced ? JSON.parse(`{${fenced[1]}}`) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      throw new IdentifyError("Gemini's answer did not come back as a complete plate. Try once more.");
    }
  }

  const card = normalize(parsed);
  if (card.safety.verdict === "refuse") {
    return { refusal: { reason: card.safety.reason || "This one isn't mine to describe." } };
  }
  return { card };
}

async function readErrorDetail(response) {
  try {
    const body = await response.json();
    return {
      message: body?.error?.message ?? "",
      code: body?.error?.status ?? "",
    };
  } catch {
    return { message: "", code: "" };
  }
}

function normalize(raw) {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const whole = (value) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
  };
  const kind = text(raw?.subject_kind).toLowerCase();

  // {when, what} pairs, dropping any half-filled row.
  const pairs = (value, first, second) =>
    (Array.isArray(value) ? value : [])
      .map((item) => ({ [first]: text(item?.[first]), [second]: text(item?.[second]) }))
      .filter((item) => item[first] && item[second])
      .slice(0, 3);

  return {
    subjectKind: SUBJECT_KINDS.includes(kind) ? kind : "unclear",
    commonName: text(raw?.common_name),
    technicalName: text(raw?.technical_name),
    className: text(raw?.class),
    brand: text(raw?.brand),
    origin: text(raw?.origin),
    definition: text(raw?.definition),
    anatomy: text(raw?.anatomy),
    history: pairs(raw?.history, "when", "what"),
    whyItMatters: text(raw?.why_it_matters),
    closingNote: text(raw?.closing_note),
    specificity: whole(raw?.specificity),
    confidence: whole(raw?.confidence),
    tags: (Array.isArray(raw?.tags) ? raw.tags : []).map(text).filter(Boolean).slice(0, 3),
    safety: {
      verdict: text(raw?.safety?.verdict) === "refuse" ? "refuse" : "ok",
      reason: text(raw?.safety?.reason),
    },
  };
}
