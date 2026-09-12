/**
 * Curated extensions offered for one-click install on the settings page.
 * Pure-JavaScript pi packages that do not need to ship inside the installer;
 * the install action pins nothing, so `pi update` keeps them current.
 * Cards keep the package name untranslated; blurbs live in the renderer's
 * i18n tables under `settings.recommended.<key>.description`.
 */
export interface RecommendedExtension {
  /** pi package source string passed to the install action. */
  source: string;
  /** npm package name: displayed as the card title and used to detect an installed copy. */
  name: string;
  /** i18n key fragment for the card's description. */
  key: string;
}

export const RECOMMENDED_EXTENSIONS: RecommendedExtension[] = [
  {
    source: "npm:pi-web-access",
    name: "pi-web-access",
    key: "webAccess",
  },
];

/** Sources the install action accepts; contracts validation uses this list. */
export const INSTALLABLE_PACKAGE_SOURCES = RECOMMENDED_EXTENSIONS.map(
  (extension) => extension.source,
);

/** Whether an extension list entry came from the named npm package. */
export function isNpmPackageExtension(
  extension: { source: string },
  name: string,
): boolean {
  return (
    extension.source === `npm:${name}` ||
    extension.source.startsWith(`npm:${name}@`)
  );
}
