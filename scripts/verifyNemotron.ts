import "dotenv/config";

/**
 * W23: Nemotron endpoint verification CLI.
 *
 * Hits whatever `NEMOTRON_ENDPOINT` is configured (default
 * https://integrate.api.nvidia.com/v1) with a tiny chat-completions
 * request and reports model id, latency, and any error. Useful both
 * for catching endpoint mismatches before a demo and for confirming
 * that a freshly-started NIM container is reachable from the host.
 *
 * Usage:
 *   npm run verify:nemotron
 *
 * Exits with code 0 on success, 1 on any failure so it can gate CI
 * or pre-demo smoke checks.
 */

// Treat empty-string env values the same as unset — `.env.local`
// commonly leaves placeholders like `NEMOTRON_ENDPOINT=` which would
// otherwise win over the catalog default.
const ENDPOINT = (process.env.NEMOTRON_ENDPOINT?.trim() || "https://integrate.api.nvidia.com/v1");
const MODEL = (process.env.NEMOTRON_MODEL?.trim() || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
const API_KEY = process.env.NEMOTRON_API_KEY?.trim();

async function main(): Promise<void> {
  console.log(`Verifying Nemotron endpoint: ${ENDPOINT}`);
  console.log(`Model: ${MODEL}`);

  if (!API_KEY) {
    console.error("\n[fail] NEMOTRON_API_KEY is not set. Add it to .env.local (any non-empty value for local NIM).");
    process.exit(1);
  }

  const url = `${ENDPOINT.replace(/\/+$/, "")}/chat/completions`;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16,
        temperature: 0,
        messages: [
          { role: "system", content: "Reply with the literal word OK." },
          { role: "user", content: "OK?" }
        ]
      })
    });
  } catch (error) {
    console.error("\n[fail] Network error reaching the endpoint.");
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\nIf you started a local NIM, confirm the container is bound to the URL above and that the host can reach it (try: curl ${ENDPOINT}/models).`);
    process.exit(1);
  }

  const latencyMs = Date.now() - startedAt;
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!response.ok) {
    console.error(`\n[fail] Endpoint returned HTTP ${response.status} after ${latencyMs}ms.`);
    console.error(typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body, null, 2).slice(0, 500));
    process.exit(1);
  }

  // OpenAI-compatible response: choices[0].message.content
  const content = (body as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
  console.log(`\n[ok] HTTP 200 in ${latencyMs}ms.`);
  console.log(`Model reply: ${typeof content === "string" ? content.slice(0, 120) : "<no content>"}`);
}

main().catch((error) => {
  console.error("\n[fail] Verification crashed:");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
