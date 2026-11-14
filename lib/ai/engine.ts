
import { NeuralNet } from './models';
import type { ModelMessage, ModelTool } from './models';
import { MemoryManager } from './memory';
import { ContextManager } from './context';
import { PromptBuilder } from './prompts';
import { SafetyFilter } from './safety';
import { ToolExecutor } from './tools';
import { ResponseFormatter } from './response';
import { neon } from '@neondatabase/serverless';

export class Engine {
  private model: NeuralNet;
  private memory: MemoryManager;
  private context: ContextManager;
  private prompts: PromptBuilder;
  private safety: SafetyFilter;
  private tools: ToolExecutor;
  private formatter: ResponseFormatter;
  private db: ReturnType<typeof neon>;

  constructor(config: {
    modelType: string;
    dbUrl: string;
    userId: string;
  }) {
    this.db = neon(config.dbUrl);

    this.model = new NeuralNet(config.modelType);
    this.memory = new MemoryManager(this.db, config.userId);
    this.context = new ContextManager();
    this.prompts = new PromptBuilder();
    this.safety = new SafetyFilter();
    this.tools = new ToolExecutor();
    this.formatter = new ResponseFormatter();

    console.log('[Engine] Brain initialized with Neon DB and Model');
  }

  /**
   * Main processing loop.
   */
  async process(userInput: string): Promise<string> {
    try {
      // 1. Retrieve persistent conversation history.
      const history = await this.memory.getRecentHistory(10);

      // 2. Validate user input.
      const validatedInput = this.safety.validateInput(userInput);

      // 3. Rebuild the context from saved history.
      this.context.clear();

      for (const message of history) {
        if (
          message.role === 'user' ||
          message.role === 'assistant' ||
          message.role === 'system'
        ) {
          this.context.addMessage(
            message.role,
            message.content ?? ''
          );
        }
      }

      this.context.addMessage('user', validatedInput);

      const contextMessages = await this.context.loadContext();

      // 4. Retrieve available tool definitions.
      const availableTools: ModelTool[] =
        this.tools.getAvailableTools();

      // 5. Build the system prompt.
      const systemPrompt = this.prompts.build({
        uncensored: true,
        tools: availableTools,
      });

      // 6. Prepare model messages.
      const messages: ModelMessage[] = [
        { role: 'system', content: systemPrompt },
        ...contextMessages.filter(
          (message) => message.role !== 'system'
        ),
      ];

      // 7. Generate the response.
      let rawResponse = await this.model.generate(
        messages,
        availableTools
      );

      // 8. Execute available tools if requested.
      if (rawResponse.usesTools) {
        const toolResults = await this.tools.execute(
          rawResponse.tools
        );

        const updatedMessages: ModelMessage[] = [
          ...messages,
          rawResponse.assistantMessage,
          ...toolResults,
        ];

        rawResponse = await this.model.generate(
          updatedMessages,
          availableTools
        );
      }

      // 9. Format the final response.
      const finalResponse = this.formatter.process(rawResponse);

      // 10. Save conversation history.
      await this.memory.saveMessage({
        role: 'user',
        content: validatedInput,
      });

      await this.memory.saveMessage({
        role: 'assistant',
        content: finalResponse,
      });

      return finalResponse;

    } catch (error) {
      console.error('[Engine] Processing Error:', error);
      return 'Error processing request. Check logs.';
    }
  }

  /**
   * Handle engine commands.
   */
  async handleCommand(command: string): Promise<string> {
    switch (command) {
      case '/reset':
        await this.memory.clearHistory();
        this.context.reset();
        return 'Context and memory cleared.';

      case '/status':
        return `Model: ${this.model.getName()} | DB: Connected | Tools: ${this.tools.list().join(', ')}`;

      default:
        return 'Unknown command.';
    }
  }
}

