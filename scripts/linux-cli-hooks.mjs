import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildInstallGuard } from './install-guard-bundle.mjs';
const require = createRequire(import.meta.url);

// Extend the installed builder's scripts, retaining its sandbox, alternatives,
// MIME and AppArmor handling instead of maintaining an outdated private copy.
export function prepareLinuxCliHooks(output) {
  const templates = join(require.resolve('app-builder-lib/package.json'), '..', 'templates', 'linux');
  mkdirSync(output, { recursive: true });
  const guard = buildInstallGuard(output);
  // The new helper is embedded in preinst: it must also upgrade releases that
  // predate the guard, without importing code from the previous installation.
  writeFileSync(join(output, 'before-install.sh'), `#!/bin/sh
set -eu
pix_target='/opt/PiX/pix-desktop'
pix_legacy_target='/opt/PiX/pix'
pix_runtime="$pix_target"
if [ ! -x "$pix_runtime" ]; then pix_runtime="$pix_legacy_target"; fi
if [ -x "$pix_runtime" ]; then
  pix_guard_dir=$(mktemp -d /tmp/pix-install-guard.XXXXXX)
  trap 'rm -rf "$pix_guard_dir"' EXIT
  trap 'exit 1' HUP INT TERM
  cat > "$pix_guard_dir/install-guard.cjs" <<'PIX_INSTALL_GUARD'
${guard}
PIX_INSTALL_GUARD
  if [ "\${DEBIAN_FRONTEND:-}" != noninteractive ] && (: < /dev/tty) 2>/dev/null; then
    ELECTRON_RUN_AS_NODE=1 "$pix_runtime" "$pix_guard_dir/install-guard.cjs" --prepare --target "$pix_target" --target "$pix_legacy_target" --receipt /run/pix-install-guard.json --owner-pid "$PPID" --ui terminal < /dev/tty
  else
    ELECTRON_RUN_AS_NODE=1 "$pix_runtime" "$pix_guard_dir/install-guard.cjs" --prepare --target "$pix_target" --target "$pix_legacy_target" --receipt /run/pix-install-guard.json --owner-pid "$PPID" --ui terminal
  fi
fi
`);
  const finish = `
# Release reservations on success, failure and cancellation, preserving hook status.
pix_finish_install() {
  pix_install_status=$?
  trap - EXIT
  if [ -f /run/pix-install-guard.json ]; then
    ELECTRON_RUN_AS_NODE=1 '/opt/\${sanitizedProductName}/\${executable}' '/opt/\${sanitizedProductName}/resources/cli/install-guard.cjs' --finish --receipt /run/pix-install-guard.json || exit 1
  fi
  exit "$pix_install_status"
}
trap pix_finish_install EXIT
trap 'exit 1' HUP INT TERM
`;
  const install = '\n# Register the terminal command separately from pix-desktop.\n' +
    "pix_cli='/opt/${sanitizedProductName}/resources/cli/pix'\n" +
    "pix_link='/usr/bin/pix'\n" +
    // Migrate the GUI alternative used by older PiX releases only.
    "if [ -L \"$pix_link\" ] && [ \"$(readlink \"$pix_link\")\" = /etc/alternatives/pix ]; then\n" +
    "  update-alternatives --remove pix '/opt/${sanitizedProductName}/pix' || true\nfi\n" +
    // The builder used this fallback on systems without update-alternatives.
    "if [ -L \"$pix_link\" ] && [ \"$(readlink \"$pix_link\")\" = '/opt/${sanitizedProductName}/pix' ]; then\n" +
    '  rm "$pix_link" || exit 1\nfi\n' +
    'if [ -e "$pix_link" ] || [ -L "$pix_link" ]; then\n' +
    '  if [ "$(readlink "$pix_link")" != "$pix_cli" ]; then\n' +
    '    echo "PiX CLI was not registered: $pix_link belongs to another installation" >&2\n    exit 1\n  fi\n' +
    'else\n  ln -s "$pix_cli" "$pix_link"\nfi\n';
  const remove = '\n# Leave a replacement command or another package untouched.\n' +
    "if [ -L /usr/bin/pix ] && [ \"$(readlink /usr/bin/pix)\" = '/opt/${sanitizedProductName}/resources/cli/pix' ]; then\n" +
    '  rm /usr/bin/pix\nfi\n';
  // Old RPM releases ran after-remove during upgrades as well. Reassert the
  // CLI after that transaction, so their old /usr/bin/pix cleanup cannot win.
  // FPM's native hook: https://github.com/jordansissel/fpm/blob/main/lib/fpm/package/rpm.rb
  writeFileSync(join(output, 'rpm-posttrans.sh'), '#!/bin/sh\n' + install.replaceAll('${sanitizedProductName}', 'PiX'));
  const afterInstall = readFileSync(join(templates, 'after-install.tpl'), 'utf8');
  writeFileSync(join(output, 'after-install.tpl'), afterInstall.replace(/^(#![^\n]*\n)/, header => header + finish) +
    '\npix_builder_status=$?\nif [ "$pix_builder_status" -ne 0 ]; then exit "$pix_builder_status"; fi\n' + install);
  writeFileSync(join(output, 'after-remove.tpl'), readFileSync(join(templates, 'after-remove.tpl'), 'utf8') + remove);
}
