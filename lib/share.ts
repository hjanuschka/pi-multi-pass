import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import qr from "qrcode-terminal";

export type SharedAccount = {
	providerName: string;
	baseProvider: string;
	label?: string;
	credential: { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: unknown };
};
export type ShareBundle = { schemaVersion: 2; accounts: SharedAccount[] };
export type ShareFrame = { uri: string; qr: string; index: number; total: number };

const PREFIX = "mps-share://v2/";
const TEXT_PREFIX = `${PREFIX}bundle/`;
const CHUNK_LENGTH = 200;
const MAX_FRAMES = 256;
const MAX_DECOMPRESSED_BYTES = 100_000;
const CREDENTIAL_KEYS = new Set(["type", "access", "refresh", "expires", "accountId", "projectId", "enterpriseUrl"]);

export function validateBundle(bundle: ShareBundle): void {
	if (bundle?.schemaVersion !== 2 || !Array.isArray(bundle.accounts) || bundle.accounts.length !== 1) throw new Error("Invalid share bundle");
	const a = bundle.accounts[0];
	if (!a || typeof a.providerName !== "string" || !/^[a-z0-9-]{1,64}$/.test(a.providerName)
		|| typeof a.baseProvider !== "string" || !/^[a-z0-9-]{1,64}$/.test(a.baseProvider)
		|| (a.label !== undefined && (typeof a.label !== "string" || a.label.length > 128))) throw new Error("Invalid account in share bundle");
	const c = a.credential;
	if (c?.type !== "oauth" || typeof c.access !== "string" || !c.access || c.access.length > 32768
		|| typeof c.refresh !== "string" || !c.refresh || c.refresh.length > 32768
		|| typeof c.expires !== "number" || !Number.isFinite(c.expires) || c.expires < 0
		|| Object.keys(c).some((key) => !CREDENTIAL_KEYS.has(key))
		|| [c.accountId, c.projectId, c.enterpriseUrl].some((value) => value !== undefined && (typeof value !== "string" || value.length > 1024))) throw new Error("Invalid OAuth credential");
}

function digest(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function compressBundle(bundle: ShareBundle): Buffer {
	validateBundle(bundle);
	const data = deflateRawSync(Buffer.from(JSON.stringify(bundle)));
	if (data.toString("base64url").length > CHUNK_LENGTH * MAX_FRAMES) throw new Error("Account is too large to export");
	return data;
}

function unpackBundle(encoded: string, checksum: string): ShareBundle {
	const data = Buffer.from(encoded, "base64url");
	if (digest(data) !== checksum) throw new Error("Share data failed checksum");
	let bundle: ShareBundle;
	try { bundle = JSON.parse(inflateRawSync(data, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString()) as ShareBundle; }
	catch { throw new Error("Invalid share payload"); }
	validateBundle(bundle);
	return bundle;
}

/** One copy/paste string for pi-to-pi transfer. This is a bearer credential. */
export function encodeShareText(bundle: ShareBundle): string {
	const data = compressBundle(bundle);
	return `${TEXT_PREFIX}${digest(data)}/${data.toString("base64url")}`;
}

export function decodeShareText(text: string): ShareBundle {
	const compact = text.replace(/\s+/g, "");
	if (compact.length > CHUNK_LENGTH * MAX_FRAMES + TEXT_PREFIX.length + 65 || !compact.startsWith(TEXT_PREFIX)) throw new Error("Invalid share text");
	const fields = compact.slice(TEXT_PREFIX.length).split("/");
	if (fields.length !== 2 || !/^[0-9a-f]{64}$/.test(fields[0]) || !/^[A-Za-z0-9_-]+$/.test(fields[1])) throw new Error("Invalid share text");
	return unpackBundle(fields[1], fields[0]);
}

/** Offline, bearer QR export: every part of the OAuth credential is in these frames. */
export async function encodeShareFrames(bundle: ShareBundle): Promise<ShareFrame[]> {
	const data = compressBundle(bundle);
	const encoded = data.toString("base64url");
	const total = Math.ceil(encoded.length / CHUNK_LENGTH);
	if (total > MAX_FRAMES) throw new Error("Account is too large to export as QR frames");
	const transferId = randomBytes(8).toString("hex");
	const checksum = digest(data);
	return Promise.all(Array.from({ length: total }, async (_, index) => {
		const uri = `${PREFIX}${transferId}/${index + 1}/${total}/${checksum}/${encoded.slice(index * CHUNK_LENGTH, (index + 1) * CHUNK_LENGTH)}`;
		const qrText = await new Promise<string>((resolve) => qr.generate(uri, { small: true }, resolve));
		return { uri, qr: qrText, index: index + 1, total };
	}));
}

type ParsedFrame = { id: string; index: number; total: number; checksum: string; chunk: string };

export function parseShareFrame(uri: string): ParsedFrame {
	if (uri.length > 600 || !uri.startsWith(PREFIX)) throw new Error("Invalid share QR");
	const parts = uri.slice(PREFIX.length).split("/");
	if (parts.length !== 5) throw new Error("Invalid share QR");
	const [id, indexText, totalText, checksum, chunk] = parts;
	if (!/^[0-9a-f]{16}$/.test(id) || !/^[1-9][0-9]{0,2}$/.test(indexText)
		|| !/^[1-9][0-9]{0,2}$/.test(totalText) || !/^[0-9a-f]{64}$/.test(checksum)
		|| !/^[A-Za-z0-9_-]{1,200}$/.test(chunk)) throw new Error("Invalid share QR");
	const index = Number(indexText), total = Number(totalText);
	if (total > MAX_FRAMES || index > total) throw new Error("Invalid share QR sequence");
	return { id, index, total, checksum, chunk };
}

/** Receivers collect frames in any order. Nothing touches auth storage until complete. */
export class ShareFrameCollector {
	private id?: string;
	private total?: number;
	private checksum?: string;
	private chunks = new Map<number, string>();

	add(uri: string): { received: number; total: number; bundle?: ShareBundle } {
		if (uri.replace(/\s+/g, "").startsWith(TEXT_PREFIX)) {
			if (this.chunks.size) throw new Error("Cannot mix a full export with QR frames");
			return { received: 1, total: 1, bundle: decodeShareText(uri) };
		}
		const frame = parseShareFrame(uri.trim());
		if (this.id && (frame.id !== this.id || frame.total !== this.total || frame.checksum !== this.checksum)) throw new Error("QR belongs to another export");
		if (this.chunks.has(frame.index) && this.chunks.get(frame.index) !== frame.chunk) throw new Error("Conflicting QR frame");
		this.id = frame.id;
		this.total = frame.total;
		this.checksum = frame.checksum;
		this.chunks.set(frame.index, frame.chunk);
		if (this.chunks.size < frame.total) return { received: this.chunks.size, total: frame.total };
		const encoded = Array.from({ length: frame.total }, (_, i) => this.chunks.get(i + 1)).join("");
		return { received: frame.total, total: frame.total, bundle: unpackBundle(encoded, frame.checksum) };
	}
}
