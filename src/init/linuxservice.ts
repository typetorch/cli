/**
 * The backend as a Linux service with no Docker (plans "typetorch init", milestone 3): the steps of the backend README's
 * "Run it on a VPS without Docker", one bash script each, run over SSH or on this machine. Every step checks before it
 * changes anything, so a rerun on a half-done server skips what is there. Caddy serves the user's domain or the
 * sslip.io name with an automatic certificate; the backend listens on 127.0.0.1 only. `typetorch init --teardown`
 * reverses it (the data folder only when asked).
 *
 * The two keys reach the server only inside /etc/typetorch/backend.env (root:typetorch, 640), written by a script fed
 * to bash on stdin: never on a command line, never in a file on this PC.
 */
import type { Tui } from "../tui.ts";
import { BACKEND_REPO_URL } from "./coolify.ts";
import { execOk, type Machine } from "./ssh.ts";

export const APP_DIR = "/opt/typetorch-backend";
export const DATA_DIR = "/var/lib/typetorch-backend";
export const ENV_FILE = "/etc/typetorch/backend.env";
export const UNIT = "typetorch-backend";
export const CADDY_SITE = "/etc/caddy/typetorch-backend.caddy";

export interface ServiceOptions {
	hostname: string;
	key: string;
	admin: string;
}

export interface Step {
	label: string;
	script: string;
}

export function caddySite(hostname: string): string {
	return `# typetorch init: the TypeTorch backend (rerun init to change it; init --teardown removes it)
${hostname} {
	request_body {
		max_size 4MB
	}
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
`;
}

export function envFile(o: ServiceOptions): string {
	return [
		"# Written by typetorch init. The two secrets: never commit or share this file.",
		`TYPETORCH_API_KEY=${o.key}`,
		`TYPETORCH_ADMIN_TOKEN=${o.admin}`,
		`TYPETORCH_DATA_DIR=${DATA_DIR}`,
		"HOST=127.0.0.1",
		"PORT=8787",
		`TYPETORCH_PUBLIC_URL=https://${o.hostname}`,
		"TYPETORCH_TRUST_PROXY=1",
		"TYPETORCH_TOKEN_LOGIN=on",
		"TYPETORCH_THREADS=1",
		"",
	].join("\n");
}

/** The install, one script per checklist line. */
export function installSteps(o: ServiceOptions): Step[] {
	return [
		{
			label: "nothing else on ports 80, 443 and 8787",
			script: `busy="$($SUDO ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443|8787)$/' | grep -v -e '"caddy"' -e '"bun"' || true)"
if [ -n "$busy" ]; then echo "another program listens on 80, 443 or 8787:"; echo "$busy"; exit 3; fi
`,
		},
		{
			label: "packages (git, curl, unzip, ufw)",
			script: `export DEBIAN_FRONTEND=noninteractive
need=""; for p in git curl unzip ufw ca-certificates; do dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"; done
if [ -n "$need" ]; then $SUDO apt-get update -q && $SUDO apt-get install -y -q $need; fi
`,
		},
		{
			label: "2 GB swap (absorbs DuckDB spikes)",
			script: `if [ -z "$($SUDO swapon --show --noheadings)" ] && [ ! -f /swapfile ]; then
  $SUDO fallocate -l 2G /swapfile && $SUDO chmod 600 /swapfile && $SUDO mkswap /swapfile && $SUDO swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
  echo 'vm.swappiness=10' | $SUDO tee /etc/sysctl.d/99-swap.conf >/dev/null && $SUDO sysctl -q --system
fi
`,
		},
		{
			label: "firewall: SSH, 80 and 443 only",
			script: `sshport="$(echo "\${SSH_CONNECTION:-}" | awk '{print $4}')"
$SUDO ufw allow OpenSSH >/dev/null
if [ -n "$sshport" ]; then $SUDO ufw allow "$sshport/tcp" >/dev/null; fi
$SUDO ufw allow 80/tcp >/dev/null && $SUDO ufw allow 443/tcp >/dev/null
$SUDO ufw --force enable >/dev/null
`,
		},
		{
			label: "Bun in /opt/bun",
			script: `if [ ! -x /opt/bun/bin/bun ]; then
  tmp="$(mktemp)"; curl -fsSL https://bun.sh/install -o "$tmp"
  $SUDO env BUN_INSTALL=/opt/bun bash "$tmp" >/dev/null; rm -f "$tmp"
fi
/opt/bun/bin/bun --version >/dev/null
$SUDO ln -sf /opt/bun/bin/bun /usr/local/bin/bun
`,
		},
		{
			label: "the typetorch service user and folders",
			script: `id typetorch >/dev/null 2>&1 || $SUDO useradd --system --home ${DATA_DIR} --shell /usr/sbin/nologin typetorch
$SUDO mkdir -p ${DATA_DIR} /etc/typetorch && $SUDO chown typetorch:typetorch ${DATA_DIR} && $SUDO chmod 750 ${DATA_DIR}
`,
		},
		{
			label: `the backend's code in ${APP_DIR}, dependencies, the explorer`,
			script: `if [ -d ${APP_DIR}/.git ]; then $SUDO git -C ${APP_DIR} pull -q --ff-only; else $SUDO git clone -q --depth 1 ${BACKEND_REPO_URL} ${APP_DIR}; fi
cd ${APP_DIR}
$SUDO /usr/local/bin/bun install --frozen-lockfile --production >/dev/null
$SUDO /usr/local/bin/bun run web:install >/dev/null && $SUDO /usr/local/bin/bun run web:build >/dev/null
`,
		},
		{
			label: `settings in ${ENV_FILE} (root:typetorch, 640)`,
			script: `umask 077
tmp="$(mktemp)"
cat > "$tmp" <<'TYPETORCH_ENV'
${envFile(o)}TYPETORCH_ENV
$SUDO install -o root -g typetorch -m 640 "$tmp" ${ENV_FILE}
rm -f "$tmp"
`,
		},
		{
			label: `the ${UNIT} service`,
			script: `$SUDO install -m 644 ${APP_DIR}/server/typetorch-backend.service /etc/systemd/system/${UNIT}.service
$SUDO systemctl daemon-reload && $SUDO systemctl enable -q ${UNIT} && $SUDO systemctl restart ${UNIT}
for i in $(seq 1 60); do if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:8787/healthz; then exit 0; fi; sleep 1; done
echo "the service did not answer on 127.0.0.1:8787; its log:"; $SUDO journalctl -u ${UNIT} -n 30 --no-pager; exit 4
`,
		},
		{
			label: `Caddy with a certificate for ${o.hostname}`,
			script: `set -o pipefail
if ! command -v caddy >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https gpg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $SUDO gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  $SUDO apt-get update -q && $SUDO apt-get install -y -q caddy
fi
tmp="$(mktemp)"
cat > "$tmp" <<'TYPETORCH_CADDY'
${caddySite(o.hostname)}TYPETORCH_CADDY
$SUDO install -m 644 "$tmp" ${CADDY_SITE}
rm -f "$tmp"
# The stock Caddyfile (a :80 placeholder page) is replaced; any other Caddyfile keeps its sites and gains one import.
if grep -q '/usr/share/caddy' /etc/caddy/Caddyfile 2>/dev/null || [ ! -s /etc/caddy/Caddyfile ]; then
  echo 'import ${CADDY_SITE}' | $SUDO tee /etc/caddy/Caddyfile >/dev/null
elif ! grep -qF 'import ${CADDY_SITE}' /etc/caddy/Caddyfile; then
  printf '\\nimport ${CADDY_SITE}\\n' | $SUDO tee -a /etc/caddy/Caddyfile >/dev/null
fi
$SUDO caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
$SUDO systemctl enable -q caddy && $SUDO systemctl reload-or-restart caddy
`,
		},
	];
}

