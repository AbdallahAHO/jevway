#!/usr/bin/env node
/**
 * inbox.mjs: a throwaway email inbox on the mail.tm REST API (no key, no dependencies, Node >= 24).
 *
 * Gives a coding agent a real address for a test or demo sign-up the user asked for, then pulls the verification
 * code or confirmation link out of the email that arrives. The password lives only in the chmod-600 env file and is
 * never printed.
 *
 * Usage:
 *   node inbox.mjs create --out "$SCRATCH/inbox.env"          # prints only the address
 *   node inbox.mjs wait --env "$SCRATCH/inbox.env" --from example --timeout 120
 *     # → {"id":"…","from":"…","subject":"…","code":"123456","links":[…],"text":"…"}
 *   node inbox.mjs list --env "$SCRATCH/inbox.env"            # date, from, subject, id
 *   node inbox.mjs read --env "$SCRATCH/inbox.env" <id>       # full message text
 *
 * Env file (written by `create`, the same lines jevway's own inbox files hold): ADDR=…  PASS=…  API=…
 * `create` tries mail.tm, then mail.gw (same API) once if mail.tm fails. `--api https://api.mail.gw` (or
 * MAILTM_API) uses only that provider: use it once when a site rejects the first address's domain.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

const MAIL_TM = 'https://api.mail.tm'
const MAIL_GW = 'https://api.mail.gw'
const POLL_INTERVAL_MS = 3000

// --- HTTP ---

/** Replaces every secret in `text` with `[secret]`, so a provider that echoes one never leaks it. */
const scrub = (text, secrets) => secrets.filter(Boolean).reduce((clean, secret) => clean.split(secret).join('[secret]'), text)

async function callApi(api, path, { method = 'GET', body, token, secrets = [] } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      accept: 'application/ld+json',
      ...(body && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = scrub((await response.text()).slice(0, 300), [...secrets, token])
    throw new Error(`${method} ${api}${path} → ${response.status} ${detail}`)
  }
  return response.json()
}

/** Collections come back as `{ 'hydra:member': [...] }` (ld+json) or a bare array (plain json). */
const membersOf = (collection) => (Array.isArray(collection) ? collection : collection['hydra:member'] ?? [])

const fetchToken = async ({ ADDR, PASS, API }) =>
  (await callApi(API, '/token', { method: 'POST', body: { address: ADDR, password: PASS }, secrets: [PASS] })).token

const listMessages = async (inbox, token) => membersOf(await callApi(inbox.API, '/messages', { token, secrets: [inbox.PASS] }))

const readMessage = (inbox, token, id) => callApi(inbox.API, `/messages/${encodeURIComponent(id)}`, { token, secrets: [inbox.PASS] })

// --- Env file ---

function readEnvFile(file) {
  if (!file) throw new Error('missing --env <file> (written by `create`)')
  const entries = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.match(/^(\w+)=(.*)$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value.trim()])
  const inbox = Object.fromEntries(entries)
  if (!inbox.ADDR || !inbox.PASS) throw new Error(`${file} has no ADDR/PASS`)
  return { API: process.env.MAILTM_API || MAIL_TM, ...inbox }
}

function writeEnvFile(file, inbox) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `ADDR=${inbox.ADDR}\nPASS=${inbox.PASS}\nAPI=${inbox.API}\n`, { mode: 0o600 })
  chmodSync(file, 0o600) // mode is ignored when the file already exists
}

// --- Message parsing ---

const htmlOf = (message) => [message.html ?? []].flat().join('\n')

const stripHtml = (html) =>
  html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const bodyText = (message) => message.text || stripHtml(htmlOf(message))

/** First standalone 4–8 digit number in subject + body ("Your code is 482913" → "482913"). */
const extractCode = (message) =>
  `${message.subject}\n${bodyText(message)}`.match(/(?<![\w.,/-])\d{4,8}(?!\d|[.,/-]\d)/)?.[0] ?? null

// Doctype/namespace URLs and images (logos, tracking pixels) are never the link to follow.
const NOT_A_LINK = /^https?:\/\/www\.w3\.org\/|\.(png|jpe?g|gif|svg|webp|ico)(\?|$)/i

