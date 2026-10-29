import { decodeHealthResponse, type HealthResponse } from "../../../../../contracts/health";

export async function readHealthResponse(url: string | URL): Promise<HealthResponse> {
  const response = await fetch(url);
  if (response.status !== 200) throw new Error(`health response returned HTTP ${response.status}`);
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error("health response must use application/json");
  }
  return decodeHealthResponse(await response.json());
}

if (import.meta.main) {
  const url = Bun.argv[2];
  if (!url) throw new Error("health URL is required");
  console.log(JSON.stringify(await readHealthResponse(url)));
}
