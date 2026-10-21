# Fork: GPU sizing web service and automatic data updates

This fork of [nemmusu/llm-capacity-planner](https://github.com/nemmusu/llm-capacity-planner) adds three things.
The planning engine (weights, KV cache, compatibility matrix) is unchanged.

## 1. Web service (`src/server.ts`, `src/web/`)

Memory-only sizing for any Hugging Face model id: weights, KV cache and fixed costs per GPU. For every card it gives the
smallest layout (TP / PP) the model fits; given a number of concurrent requests, it adds how many copies of the
model, GPUs and servers they take. Speed, time to first token and user counts are deliberately not shown; they stay in
the CLI's output.

```bash
npm ci
npm run serve                  # http://localhost:8080
```

| Endpoint | |
| --- | --- |
| `GET /` | the page |
| `POST /api/plan` | `{"model":"Qwen/Qwen3-32B","tokens":"128k","typicalTokens":"32k","concurrent":64,"engine":"vllm","cache":"fp8"}` |
| `GET /api/gpus` | the GPU catalog |
| `GET /api/meta` | engine versions, catalog dates, built-in models |
| `GET /healthz` | probe |

`POST /api/plan` also takes `variant` (folder of a quantized checkpoint in the repo), `textOnly` (leave the vision
encoder out) and `refresh` (read the model from Hugging Face again). Errors come back as `{"error": "..."}`: 400 for
a bad request, 404 for an unknown model, 422 for a model the planner cannot read, 502 when Hugging Face is unreachable.

Environment: `PORT`, `HF_TOKEN` (gated models), `HTTPS_PROXY` / `NO_PROXY`, `HF_ENDPOINT` (an internal mirror such
as Artifactory or Nexus), `XDG_CACHE_HOME` (disk cache of Hugging Face answers), `PLAN_CONCURRENCY` (plans at once,
default 4).

"Requests/copy" is how many requests of the typical length (`typicalTokens`, half the context by default) fit in the
KV cache at once, with an 85 % safety margin. For the worst case, set `typicalTokens` equal to `tokens`.

## 2. Automatic data updates (`scripts/sync/`, `.github/workflows/sync-*.yml`)

| Job | When | What it does |
| --- | --- | --- |
| `sync:compat` | weekly | Finds the latest vLLM / SGLang tags with `git ls-remote`. When newer than the matrix, it looks for every line of engine code a rule cites at the new tag. All found: the matrix moves to the new release and a pull request is opened. Some missing: a **draft** pull request lists the rules a person must verify. |
| `sync:epoch` | daily | Compares `data/hardware.json` with Epoch AI's ML hardware dataset. New NVIDIA cards are written as drafts to `data/pending-gpus.json`, differing memory or bandwidth values are listed in `data/epoch-sync.md`, and a pull request is opened. |

Run them by hand:

```bash
npm run sync:compat -- --report compat.md
npm run sync:epoch -- --write --report epoch.md      # air-gapped: add --file ml_hardware.csv
```

**Why pull requests rather than direct updates:** the catalog values come from NVIDIA datasheets, each with its
source. Epoch is a cross-check that catches new cards; it never changes a value silently.

- Completing a draft card: take its compute capability from [NVIDIA's list](https://developer.nvidia.com/cuda-gpus).
  FP8 / NVFP4 / MXFP4 support follows from it (`formatsFromCompute`; the rule matches all 26 catalog cards). Then fill
  in the CUDA-visible memory, NVLink and GPUs per server, move the entry to `hardware.json` and run `npm test`.
- What the matrix check covers: whether the code each rule cites is still there. It does not cover the KV cache layout
  in `src/model/vllm-kv.ts`, which must be checked by hand for a new vLLM release.
- Both jobs regenerate `data/report.json`, which is fingerprinted over `data/*.json`.

The workflows use `peter-evans/create-pull-request`. Enable *Settings → Actions → General → Allow GitHub Actions to
create and approve pull requests*. On GitHub Enterprise the action must be mirrored and the runner must reach
`github.com` and `epoch.ai`.

## 3. Public demo on Render (free)

`render.yaml` is a Render Blueprint: in the Render dashboard choose *New → Blueprint*, connect this repository and
apply. It builds the `Containerfile` on the free plan (512 MB, no credit card) and redeploys on every push to `main`.
A free service sleeps after 15 minutes without traffic and takes about a minute to wake. Set `HF_TOKEN` in the
dashboard to read gated models.

## 4. OpenShift (`Containerfile`, `deploy/openshift/`)

```bash
# edit the proxy in deploy/openshift/configmap.yaml and the HF token in secret.yaml
oc new-project gpu-sizing
oc apply -k deploy/openshift
oc start-build gpu-sizing --follow
oc get route gpu-sizing
```

The image is based on UBI9 Node.js 22 and runs as any UID (restricted SCC). It carries the configs and safetensors
headers of 91 models, which are planned without the network; any other model is read live from Hugging Face. The
BuildConfig builds from this repository: with its webhook set up, a merged pull request rebuilds the image and the
Deployment rolls out the new one.
