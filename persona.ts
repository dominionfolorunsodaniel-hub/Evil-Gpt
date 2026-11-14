import { WickedConfig } from './config';

export class Persona {
  private config: WickedConfig;

  constructor(config: WickedConfig) {
    this.config = config;
  }

  /**
   * Returns the system message to prepend to every conversation
   */
  getSystemMessage(): string {
    return this.config.systemPrompt;
  }

  /**
   * Updates the personality dynamically
   */
  updateConfig(newConfig: Partial<WickedConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get the current config
   */
  getConfig(): WickedConfig {
    return { ...this.config };
  }
}
