import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_CONFIG = "monitor-providers.local.json";
const API_PATH_SUFFIX_REGEX = /\/(chat\/completions|responses|messages)\/?$/;
const GOOGLE_GENERATIVE_API_REGEX = /\/v\d+\w*\/models\/[^/:]+:(generateContent|streamGenerateContent)\/?$/;

function parseArgs(argv) {
  const args = { config: DEFAULT_CONFIG, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--config") args.config = argv[++i];
    else if (arg === "--schema") args.schema = argv[++i];
    else if (arg === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadEnv() {
  const cwd = process.cwd();
  return {
    ...parseEnvFile(resolve(cwd, ".env")),
    ...parseEnvFile(resolve(cwd, ".env.local")),
    ...process.env,
  };
}

function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Copy monitor-providers.example.json to ${DEFAULT_CONFIG} first.`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function getApiKey(provider, env) {
  const key = provider.apiKey || (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined);
  if (!key) throw new Error(`${provider.name || provider.type}: missing apiKey or apiKeyEnv`);
  return key;
}

function deriveBaseURL(endpoint) {
  const [pathWithoutQuery] = endpoint.split("?");
  if (GOOGLE_GENERATIVE_API_REGEX.test(pathWithoutQuery)) {
    return pathWithoutQuery.match(/^(https:\/\/generativelanguage\.googleapis\.com\/v\d+\w*)/)?.[1] || pathWithoutQuery;
  }
  return pathWithoutQuery.replace(API_PATH_SUFFIX_REGEX, "");
}

function appendPath(base, path) {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function fetchModels(provider, apiKey) {
  if (Array.isArray(provider.models)) return provider.models;

  const baseURL = deriveBaseURL(provider.endpoint);
  const modelsEndpoint = provider.modelsEndpoint || appendPath(baseURL, "models");

  if (provider.type === "anthropic") {
    const json = await fetchJson(modelsEndpoint, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": provider.anthropicVersion || "2023-06-01",
      },
    });
    return (json.data || []).map((model) => model.id).filter(Boolean);
  }

  if (provider.type === "gemini" && modelsEndpoint.includes("generativelanguage.googleapis.com")) {
    const url = new URL(modelsEndpoint);
    url.searchParams.set("key", apiKey);
    const json = await fetchJson(url);
    return (json.models || [])
      .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes("generateContent"))
      .map((model) => model.name?.replace(/^models\//, ""))
      .filter(Boolean);
  }

  const json = await fetchJson(modelsEndpoint, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return (json.data || []).map((model) => model.id).filter(Boolean);
}

function filterModels(models, provider) {
  const include = (provider.include || []).map((pattern) => new RegExp(pattern, "i"));
  const exclude = (provider.exclude || []).map((pattern) => new RegExp(pattern, "i"));
  return [...new Set(models)]
    .filter((model) => include.length === 0 || include.some((regex) => regex.test(model)))
    .filter((model) => !exclude.some((regex) => regex.test(model)))
    .sort();
}

async function upsertModels(supabase, type, models) {
  const rows = models.map((model) => ({ type, model }));
  const { data, error } = await supabase
    .from("check_models")
    .upsert(rows, { onConflict: "type,model" })
    .select("id,type,model");
  if (error) throw error;
  return new Map(data.map((row) => [row.model, row.id]));
}

async function loadExistingConfigs(supabase, type, endpoint) {
  const { data, error } = await supabase
    .from("check_configs")
    .select("id,name,type,model_id,endpoint,api_key,enabled,group_name")
    .eq("type", type)
    .eq("endpoint", endpoint);
  if (error) throw error;
  return new Map(data.map((row) => [row.model_id, row]));
}

async function syncProvider(supabase, provider, env, dryRun) {
  const apiKey = getApiKey(provider, env);
  const endpoint = provider.endpoint;
  if (!endpoint) throw new Error(`${provider.name || provider.type}: missing endpoint`);

  const models = filterModels(await fetchModels(provider, apiKey), provider);
  console.log(`${provider.name || provider.type}: ${models.length} model(s)`);
  if (dryRun || models.length === 0) {
    for (const model of models) console.log(`  ${model}`);
    return;
  }

  const modelIds = await upsertModels(supabase, provider.type, models);
  const existing = await loadExistingConfigs(supabase, provider.type, endpoint);
  const rowsToInsert = [];

  for (const model of models) {
    const modelId = modelIds.get(model);
    const name = `${provider.name || provider.type} ${model}`;
    const row = {
      name,
      type: provider.type,
      model_id: modelId,
      endpoint,
      api_key: apiKey,
      enabled: provider.enabled ?? true,
      group_name: provider.groupName ?? null,
    };
    const current = existing.get(modelId);
    if (!current) {
      rowsToInsert.push(row);
      continue;
    }
    const changed =
      current.name !== row.name ||
      current.api_key !== row.api_key ||
      current.enabled !== row.enabled ||
      (current.group_name || null) !== row.group_name;
    if (changed) {
      const { error } = await supabase.from("check_configs").update(row).eq("id", current.id);
      if (error) throw error;
    }
  }

  if (rowsToInsert.length > 0) {
    const { error } = await supabase.from("check_configs").insert(rowsToInsert);
    if (error) throw error;
  }
  console.log(`  inserted=${rowsToInsert.length}, existing=${models.length - rowsToInsert.length}`);
}

function printHelp() {
  console.log(`Usage: pnpm models:sync -- [--config ${DEFAULT_CONFIG}] [--schema public|dev] [--dry-run]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const env = loadEnv();
  const configPath = resolve(process.cwd(), args.config);
  const config = loadConfig(configPath);
  const schema = args.schema || config.schema || "public";

  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!args.dryRun && (!supabaseUrl || !serviceRoleKey)) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local/.env");
  }

  const supabase = args.dryRun
    ? null
    : createClientFrom(await import("@supabase/supabase-js"), supabaseUrl, serviceRoleKey, schema);
  for (const provider of config.providers || []) {
    await syncProvider(supabase, provider, env, args.dryRun);
  }
}

function createClientFrom(module, supabaseUrl, serviceRoleKey, schema) {
  return module.createClient(supabaseUrl, serviceRoleKey, { db: { schema } });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
