# Nemotron on-prem with NVIDIA NIM

This document explains how Huddle Radio swaps its Nemotron Nano Omni
backend from NVIDIA's hosted catalog (`build.nvidia.com`) to a
locally hosted NVIDIA NIM container, with no application code
changes.

The point of the talking point: every Nemotron-powered surface in
the app (vision, ASR, subtitles) routes through a single env var
(`NEMOTRON_ENDPOINT`). Set it to your NIM container URL and the
exact same code paths run against on-prem inference.

## Why on-prem matters for M&E

Three reasons a sports/media operator would deploy NIM rather than
call `build.nvidia.com` directly:

1. **Data residency.** Broadcast clips often carry rights-restricted
   audio that can't leave the operator's network. NIM keeps the
   model on the same VPC as the playout system.
2. **Latency floor.** A NIM container running on local L40S/H100s
   typically returns frame analysis in ~150ms vs ~600-900ms
   round-tripping to the public catalog. For a 5s frame cadence
   that's the difference between "the host commented before the
   replay" and "the host commented after."
3. **Predictable cost.** GPU-hour pricing is flat against unit
   consumption — for a 24/7 multi-game stream that's cheaper than
   per-token billing past a certain volume.

## Architecture

```
                  +-----------------------------+
                  |  Huddle App (Next.js + WS)  |
                  +--------------+--------------+
                                 |
                                 |  NEMOTRON_API_KEY
                                 |  NEMOTRON_ENDPOINT
                                 v
              +------------------+-------------------+
              |  OpenAI-compatible chat.completions  |
              +------------------+-------------------+
                                 |
                +----------------+----------------+
                |                                 |
                v                                 v
   build.nvidia.com (hosted)         http://localhost:8000/v1
   nemotron-3-nano-omni              NIM container
   (default — zero ops)              (data residency + low latency)
```

The app's vision/ASR/subtitles surfaces all go through the same
`NEMOTRON_ENDPOINT`:

| Surface             | Route                          | Provider source                                |
| ------------------- | ------------------------------ | ---------------------------------------------- |
| Frame analysis      | `POST /api/vision/observe`     | `src/providers/nemotronVisionProvider.ts`      |
| Audio transcription | `POST /api/asr/transcribe`     | `src/providers/nemotronAsrProvider.ts`         |
| Clip subtitles      | `POST /api/clip/subtitles`     | reuses the ASR provider + `src/shared/webvtt.ts` |
| Voice cue (W18)     | `POST /api/asr/transcribe`     | reuses the ASR provider                        |

All four surfaces share the same `NEMOTRON_API_KEY` and
`NEMOTRON_ENDPOINT`. Switching to NIM is one env-var change.

## Start a local NIM container

NIM containers are pulled from `nvcr.io`. You'll need an NGC API key
from `ngc.nvidia.com` and a host with a recent NVIDIA driver +
container toolkit.

```bash
# 1. Authenticate with the NVIDIA container registry.
echo "$NGC_API_KEY" | docker login nvcr.io -u '$oauthtoken' --password-stdin

# 2. Pull and run the Nano Omni NIM (image tag will track the
#    catalog release; check ngc.nvidia.com for current tags).
docker run -it --rm \
  --gpus all \
  --shm-size=16GB \
  -e NGC_API_KEY="$NGC_API_KEY" \
  -p 8000:8000 \
  -v ~/.cache/nim:/opt/nim/.cache \
  nvcr.io/nim/nvidia/nemotron-3-nano-omni:latest

# Container exposes an OpenAI-compatible server on :8000.
```

## Point Huddle at the local NIM

Add to `.env.local`:

```bash
NEMOTRON_API_KEY=local-nim-no-key-required-but-env-var-must-be-set
NEMOTRON_ENDPOINT=http://localhost:8000/v1
NEMOTRON_MODEL=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
MODEL_PROVIDER=nemotron
```

(NIM containers ignore the bearer token; the env var presence is the
only gate the providers check, so any non-empty value works.)

Restart `npm run dev` and the next frame capture, voice cue, or
clip-subtitle request lands on the local container instead of
`build.nvidia.com`.

## Verify the endpoint

```bash
npm run verify:nemotron
```

The script (`scripts/verifyNemotron.ts`) sends a tiny chat
completion against whatever `NEMOTRON_ENDPOINT` is configured and
prints latency, the model name, and any error. Run it after starting
the NIM container or before every demo to catch endpoint mismatches.

## Hot-swap during a demo

Because the endpoint is read on every Route Handler invocation
(no module-level singleton), changing `NEMOTRON_ENDPOINT` and
restarting the dev server is the entire cutover — no provider
re-registration, no client rebuild, no ID changes in the UI. The
"Nemotron sees" panel keeps the same green-dot branding because the
provider's `id` and the model name don't change.
