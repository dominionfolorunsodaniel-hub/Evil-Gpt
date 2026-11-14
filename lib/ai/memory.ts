
import type { ModelMessage } from './models';

export interface MemoryConfig {
  shortTermSize: number;
  longTermEnabled: boolean;
}

export interface LongTermMemoryEntry {
  id: string;
  category: 'fact' | 'preference' | 'event';
  content: string;
  timestamp: number;
  tags: string[];
}

export class MemoryManager {
  private shortTermBuffer: ModelMessage[] = [];
  private longTermMemory: LongTermMemoryEntry[] = [];
  private config: MemoryConfig;
  private tableReady = false;

  constructor(
    private db: any,
    private userId: string,
    config: Partial<MemoryConfig> = {}
  ) {
    if (!userId || !userId.trim()) {
      throw new Error('A valid user ID is required.');
    }

    this.config = {
      shortTermSize: config.shortTermSize ?? 20,
      longTermEnabled: config.longTermEnabled ?? true,
    };

    if (
      !Number.isInteger(this.config.shortTermSize) ||
      this.config.shortTermSize < 1
    ) {
      throw new Error('shortTermSize must be a positive integer.');
    }

    console.log(
      `[Memory] Initialized with short-term size: ${this.config.shortTermSize}`
    );
  }

  /**
   * Create required database tables and indexes.
   */
  private async ensureTable(): Promise<void> {
    if (this.tableReady) return;

    await this.db`
      CREATE TABLE IF NOT EXISTS ai_memory (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await this.db`
      CREATE INDEX IF NOT EXISTS ai_memory_user_created_idx
      ON ai_memory (user_id, created_at DESC)
    `;

    await this.db`
      CREATE TABLE IF NOT EXISTS ai_long_term_memory (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb
      )
    `;

    this.tableReady = true;
  }

  /**
   * Add a message to short-term memory.
   */
  addMessage(message: ModelMessage): void {
    this.shortTermBuffer.push(message);

    if (this.shortTermBuffer.length > this.config.shortTermSize) {
      this.shortTermBuffer.shift();
    }
  }

  /**
   * Get current short-term memory.
   */
  getShortTermContext(): ModelMessage[] {
    return [...this.shortTermBuffer];
  }

  /**
   * Save a fact or preference to long-term memory.
   */
  async saveLongTermMemory(
    entry: Omit<LongTermMemoryEntry, 'id' | 'timestamp'>
  ): Promise<void> {
    if (!this.config.longTermEnabled) return;

    if (!entry.content.trim()) {
      throw new Error('Memory content cannot be empty.');
    }

    if (!Array.isArray(entry.tags)) {
      throw new Error('Memory tags must be an array.');
    }

    const newEntry: LongTermMemoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    await this.ensureTable();

    await this.db`
      INSERT INTO ai_long_term_memory
        (id, user_id, category, content, timestamp, tags)
      VALUES (
        ${newEntry.id},
        ${this.userId},
        ${newEntry.category},
        ${newEntry.content},
        ${newEntry.timestamp},
        ${JSON.stringify(newEntry.tags)}::jsonb
      )
    `;

    this.longTermMemory.push(newEntry);

    console.log(
      `[Memory] Long-term memory updated: ${entry.category}`
    );
  }

  /**
   * Retrieve relevant long-term memories.
   */
  async getRelevantLongTermMemories(
    query?: string
  ): Promise<LongTermMemoryEntry[]> {
    if (!this.config.longTermEnabled) return [];

    await this.ensureTable();

    const rows = await this.db`
      SELECT id, category, content, timestamp, tags
      FROM ai_long_term_memory
      WHERE user_id = ${this.userId}
      ORDER BY timestamp DESC
    `;

    const memories: LongTermMemoryEntry[] = rows.map((row: any) => {
      let tags: unknown = row.tags;

      if (typeof tags === 'string') {
        try {
          tags = JSON.parse(tags);
        } catch {
          tags = [];
        }
      }

      return {
        id: String(row.id),
        category: row.category as LongTermMemoryEntry['category'],
        content: String(row.content ?? ''),
        timestamp: Number(row.timestamp),
        tags: Array.isArray(tags)
          ? tags.filter((tag): tag is string => typeof tag === 'string')
          : [],
      };
    });

    this.longTermMemory = memories;

    if (!query) return [...memories];

    const lowerQuery = query.toLowerCase();

    return memories.filter((entry) => {
      const lowerContent = entry.content.toLowerCase();

      return (
        lowerContent.includes(lowerQuery) ||
        entry.tags.some((tag) =>
          lowerQuery.includes(tag.toLowerCase())
        )
      );
    });
  }

  /**
   * Retrieve recent conversation history from Neon.
   */
  async getRecentHistory(limit = 10): Promise<ModelMessage[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('History limit must be a positive integer.');
    }

    await this.ensureTable();

    const rows = await this.db`
      SELECT role, content
      FROM ai_memory
      WHERE user_id = ${this.userId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;

    const messages: ModelMessage[] = rows.reverse().map((row: any) => ({
      role: row.role as ModelMessage['role'],
      content: row.content ?? '',
    }));

    this.shortTermBuffer = messages.slice(-this.config.shortTermSize);

    return messages;
  }

  /**
   * Save a conversation message to Neon and short-term memory.
   */
  async saveMessage(message: {
    role: 'user' | 'assistant';
    content: string;
  }): Promise<void> {
    if (!message.content.trim()) {
      throw new Error('Message content cannot be empty.');
    }

    await this.ensureTable();

    await this.db`
      INSERT INTO ai_memory (user_id, role, content)
      VALUES (${this.userId}, ${message.role}, ${message.content})
    `;

    this.addMessage(message);
  }

  /**
   * Clear conversation history and long-term memory for this user.
   */
  async clearHistory(): Promise<void> {
    await this.ensureTable();

    await this.db`
      DELETE FROM ai_memory
      WHERE user_id = ${this.userId}
    `;

    await this.db`
      DELETE FROM ai_long_term_memory
      WHERE user_id = ${this.userId}
    `;

    this.clear();
  }

  /**
   * Clear local memory buffers.
   */
  clear(): void {
    this.shortTermBuffer = [];
    this.longTermMemory = [];

    console.log('[Memory] All memory cleared');
  }

  /**
   * Get memory statistics.
   */
  getStats(): {
    shortTerm: number;
    longTerm: number;
  } {
    return {
      shortTerm: this.shortTermBuffer.length,
      longTerm: this.longTermMemory.length,
    };
  }

  /**
   * Get current memory configuration.
   */
  getConfig(): MemoryConfig {
    return { ...this.config };
  }
}

