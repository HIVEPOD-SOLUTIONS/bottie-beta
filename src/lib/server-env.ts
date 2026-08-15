type EnvSource = "process.env" | "process.env.secrets" | "process.env.SECRETS";

export type ServerEnvDiagnostic = {
  name: string;
  configured: boolean;
  source: EnvSource | null;
  direct: {
    present: boolean;
    nonEmpty: boolean;
    trimmedNonEmpty: boolean;
    length: number;
    trimmedLength: number;
    hasLeadingOrTrailingWhitespace: boolean;
    wrappedInQuotes: boolean;
  };
  secretStores: Array<{
    envName: "secrets" | "SECRETS";
    present: boolean;
    parses: boolean;
    containsKey: boolean;
    keys: string[];
    valueNonEmpty: boolean;
    valueTrimmedNonEmpty: boolean;
    valueLength: number;
    valueTrimmedLength: number;
    valueHasLeadingOrTrailingWhitespace: boolean;
    valueWrappedInQuotes: boolean;
  }>;
};

function normalizeValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isWrappedInQuotes(value: string) {
  return (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  );
}

function safeKeys(value: Record<string, unknown>) {
  return Object.keys(value).sort();
}

function parseSecretStore(envName: "secrets" | "SECRETS") {
  const raw = process.env[envName];
  if (!raw) return { raw, parsed: undefined };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { raw, parsed: parsed as Record<string, unknown> };
    }
  } catch {
    // handled by diagnostics
  }

  return { raw, parsed: undefined };
}

export function getServerEnv(name: string): string | undefined {
  const direct = normalizeValue(process.env[name]);
  if (direct) return direct;

  for (const envName of ["secrets", "SECRETS"] as const) {
    const { parsed } = parseSecretStore(envName);
    const value = parsed ? normalizeValue(parsed[name]) : undefined;
    if (value) return value;
  }

  return undefined;
}

export function getServerEnvDiagnostic(name: string): ServerEnvDiagnostic {
  const directValue = process.env[name] ?? "";
  const directTrimmed = directValue.trim();
  const directUsable = normalizeValue(directValue);

  const secretStores = (["secrets", "SECRETS"] as const).map((envName) => {
    const { raw, parsed } = parseSecretStore(envName);
    const value = parsed?.[name];
    const stringValue = typeof value === "string" ? value : "";
    const trimmed = stringValue.trim();

    return {
      envName,
      present: Boolean(raw),
      parses: Boolean(parsed),
      containsKey: Boolean(parsed && Object.prototype.hasOwnProperty.call(parsed, name)),
      keys: parsed ? safeKeys(parsed) : [],
      valueNonEmpty: stringValue.length > 0,
      valueTrimmedNonEmpty: trimmed.length > 0,
      valueLength: stringValue.length,
      valueTrimmedLength: trimmed.length,
      valueHasLeadingOrTrailingWhitespace: stringValue !== trimmed,
      valueWrappedInQuotes: stringValue.length > 1 && isWrappedInQuotes(stringValue),
    };
  });

  const store = secretStores.find((entry) => entry.valueTrimmedNonEmpty);
  const source: EnvSource | null = directUsable
    ? "process.env"
    : store
      ? store.envName === "secrets"
        ? "process.env.secrets"
        : "process.env.SECRETS"
      : null;

  return {
    name,
    configured: Boolean(directUsable || store),
    source,
    direct: {
      present: Object.prototype.hasOwnProperty.call(process.env, name),
      nonEmpty: directValue.length > 0,
      trimmedNonEmpty: directTrimmed.length > 0,
      length: directValue.length,
      trimmedLength: directTrimmed.length,
      hasLeadingOrTrailingWhitespace: directValue !== directTrimmed,
      wrappedInQuotes: directValue.length > 1 && isWrappedInQuotes(directValue),
    },
    secretStores,
  };
}
