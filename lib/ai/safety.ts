
export class SafetyFilter {
  validateInput(input: string): string {
    if (typeof input !== 'string') {
      throw new Error('Input must be text.');
    }

    const cleaned = input.replace(/\0/g, '').trim();

    if (!cleaned) {
      throw new Error('Please enter a message.');
    }

    if (cleaned.length > 20000) {
      throw new Error('Message is too long.');
    }

    return cleaned;
  }
}

