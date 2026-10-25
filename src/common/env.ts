const env_keys = ['S3_ACCOUNT_ID', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET_NAME', 'S3_ENDPOINT', 'TETRIO_TOKEN', 'PORT'] as const;

export type Env = Record<typeof env_keys[number], string>;

const buildEnv = (keys: typeof env_keys): Env => {
	const env: Env = {} as Env;
	for (const key of keys) {
		const v = process.env[key];
		if (!v) {
			throw new Error(`Missing env var ${key}`);
		}
		env[key] = v;
	}

	return env;
}
export const env: Env = buildEnv(env_keys);