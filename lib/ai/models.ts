
import getOpenAIClient from '../openai';

export interface ModelConfig {
  name: string;
  contextWindow: number;
  temperature: number;
  maxTokens: number;
  modelPath?: string;
}

export interface ModelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
}

export interface ModelTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelResponse {
  usesTools: boolean;
  tools: ModelToolCall[];
  assistantMessage: {
    role: 'assistant';
    content: string | null;
    tool_calls?: ModelToolCall[];
  };
  content: string;
}

export class NeuralNet {
  private config: ModelConfig;

  constructor(modelType: string = 'gpt-4.1-mini') {
    this.config = {
      name: modelType || 'gpt-4.1-mini',
      contextWindow: 32768,
      temperature: 0.7,
      maxTokens: 2048,
    };

    console.log(`[Models] OpenAI model configured: ${this.config.name}`);
  }

  /**
   * Check whether the OpenAI client has an API key.
   */
  isReady(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  /**
   * Get the current model name.
   */
  getName(): string {
    return this.config.name;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): ModelConfig {
    return { ...this.config };
  }

  /**
   * Update configuration dynamically.
   */
  updateConfig(newConfig: Partial<ModelConfig>): void {
    const updated = { ...this.config, ...newConfig };

    if (!updated.name.trim()) {
      throw new Error('Model name cannot be empty.');
    }

    if (
      !Number.isFinite(updated.temperature) ||
      updated.temperature < 0 ||
      updated.temperature > 2
    ) {
      throw new Error('Temperature must be between 0 and 2.');
    }

    if (
      !Number.isInteger(updated.maxTokens) ||
      updated.maxTokens < 1
    ) {
      throw new Error('maxTokens must be a positive integer.');
    }

    this.config = updated;

    console.log(`[Models] Configuration updated: ${this.config.name}`);
  }

  /**
   * Generate an AI response using OpenAI.
   */
  async generate(
    messages: ModelMessage[],
    tools?: ModelTool[]
  ): Promise<ModelResponse> {
    if (!this.isReady()) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    if (!messages.length) {
      throw new Error('At least one message is required.');
    }


    try {
      const openai = getOpenAIClient();

      const response = await openai.chat.completions.create({
        model: this.config.name,
        messages: messages as any,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        ...(tools?.length
          ? {
              tools,
              tool_choice: 'auto' as const,
            }
          : {}),
      });

      const message = response.choices[0]?.message;

      if (!message) {
        throw new Error('OpenAI returned an empty response.');
      }

      const toolCalls = (message.tool_calls ?? []) as unknown as ModelToolCall[];

      return {
        usesTools: toolCalls.length > 0,
        tools: toolCalls,
        assistantMessage: {
          role: 'assistant',
          content: message.content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        content: message.content ?? '',
      };
    } catch (error) {
      console.error('[Models] Error generating response:', error);
      throw error;
    }
  }
}


export default NeuralNet;
