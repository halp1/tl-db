const envKeys = [
  "S3_ACCOUNT_ID",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET_NAME",
  "S3_ENDPOINT",
  "TETRIO_TOKEN",
  "PORT",
] as const;

const optionalEnvKeys = ["INGEST_URL", "INGEST_TOKEN", "SCRAPE_COMPRESSORS"] as const;

export type Env = Record<(typeof envKeys)[number], string>;
export type OptionalEnv = Partial<Record<(typeof optionalEnvKeys)[number], string>>;

const missing = envKeys.filter((key) => !process.env[key]);
if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(", ")}`);

export const env = Object.fromEntries(envKeys.map((key) => [key, process.env[key]!])) as Env;

export const optionalEnv: OptionalEnv = Object.fromEntries(
  optionalEnvKeys.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
);
