import { emit, env, ghJson, linkedIssue } from "../../.shared/utils.ts";

export interface Candidate { number: number; isDraft: boolean; createdAt: string; headRefOid: string; baseRefName: string; files: { path: string }[]; body: string; state?: string }
export function oldestUnchecked(rows: Candidate[], finalHeads: Set<string>): Candidate | null {
  return rows.filter(row => !row.isDraft && (!row.state || row.state === "OPEN") && !finalHeads.has(row.headRefOid)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

function hasFinal(repo: string, head: string): boolean {
  const statuses = ghJson(["api", `repos/${repo}/commits/${head}/statuses`]) as { context: string; state: string }[];
  const latest = statuses.find(status => status.context === "factory/app-check");
  return latest?.state === "success" || latest?.state === "failure" || latest?.state === "error";
}

if (import.meta.main) {
  const repo = env("repo_path"), requested = env("pr");
  const fields = "number,isDraft,createdAt,headRefOid,baseRefName,files,body,state";
  const rows = requested
    ? [ghJson(["pr", "view", requested, "--repo", repo, "--json", fields]) as Candidate]
    : ghJson(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", fields]) as Candidate[];
  const finals = new Set(requested ? [] : rows.filter(row => hasFinal(repo, row.headRefOid)).map(row => row.headRefOid));
  // A PR named by the operator is checked even as a draft; only the automatic pick skips drafts.
  const picked = requested ? (rows[0]?.state === "OPEN" ? rows[0] : null) : oldestUnchecked(rows, finals);
  if (!picked) emit({ found: false, pr: null, head: "", files: [], base: "", issue: null, issue_body: "", issue_labels: [] });
  else {
    const issue = linkedIssue(picked.body);
    const detail = issue ? ghJson(["issue", "view", String(issue), "--repo", repo, "--json", "body,labels"]) : null;
    emit({ found: true, pr: picked.number, head: picked.headRefOid, files: picked.files.map(file => file.path), base: picked.baseRefName, issue,
      issue_body: detail?.body ?? "", issue_labels: (detail?.labels ?? []).map((label: { name: string }) => label.name) });
  }
}
