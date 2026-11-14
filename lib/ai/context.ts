import type { ModelMessage } from './models';

export interface ContextConfig {
  maxHistoryLength: number;
  includeSystemPrompt: boolean;
}

export class ContextManager {
  private history: ModelMessage[] = [];
  private config: ContextConfig;

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = {
      maxHistoryLength: config.maxHistoryLength ?? 50,
      includeSystemPrompt: config.includeSystemPrompt ?? true,
    };

    if (
      !Number.isInteger(this.config.maxHistoryLength) ||
      this.config.maxHistoryLength < 1
    ) {
      throw new Error('maxHistoryLength must be a positive integer.');
    }
  }

  /**
   * Add a new message to the context.
   */
  addMessage(
    role: 'user' | 'assistant' | 'system',
    content: string
  ): void {
    this.history.push({ role, content });
    this.trimHistory();
  }

  /**
   * Keep history within the configured limit,
   * preserving the system prompt where possible.
   */
  private trimHistory(): void {
    if (this.history.length <= this.config.maxHistoryLength) {
      return;
    }

    const systemMessage = this.history.find(
      (message) => message.role === 'system'
    );

    const otherMessages = this.history.filter(
      (message) => message.role !== 'system'
    );

    const availableSlots = Math.max(
      0,
      this.config.maxHistoryLength - (systemMessage ? 1 : 0)
    );

    this.history = [
      ...(systemMessage ? [systemMessage] : []),
      ...otherMessages.slice(-availableSlots),
    ];
  }

  /**
   * Get the full context ready for an API call.
   */
  getContext(): ModelMessage[] {
    const history = [...this.history];

    if (this.config.includeSystemPrompt) {
      const systemMessage = history.find(
        (message) => message.role === 'system'
      );

      if (systemMessage) {
        return [
          systemMessage,
          ...history.filter(
            (message) => message.role !== 'system'
          ),
        ];
      }
    }

    return history;
  }

  /**
   * Load context for compatibility with engine.ts.
   */
  async loadContext(): Promise<ModelMessage[]> {
    return this.getContext();
  }

  /**
   * Clear the entire context.
   */
  clear(): void {
    this.history = [];
  }

  /**
   * Reset context for compatibility with engine.ts.
   */
  reset(): void {
    this.clear();
  }

  /**
   * Get the current history length.
   */
  getLength(): number {
    return this.history.length;
  }

  /**
   * Get the last N messages.
   */
  getLastMessages(n: number): ModelMessage[] {
    if (!Number.isInteger(n) || n <= 0) {
      return [];
    }

    return this.history.slice(-n);
  }

  /**
   * Update context configuration.
   */
  updateConfig(config: Partial<ContextConfig>): void {
    const updatedConfig = {
      ...this.config,
      ...config,
    };

    if (
      !Number.isInteger(updatedConfig.maxHistoryLength) ||
      updatedConfig.maxHistoryLength < 1
    ) {
      throw new Error('maxHistoryLength must be a positive integer.');
    }

    this.config = updatedConfig;
    this.trimHistory();
  }
}
