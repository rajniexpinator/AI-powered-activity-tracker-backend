/**
 * Phase 3: OpenAI integration for AI Chat Logging.
 * Provides a configured client and helpers for chat completions (prompt design,
 * structured extraction, etc. will use this in later tasks).
 */
import OpenAI from 'openai'

const apiKey = process.env.OPENAI_API_KEY
const organization = process.env.OPENAI_ORG_ID || undefined

/**
 * OpenAI client instance. Null if OPENAI_API_KEY is not set.
 * @type {OpenAI | null}
 */
export const openai = apiKey
  ? new OpenAI({ apiKey, organization: organization || undefined })
  : null

/**
 * Whether the OpenAI integration is available (API key configured).
 * @returns {boolean}
 */
export function isOpenAIAvailable() {
  return Boolean(apiKey)
}

/**
 * Create a chat completion (for use by prompt design, extraction, etc.).
 *
 * @param {Array<{ role: 'system' | 'user' | 'assistant'; content: string }>} messages - Chat messages
 * @param {Object} [options] - Optional overrides
 * @param {string} [options.model='gpt-4o-mini'] - Model name
 * @param {number} [options.temperature] - Sampling temperature
 * @param {boolean} [options.stream=false] - Stream response
 * @returns {Promise<import('openai').Chat.Completions.ChatCompletion>}
 * @throws {Error} If OPENAI_API_KEY is not set or the API request fails
 */
export async function createChatCompletion(messages, options = {}) {
  if (!openai) {
    throw new Error('OpenAI is not configured: set OPENAI_API_KEY in the environment')
  }
  const { model = 'gpt-4o-mini', temperature, stream = false, ...rest } = options
  const params = {
    model,
    messages,
    stream,
    ...(temperature !== undefined && { temperature }),
    ...rest,
  }
  return openai.chat.completions.create(params)
}

/**
 * Get the first assistant reply text from a chat completion.
 *
 * @param {import('openai').Chat.Completions.ChatCompletion} completion
 * @returns {string | null}
 */
export function getAssistantContent(completion) {
  const choice = completion.choices?.[0]
  const content = choice?.message?.content
  return typeof content === 'string' ? content : null
}
