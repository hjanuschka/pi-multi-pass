import { readFileSync } from "node:fs";
import { join } from "node:path";
export function getAgentDir() {
	return process.env.MULTIPASS_TEST_AGENT_DIR ?? "/tmp";
}
export function readStoredCredential(providerId, authPath = join(getAgentDir(), "auth.json")) {
	try {
		return JSON.parse(readFileSync(authPath, "utf-8"))[providerId];
	} catch {
		return undefined;
	}
}
export class BorderedLoader {}
export class DynamicBorder {}
export function keyHint() { return ""; }
