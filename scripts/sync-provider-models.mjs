import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

const PROVIDERS = {
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKeyEnv: "OPENAI_API_KEY",
    include: "^(gpt|o[0-9])",
    exclude: "embedding,audio,tts,whisper,moderation",
  },
  anthropic: {
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    include: "^claude",
    exclude: "",
  },
  gemini: {
    label: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    apiKeyEnv: "GEMINI_API_KEY",
    include: "^gemini",
    exclude: "embedding",
  },
};

const API_PATH_SUFFIX_REGEX = /\/(chat\/completions|responses|messages)\/?$/;
const GOOGLE_GENERATIVE_API_REGEX = /\/v\d+\w*\/models\/[^/:]+:(generateContent|streamGenerateContent)\/?$/;

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--schema") args.schema = argv[++index];
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

async function ask(question, defaultValue = "") {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await readline.question(`${question}${suffix}: `)).trim();
  readline.close();
  return answer || defaultValue;
}

async function askSecret(question, fallback = "") {
  if (!process.stdin.isTTY) return ask(question, fallback);
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  const hint = fallback ? " [回车使用 .env.local 中的值]" : "";
  const pending = readline.question(`${question}${hint}: `);
  muted = true;
  const answer = (await pending).trim();
  muted = false;
  readline.close();
  process.stdout.write("\n");
  return answer || fallback;
}

async function confirm(question, defaultYes = true) {
  const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  return answer ? answer === "y" || answer === "yes" : defaultYes;
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

async function fetchModels(provider) {
  const modelsEndpoint = provider.modelsEndpoint || appendPath(deriveBaseURL(provider.endpoint), "models");

  if (provider.type === "anthropic") {
    const json = await fetchJson(modelsEndpoint, {
      headers: { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" },
    });
    return (json.data || []).map((model) => model.id).filter(Boolean);
  }

  if (provider.type === "gemini" && modelsEndpoint.includes("generativelanguage.googleapis.com")) {
    const url = new URL(modelsEndpoint);
    url.searchParams.set("key", provider.apiKey);
    const json = await fetchJson(url);
    return (json.models || [])
      .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes("generateContent"))
      .map((model) => model.name?.replace(/^models\//, ""))
      .filter(Boolean);
  }

  const json = await fetchJson(modelsEndpoint, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  });
  return (json.data || []).map((model) => model.id).filter(Boolean);
}

function filterModels(models, includePattern, excludePatterns) {
  const include = includePattern ? new RegExp(includePattern, "i") : null;
  const exclude = excludePatterns.filter(Boolean).map((pattern) => new RegExp(pattern, "i"));
  return [...new Set(models)]
    .filter((model) => !include || include.test(model))
    .filter((model) => !exclude.some((regex) => regex.test(model)))
    .sort();
}

async function promptProvider(env) {
  console.log("\n选择供应商：\n1) OpenAI\n2) Anthropic\n3) Gemini");
  const choice = await ask("请输入序号", "1");
  const type = { 1: "openai", 2: "anthropic", 3: "gemini" }[choice];
  if (!type) throw new Error("无效的供应商序号");

  const defaults = PROVIDERS[type];
  const name = await ask("监控名称", defaults.label);
  const endpoint = await ask("调用端点", defaults.endpoint);
  const modelsEndpoint = await ask("模型列表端点（留空自动推导）");
  const apiKey = await askSecret("API Key（输入不显示）", env[defaults.apiKeyEnv]);
  if (!apiKey) throw new Error("API Key 不能为空");
  const groupName = await ask("监控分组", defaults.label);
  const includePattern = await ask("模型包含正则（留空表示全部）", defaults.include);
  const excludeInput = await ask("排除规则，逗号分隔", defaults.exclude);

  return {
    name,
    type,
    endpoint,
    modelsEndpoint,
    apiKey,
    groupName,
    includePattern,
    excludePatterns: excludeInput.split(",").map((value) => value.trim()),
  };
}

async function upsertModels(supabase, type, models) {
  const { data, error } = await supabase
    .from("check_models")
    .upsert(models.map((model) => ({ type, model })), { onConflict: "type,model" })
    .select("id,model");
  if (error) throw error;
  return new Map(data.map((row) => [row.model, row.id]));
}

async function syncProvider(supabase, provider, models) {
  const modelIds = await upsertModels(supabase, provider.type, models);
  const { data: existingRows, error } = await supabase
    .from("check_configs")
    .select("id,name,model_id,api_key,enabled,group_name")
    .eq("type", provider.type)
    .eq("endpoint", provider.endpoint);
  if (error) throw error;

  const existing = new Map(existingRows.map((row) => [row.model_id, row]));
  const inserts = [];
  let updated = 0;

  for (const model of models) {
    const modelId = modelIds.get(model);
    const row = {
      name: `${provider.name} ${model}`,
      type: provider.type,
      model_id: modelId,
      endpoint: provider.endpoint,
      api_key: provider.apiKey,
      enabled: true,
      group_name: provider.groupName || null,
    };
    const current = existing.get(modelId);
    if (!current) {
      inserts.push(row);
    } else if (
      current.name !== row.name ||
      current.api_key !== row.api_key ||
      !current.enabled ||
      (current.group_name || null) !== row.group_name
    ) {
      const { error: updateError } = await supabase.from("check_configs").update(row).eq("id", current.id);
      if (updateError) throw updateError;
      updated += 1;
    }
  }

  if (inserts.length > 0) {
    const { error: insertError } = await supabase.from("check_configs").insert(inserts);
    if (insertError) throw insertError;
  }
  console.log(`完成：新增 ${inserts.length}，更新 ${updated}，已有 ${models.length - inserts.length - updated}`);
}

function printHelp() {
  console.log("Usage: pnpm models:sync -- [--schema public|dev] [--dry-run]");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (!process.stdin.isTTY) throw new Error("引导模式需要在交互式终端中运行");

  const env = loadEnv();
  const schema = args.schema || await ask("Supabase schema", "public");
  if (!new Set(["public", "dev"]).has(schema)) throw new Error("schema 只能是 public 或 dev");

  let supabase;
  while (true) {
    const provider = await promptProvider(env);
    console.log("\n正在获取模型列表...");
    const models = filterModels(await fetchModels(provider), provider.includePattern, provider.excludePatterns);
    if (models.length === 0) throw new Error("筛选后没有可监控模型，请调整包含或排除规则");

    console.log(`\n找到 ${models.length} 个模型：`);
    for (const model of models) console.log(`- ${model}`);
    if (!await confirm(args.dryRun ? "结束预览？" : "确认写入监控站？")) continue;

    if (!args.dryRun) {
      const supabaseUrl = env.SUPABASE_URL || await ask("SUPABASE_URL");
      const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || await askSecret("SUPABASE_SERVICE_ROLE_KEY（输入不显示）");
      if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase URL 和 Service Role Key 不能为空");
      if (!supabase) {
        const { createClient } = await import("@supabase/supabase-js");
        supabase = createClient(supabaseUrl, serviceRoleKey, { db: { schema } });
      }
      await syncProvider(supabase, provider, models);
    }

    if (!await confirm("继续添加其他供应商？", false)) break;
  }
}

main().catch((error) => {
  console.error(`\n失败：${error.message || error}`);
  process.exit(1);
});
