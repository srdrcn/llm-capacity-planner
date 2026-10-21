# Fork: GPU Sizing web servisi ve otomatik veri güncellemesi

Bu fork, [nemmusu/llm-capacity-planner](https://github.com/nemmusu/llm-capacity-planner) üzerine üç şey ekler.
Planlama motoru (ağırlık, KV cache, uyumluluk matrisi) değiştirilmedi.

## 1. Web servisi (`src/server.ts`, `src/web/`)

Herhangi bir Hugging Face model ID'si için sadece **bellek** hesabı yapar: ağırlıklar, KV cache ve sabit maliyetler.
Her kart için modelin sığdığı en küçük düzeni (TP/PP) verir. Eşzamanlı istek sayısı girilirse kaç kopya, kaç GPU ve
kaç sunucu gerektiğini hesaplar. Hız, TTFT ve kullanıcı tahminleri bilerek gösterilmez; bunlar CLI çıktısında duruyor.

```bash
npm ci
npm run serve                  # http://localhost:8080
```

| Uç nokta | |
| --- | --- |
| `GET /` | arayüz |
| `POST /api/plan` | `{"model":"Qwen/Qwen3-32B","tokens":"128k","typicalTokens":"32k","concurrent":64,"engine":"vllm","cache":"fp8"}` |
| `GET /api/gpus` | GPU kataloğu |
| `GET /api/meta` | engine sürümleri, katalog tarihleri, yerleşik modeller |
| `GET /healthz` | probe |

Ortam değişkenleri: `PORT`, `HF_TOKEN` (gated modeller için), `HTTPS_PROXY` / `NO_PROXY`, `HF_ENDPOINT` (iç ayna:
Artifactory/Nexus), `XDG_CACHE_HOME` (HF cevaplarının disk önbelleği), `PLAN_CONCURRENCY`.

"İstek/kopya": ortalama istek uzunluğunda (`typicalTokens`, varsayılan context'in yarısı) KV cache'e aynı anda sığan
istek sayısı, %85 güvenlik payıyla. En kötü durum için `typicalTokens` değerini `tokens` ile aynı verin.

## 2. Otomatik veri güncellemesi (`scripts/sync/`, `.github/workflows/sync-*.yml`)

| İş | Ne zaman | Ne yapar |
| --- | --- | --- |
| `sync:compat` | haftalık | `git ls-remote` ile en son vLLM / SGLang tag'ini bulur. Daha yeniyse uyumluluk matrisindeki her kuralın dayandığı kod satırını yeni tag'de arar. Hepsi bulunursa matrisi yeni sürüme taşıyıp PR açar. Bulunamayanlar varsa, kontrol edilecek kuralları listeleyen **draft** PR açar. |
| `sync:epoch` | günlük | Epoch AI ML hardware verisini `data/hardware.json` ile karşılaştırır. Yeni NVIDIA kartlarını `data/pending-gpus.json`'a taslak olarak yazar, farklı bellek veya bant genişliği değerlerini `data/epoch-sync.md`'de listeler ve PR açar. |

Elle çalıştırmak için:

```bash
npm run sync:compat -- --report compat.md
npm run sync:epoch -- --write --report epoch.md      # kapalı ağda: --file ml_hardware.csv
```

**Neden PR, neden doğrudan güncelleme değil:** Katalogdaki değerler NVIDIA datasheet'lerinden, kaynaklarıyla birlikte
girilmiş. Epoch bu değerleri çapraz kontrol eder ve yeni kartları yakalar, ama değerleri sessizce değiştirmez.

- Yeni kart taslağı nasıl tamamlanır: compute capability [NVIDIA listesinden](https://developer.nvidia.com/cuda-gpus) girilir. FP8/NVFP4/MXFP4 desteği compute capability'den türetilir (`formatsFromCompute`; kural katalogdaki 26 kartın hepsiyle tutarlı). Ardından CUDA'nın gördüğü bellek, NVLink ve sunucu başına GPU alanları doldurulur, kart `hardware.json`'a taşınır ve `npm test` çalıştırılır.
- Matris kontrolünün kapsamı: kural kaynaklarının yerinde olup olmadığını kontrol eder. `src/model/vllm-kv.ts`'deki KV yerleşimini kontrol etmez; o kısım yeni vLLM sürümünde elle doğrulanmalı.

Workflow'lar `peter-evans/create-pull-request` kullanır. GitHub Enterprise'da bu action'ın aynalanması, runner'ın da
`github.com` ve `epoch.ai` adreslerine çıkabilmesi gerekir.

## 3. OpenShift (`Containerfile`, `deploy/openshift/`)

```bash
# deploy/openshift/buildconfig.yaml içinde git URI, configmap.yaml içinde proxy, secret.yaml içinde HF token düzenlenir
oc new-project gpu-sizing
oc apply -k deploy/openshift
oc start-build gpu-sizing --follow
oc get route gpu-sizing
```

Imaj UBI9 Node.js 22 tabanlıdır ve herhangi bir UID ile çalışır (restricted SCC). İçinde 91 modelin config'i ve header'ları
yerleşik olarak gelir; bu modeller ağ olmadan hesaplanır. Diğer modeller canlı olarak HF'ten okunur. PR merge edildiğinde
BuildConfig webhook'u imajı yeniden kurar ve deployment kendiliğinden güncellenir.
