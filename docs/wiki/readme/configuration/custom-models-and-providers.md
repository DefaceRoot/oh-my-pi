# Custom Models and Providers

This document provides detailed documentation for configuring custom models and providers within the `oh-my-pi` system, as described in the `models.yml` provider integration guide . It covers the configuration file location, schema, validation rules, merge behavior, runtime discovery, and API key resolution .

## Model and Provider Configuration (`models.yml`) 

The `models.yml` file is the primary mechanism for loading models, applying overrides, resolving credentials, and selecting models at runtime .

### What Controls Model Behavior 

Key implementation files that control model behavior include:
*   `src/config/model-registry.ts`: Handles loading built-in and custom models, provider overrides, runtime discovery, and authentication integration .
*   `src/config/model-resolver.ts`: Parses model patterns and selects models .
*   `src/config/settings-schema.ts`: Defines model-related settings like `modelRoles` and provider transport preferences .
*   `src/session/auth-storage.ts`: Manages API key and OAuth resolution order .
*   `packages/ai/src/models.ts` and `packages/ai/src/types.ts`: Contain built-in providers/models and `Model`/`compat` types .

### Config File Location and Legacy Behavior 

The default configuration path is `~/.omp/agent/models.yml` . Legacy `models.json` files are still supported and will be migrated to `models.yml` if `models.yml` is missing . Explicit `.json` or `.jsonc` paths are also supported when passed programmatically to `ModelRegistry` .

### `models.yml` Shape 

The basic structure of `models.yml` is as follows:
```yaml
providers:
  <provider-id>:
    # provider-level config
``` 
The `<provider-id>` is the canonical key used for selection and authentication lookup .

### Provider-level Fields 

A provider configuration can include the following fields:
```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: MY_PROVIDER_API_KEY
    api: openai-completions
    headers:
      X-Team: platform
    authHeader: true
    auth: apiKey
    discovery:
      type: ollama
    modelOverrides:
      some-model-id:
        name: Renamed model
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 16384
        headers:
          X-Model: value
        compat:
          supportsStore: true
          supportsDeveloperRole: true
          supportsReasoningEffort: true
          maxTokensField: max_completion_tokens
          openRouterRouting:
            only: [anthropic]
          vercelGatewayRouting:
            order: [anthropic, openai]
``` 

#### Allowed Provider/Model `api` Values 
The `api` field can be one of the following:
*   `openai-completions` 
*   `openai-responses` 
*   `openai-codex-responses` 
*   `azure-openai-responses` 
*   `anthropic-messages` 
*   `google-generative-ai` 
*   `google-vertex` 

#### Allowed Auth/Discovery Values 
*   `auth`: `apiKey` (default) or `none` 
*   `discovery.type`: `ollama` 

### Validation Rules 

#### Full Custom Provider (`models` is non-empty) 
*   `baseUrl` is required .
*   `apiKey` is required unless `auth: none` is specified .
*   `api` is required at the provider level or for each model .

#### Override-only Provider (`models` missing or empty) 
At least one of the following must be defined:
*   `baseUrl` 
*   `modelOverrides` 
*   `discovery` 

#### Discovery 
*   `discovery` requires a provider-level `api` .

#### Model Value Checks 
*   `id` is required .
*   `contextWindow` and `maxTokens` must be positive if provided .

### Merge and Override Order 

The `ModelRegistry` processes configurations in the following order during a refresh:
1.  Loads built-in providers/models from `@oh-my-pi/pi-ai` .
2.  Loads `models.yml` custom configuration .
3.  Applies provider overrides (`baseUrl`, `headers`) to built-in models .
4.  Applies `modelOverrides` (per provider and model ID) .
5.  Merges custom `models`: existing models are replaced if they have the same `provider + id`, otherwise they are appended .
6.  Applies runtime-discovered models (e.g., Ollama and LM Studio), then re-applies model overrides .

Provider defaults versus per-model overrides:
*   Provider `headers` serve as the baseline .
*   Model `headers` override provider header keys .
*   `modelOverrides` can customize model metadata such as `name`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`, `headers`, `compat`, and `contextPromotionTarget` .
*   `compat` settings are deep-merged for nested routing blocks like `openRouterRouting` and `vercelGatewayRouting` .

### Runtime Discovery Integration 

#### Implicit Ollama Discovery 
If Ollama is not explicitly configured, the registry automatically adds a discoverable provider with:
*   `provider`: `ollama` 
*   `api`: `openai-completions` 
*   `baseUrl`: `OLLAMA_BASE_URL` environment variable or `http://127.0.0.1:11434` 
*   `auth mode`: keyless (`auth: none` behavior) 
Runtime discovery calls `GET /api/tags` on Ollama to synthesize model entries .

#### Implicit LM Studio Discovery 
Similarly, for LM Studio:
*   `provider`: `lm-studio` 
*   `api`: `openai-completions` 
*   `baseUrl`: `LM_STUDIO_BASE_URL` environment variable or `http://127.0.0.1:1234/v1` 
*   `auth mode`: keyless (`auth: none` behavior) 
Runtime discovery fetches models via `GET /models` to synthesize model entries .

#### Explicit Provider Discovery 
You can explicitly configure discovery in `models.yml`:
```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    api: openai-completions
    auth: none
    discovery:
      type: ollama
``` 

#### Extension Provider Registration 
Extensions can register providers at runtime using `pi.registerProvider(...)` <cite repo="DefaceRoot/oh-my-pi" path="docs/models.md" start="181" end="1

Wiki pages you might want to explore:
- [Thinking & Reasoning (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#4.3)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_92fdd54d-f1be-4b4f-9041-f7cfd6c9f406

