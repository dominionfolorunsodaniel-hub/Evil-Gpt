
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

  constructor(
    modelType: string = process.env.GROQ_MODEL || 'openai/gpt-oss-20b'
  ) {
    this.config = {
      name: modelType || 'openai/gpt-oss-20b',
      contextWindow: 32768,
      temperature: 0.7,
      maxTokens: 2048,
    };

    console.log(`[Models] Groq model configured: ${this.config.name}`);
  }

  isReady(): boolean {
    return Boolean(process.env.GROQ_API_KEY);
  }

  getName(): string {
    return this.config.name;
  }

  getConfig(): ModelConfig {
    return { ...this.config };
  }

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

  async generate(
    messages: ModelMessage[],
    tools?: ModelTool[]
  ): Promise<ModelResponse> {
    if (!this.isReady()) {
      throw new Error('GROQ_API_KEY is not configured.');
    }

    if (!messages.length) {
      throw new Error('At least one message is required.');
    }

    try {
      const groq = getOpenAIClient();

      const response = await groq.chat.completions.create({
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
        throw new Error('Groq returned an empty response.');
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
      console.error('[Models] Groq generation error:', error);
      throw error;
    }
  }
}

export default NeuralNet;

