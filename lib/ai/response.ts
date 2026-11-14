
import type { ModelResponse } from './models';

export class ResponseFormatter {
  process(response: ModelResponse): string {
    const content = response.content?.trim();

    return content || 'I could not generate a response. Please try again.';
  }
}

