/**
 * Who may use `typetorch serve --remote` from another machine (protocol.ts "Remote"). The owner runs `typetorch serve
 * pair`, which makes a one-time pairing code; the other person types it into the Studio plugin, which trades it at
 * `POST /tt/pair` for a device token. Tokens are 32 random bytes (base64url), kept only as SHA-256 hashes in
 * `.typetorch/serve-remote.json` (so a restart keeps them), and expire after TOKEN_DAYS. `typetorch serve unpair`
 * revokes them.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PAIRING_FILE = join(".typetorch", "serve-remote.json");
/** No 0/O, 1/I/L: read aloud or retyped from a chat. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
export const CODE_MINUTES = 15;
export const TOKEN_DAYS = 30;
/** Wrong codes in a row (any caller) before pairing locks until the owner makes a new code. */
export const MAX_BAD_CODES = 5;

export interface Device {
	/** What the person called their Studio (the plugin sends the Roblox user name). */
	name: string;
	/** SHA-256 of the token, hex. */
	hash: string;
	createdAt: string;
	expiresAt: string;
	lastSeen?: string;
}

const hashOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

function sameHash(a: string, b: string): boolean {
	const x = Buffer.from(a, "hex");
	const y = Buffer.from(b, "hex");
	return x.length === y.length && timingSafeEqual(x, y);
}

export function newCode(random: (n: number) => Buffer = randomBytes): string {
	const bytes = random(CODE_LENGTH);
	let code = "";
	for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
	return code;
}

/** Codes are typed by hand: case, spaces and dashes don't matter. */
export function normalizeCode(code: string): string {
	return code.toUpperCase().replace(/[\s-]/g, "");
}

/** `serve.example.com/` -> `https://serve.example.com`; throws on anything but an http(s) address (with an optional path). */
export function normalizeUrl(raw: string): string {
	let text = raw.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new Error(`not a URL: ${raw}`);
	}
	if (url.search || url.hash || url.username || url.password) throw new Error(`--url: just the tunnel's address, e.g. https://serve.example.com (got ${raw})`);
	return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export class Pairing {
	private devices: Device[] = [];
	/** The owner's tunnel URL (`serve pair --url`), remembered so `serve pair` prints one link with the code in it. */
	url?: string;
	private code?: { code: string; expiresAt: number };
	private badCodes = 0;

	constructor(
		private readonly root: string,
		private readonly now: () => number = Date.now,
	) {
		const file = join(root, PAIRING_FILE);
		if (existsSync(file)) {
			try {
				const raw = JSON.parse(readFileSync(file, "utf8"));
				if (typeof raw?.url === "string") this.url = raw.url;
				if (Array.isArray(raw?.devices)) this.devices = raw.devices.filter((d: Device) => typeof d?.hash === "string" && typeof d?.name === "string");
			} catch {
				this.devices = [];
			}
		}
		this.prune();
	}

	/**
	 * A new one-time code (replaces any earlier one and unlocks pairing). `url`: the owner's tunnel URL, remembered for
	 * later codes. With a URL, `link` is the one thing to share: `<url>#<code>`, which the plugin's Remote box takes as is.
	 */
	newCode(url?: string): { code: string; expiresAt: string; url?: string; link?: string } {
		if (url !== undefined) {
			this.url = normalizeUrl(url);
			this.save();
		}
		const code = newCode();
		const expiresAt = this.now() + CODE_MINUTES * 60_000;
		this.code = { code, expiresAt };
		this.badCodes = 0;
		return { code, expiresAt: new Date(expiresAt).toISOString(), ...(this.url ? { url: this.url, link: `${this.url}#${code}` } : {}) };
	}

	/** Trades the current code for a device token; the code works once. Throws a message for the caller. */
	pair(code: string, name: string): { token: string; expiresAt: string } {
		const current = this.code;
		if (!current || this.now() > current.expiresAt) throw new Error("no pairing code is active: ask the owner to run `typetorch serve pair`");
		if (this.badCodes >= MAX_BAD_CODES) throw new Error("too many wrong codes: ask the owner for a new one (`typetorch serve pair`)");
		if (normalizeCode(code) !== current.code) {
			this.badCodes++;
			if (this.badCodes >= MAX_BAD_CODES) this.code = undefined;
			throw new Error("wrong pairing code");
		}
		this.code = undefined;
		const token = randomBytes(32).toString("base64url");
		const createdAt = this.now();
		const device: Device = {
			name: name.slice(0, 60) || "Studio",
			hash: hashOf(token),
			createdAt: new Date(createdAt).toISOString(),
			expiresAt: new Date(createdAt + TOKEN_DAYS * 86_400_000).toISOString(),
		};
		this.devices.push(device);
		this.save();
		return { token, expiresAt: device.expiresAt };
	}

	/** The device a token belongs to, or undefined (unknown, revoked or expired). */
	check(token: string | undefined): Device | undefined {
		if (!token || token.length > 200) return undefined;
		this.prune();
		const hash = hashOf(token);
		const device = this.devices.find((d) => sameHash(d.hash, hash));
		if (device) device.lastSeen = new Date(this.now()).toISOString();
		return device;
	}

	list(): Omit<Device, "hash">[] {
		this.prune();
		return this.devices.map(({ hash: _, ...rest }) => rest);
	}

	/** Revokes the devices called `name`, or all of them; returns how many. */
	revoke(name?: string): number {
		const before = this.devices.length;
		this.devices = name === undefined ? [] : this.devices.filter((d) => d.name !== name);
		this.save();
		return before - this.devices.length;
	}

	private prune() {
		const now = this.now();
		const kept = this.devices.filter((d) => Date.parse(d.expiresAt) > now);
		if (kept.length !== this.devices.length) {
			this.devices = kept;
			this.save();
		}
	}

	private save() {
		const file = join(this.root, PAIRING_FILE);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ v: 1, ...(this.url ? { url: this.url } : {}), devices: this.devices.map(({ lastSeen: _, ...d }) => d) }, null, "\t") + "\n", { mode: 0o600 });
	}
}
