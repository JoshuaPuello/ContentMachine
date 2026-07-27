import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const OUTPUT_ROOT = path.join(__dirname, '..', '..', 'output')

const mutationChains = new Map()

export const validSessionId = (value) => /^[a-zA-Z0-9_-]+$/.test(String(value || ''))

export const sessionDirectory = (sessionId) => {
  if (!validSessionId(sessionId)) throw new Error('A valid project session id is required')
  return path.join(OUTPUT_ROOT, String(sessionId))
}

export const sessionJsonPath = (sessionId) => path.join(sessionDirectory(sessionId), 'session.json')

export const withSessionMutationLock = async (sessionId, operation) => {
  if (!String(sessionId || '').trim()) throw new Error('A session id is required')
  const previous = mutationChains.get(sessionId) || Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  mutationChains.set(sessionId, current)
  try {
    return await current
  } finally {
    if (mutationChains.get(sessionId) === current) mutationChains.delete(sessionId)
  }
}

export const readSessionSnapshot = async (sessionId) =>
  JSON.parse(await fs.readFile(sessionJsonPath(sessionId), 'utf8'))

export const writeSessionSnapshot = async (sessionId, snapshot) => {
  const directory = sessionDirectory(sessionId)
  await fs.mkdir(directory, { recursive: true })
  const target = sessionJsonPath(sessionId)
  const temporary = `${target}.tmp.${randomUUID()}`
  await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8')
  await fs.rename(temporary, target)
}

await fs.mkdir(OUTPUT_ROOT, { recursive: true })
