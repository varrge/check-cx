import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

const PROVIDERS = {
  openai: {
    label: "OpenAI",
    serviceUrl: "https://api.openai.com",
    apiVersion: "v1",
    callPath: "chat/completions",
    callSuffix: /\/(chat\/completions|responses)$/i,
    apiKeyEnv: "OPENAI_API_KEY",
    include: "^(gpt|o[0-9])",
    exclude: "embedding,audio,tts,whisper,moderation,image",
  },
  anthropic: {
    label: "Anthropic",
    serviceUrl: "https://api.anthropic.com",
    apiVersion: "v1",
    callPath: "messages",
    callSuffix: /\/messages$/i,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    include: "^claude",
    exclude: "",
  },
  gemini: {
    label: "Gemini",
    serviceUrl: "https://generativelanguage.googleapis.com",
    apiVersion: "v1beta",
    callPath: "models/gemini-2.0-flash:generateContent",
    callSuffix: /\/models\/[^/:]+:(generateContent|streamGenerateContent)$/i,
    apiKeyEnv: "GEMINI_API_KEY",
    include: "^gemini",
    exclude: "embedding",
  },
};

const API_PATH_SUFFIX_REGEX = /\/(chat\/completions|responses|messages)\/?$/;
const GOOGLE_GENERATIVE_API_REGEX = /\/v\d+\w*\/models\/[^/:]+:(generateContent|streamGenerateContent)\/?$/;

