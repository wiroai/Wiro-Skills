#!/usr/bin/env node
// Builds the Wiro AI skills from the command sources of the Wiro AI plugin.
//
//   node scripts/build.mjs [--plugin <path>]          write skills/<name>/SKILL.md
//   node scripts/build.mjs [--plugin <path>] --check  exit 1 when a skill is missing, stale or out of date
//
// <path> is a checkout of https://github.com/wiroai/Wiro-Plugin (default: ../Wiro-Plugin).
// Sources: <path>/src/commands/<name>.md and <path>/src/partials/<name>.md, the same files the
// plugin's slash commands are built from. In a body, {{args}} is the user's request,
// {{> partial key="value"}} pulls in a partial, {{connect}} says how to connect the Wiro MCP
// server and {{cmd:<name>}} names another skill.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const check = argv.includes('--check');
const pluginAt = argv.indexOf('--plugin');
if (pluginAt >= 0 && !argv[pluginAt + 1]) {
  console.error('usage: node scripts/build.mjs [--plugin <path to Wiro-Plugin>] [--check]');
  process.exit(2);
}
const plugin = resolve(root, pluginAt >= 0 ? argv[pluginAt + 1] : '../Wiro-Plugin');
if (!existsSync(join(plugin, 'src/commands'))) {
  console.error(`${plugin}/src/commands not found. Clone https://github.com/wiroai/Wiro-Plugin and pass --plugin <path>.`);
  process.exit(2);
}

// The commands that make sense as skills on their own, and when an agent should load each one.
// The plugin's agent, workflow and task commands are left out: the wiro-agents, wiro-workflows
// and wiro-ai skills in Wiro-Plugin cover them.
const SKILLS = {
  image: 'Use when the user wants new images made with Wiro AI or through the Wiro MCP server.',
  'edit-image': 'Use when the user wants an existing image changed, restyled, upscaled or cut out with Wiro AI or through the Wiro MCP server.',
  video: 'Use when the user wants a video, or a still image animated, with Wiro AI or through the Wiro MCP server.',
  music: 'Use when the user wants music, a song or a jingle made with Wiro AI or through the Wiro MCP server.',
  speech: 'Use when the user wants text read aloud, a voice-over or narration made with Wiro AI or through the Wiro MCP server.',
  transcribe: 'Use when the user wants a recording or a video turned into text, captions or subtitles with Wiro AI or through the Wiro MCP server.',
  '3d': 'Use when the user wants a 3D model made from a photo or a description with Wiro AI or through the Wiro MCP server.',
  models: 'Use when the user asks which Wiro AI model fits a job, what Wiro AI models cost, or how two models compare.',
};

const ARGS = "the user's request in this conversation";
const CONNECT = "tell the user to connect the Wiro MCP server: add the remote server `https://mcp.wiro.ai/v1` (Streamable HTTP) under the name `wiro` and sign in with a Wiro account when the client asks, or send a Wiro API key as a Bearer token. In Claude Code that is `claude mcp add --transport http wiro https://mcp.wiro.ai/v1`; setup for other clients is at https://wiro.ai/docs/wiro-mcp-server.";
const skillName = name => `wiro-${name}`;
const cmd = name => `the \`${skillName(name)}\` skill`;

// Agents that read $1, $2 ... as arguments get dollar amounts written as "1 USD".
const usdAmounts = text => text.replace(/\$(\d+(?:\.\d+)?)/g, '$1 USD');

function parseSource(path) {
  const text = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path}: missing front matter`);
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`${path}: bad front matter line "${line}"`);
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  for (const key of ['name', 'description']) {
    if (!meta[key]) throw new Error(`${path}: front matter needs ${key}`);
  }
  return { meta, body: match[2] };
}

const partials = Object.fromEntries(
  readdirSync(join(plugin, 'src/partials'))
    .filter(file => file.endsWith('.md'))
    .map(file => [file.slice(0, -3), readFileSync(join(plugin, 'src/partials', file), 'utf8').trimEnd()]),
);

function expand(body, where) {
  return body.replace(/\{\{>\s*([\w-]+)((?:\s+[\w-]+="(?:[^"\\]|\\.)*")*)\s*\}\}/g, (_, name, rawParams) => {
    const partial = partials[name];
    if (partial === undefined) throw new Error(`${where}: unknown partial ${name}`);
    const params = {};
    for (const [, key, value] of rawParams.matchAll(/([\w-]+)="((?:[^"\\]|\\.)*)"/g)) {
      params[key] = value.replace(/\\(.)/g, '$1');
    }
    return partial.replace(/\{\{(?!>|args\}\}|connect\}\}|cmd:)([\w-]+)\}\}/g, (__, key) => {
      if (params[key] === undefined) throw new Error(`${where}: partial ${name} needs ${key}="..."`);
      return params[key];
    });
  });
}

function render(name, source, where) {
  if (source.meta.name !== name) throw new Error(`${where}: name is "${source.meta.name}", expected "${name}"`);
  let body = expand(source.body, where)
    .replaceAll('{{connect}}', CONNECT)
    .replace(/\{\{cmd:([\w-]+)\}\}/g, (_, other) => {
      if (!(other in SKILLS)) throw new Error(`${where}: refers to ${other}, which is not one of these skills`);
      return cmd(other);
    })
    .replaceAll('{{args}}', ARGS)
    .replaceAll('This command only reads', 'This skill only reads')
    .replaceAll('naming the command that runs', 'naming the skill that runs')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';
  body = usdAmounts(body);
  const description = `${source.meta.description}. ${SKILLS[name]}`;
  const text = ['---', `name: ${skillName(name)}`, `description: ${JSON.stringify(description)}`, '---', '', body].join('\n');
  lint(text, description, where);
  return text;
}

function lint(text, description, where) {
  const problems = [];
  if (/\{\{/.test(text)) problems.push('an unresolved {{...}}');
  if (text.includes('$ARGUMENTS')) problems.push('$ARGUMENTS');
  if (/\$\d/.test(text)) problems.push('a $<digit> that an agent could read as an argument');
  if (/this command|the command that|slash command/i.test(text)) problems.push('slash-command wording; a skill is not a command');
  if (/(^|[\s(])\/wiro/.test(text)) problems.push('a slash command name');
  if (/\u2014/.test(text)) problems.push('an em dash');
  if (description.length > 1024) problems.push(`a description of ${description.length} characters (limit 1024)`);
  if (problems.length) throw new Error(`${where}: ${problems.join(', ')}`);
}

const expected = new Map();
for (const name of Object.keys(SKILLS)) {
  const path = join(plugin, 'src/commands', `${name}.md`);
  if (!existsSync(path)) throw new Error(`${path} not found`);
  expected.set(`skills/${skillName(name)}/SKILL.md`, render(name, parseSource(path), `src/commands/${name}.md`));
}

let problems = 0;
const skillsDir = join(root, 'skills');
for (const dir of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
  const file = `skills/${dir}/SKILL.md`;
  if (expected.has(file)) continue;
  if (check) { console.error(`stale: skills/${dir}`); problems++; continue; }
  rmSync(join(skillsDir, dir), { recursive: true });
  console.log(`removed skills/${dir}`);
}
for (const [file, text] of expected) {
  const path = join(root, file);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === text) continue;
  if (check) { console.error(`out of date: ${file}`); problems++; continue; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${file}`);
}

if (check) {
  if (problems) {
    console.error(`${problems} skill file(s) differ from the sources in ${plugin}. Run: node scripts/build.mjs --plugin <path>`);
    process.exit(1);
  }
  console.log(`${expected.size} skills match the sources in ${plugin}.`);
}