/** The reverse: the service, the code, the settings, the Caddy site; the data folder and Bun only when asked. */
export function teardownSteps(o: { deleteData: boolean }): Step[] {
	return [
		{
			label: `stop and remove the ${UNIT} service`,
			script: `if [ -f /etc/systemd/system/${UNIT}.service ]; then $SUDO systemctl disable -q --now ${UNIT} || true; $SUDO rm -f /etc/systemd/system/${UNIT}.service; $SUDO systemctl daemon-reload; fi
`,
		},
		{
			label: "remove the Caddy site",
			script: `if [ -f ${CADDY_SITE} ]; then
  $SUDO rm -f ${CADDY_SITE}
  if [ -f /etc/caddy/Caddyfile ]; then $SUDO sed -i '\\#^import ${CADDY_SITE}$#d' /etc/caddy/Caddyfile; fi
  if command -v caddy >/dev/null && systemctl is-active -q caddy; then $SUDO systemctl reload caddy || true; fi
fi
`,
		},
		{
			label: `remove ${APP_DIR} and ${ENV_FILE}`,
			script: `$SUDO rm -rf ${APP_DIR} ${ENV_FILE}
$SUDO rmdir /etc/typetorch 2>/dev/null || true
`,
		},
		...(o.deleteData
			? [
					{
						label: `delete the data in ${DATA_DIR} and the typetorch user`,
						script: `$SUDO rm -rf ${DATA_DIR}
if id typetorch >/dev/null 2>&1; then $SUDO userdel typetorch; fi
`,
					},
				]
			: []),
	];
}

/** Runs the steps in order, one checklist line each; stops at the first failure with its output. */
export async function runSteps(tui: Tui, machine: Machine, steps: Step[]): Promise<void> {
	const list = tui.checklist(steps.map((s) => s.label));
	for (const [i, step] of steps.entries()) {
		try {
			await execOk(machine, step.script, step.label);
		} catch (error) {
			list.fail(i);
			throw error;
		}
		list.done(i);
	}
}

export function linuxServiceInstall(tui: Tui, machine: Machine, o: ServiceOptions): Promise<void> {
	tui.note(`installing on ${machine.label}; each step skips what is already there, so running it again is safe`);
	return runSteps(tui, machine, installSteps(o));
}
