import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Extend the installed builder's scripts, retaining its sandbox, alternatives,
// MIME and AppArmor handling instead of maintaining an outdated private copy.
export function prepareLinuxCliHooks(output) {
  const templates = join(require.resolve('app-builder-lib/package.json'), '..', 'templates', 'linux');
  mkdirSync(output, { recursive: true });
  const install = '\n# Register the terminal command separately from pix-desktop.\n' +
    "pix_cli='/opt/${sanitizedProductName}/resources/cli/pix'\n" +
    "pix_link='/usr/bin/pix'\n" +
    // Migrate the GUI alternative used by older PiX releases only.
    "if [ -L \"$pix_link\" ] && [ \"$(readlink \"$pix_link\")\" = /etc/alternatives/pix ]; then\n" +
    "  update-alternatives --remove pix '/opt/${sanitizedProductName}/pix' || true\nfi\n" +
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
  for (const [name, suffix] of [['after-install.tpl', install], ['after-remove.tpl', remove]])
    writeFileSync(join(output, name), readFileSync(join(templates, name), 'utf8') + suffix);
}
