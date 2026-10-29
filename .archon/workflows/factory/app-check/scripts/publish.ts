import { env, ghJson, jsonEnv, postStatus, run } from "../../.shared/utils.ts";

const repo = env("repo_path"), head = env("head"), pr = env("pr"), overall = env("overall");
const lines = jsonEnv<string[]>("lines", []), report = env("report");
postStatus(repo, head, overall === "PASS" ? "success" : "failure", "factory/app-check", overall === "PASS" ? "black-box app check passed" : "black-box app check failed");
const marker = "<!-- factory-app-check -->";
const body = `${marker}\n## Factory app check: ${overall}\n\n${lines.join("\n")}\n\n${report}`;
const comments = ghJson(["api", `repos/${repo}/issues/${pr}/comments`, "--paginate"]) as { id: number; body: string }[];
const prior = comments.find(comment => comment.body.includes(marker));
const file = `${process.env.ARTIFACTS_DIR}/app-check/comment.json`;
await Bun.write(file, JSON.stringify({ body }));
if (prior) run(["gh", "api", "--method", "PATCH", `repos/${repo}/issues/comments/${prior.id}`, "--input", file]);
else run(["gh", "api", "--method", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", file]);
console.log(JSON.stringify({ state: overall === "PASS" ? "success" : "failure", comment: prior ? "updated" : "created" }));
