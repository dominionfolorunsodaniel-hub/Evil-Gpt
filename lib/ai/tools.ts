
import type {
  ModelMessage,
  ModelTool,
  ModelToolCall,
} from './models';

export class ToolExecutor {
  getAvailableTools(): ModelTool[] {
    return [];
  }

  list(): string[] {
    return [];
  }

  async execute(
    calls: ModelToolCall[]
  ): Promise<ModelMessage[]> {
    return calls.map((call) => ({
      role: 'tool',
      tool_call_id: call.id,
      content: `Tool "${call.function.name}" is not currently available.`,
    }));
  }
}

