import { env, postStatus } from "../../.shared/utils.ts";
postStatus(env("repo_path"), env("head"), "pending", "factory/app-check", "black-box app check running");
console.log(JSON.stringify({ posted: true }));
