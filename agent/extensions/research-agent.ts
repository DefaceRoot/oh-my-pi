import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const RESEARCH_MARKER = "RESEARCH_AGENT_DYNAMIC_CAPABILITIES";
const RUNTIME_BLOCK_HEADER = "## Research Runtime Capabilities (auto-generated)";

type SearchProviderLike = {
  id?: string;
  label?: string;
};

type SearchProviderModule = {
  resolveProviderChain?: (preferred?: string) => Promise<SearchProviderLike[]>;
};

type SettingsLike = {
  get?: (key: string) => unknown;
};

let searchProviderModulePromise: Promise<SearchProviderModule | null> | undefined;
let settingsModulePromise: Promise<SettingsLike | null> | undefined;

function getPackageSourceCandidates(relativePath: string): string[] {
  const candidates: string[] = [];
  const packageDirFromEnv = process.env.PI_PACKAGE_DIR?.trim();
  if (packageDirFromEnv) {
    candidates.push(`${packageDirFromEnv}/${relativePath}`);
  }
  candidates.push(`/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/${relativePath}`);
  return candidates;
}

async function loadFirstModule<T>(candidates: string[]): Promise<T | null> {
  for (const candidate of candidates) {
    try {
      const loaded = await import(candidate);
      return loaded as T;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function getSearchProviderModule(): Promise<SearchProviderModule | null> {
  if (!searchProviderModulePromise) {
    searchProviderModulePromise = loadFirstModule<SearchProviderModule>(
      getPackageSourceCandidates("src/web/search/provider.ts"),
    );
  }
  return searchProviderModulePromise;
}

async function getSettingsModule(): Promise<SettingsLike | null> {
  if (!settingsModulePromise) {
    settingsModulePromise = (async () => {
      const loaded = await loadFirstModule<{ settings?: SettingsLike }>(
        getPackageSourceCandidates("src/config/settings.ts"),
      );
      return loaded?.settings ?? null;
    })();
  }
  return settingsModulePromise;
}

async function getPreferredSearchProvider(): Promise<string> {
  const settings = await getSettingsModule();
  const preferred = settings?.get?.("providers.webSearch");
  if (typeof preferred === "string" && preferred.trim().length > 0) return preferred.trim();
  return "auto";
}

async function getAvailableSearchProviders(preferred: string): Promise<string[]> {
  const providerModule = await getSearchProviderModule();
  if (!providerModule?.resolveProviderChain) return [];
  try {
    const providers = await providerModule.resolveProviderChain(preferred);
    const labels = providers
      .map(provider => {
        const id = provider.id?.trim();
        const label = provider.label?.trim();
        if (!id) return undefined;
        return label && label.length > 0 ? `${id} (${label})` : id;
      })
      .filter((value): value is string => Boolean(value));
    return [...new Set(labels)];
  } catch {
    return [];
  }
}

function parseMcpToolNames(toolNames: string[]): string[] {
  return toolNames.filter(name => name.startsWith("mcp_"));
}

function buildRuntimeBlock(input: {
  toolNames: string[];
  availableSearchProviders: string[];
  preferredSearchProvider: string;
}): string {
  const { toolNames, availableSearchProviders, preferredSearchProvider } = input;
  const hasFetch = toolNames.includes("fetch");
  const hasWebSearch = toolNames.includes("web_search");
  const mcpTools = parseMcpToolNames(toolNames);
  const hasBtca = mcpTools.some(name => name.startsWith("mcp_better_context_"));
  const hasAugment = mcpTools.includes("mcp_augment_codebase_retrieval");

  const lines: string[] = [
    "",
    RUNTIME_BLOCK_HEADER,
    "Use only the services listed below for this run.",
    `- fetch: ${hasFetch ? "available" : "unavailable"}`,
    `- web_search: ${hasWebSearch ? "available" : "unavailable"}`,
  ];

  if (hasWebSearch) {
    lines.push(`- preferred web_search provider setting: ${preferredSearchProvider}`);
    if (availableSearchProviders.length > 0) {
      lines.push(`- web_search providers available now: ${availableSearchProviders.join(", ")}`);
    } else {
      lines.push("- web_search providers available now: none detected");
    }
  }

  if (mcpTools.length > 0) {
    lines.push(`- MCP research tools available: ${mcpTools.join(", ")}`);
  } else {
    lines.push("- MCP research tools available: none");
  }

  if (hasBtca) {
    lines.push("- BTCA is available. Workflow: call mcp_better_context_listresources, then mcp_better_context_ask with targeted questions.");
  }

  if (hasAugment) {
    lines.push("- Augment codebase retrieval is available for semantic code discovery.");
  }

  lines.push("Do not reference unavailable providers or tools in your plan/output.");
  return lines.join("\n");
}

export default function researchAgentExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (!event.systemPrompt.includes(RESEARCH_MARKER)) return;
    if (event.systemPrompt.includes(RUNTIME_BLOCK_HEADER)) return;

    const toolNames = pi.getActiveTools().map(tool => tool.name);
    const preferredSearchProvider = await getPreferredSearchProvider();
    const availableSearchProviders = toolNames.includes("web_search")
      ? await getAvailableSearchProviders(preferredSearchProvider)
      : [];

    const runtimeBlock = buildRuntimeBlock({
      toolNames,
      availableSearchProviders,
      preferredSearchProvider,
    });

    return {
      systemPrompt: event.systemPrompt + runtimeBlock,
    };
  });
}
