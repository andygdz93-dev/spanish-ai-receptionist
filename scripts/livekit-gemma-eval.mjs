import { inference, initializeLogger, llm } from '@livekit/agents';
import dotenv from 'dotenv';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, scenarios } from './conversation-eval.mjs';

initializeLogger({ pretty: false, level: 'error' });

const MODEL = 'google/gemma-4-31b-it';
const MAX_USD = 1.0;
const REQUEST_OUTPUT_LIMIT = 120;
const MAX_INPUT_TOKENS_ESTIMATE = 12000; // Conservative ceiling for these short fixtures.
// Current published Build/Ship non-cached Gemma 4 31B token rates per million.
const INPUT_RATE = 0.4;
const OUTPUT_RATE = 1.2;
const envFile = fileURLToPath(new URL('../.env.local', import.meta.url));
const outputFile = resolve('livekit-gemma-evaluation.local.json');

function readiness() {
  if (fs.existsSync(envFile)) dotenv.config({ path: envFile, quiet: true });
  const requirements = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
  const missing = requirements.filter((name) => !process.env[name]?.trim());
  return {
    model: MODEL,
    mode: 'synthetic text only',
    credential_names_configured: requirements.filter((name) => !missing.includes(name)),
    missing_credential_names: missing,
    provider_spending_cap_verified: process.env.LIVEKIT_TEST_CAP_VERIFIED === 'yes',
    explicit_soft_budget_acknowledged: process.env.LIVEKIT_TEST_SOFT_BUDGET_ACKNOWLEDGED === 'yes',
    limit_usd: MAX_USD,
    output_tokens_per_request: REQUEST_OUTPUT_LIMIT,
    script_does_not_enforce_provider_billing_cap: true,
    planned_scenarios: scenarios.length,
    planned_turns: scenarios.reduce((total, scenario) => total + scenario.turns.length, 0),
  };
}

async function run() {
  const status = readiness();
  if (
    status.missing_credential_names.length ||
    (!status.provider_spending_cap_verified && !status.explicit_soft_budget_acknowledged)
  ) {
    console.error(
      'BLOCKED: Credentials and either provider cap or explicitly acknowledged soft budget required.',
    );
    console.error(JSON.stringify(status, null, 2));
    process.exitCode = 2;
    return;
  }
  const source = fs.readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
  const found = source.match(/instructions:\s*dedent`([\s\S]*?)`/);
  if (!found || !source.includes(`model: '${MODEL}'`)) {
    throw new Error('Model or instructions differ from expected production configuration');
  }
  const instructions = found[1].replace(/^ {6}/gm, '').trim();
  const model = new inference.LLM({
    model: MODEL,
    modelOptions: { max_completion_tokens: REQUEST_OUTPUT_LIMIT, temperature: 0 },
  });
  let measuredUsd = 0;
  const records = [];
  try {
    for (const scenario of scenarios) {
      const context = llm.ChatContext.empty();
      context.addMessage({ role: 'system', content: instructions });
      for (const caller of scenario.turns) {
        // Soft safety margin only, not an actual provider billing cap.
        const worstCaseUsd =
          (MAX_INPUT_TOKENS_ESTIMATE * INPUT_RATE + REQUEST_OUTPUT_LIMIT * OUTPUT_RATE) / 1_000_000;
        if (measuredUsd + worstCaseUsd >= MAX_USD - 0.1) {
          throw new Error('Budget safety margin reached: stopping before next request');
        }
        context.addMessage({ role: 'user', content: caller });
        const start = performance.now();
        const result = await model.chat({ chatCtx: context }).collect();
        const response = result.text ?? '';
        const usage = result.usage;
        if (
          !usage ||
          !Number.isFinite(usage.promptTokens) ||
          !Number.isFinite(usage.completionTokens)
        ) {
          throw new Error('Provider did not return token usage; stopping immediately');
        }
        measuredUsd +=
          (usage.promptTokens * INPUT_RATE + usage.completionTokens * OUTPUT_RATE) / 1_000_000;
        records.push({
          scenario: scenario.id,
          caller,
          response,
          elapsed_ms: Math.round(performance.now() - start),
          model: MODEL,
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
        });
        context.addMessage({ role: 'assistant', content: response });
      }
    }
  } finally {
    await model.aclose();
    const verdict = evaluate(records);
    const safeReport = {
      type: 'configured-livekit-model-text-integration',
      model: MODEL,
      estimated_usd_from_reported_tokens: measuredUsd,
      cost_is_estimate_not_provider_billing_receipt: true,
      scenario_count: scenarios.length,
      completed_turns: records.length,
      total_assertions: verdict.total,
      passed: verdict.passed,
      failed: verdict.failed,
      cases: verdict.cases,
      records,
    };
    fs.writeFileSync(outputFile, JSON.stringify(safeReport, null, 2), { mode: 0o600 });
    console.log(
      JSON.stringify({
        model: MODEL,
        completed_turns: records.length,
        estimated_usd: measuredUsd,
        passed: verdict.passed,
        failed: verdict.failed,
        report: outputFile,
      }),
    );
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--preflight') {
  console.log(JSON.stringify(readiness(), null, 2));
} else if (args.length === 1 && args[0] === '--run') {
  await run();
} else {
  console.log('Usage: node scripts/livekit-gemma-eval.mjs --preflight | --run');
  process.exitCode = 2;
}
