
import OpenAI from "openai";

let groq = null;

export default function getOpenAIClient() {
  if (!groq) {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      throw new Error("GROQ_API_KEY is not configured.");
    }

    groq = new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }

  return groq;
}