/** Unique http(s) URLs a person could follow, from the text and html parts, html entities for `&` decoded. */
function extractLinks(message) {
  const urls = `${message.text ?? ''}\n${htmlOf(message)}`.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []
  return [...new Set(urls.map((url) => url.replace(/&amp;/g, '&')))].filter((url) => !NOT_A_LINK.test(url))
}

const matchesFilters = (message, { from, subject }) => {
  const sender = `${message.from?.name ?? ''} ${message.from?.address ?? ''}`.toLowerCase()
  return (
    (!from || sender.includes(from.toLowerCase())) &&
    (!subject || (message.subject ?? '').toLowerCase().includes(subject.toLowerCase()))
  )
}

// --- Commands ---

async function createOn(api) {
  const domains = membersOf(await callApi(api, '/domains'))
  const domain = domains.find((entry) => entry.isActive !== false)?.domain
  if (!domain) throw new Error(`${api} offered no active domain`)
  const inbox = {
    ADDR: `test-${randomBytes(5).toString('hex')}@${domain}`,
    PASS: randomBytes(18).toString('base64url'),
    API: api,
  }
  await callApi(api, '/accounts', { method: 'POST', body: { address: inbox.ADDR, password: inbox.PASS }, secrets: [inbox.PASS] })
  return inbox
}

async function create({ out, api }) {
  let inbox
  if (api) {
    inbox = await createOn(api)
  } else {
    try {
      inbox = await createOn(MAIL_TM)
    } catch (first) {
      console.error(`mail.tm failed (${first.message}); trying mail.gw once`)
      inbox = await createOn(MAIL_GW)
    }
  }
  const envFile = out || join(tmpdir(), 'jevway-inbox', `${inbox.ADDR.split('@')[0]}.env`)
  writeEnvFile(envFile, inbox)
  console.error(`credentials → ${envFile} (chmod 600)`)
  console.log(inbox.ADDR)
}

async function wait({ env, from, subject, timeout }) {
  const inbox = readEnvFile(env)
  const token = await fetchToken(inbox)
  const deadline = Date.now() + Number(timeout) * 1000

  for (;;) {
    const match = (await listMessages(inbox, token)).find((message) => matchesFilters(message, { from, subject }))
    if (match) {
      const message = await readMessage(inbox, token, match.id)
      const text = bodyText(message)
      const result = { id: message.id, from: message.from?.address, subject: message.subject, code: extractCode(message), links: extractLinks(message), text }
      console.log(JSON.stringify(result, null, 2))
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)))
  }
  throw new Error(`no matching message for ${inbox.ADDR} within ${timeout}s`)
}

async function list({ env }) {
  const inbox = readEnvFile(env)
  const messages = await listMessages(inbox, await fetchToken(inbox))
  if (messages.length === 0) return console.log(`(empty) ${inbox.ADDR}`)
  for (const message of messages) {
    console.log([message.createdAt, message.from?.address, message.subject, message.id].join('  '))
  }
}

async function read({ env }, id) {
  if (!id) throw new Error('usage: read --env <file> <id>')
  const inbox = readEnvFile(env)
  const message = await readMessage(inbox, await fetchToken(inbox), id)
  console.log(`From: ${message.from?.address}\nSubject: ${message.subject}\nDate: ${message.createdAt}\n\n${bodyText(message)}`)
}

// --- CLI ---

const commands = { create, wait, list, read }

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    env: { type: 'string' },
    api: { type: 'string', default: process.env.MAILTM_API },
    from: { type: 'string' },
    subject: { type: 'string' },
    timeout: { type: 'string', default: '120' },
  },
})

const [commandName, ...commandArgs] = positionals
const command = commands[commandName]
if (!command) {
  console.error('usage: inbox.mjs <create [--out f] [--api url] | wait --env f [--from s] [--subject s] [--timeout 120] | list --env f | read --env f <id>>')
  process.exit(2)
}

command({ ...options, api: options.api?.replace(/\/$/, '') }, ...commandArgs).catch((error) => {
  console.error(`inbox.mjs ${commandName}: ${error.message}`)
  process.exit(1)
})
