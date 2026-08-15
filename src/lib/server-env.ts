export function getServerEnv(name: string): string | undefined {
  const direct = process.env[name];
  if (direct) return direct;

  const rawSecrets = process.env.secrets;
  if (!rawSecrets) return undefined;

  try {
    const secrets = JSON.parse(rawSecrets) as Record<string, unknown>;
    const value = secrets[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
