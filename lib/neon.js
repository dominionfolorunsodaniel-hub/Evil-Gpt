import { NeonDatabase } from "@neondatabase/serverless";

const neon = NeonDatabase({
  connectionString: process.env.DATABASE_URL,
});

export default neon;
