import dotenv from "dotenv";

dotenv.config({ quiet: true });

// Assert a var is present WITHOUT ever touching/printing its value.
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name} (set it in .env)`);
  }
  return value;
}

export const OPENAI_API_KEY = required("OPENAI_API_KEY");
export const EXA_API_KEY = required("EXA_API_KEY");
export const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.1";
