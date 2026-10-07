import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

/**
 * The aiqu gateway (OpenAI-compatible) as an AI SDK provider.
 *
 * supportsStructuredOutputs currently has no effect on any call. In
 * @ai-sdk/openai-compatible the flag only changes how a JSON response format
 * with a schema is sent (`json_schema` instead of `json_object`), and nothing
 * in the brain asks for one: the draft is plain text and repairs are
 * edit_answer tool calls (no generateObject / Output.object anywhere, checked
 * 2026-10-07, and git history of this package has no structured call either).
 * It arrived with the loop in ed8be45 and is left on, unchanged on demo day:
 * if a structured call is ever added, it makes the gateway get a real
 * `json_schema` instead of a schemaless `json_object`. Removing it today would
 * change nothing on the wire, but it is not this cleanup's call to make.
 */
export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export function aiquModel(cfg: LlmConfig, model = cfg.model): LanguageModel {
  return createOpenAICompatible({ name: 'aiqu', baseURL: cfg.baseUrl, apiKey: cfg.apiKey, supportsStructuredOutputs: true })(model)
}

/** Thinking is a chat-template switch on this gateway, passed per call. */
export const thinkingOption = (on: boolean) => ({ aiqu: { chat_template_kwargs: { thinking: on } } })
