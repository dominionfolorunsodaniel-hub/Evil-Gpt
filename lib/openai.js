
import OpenAI from "openai";

let openai = null;

export default function getOpenAIClient() {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    openai = new OpenAI({ apiKey });
  }

  return openai;
}
