import { spawn } from 'node:child_process';
import { backendForModel, claudeCliModel } from './types.js';

export async function callJudge(model: string, prompt: string): Promise<string> {
  return backendForModel(model) === 'openrouter'
    ? callOpenRouter(model, prompt)
    : callClaude(model, prompt);
}

async function callOpenRouter(model: string, prompt: string): Promise<string> {
  const apiModel = model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://games.coop',
      'X-Title': 'coga-harness-judge',
    },
    body: JSON.stringify({
      model: apiModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
      temperature: 0.3,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenRouter judge call failed ${response.status}: ${text}`);
  const payload: unknown = JSON.parse(text);
  const choices = record(payload)?.choices;
  const firstChoice = Array.isArray(choices) ? record(choices[0]) : undefined;
  const content = record(firstChoice?.message)?.content;
  if (typeof content !== 'string') {
    throw new Error(`Unexpected OpenRouter response shape: ${text.slice(0, 500)}`);
  }
  return content;
}

async function callClaude(model: string, prompt: string): Promise<string> {
  const cliModel = claudeCliModel(model);
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['--print', '--model', cliModel, '--dangerously-skip-permissions'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(`claude --print exited ${code}: ${err.slice(0, 500)}`));
        return;
      }
      if (!out.trim()) {
        reject(new Error(`claude --print produced no output. stderr: ${err.slice(0, 500)}`));
        return;
      }
      resolve(out);
    });
    child.on('error', (error) => reject(new Error(`Failed to spawn claude: ${error.message}`)));
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}
