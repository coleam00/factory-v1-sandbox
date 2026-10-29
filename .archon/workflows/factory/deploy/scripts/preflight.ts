import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseFullCommitSha } from "../../../../../contracts/health";

const revision = parseFullCommitSha(process.env.INPUTS_REVISION?.trim());
if (!revision) throw new Error("revision must be an exact 40-character commit id");
const deployDoc = resolve("DEPLOY.md");
if (!existsSync(deployDoc)) throw new Error("DEPLOY.md is required; factory-deploy never invents deployment instructions");
console.log(JSON.stringify({ revision, deploy_doc: deployDoc, started_at: Date.now() }));
