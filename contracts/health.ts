declare const fullCommitShaBrand: unique symbol;

export type FullCommitSha = string & { readonly [fullCommitShaBrand]: true };
export type HealthResponse = { status: "ok"; revision: FullCommitSha | null };

export function parseFullCommitSha(value: string | undefined): FullCommitSha | null {
  return value && /^[0-9a-f]{40}$/i.test(value)
    ? (value.toLowerCase() as FullCommitSha)
    : null;
}

export function createHealthResponse(revision: FullCommitSha | null): HealthResponse {
  return { status: "ok", revision };
}

export function decodeHealthResponse(value: unknown): HealthResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("health response must be an object");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "revision" || keys[1] !== "status") {
    throw new Error("health response must contain exactly status and revision");
  }
  if (record.status !== "ok") throw new Error("health response status must be ok");
  if (record.revision === null) return createHealthResponse(null);
  if (typeof record.revision !== "string") throw new Error("health response revision must be a full commit or null");

  const revision = parseFullCommitSha(record.revision);
  if (revision === null || revision !== record.revision) {
    throw new Error("health response revision must be a lowercase full commit");
  }
  return createHealthResponse(revision);
}