function parseArgs(argv) {
  const args = { dryRun: false, remove: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--remove") args.remove = true;
    else if (arg === "--schema") args.schema = argv[++index];
    else if (arg === "--self-test") args.selfTest = true;
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

function inferProviderEndpoints(type, input) {
  const defaults = PROVIDERS[type];
  const serviceUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  const url = new URL(serviceUrl);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("服务地址只支持 http:// 或 https://");

  url.hash = "";
  const inputPath = url.pathname.replace(/\/+$/, "");
  url.pathname = inputPath || "/";
  const modelsSuffix = /\/models$/i;
  let apiPath;
  let endpoint;
  let modelsEndpoint;

  if (defaults.callSuffix.test(inputPath)) {
    apiPath = inputPath.replace(defaults.callSuffix, "");
    endpoint = url.toString();
  } else if (modelsSuffix.test(inputPath)) {
    apiPath = inputPath.replace(modelsSuffix, "");
    modelsEndpoint = url.toString();
  } else {
    apiPath = /\/v\d+[a-z\d]*$/i.test(inputPath)
      ? inputPath
      : `${inputPath}/${defaults.apiVersion}`;
  }

  function buildEndpoint(path) {
    const result = new URL(url);
    result.pathname = `${apiPath.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
    return result.toString();
  }

  return {
    endpoint: endpoint || buildEndpoint(defaults.callPath),
    modelsEndpoint: modelsEndpoint || buildEndpoint("models"),
  };
}

function runEndpointSelfTest() {
  const cases = [
    ["openai", "https://gateway.example.com", "https://gateway.example.com/v1/chat/completions", "https://gateway.example.com/v1/models"],
    ["openai", "gateway.example.com/v1", "https://gateway.example.com/v1/chat/completions", "https://gateway.example.com/v1/models"],
    ["openai", "https://gateway.example.com/v1/models", "https://gateway.example.com/v1/chat/completions", "https://gateway.example.com/v1/models"],
    ["openai", "https://gateway.example.com/v1/responses", "https://gateway.example.com/v1/responses", "https://gateway.example.com/v1/models"],
    ["anthropic", "https://api.anthropic.com", "https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/models"],
    ["gemini", "https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent", "https://generativelanguage.googleapis.com/v1beta/models"],
  ];

  for (const [type, input, expectedEndpoint, expectedModelsEndpoint] of cases) {
    const actual = inferProviderEndpoints(type, input);
    if (actual.endpoint !== expectedEndpoint || actual.modelsEndpoint !== expectedModelsEndpoint) {
      throw new Error(`${type} 端点推导失败：${input} -> ${JSON.stringify(actual)}`);
    }
  }

  const selectionCases = [["1", 3, 0], ["3", 3, 2], ["0", 3, -1], ["4", 3, -1], ["1.5", 3, -1]];
  for (const [input, count, expected] of selectionCases) {
    const actual = parseSelection(input, count);
    if (actual !== expected) throw new Error(`删除序号解析失败：${input} -> ${actual}`);
  }
  console.log(`脚本自检通过（${cases.length} 个端点场景，${selectionCases.length} 个删除选择场景）`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url} 返回 ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    const contentType = response.headers.get("content-type") || "unknown";
    throw new Error(`${url} 没有返回 JSON，content-type=${contentType}: ${body.slice(0, 300)}`);
  }
}

function createSupabaseRestClient(supabaseUrl, serviceRoleKey, schema) {
  const restUrl = appendPath(supabaseUrl, "rest/v1");
  const baseHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    "Accept-Profile": schema,
    "Content-Profile": schema,
  };

  async function request(path, options = {}) {
    const response = await fetch(`${restUrl}/${path}`, {
      ...options,
      headers: {
        ...baseHeaders,
        ...(options.headers || {}),
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase ${path} 返回 ${response.status}: ${body.slice(0, 300)}`);
    }
    return body ? JSON.parse(body) : null;
  }

  return { request };
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

async function fetchOrPromptModels(provider) {
  try {
    return filterModels(await fetchModels(provider), provider.includePattern, provider.excludePatterns);
  } catch (error) {
    console.error(`\n自动获取模型列表失败：${error.message || error}`);
    if (!await confirm("是否手动输入模型名继续？", true)) {
      throw error;
    }
    const input = await ask("模型名，多个用逗号分隔");
    const models = input
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    if (models.length === 0) throw new Error("没有输入任何模型名");
    return [...new Set(models)].sort();
  }
}

async function promptProvider(env) {
  console.log("\n选择供应商：\n1) OpenAI / OpenAI 兼容接口\n2) Anthropic\n3) Gemini");
  const choice = await ask("请输入序号", "1");
  const type = { 1: "openai", 2: "anthropic", 3: "gemini" }[choice];
  if (!type) throw new Error("无效的供应商序号");

  const defaults = PROVIDERS[type];
  const name = await ask("监控名称", defaults.label);
  const serviceUrl = await ask("服务地址（域名、/v1 地址或任一完整端点）", defaults.serviceUrl);
  let { endpoint, modelsEndpoint } = inferProviderEndpoints(type, serviceUrl);
  console.log(`\n已自动推导：\n- 调用端点：${endpoint}\n- 模型列表：${modelsEndpoint}`);
  if (!await confirm("使用以上端点？", true)) {
    endpoint = await ask("调用端点", endpoint);
    modelsEndpoint = await ask("模型列表端点", modelsEndpoint);
  }
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
  const rows = await supabase.request("check_models?on_conflict=type,model&select=id,model", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(models.map((model) => ({ type, model }))),
  });
  return new Map(rows.map((row) => [row.model, row.id]));
}

