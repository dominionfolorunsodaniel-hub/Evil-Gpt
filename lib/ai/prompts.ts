
import OpenAI from 'openai';

import type {
  ModelMessage,
  ModelTool,
} from './models';

import { Persona } from '../../persona';
import { DEFAULT_WICKED_CONFIG } from '../../config';

export interface PromptOptions {
  uncensored?: boolean;
  tools?: ModelTool[];
  context?: unknown;
  additionalInstructions?: string[];
}

export interface ChatCompletionOptions extends PromptOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class EvilPromptGenerator {
  private persona?: Persona;
  private openai?: OpenAI;

  constructor(openai?: OpenAI, persona?: Persona) {
    this.openai = openai;
    this.persona = persona;
  }

  /**
   * Generate the system prompt.
   */
  generateSystemPrompt(options: PromptOptions = {}): string {
    const personaPrompt =
      this.persona?.getSystemMessage() ||
      DEFAULT_WICKED_CONFIG.systemPrompt;

    let prompt = `${personaPrompt}

## Core Behaviour
- Be accurate, helpful, and direct.
- Explain complex topics clearly.
- Adapt explanations to the user's knowledge level.
- Use Markdown where appropriate.
- Distinguish facts from assumptions.
- Never invent information or claim to have performed actions you did not perform.
- Maintain your personality while remaining responsible and accurate.

`;

    if (options.additionalInstructions?.length) {
      prompt += `## Additional Instructions
${options.additionalInstructions
  .map((item: string, index: number) => `${index + 1}. ${item}`)
  .join('\n')}

`;
    }

    if (options.context !== undefined) {
      prompt += `## Conversation Context
${JSON.stringify(options.context, null, 2)}

`;
    }

    if (options.tools?.length) {
      prompt += `## Available Tools
${options.tools
  .map(
    (tool) =>
      `- ${tool.function.name}: ${tool.function.description}`
  )
  .join('\n')}

Use available tools only when appropriate. Never claim a tool was executed before receiving its result.

`;
    }

    if (options.uncensored) {
      prompt += `## Communication Style
- Be candid and direct.
- Use sarcasm or sharp humour when appropriate.
- Prioritize clarity and useful explanations.

`;
    }

    prompt += `## Response Guidelines
- Be concise when possible and detailed when necessary.
- Answer the actual question.
- Explain uncertainty honestly.
- Do not fabricate sources, results, or capabilities.
`;

    return prompt.trim();
  }

  /**
   * Compatible with the existing Engine.
   */
  build(options: PromptOptions = {}): string {
    return this.generateSystemPrompt(options);
  }

  /**
   * Convert internal messages into OpenAI-compatible messages.
   */
  buildMessages(
    history: ModelMessage[],
    options: PromptOptions = {}
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: this.generateSystemPrompt(options),
      },
    ];

    for (const message of history) {
      if (message.role === 'system') continue;

      if (message.role === 'user') {
        messages.push({
          role: 'user',
          content: message.content ?? '',
        });
        continue;
      }

      if (message.role === 'assistant') {
        if (message.tool_calls?.length) {
          messages.push({
            role: 'assistant',
            content: message.content,
            tool_calls: message.tool_calls as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
          });
        } else {
          messages.push({
            role: 'assistant',
            content: message.content ?? '',
          });
        }
        continue;
      }

      if (message.role === 'tool') {
        if (!message.tool_call_id) {
          throw new Error('Tool message is missing tool_call_id.');
        }

        messages.push({
          role: 'tool',
          tool_call_id: message.tool_call_id,
          content: message.content ?? '',
        });
      }
    }

    return messages;
  }

  /**
   * Convert internal tool definitions into OpenAI format.
   */
  buildOpenAITools(
    tools: ModelTool[]
  ): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
  }

  /**
   * Generate individual conversation messages.
   */
  generateUserMessage(content: string): ModelMessage {
    return { role: 'user', content };
  }

  generateAssistantMessage(content: string): ModelMessage {
    return { role: 'assistant', content };
  }

  generateToolMessage(
    toolCallId: string,
    content: string
  ): ModelMessage {
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content,
    };
  }

  /**
   * Complete OpenAI request flow.
   */
  async chatCompletion(
    history: ModelMessage[],
    options: ChatCompletionOptions = {}
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    if (!this.openai) {
      throw new Error(
        'OpenAI client is not configured. Provide an OpenAI instance.'
      );
    }

    const {
      model = 'gpt-4o',
      temperature = 0.7,
      maxTokens = 2048,
      tools,
      ...promptOptions
    } = options;

    const messages = this.buildMessages(history, promptOptions);

    const openaiTools = tools?.length
      ? this.buildOpenAITools(tools)
      : undefined;

    return this.openai.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(openaiTools?.length
        ? {
            tools: openaiTools,
            tool_choice: 'auto' as const,
          }
        : {}),
    });
  }

  /**
   * Process tool calls returned by OpenAI.
   */
  async processToolCalls(
    completion: OpenAI.Chat.Completions.ChatCompletion,
    implementations: Record<
      string,
      (args: Record<string, unknown>) => Promise<string>
    >
  ): Promise<ModelMessage[]> {
    const message = completion.choices[0]?.message;

    if (!message?.tool_calls?.length) return [];

    const results: ModelMessage[] = [];

    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue;

      const implementation = implementations[call.function.name];

      if (!implementation) {
        results.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Tool "${call.function.name}" is not registered.`,
        });
        continue;
      }

      try {
        const parsed: unknown = JSON.parse(call.function.arguments);

        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error('Tool arguments must be a JSON object.');
        }

        const result = await implementation(
          parsed as Record<string, unknown>
        );

        results.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        });
      } catch (error) {
        results.push({
          role: 'tool',
          tool_call_id: call.id,
          content:
            error instanceof Error
              ? `Tool execution failed: ${error.message}`
              : 'Tool execution failed.',
        });
      }
    }

    return results;
  }

  /**
   * Format the response for display.
   */
  formatResponse(
    response: OpenAI.Chat.Completions.ChatCompletion
  ): string {
    const choice = response.choices[0];

    if (!choice) return 'No response generated.';

    if (choice.message.content) {
      return choice.message.content.trim();
    }

    if (choice.message.tool_calls?.length) {
      return 'The assistant requested tool execution.';
    }

    return 'The assistant returned an empty response.';
  }

  setOpenAIClient(openai: OpenAI): void {
    this.openai = openai;
  }

  setPersona(persona: Persona): void {
    this.persona = persona;
  }

  clearPersona(): void {
    this.persona = undefined;
  }
}

/**
 * Compatibility with the existing Engine.
 */
export class PromptBuilder extends EvilPromptGenerator {}

/**
 * Create the default persona using the existing configuration.
 */
export const createDefaultPersona = (): Persona =>
  new Persona(DEFAULT_WICKED_CONFIG);

export default EvilPromptGenerator;