async function syncProvider(supabase, provider, models) {
  const modelIds = await upsertModels(supabase, provider.type, models);
  const params = new URLSearchParams({
    select: "id,name,model_id,api_key,enabled,group_name",
    type: `eq.${provider.type}`,
    endpoint: `eq.${provider.endpoint}`,
  });
  const existingRows = await supabase.request(`check_configs?${params}`);

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
      await supabase.request(`check_configs?id=eq.${current.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(row),
      });
      updated += 1;
    }
  }

  if (inserts.length > 0) {
    await supabase.request("check_configs", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(inserts),
    });
  }
  console.log(`完成：新增 ${inserts.length}，更新 ${updated}，已有 ${models.length - inserts.length - updated}`);
}

function getModelName(config) {
  const relation = Array.isArray(config.check_models) ? config.check_models[0] : config.check_models;
  return relation?.model || "未知模型";
}

function parseSelection(input, count) {
  if (!/^\d+$/.test(input)) return -1;
  const index = Number(input) - 1;
  return index >= 0 && index < count ? index : -1;
}

async function removeMonitoredModel(supabase, dryRun) {
  const params = new URLSearchParams({
    select: "id,name,type,endpoint,enabled,group_name,check_models(model)",
    order: "group_name.asc.nullslast,name.asc",
  });
  const configs = await supabase.request(`check_configs?${params}`);
  if (configs.length === 0) {
    console.log("当前没有可删除的模型监控配置");
    return;
  }

  console.log(`\n当前共有 ${configs.length} 个模型监控配置：`);
  configs.forEach((config, index) => {
    const group = config.group_name || "未分组";
    const status = config.enabled ? "启用" : "停用";
    console.log(`${index + 1}) [${group}] ${getModelName(config)} | ${config.name} | ${config.type} | ${status}`);
  });

  let selected;
  while (!selected) {
    const answer = await ask("输入要删除的序号（q 取消）");
    if (answer.toLowerCase() === "q") {
      console.log("已取消，没有删除任何配置");
      return;
    }
    const selectedIndex = parseSelection(answer, configs.length);
    if (selectedIndex >= 0) {
      selected = configs[selectedIndex];
    } else {
      console.log(`请输入 1-${configs.length} 之间的序号，或输入 q 取消`);
    }
  }

  const displayEndpoint = selected.endpoint.split("?")[0] + (selected.endpoint.includes("?") ? "?…" : "");
  console.log(`\n即将删除：\n- 模型：${getModelName(selected)}\n- 名称：${selected.name}\n- 分组：${selected.group_name || "未分组"}\n- 端点：${displayEndpoint}`);
  console.log("注意：对应的检测历史会一并删除；共享模型定义和其他监控配置不会受影响。");

  if (dryRun) {
    console.log("\n预览完成，--dry-run 模式没有执行删除");
    return;
  }
  if (!await confirm("确认永久删除这个监控配置？", false)) {
    console.log("已取消，没有删除任何配置");
    return;
  }

  const deleted = await supabase.request(`check_configs?id=eq.${selected.id}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  if (!Array.isArray(deleted) || deleted.length !== 1) {
    throw new Error("删除结果异常，请刷新列表后重试");
  }
  console.log(`删除完成：${getModelName(selected)}（${selected.name}）`);
}

function printHelp() {
  console.log("Usage:");
  console.log("  pnpm models:sync -- [--schema public|dev] [--dry-run] [--self-test]");
  console.log("  pnpm models:remove -- [--schema public|dev] [--dry-run]");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.selfTest) return runEndpointSelfTest();
  if (!process.stdin.isTTY) throw new Error("引导模式需要在交互式终端中运行");

  const env = loadEnv();
  const schema = args.schema || await ask("Supabase schema", "public");
  if (!new Set(["public", "dev"]).has(schema)) throw new Error("schema 只能是 public 或 dev");

  if (args.remove) {
    const supabaseUrl = env.SUPABASE_URL || await ask("SUPABASE_URL");
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || await askSecret("SUPABASE_SERVICE_ROLE_KEY（输入不显示）");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase URL 和 Service Role Key 不能为空");
    const supabase = createSupabaseRestClient(supabaseUrl, serviceRoleKey, schema);
    return removeMonitoredModel(supabase, args.dryRun);
  }

  let supabase;
  while (true) {
    const provider = await promptProvider(env);
    console.log("\n正在获取模型列表...");
    const models = await fetchOrPromptModels(provider);
    if (models.length === 0) throw new Error("筛选后没有可监控模型，请调整包含或排除规则");

    console.log(`\n找到 ${models.length} 个模型：`);
    for (const model of models) console.log(`- ${model}`);
    if (!await confirm(args.dryRun ? "结束预览？" : "确认写入监控站？")) continue;

    if (!args.dryRun) {
      const supabaseUrl = env.SUPABASE_URL || await ask("SUPABASE_URL");
      const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || await askSecret("SUPABASE_SERVICE_ROLE_KEY（输入不显示）");
      if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase URL 和 Service Role Key 不能为空");
      if (!supabase) {
        supabase = createSupabaseRestClient(supabaseUrl, serviceRoleKey, schema);
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
